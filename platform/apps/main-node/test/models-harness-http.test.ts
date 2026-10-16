// Models and harness on a booted main-node (docs/plans/models-harness.md, WIRE):
// the catalog routes, harness cards, the agent guard and the sandbox token on
// the inference proxy, all through the real HTTP stack.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import { createNodeSecrets } from "../src/secrets";
import { issueSandboxInferenceToken } from "../src/lib/sandbox-inference-token";
import { createModelsHarnessWiring, buildHarnessCardRoutesFor } from "../src/lib/models-harness-wiring";

const ROOT_SECRET = Buffer.alloc(32, 7).toString("base64");
const API_KEY = "test-static-api-key";
const created: NodeControlPlane[] = [];
const dirs: string[] = [];

interface UpstreamCall {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: { url: string; calls: UpstreamCall[]; server: Server };

beforeAll(async () => {
  const calls: UpstreamCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      let model = "unknown";
      try { model = (JSON.parse(body) as { model?: string }).model ?? model; } catch { /* not JSON */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_fake", type: "message", role: "assistant", model,
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        data: [],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  upstream = { url: `http://127.0.0.1:${port}`, calls, server };
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
});

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  upstream.calls.length = 0;
});

async function boot(overrides: Record<string, string | undefined> = {}): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-models-harness-"));
  dirs.push(dir);
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
    ANTHROPIC_API_KEY: "sk-server-unused",
    SANDBOX_GATEWAY_BASE_URL: "http://host.boxlite.internal:8795",
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig(env)));
  created.push(cp);
  return cp;
}

const headers = { "x-api-key": API_KEY, "anthropic-beta": "managed-agents-2026-04-01" };

