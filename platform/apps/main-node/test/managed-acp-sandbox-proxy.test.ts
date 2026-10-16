// An acp-sandbox turn reaches its model through the inference proxy
// (docs/plans/models-harness.md, 5.4 to 5.8). A fake ACP agent runs in a
// LocalSubprocessSandbox, reports the variables it got and calls the proxy
// with them; a fake upstream records what the proxy sent on.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serve, type ServerType } from "@hono/node-server";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const ROOT_SECRET = Buffer.alloc(32, 9).toString("base64");
const API_KEY = "acp-proxy-test-key";
const headers = { "x-api-key": API_KEY, "anthropic-beta": "managed-agents-2026-04-01" };

interface UpstreamCall { path: string; headers: IncomingHttpHeaders; body: string }

let upstream: { url: string; calls: UpstreamCall[]; server: Server };
const planes: NodeControlPlane[] = [];
const fronts: ServerType[] = [];
const dirs: string[] = [];

// Minimal ACP agent: on a prompt it calls the model through the proxy named by
// its environment and answers with a JSON report of what it saw.
const agentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  if (request.method === "initialize") return result({ protocolVersion: 1, agentCapabilities: {} });
  if (request.method === "session/new") return result({ sessionId: "proxy-acp-session" });
  if (request.method !== "session/prompt") {
    return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
  (async () => {
    const env = process.env;
    const base = env.OMA_INFERENCE_BASE_URL || env.ANTHROPIC_BASE_URL;
    const token = env.OMA_INFERENCE_TOKEN || env.ANTHROPIC_AUTH_TOKEN;
    const model = env.OMA_MODEL || env.ANTHROPIC_MODEL;
    let proxy = null;
    try {
      const response = await fetch(base + "/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "ping" }] }),
      });
      proxy = { status: response.status, body: await response.json().catch(() => null) };
    } catch (error) {
      proxy = { error: String(error) };
    }
    const report = {
      prompt: request.params.prompt.map((block) => block.text || "").join(""),
      ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL || null,
      ANTHROPIC_MODEL: env.ANTHROPIC_MODEL || null,
      ANTHROPIC_AUTH_TOKEN: env.ANTHROPIC_AUTH_TOKEN ? env.ANTHROPIC_AUTH_TOKEN.slice(0, 8) : null,
      has_ANTHROPIC_API_KEY: Object.prototype.hasOwnProperty.call(env, "ANTHROPIC_API_KEY"),
      ANTHROPIC_API_KEY_is_vault: env.ANTHROPIC_API_KEY === "sk-vault-should-not-leak",
      has_CLAUDE_CODE_OAUTH_TOKEN: Object.prototype.hasOwnProperty.call(env, "CLAUDE_CODE_OAUTH_TOKEN"),
      ANTHROPIC_API_KEY_is_old: env.ANTHROPIC_API_KEY === "sk-ant-api03-old-agent",
      GITHUB_TOKEN: env.GITHUB_TOKEN || null,
      OMA_INFERENCE_PROTOCOL: env.OMA_INFERENCE_PROTOCOL || null,
      OMA_INFERENCE_BASE_URL: env.OMA_INFERENCE_BASE_URL || null,
      OMA_INFERENCE_TOKEN: env.OMA_INFERENCE_TOKEN ? env.OMA_INFERENCE_TOKEN.slice(0, 8) : null,
      OMA_MODEL: env.OMA_MODEL || null,
      proxy,
    };
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(report) } },
      },
    });
    result({ stopReason: "end_turn" });
  })();
});
`;

beforeAll(async () => {
  const calls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ path: req.url ?? "", headers: req.headers, body });
      let model = "unknown";
      try { model = (JSON.parse(body) as { model?: string }).model ?? model; } catch { /* not JSON */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_fake", type: "message", role: "assistant", model,
        content: [{ type: "text", text: "pong" }], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 }, data: [],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstream = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server };
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
});

afterEach(async () => {
  await Promise.all(fronts.splice(0).map((front) => new Promise<void>((resolve) => front.close(() => resolve()))));
  await Promise.all(planes.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  upstream.calls.length = 0;
});

/** A control plane behind a real port, so the agent in the sandbox can call it. */
async function boot(dir: string, overrides: Record<string, string | undefined> = {}): Promise<NodeControlPlane> {
  let target: NodeControlPlane | null = null;
  const front = await new Promise<ServerType>((resolve) => {
    const server = serve(
      { fetch: (request) => target ? target.fetch(request) : new Response("starting", { status: 503 }), port: 0, hostname: "127.0.0.1" },
      () => resolve(server),
    );
  });
  fronts.push(front);
  const { port } = front.address() as AddressInfo;
  const env: Record<string, string | undefined> = {
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    API_KEY,
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    PLATFORM_ROOT_SECRET: ROOT_SECRET,
    SANDBOX_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig(env)));
  target = cp;
  planes.push(cp);
  return cp;
}

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-acp-proxy-"));
  dirs.push(dir);
  return dir;
}

async function api<T = Record<string, unknown>>(cp: NodeControlPlane, method: string, path: string, body?: unknown): Promise<T> {
  const response = await cp.fetch(new Request(`http://cp${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const text = await response.text();
  if (response.status >= 300) throw new Error(`${method} ${path} → ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

type SessionEvent = { type: string; content?: Array<{ type: string; text?: string }>; error?: { message?: string }; message?: string };

async function waitForEvent(cp: NodeControlPlane, sessionId: string, match: (event: SessionEvent) => boolean): Promise<SessionEvent> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = await api<{ data: SessionEvent[] }>(cp, "GET", `/v1/sessions/${sessionId}/events?limit=100`);
    const found = page.data.find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const page = await api<{ data: SessionEvent[] }>(cp, "GET", `/v1/sessions/${sessionId}/events?limit=100`);
  throw new Error(`no matching event; seen: ${JSON.stringify(page.data.map((event) => event.type))}`);
}

function agentScript(dir: string): string {
  const path = join(dir, "fake-acp-agent.cjs");
  writeFileSync(path, agentSource);
  return path;
}

/** An agent saved before the guard existed: its stored ACP env carries keys. */
async function plantOldAgentEnv(cp: NodeControlPlane, agentId: string, env: Record<string, string>) {
  const sql = cp.components.database.sql;
  const row = await sql.prepare("SELECT document FROM managed_agents WHERE id = ?").bind(agentId).first<{ document: string }>();
  const document = JSON.parse(row!.document) as { openma: { acp: { agent: { env?: Record<string, string> } } } };
  document.openma.acp.agent.env = { ...document.openma.acp.agent.env, ...env };
  await sql.prepare("UPDATE managed_agents SET document = ? WHERE id = ?").bind(JSON.stringify(document), agentId).run();
}

async function seed(cp: NodeControlPlane, dir: string, harness: { id: string }, oldAgentEnv?: Record<string, string>) {
  await api(cp, "POST", "/v1/oma/model_cards", {
    model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic",
    api_key: "sk-card-secret", base_url: upstream.url, is_default: true,
  });
  const vault = await api<{ id: string }>(cp, "POST", "/v1/vaults", { display_name: "acp-keys" });
  for (const [name, value] of [["ANTHROPIC_API_KEY", "sk-vault-should-not-leak"], ["GITHUB_TOKEN", "ghp_vault_github"]]) {
    await api(cp, "POST", `/v1/vaults/${vault.id}/credentials`, {
      auth: { type: "environment_variable", secret_name: name, secret_value: value, networking: { type: "unrestricted" } },
    });
  }
  const environment = await api<{ id: string }>(cp, "POST", "/v1/environments", {
    name: "acp-proxy-env", config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  const agent = await api<{ id: string }>(cp, "POST", "/v1/agents", {
    name: "acp-proxy-agent",
    model: "verify-fake",
    _oma: {
      harness: "acp-sandbox",
      acp: { agent: { id: harness.id, command: process.execPath, args: [agentScript(dir)], cwd: "/workspace" } },
    },
  });
  if (oldAgentEnv !== undefined) await plantOldAgentEnv(cp, agent.id, oldAgentEnv);
  const session = await api<{ id: string }>(cp, "POST", "/v1/sessions", {
    agent: agent.id, environment_id: environment.id, vault_ids: [vault.id],
  });
  // Creating a model card probes its upstream once; only turn calls count.
  upstream.calls.length = 0;
  return session.id;
}

async function runTurn(cp: NodeControlPlane, sessionId: string) {
  await api(cp, "POST", `/v1/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text: "проверь модель" }] }],
  });
  const message = await waitForEvent(cp, sessionId, (event) => event.type === "agent.message" || event.type === "session.error");
  expect(message.type, JSON.stringify(message)).toBe("agent.message");
  return JSON.parse(message.content!.map((block) => block.text ?? "").join("")) as Record<string, unknown>;
}