function call(cp: NodeControlPlane, method: string, path: string, body?: unknown, extra: Record<string, string> = headers) {
  return cp.fetch(new Request(`http://cp${path}`, {
    method,
    headers: { ...extra, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function json<T = Record<string, unknown>>(response: Response | Promise<Response>): Promise<T> {
  return (await response).json() as Promise<T>;
}

async function createCard(cp: NodeControlPlane, body: Record<string, unknown>) {
  const response = await call(cp, "POST", "/v1/oma/model_cards", {
    api_key: "sk-card-secret",
    base_url: upstream.url,
    ...body,
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

function guardError(message: string | RegExp) {
  return {
    type: "error",
    error: { type: "invalid_request_error", message: typeof message === "string" ? message : expect.stringMatching(message) },
  };
}

type Entry = { id: string; source: string; status: string; reason: string | null; card_id: string | null };

describe("GET /v1/oma/harnesses", () => {
  it("returns the built-in loop and Claude Code", async () => {
    const cp = await boot();
    const response = await call(cp, "GET", "/v1/oma/harnesses");
    expect(response.status).toBe(200);
    const { data } = await json<{ data: Entry[] }>(response);
    expect(data.slice(0, 2).map((entry) => entry.id)).toEqual(["pi", "claude-acp"]);
    expect(data.find((entry) => entry.id === "claude-acp")).toMatchObject({ status: "ready", reason: null });
  });

  it("marks ACP entries unavailable when the VM has no server address", async () => {
    const cp = await boot({ SANDBOX_GATEWAY_BASE_URL: undefined, PUBLIC_BASE_URL: undefined });
    const { data } = await json<{ data: Entry[] }>(call(cp, "GET", "/v1/oma/harnesses"));
    expect(data.find((entry) => entry.id === "pi")).toMatchObject({ status: "ready" });
    expect(data.find((entry) => entry.id === "claude-acp")).toMatchObject({
      status: "unavailable",
      reason: "VM не знает адрес сервера: задайте SANDBOX_GATEWAY_BASE_URL",
    });

    const agent = await call(cp, "POST", "/v1/agents", {
      name: "cc", model: "claude-sonnet-4-6",
      _oma: { harness: "acp-sandbox", acp: { agent: { id: "claude-acp", command: "claude-agent-acp" } } },
    });
    expect(agent.status).toBe(400);
    expect(await agent.json()).toEqual(guardError(
      "Harness «Claude Code в песочнице» недоступен: VM не знает адрес сервера: задайте SANDBOX_GATEWAY_BASE_URL",
    ));
  });

  it("takes the VM address from PUBLIC_BASE_URL and needs the root secret", async () => {
    const viaPublic = await boot({ SANDBOX_GATEWAY_BASE_URL: undefined, PUBLIC_BASE_URL: "https://oma.example" });
    const ready = await json<{ data: Entry[] }>(call(viaPublic, "GET", "/v1/oma/harnesses"));
    expect(ready.data.find((entry) => entry.id === "claude-acp")?.status).toBe("ready");

    const noSecret = await boot({ PLATFORM_ROOT_SECRET: undefined });
    const blocked = await json<{ data: Entry[] }>(call(noSecret, "GET", "/v1/oma/harnesses"));
    expect(blocked.data.find((entry) => entry.id === "claude-acp")?.reason)
      .toBe("Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET");
  });
});

describe("GET /v1/oma/model_options", () => {
  it("lists the workspace card first, then the server-key models, without any key", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic", is_default: true });
    const response = await call(cp, "GET", "/v1/oma/model_options");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("sk-card-secret");
    expect(text).not.toContain("sk-server-unused");
    const body = JSON.parse(text) as { builtin_available: boolean; data: Array<Record<string, unknown>> };
    expect(body.builtin_available).toBe(true);
    expect(body.data[0]).toMatchObject({
      handle: "verify-fake",
      source: "card",
      is_default: true,
      wire_model: "claude-sonnet-4-6",
      protocols: ["anthropic-messages"],
      harnesses: expect.arrayContaining(["pi", "claude-acp"]),
    });
    expect(body.data.slice(1).every((option) => option.source === "builtin")).toBe(true);
    expect(body.data.some((option) => option.handle === "claude-sonnet-4-6")).toBe(true);
  });

  it("has no built-in models without a server key", async () => {
    const cp = await boot({ ANTHROPIC_API_KEY: undefined });
    expect(await json(call(cp, "GET", "/v1/oma/model_options"))).toEqual({ builtin_available: false, data: [] });
  });
});

describe("/v1/oma/harness_cards", () => {
  const card = {
    name: "Aider через ACP",
    harness_id: "aider-local",
    command: "aider-acp",
    args: [],
    install: { npm: [], pip: ["aider-chat==0.86.1"] },
    protocols: ["openai-chat"],
    allowed_env: ["AIDER_AUTO_COMMITS"],
  };

  it("creates, lists, changes and deletes a card, and the catalog follows", async () => {
    const cp = await boot();
    const created = await call(cp, "POST", "/v1/oma/harness_cards", card);
    expect(created.status).toBe(201);
    const saved = await created.json() as { id: string; status: string; cwd: string };
    expect(saved).toMatchObject({ harness_id: "aider-local", status: "unverified", cwd: "/mnt/session/outputs" });
    expect(saved.id).toMatch(/^hcard_[A-Za-z0-9]{16}$/);

    const catalog = await json<{ data: Entry[] }>(call(cp, "GET", "/v1/oma/harnesses"));
    expect(catalog.data.at(-1)).toMatchObject({ id: "aider-local", source: "card", status: "unverified", card_id: saved.id });

    const again = await call(cp, "POST", "/v1/oma/harness_cards", card);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "Harness с ID «aider-local» уже есть", field: "harness_id" });

    const withValues = await call(cp, "POST", "/v1/oma/harness_cards", { ...card, harness_id: "other", env: { X: "sk-value-secret" } });
    expect(withValues.status).toBe(400);
    const problem = await withValues.json() as { error: string; field: string };
    expect(problem.field).toBe("env");
    expect(JSON.stringify(problem)).not.toContain("sk-value-secret");

    const renamed = await call(cp, "POST", `/v1/oma/harness_cards/${saved.id}`, { name: "Aider" });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "Aider", harness_id: "aider-local" });
    expect((await call(cp, "POST", `/v1/oma/harness_cards/${saved.id}`, { harness_id: "renamed" })).status).toBe(400);

    const page = await json<{ data: Array<{ id: string }>; next_cursor: string | null }>(call(cp, "GET", "/v1/oma/harness_cards?q=AIDER"));
    expect(page).toEqual({ data: [expect.objectContaining({ id: saved.id })], next_cursor: null });

    expect(await json(call(cp, "DELETE", `/v1/oma/harness_cards/${saved.id}`))).toEqual({ type: "harness_card_deleted", id: saved.id });
    const after = await json<{ data: Entry[] }>(call(cp, "GET", "/v1/oma/harnesses"));
    expect(after.data.some((entry) => entry.id === "aider-local")).toBe(false);
    expect(await json(call(cp, "GET", `/v1/oma/harness_cards/${saved.id}`))).toMatchObject({ archived_at: expect.any(String) });
    expect((await call(cp, "POST", "/v1/oma/harness_cards", card)).status).toBe(409);
    const archivedEdit = await call(cp, "POST", `/v1/oma/harness_cards/${saved.id}`, { name: "Снова" });
    expect(archivedEdit.status).toBe(409);
    expect((await call(cp, "GET", "/v1/oma/harness_cards/hcard_missing")).status).toBe(404);
  });

  it("is closed to anonymous calls", async () => {
    const cp = await boot();
    expect((await call(cp, "GET", "/v1/oma/harness_cards", undefined, {})).status).toBe(401);
  });

  it("answers 501 on MySQL, where the catalog has no cards", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const config = loadNodeConfig({ NODE_ENV: "test", PLATFORM_ROOT_SECRET: ROOT_SECRET });
    const wiring = createModelsHarnessWiring({
      config,
      sql,
      dialect: "mysql",
      modelCards: { list: async () => [] },
    });
    expect(wiring.cardStore).toBeNull();
    const routes = buildHarnessCardRoutesFor(wiring);
    const response = await routes.request("/", { method: "GET" });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "Свои harness на MySQL не поддерживаются", field: null });
    expect((await wiring.catalog.harnesses("ws")).every((entry) => entry.source === "builtin")).toBe(true);
  });
});

describe("agent guard on /v1/agents", () => {
  const claude = (extra: Record<string, unknown> = {}, env?: Record<string, string>) => ({
    harness: "acp-sandbox",
    acp: { agent: { id: "claude-acp", command: "sh", args: ["-c", "exec claude-agent-acp"], ...(env ? { env } : {}), ...extra } },
  });

  it("rejects every case of table 4.3 with its text", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic", is_default: true });
    await createCard(cp, { model_id: "verify-oai", model: "gpt-4.1", provider: "openai" });
    await createCard(cp, { model_id: "verify-plain", model: "vendor/unknown-model", provider: "openrouter" });
    const cases: Array<[unknown, string | RegExp]> = [
      [{ model: "verify-fake", _oma: { harness: "acp-proxy" } }, "acp-proxy на этом сервере не работает. Выберите harness из GET /v1/oma/harnesses"],
      [{ model: "verify-fake", _oma: { harness: "ai-sdk" } }, "Harness ai-sdk устарел. Выберите встроенный цикл или ACP-агента из каталога"],
      [{ model: "verify-fake", _oma: { harness: "foo" } }, "Неизвестный harness «foo»"],
      [{ model: "verify-fake", _oma: { harness: "acp-sandbox", acp: { agent: { id: "claude-acp" } } } }, "Для acp-sandbox задайте _oma.acp.agent.command"],
      [{ model: "verify-fake", _oma: { harness: "acp-sandbox", acp: { agent: { id: "nope", command: "x" } } } }, "Harness «nope» не найден. Выберите вариант из GET /v1/oma/harnesses"],
      [{ model: "missing-model" }, "Модель «missing-model» не найдена. Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY"],
      [{ model: "verify-oai", _oma: claude() }, /^Модель «verify-oai» не подходит для «Claude Code в песочнице»: нужен протокол anthropic-messages, у модели openai-chat/],
      [{ model: { id: "verify-fake", effort: "high" }, _oma: claude() }, "Claude Code в песочнице не принимает усилие: уберите model.effort"],
      [{ model: { id: "verify-fake", speed: "fast" }, _oma: claude() }, "Claude Code в песочнице не принимает скорость: уберите model.speed"],
      [{ model: { id: "verify-plain", effort: "max" } }, "Модель «verify-plain» не поддерживает усилие"],
      [{ model: { id: "verify-plain", speed: "fast" } }, "Модель «verify-plain» не поддерживает быструю скорость"],
      [{ model: "verify-fake", _oma: claude({}, { ANTHROPIC_BASE_URL: "http://elsewhere" }) }, "Переменную «ANTHROPIC_BASE_URL» задаёт сервер, уберите её из env агента"],
      [{ model: "verify-fake", _oma: claude({}, { GITHUB_TOKEN: "x" }) }, "Переменная «GITHUB_TOKEN» похожа на секрет. Ключи в env агента не кладите: модель подключается через прокси сервера"],
    ];
    for (const [body, message] of cases) {
      const response = await call(cp, "POST", "/v1/agents", { name: "guarded", ...(body as object) });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json(), JSON.stringify(body)).toEqual(guardError(message));
    }
  });

  it("passes the W4 recipe and a model handle string, and checks updates by the merged config", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic", is_default: true });
    const { data } = await json<{ data: Array<Entry & { acp: unknown }> }>(call(cp, "GET", "/v1/oma/harnesses"));
    const recipe = data.find((entry) => entry.id === "claude-acp")!.acp;

    const acpAgent = await call(cp, "POST", "/v1/agents", { name: "cc", model: "verify-fake", _oma: { harness: "acp-sandbox", acp: recipe } });
    expect(acpAgent.status).toBeLessThan(300);
    const { id } = await acpAgent.json() as { id: string };
    const plain = await call(cp, "POST", "/v1/agents", { name: "plain", model: "claude-sonnet-4-6" });
    expect(plain.status).toBeLessThan(300);

    const version = (await json<{ version: number }>(call(cp, "GET", `/v1/agents/${id}`))).version;
    const toOai = await call(cp, "POST", `/v1/agents/${id}`, { version, model: { id: "verify-fake", effort: "high" } });
    expect(toOai.status).toBe(400);
    expect(await toOai.json()).toEqual(guardError("Claude Code в песочнице не принимает усилие: уберите model.effort"));
    const renamed = await call(cp, "POST", `/v1/agents/${id}`, { version, name: "cc-renamed" });
    expect(renamed.status).toBeLessThan(300);
    expect(await renamed.json()).toMatchObject({ name: "cc-renamed" });
    expect((await call(cp, "POST", `/v1/agents/${id}/archive`, {})).status).toBeLessThan(300);
  });

  it("lets the console form rename an agent whose harness card was deleted", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-oai", model: "gpt-4.1", provider: "openai", is_default: true });
    const card = await json<{ id: string }>(call(cp, "POST", "/v1/oma/harness_cards", {
      name: "Aider через ACP", harness_id: "aider-local", command: "aider-acp", protocols: ["openai-chat"],
    }));
    const created = await call(cp, "POST", "/v1/agents", {
      name: "aider", model: "verify-oai",
      _oma: { harness: "acp-sandbox", acp: { agent: { id: "aider-local", command: "aider-acp", args: [] } } },
    });
    expect(created.status).toBeLessThan(300);
    const { id } = await created.json() as { id: string };
    expect((await call(cp, "DELETE", `/v1/oma/harness_cards/${card.id}`)).status).toBe(200);

    // The form sends the stored model and the whole _oma block with every save.
    type Stored = { version: number; model: unknown; _oma: { harness: string; acp: { agent: Record<string, unknown> } } };
    const stored = await json<Stored>(call(cp, "GET", `/v1/agents/${id}`));
    const renamed = await call(cp, "POST", `/v1/agents/${id}`, {
      version: stored.version, name: "aider-renamed", model: stored.model,
      _oma: { harness: stored._oma.harness, acp: stored._oma.acp },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: "aider-renamed" });

    const after = await json<Stored>(call(cp, "GET", `/v1/agents/${id}`));
    const withEnv = await call(cp, "POST", `/v1/agents/${id}`, {
      version: after.version, model: after.model,
      _oma: { acp: { ...after._oma.acp, agent: { ...after._oma.acp.agent, env: { AIDER_AUTO_COMMITS: "false" } } } },
    });
    expect(withEnv.status).toBe(400);
    expect(await withEnv.json()).toEqual(guardError("Harness «aider-local» не найден. Выберите вариант из GET /v1/oma/harnesses"));
  });
});