describe("acp-sandbox turn through the inference proxy", () => {
  it("gives a built-in ACP entry the proxy, never the Vault model key", async () => {
    const dir = newDir();
    const cp = await boot(dir);
    const sessionId = await seed(cp, dir, { id: "claude-acp" });
    const report = await runTurn(cp, sessionId);

    expect(report.prompt).toBe("проверь модель");
    expect(report.ANTHROPIC_BASE_URL).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/v1/oma/inference-proxy/${sessionId}/anthropic$`));
    expect(report.ANTHROPIC_AUTH_TOKEN).toBe("oma_sbx_");
    expect(report.ANTHROPIC_MODEL).toBe("verify-fake");
    expect(report.has_ANTHROPIC_API_KEY).toBe(false);
    expect(report.GITHUB_TOKEN).toBe("ghp_vault_github");
    expect(report.proxy).toMatchObject({ status: 200, body: { model: "claude-sonnet-4-6" } });

    const modelCalls = upstream.calls.filter((call) => call.path === "/v1/messages");
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]!.headers["x-api-key"]).toBe("sk-card-secret");
    expect(JSON.parse(modelCalls[0]!.body)).toMatchObject({ model: "claude-sonnet-4-6" });
    expect(JSON.stringify(modelCalls[0]!.headers)).not.toContain("oma_sbx_");
  });

  it("gives a harness card the OMA_INFERENCE_* variables", async () => {
    const dir = newDir();
    const cp = await boot(dir);
    await api(cp, "POST", "/v1/oma/harness_cards", {
      name: "Свой агент", harness_id: "fake-card", command: process.execPath,
      protocols: ["anthropic-messages"],
    });
    const sessionId = await seed(cp, dir, { id: "fake-card" });
    const report = await runTurn(cp, sessionId);

    const base = `/v1/oma/inference-proxy/${sessionId}/anthropic`;
    expect(report.OMA_INFERENCE_PROTOCOL).toBe("anthropic-messages");
    expect(report.OMA_INFERENCE_BASE_URL).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${base}$`));
    expect(report.OMA_INFERENCE_TOKEN).toBe("oma_sbx_");
    expect(report.OMA_MODEL).toBe("verify-fake");
    expect(report.ANTHROPIC_BASE_URL).toBe(report.OMA_INFERENCE_BASE_URL);
    expect(report.ANTHROPIC_API_KEY_is_vault).toBe(false);
    expect(report.proxy).toMatchObject({ status: 200, body: { model: "claude-sonnet-4-6" } });
    expect(upstream.calls.filter((call) => call.path === "/v1/messages")).toHaveLength(1);
  });

  const OLD_AGENT_KEYS = {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-old-agent",
    ANTHROPIC_API_KEY: "sk-ant-api03-old-agent",
  };

  it("keeps the model keys of an old agent snapshot out of a built-in entry turn", async () => {
    const dir = newDir();
    const cp = await boot(dir);
    const sessionId = await seed(cp, dir, { id: "claude-acp" }, OLD_AGENT_KEYS);
    const report = await runTurn(cp, sessionId);

    expect(report.has_CLAUDE_CODE_OAUTH_TOKEN).toBe(false);
    expect(report.has_ANTHROPIC_API_KEY).toBe(false);
    expect(report.ANTHROPIC_AUTH_TOKEN).toBe("oma_sbx_");
    expect(report.proxy).toMatchObject({ status: 200, body: { model: "claude-sonnet-4-6" } });
  });

  it("keeps the model keys of an old agent snapshot out of a harness card turn", async () => {
    const dir = newDir();
    const cp = await boot(dir);
    await api(cp, "POST", "/v1/oma/harness_cards", {
      name: "Свой агент", harness_id: "fake-card", command: process.execPath,
      protocols: ["anthropic-messages"],
    });
    const sessionId = await seed(cp, dir, { id: "fake-card" }, OLD_AGENT_KEYS);
    const report = await runTurn(cp, sessionId);

    expect(report.has_CLAUDE_CODE_OAUTH_TOKEN).toBe(false);
    expect(report.ANTHROPIC_API_KEY_is_old).toBe(false);
    expect(report.has_ANTHROPIC_API_KEY).toBe(false);
    expect(report.OMA_INFERENCE_TOKEN).toBe("oma_sbx_");
    expect(report.proxy).toMatchObject({ status: 200, body: { model: "claude-sonnet-4-6" } });
  });

  it("fails the turn, not the session, when the VM has no server address", async () => {
    const dir = newDir();
    const first = await boot(dir);
    const sessionId = await seed(first, dir, { id: "claude-acp" });
    await first.stop("test");
    planes.splice(planes.indexOf(first), 1);

    const cp = await boot(dir, { SANDBOX_GATEWAY_BASE_URL: undefined, PUBLIC_BASE_URL: undefined });
    await api(cp, "POST", `/v1/sessions/${sessionId}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "проверь модель" }] }],
    });
    const error = await waitForEvent(cp, sessionId, (event) => event.type === "session.error" || event.type === "agent.message");
    expect(error.type).toBe("session.error");
    expect(JSON.stringify(error)).toContain(
      "ACP-агенту нужен прокси модели: VM не знает адрес сервера: задайте SANDBOX_GATEWAY_BASE_URL",
    );
    expect(upstream.calls.filter((call) => call.path === "/v1/messages")).toEqual([]);
    const session = await api<{ status: string }>(cp, "GET", `/v1/sessions/${sessionId}`);
    expect(session.status).not.toBe("terminated");
  });
});