describe("sandbox inference token", () => {
  it("opens only the inference proxy of its own session, which sends the card key and wire model", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic", is_default: true });
    const environment = await json<{ id: string }>(call(cp, "POST", "/v1/environments", {
      name: "token-env", config: { type: "cloud", networking: { type: "unrestricted" } },
    }));
    const agent = await json<{ id: string }>(call(cp, "POST", "/v1/agents", { name: "token-agent", model: "verify-fake" }));
    const session = await json<{ id: string }>(call(cp, "POST", "/v1/sessions", { agent: agent.id, environment_id: environment.id }));
    const other = await json<{ id: string }>(call(cp, "POST", "/v1/sessions", { agent: agent.id, environment_id: environment.id }));
    expect(session.id).toBeTruthy();
    upstream.calls.length = 0;

    const cipher = createNodeSecrets(ROOT_SECRET).cipherFor("managed.sandbox-inference");
    const token = await issueSandboxInferenceToken({ cipher, workspaceId: "default", sessionId: session.id, ttlMs: 60_000 });
    const bearer = { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" };
    const message = { model: "verify-fake", max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

    expect((await call(cp, "GET", "/v1/agents", undefined, bearer)).status).toBe(403);
    expect((await call(cp, "GET", "/v1/oma/harness_cards", undefined, bearer)).status).toBe(403);
    expect((await call(cp, "POST", `/v1/oma/inference-proxy/${other.id}/anthropic/v1/messages`, message, bearer)).status).toBe(403);
    expect(upstream.calls).toEqual([]);

    const proxied = await call(cp, "POST", `/v1/oma/inference-proxy/${session.id}/anthropic/v1/messages`, message, bearer);
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toMatchObject({ model: "claude-sonnet-4-6" });
    expect(upstream.calls).toHaveLength(1);
    const [forwarded] = upstream.calls;
    expect(forwarded!.path).toBe("/v1/messages");
    expect(forwarded!.headers["x-api-key"]).toBe("sk-card-secret");
    expect(JSON.stringify(forwarded!.headers)).not.toContain(token);
    expect(JSON.parse(forwarded!.body)).toMatchObject({ model: "claude-sonnet-4-6", max_tokens: 16 });

    // The token reaches model calls only, not the rest of the provider API.
    for (const [method, path] of [
      ["GET", "anthropic/v1/files"],
      ["DELETE", "anthropic/v1/files/file_other_session"],
      ["POST", "anthropic/v1/messages/batches"],
    ] as const) {
      const response = await call(cp, method, `/v1/oma/inference-proxy/${session.id}/${path}`, method === "POST" ? message : undefined, bearer);
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect(upstream.calls).toHaveLength(1);

    const expired = await issueSandboxInferenceToken({ cipher, workspaceId: "default", sessionId: session.id, ttlMs: 1, now: Date.now() - 10_000 });
    expect((await call(cp, "POST", `/v1/oma/inference-proxy/${session.id}/anthropic/v1/messages`, message, {
      authorization: `Bearer ${expired}`,
    })).status).toBe(401);
  });
});
