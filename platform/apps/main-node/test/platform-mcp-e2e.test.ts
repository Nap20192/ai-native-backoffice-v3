// End-to-end test of the assistant (docs/plans/builder-agent.md, BS3).
//
// A real Node control plane with sign-in, the real routes on SQLite, the
// real runner and harness, and a scripted model that speaks the Anthropic
// Messages protocol. The assistant proposes writes, the session stops with
// `requires_action`, the console previews and confirms through the card
// routes, and the runner executes the call through the platform MCP server.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { SandboxExecutor, SandboxFactory } from "@open-managed-agents/sandbox";

import { loadNodeConfig } from "../src/config";
import { nodeDefaults } from "../src/components";
import { Disposables } from "../src/lifecycle";
import { mountNodeHttp } from "../src/modules/node-http";
import { createNodeRuntime } from "../src/modules/node-runtime";

const BASE = "http://localhost:8080";
const MODEL = "claude-sonnet-4-6";
const BETA = "managed-agents-2026-04-01,files-api-2025-04-14,skills-2025-10-02,agent-memory-2026-07-22";

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: Record<string, unknown> };

interface ToolResultSeen {
  id: string;
  text: string;
  isError: boolean;
}

type Step = (results: ToolResultSeen[]) => Block[];

// ---------- scripted model ----------

const steps = new Map<string, Step>();
const modelRequests: Array<Record<string, any>> = [];
let toolCounter = 0;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: any) => (block?.type === "text" ? String(block.text ?? "") : "")).join("");
}

function decide(input: Record<string, any>): Block[] {
  const messages: any[] = Array.isArray(input.messages) ? input.messages : [];
  let markerIndex = -1;
  let key = "";
  messages.forEach((message, index) => {
    if (message?.role !== "user") return;
    const match = /E2E:([a-z0-9_-]+)/.exec(textOf(message.content));
    if (match) {
      markerIndex = index;
      key = match[1]!;
    }
  });
  if (markerIndex === -1) return [{ type: "text", text: "FAKE_NO_MARKER" }];
  const results: ToolResultSeen[] = [];
  for (const message of messages.slice(markerIndex + 1)) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "tool_result") continue;
      results.push({ id: String(block.tool_use_id), text: textOf(block.content), isError: block.is_error === true });
    }
  }
  const step = steps.get(key);
  if (!step) return [{ type: "text", text: `FAKE_UNKNOWN_${key}` }];
  return step(results);
}

function sse(blocks: Block[], requestNumber: number): string {
  const calling = blocks.some((block) => block.type === "tool_use");
  const events: unknown[] = [
    { type: "message_start", message: { id: `msg_e2e_${requestNumber}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else {
      toolCounter += 1;
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_e2e_${toolCounter}`, name: block.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({ type: "message_delta", delta: { stop_reason: calling ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  events.push({ type: "message_stop" });
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

let modelServer: Server | null = null;

async function startModel(): Promise<string> {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    let input: Record<string, any> = {};
    try {
      input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      input = {};
    }
    modelRequests.push(input);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sse(decide(input), modelRequests.length));
  });
  await new Promise<void>((resolve) => modelServer!.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

// ---------- control plane ----------

const dir = mkdtempSync(join(tmpdir(), "oma-platform-mcp-e2e-"));
const disposables = new Disposables();
let runtime: Awaited<ReturnType<typeof createNodeRuntime>>;
let appFetch: (request: Request) => Response | Promise<Response>;
let cookie = "";
let userId = "";
let workspaceId = "";
let platformUrl = "";
let assistantSessionId = "";
const innerCalls: Array<{ method: string; path: string }> = [];

const fakeSandbox: SandboxFactory = async () => {
  const sandbox: SandboxExecutor & {
    sessionOutputMountCapabilities(): { durability: "durable" };
    mountSessionOutputs(): Promise<void>;
  } = {
    exec: async () => "",
    readFile: async () => {
      throw new Error("no file");
    },
    writeFile: async (path) => path,
    setEnvVars: async () => {},
    sessionOutputMountCapabilities: () => ({ durability: "durable" }),
    mountSessionOutputs: async () => {},
  };
  return sandbox;
};

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, origin: BASE, "anthropic-beta": BETA, ...extra };
}

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return appFetch(
    new Request(`${BASE}${path}`, {
      method,
      headers: headers(body === undefined ? extra : { "content-type": "application/json", ...extra }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function ok<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const response = await call(method, path, body, extra);
  const text = await response.text();
  expect(response.status, `${method} ${path}: ${text}`).toBeLessThan(300);
  return (text ? JSON.parse(text) : null) as T;
}

async function events(sessionId: string): Promise<any[]> {
  const all: any[] = [];
  let page: string | null = null;
  do {
    const query: string = `limit=100&order=asc${page ? `&page=${encodeURIComponent(page)}` : ""}`;
    const body: { data: any[]; next_page: string | null } = await ok("GET", `/v1/sessions/${sessionId}/events?${query}`);
    all.push(...body.data);
    page = body.next_page;
  } while (page);
  return all;
}

async function waitFor<T>(what: string, ...rest: [() => Promise<T | undefined>] | [() => Promise<string>, () => Promise<T | undefined>]): Promise<T> {
  const probe = rest.length === 1 ? rest[0] : rest[1];
  const detail = rest.length === 2 ? rest[0] : async () => "";
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${what}; ${await detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The first `session.status_idle` after the event with this id. */
async function idleAfter(sessionId: string, eventId: string): Promise<{ stop: any; all: any[] }> {
  const tail = async () => (await events(sessionId)).slice(-6).map((event) => `${event.type}${event.stop_reason ? JSON.stringify(event.stop_reason) : ""}${event.error ? JSON.stringify(event.error) : ""}`).join(" | ") + ` || model requests ${modelRequests.length}: ${JSON.stringify(modelRequests.at(-1)?.messages?.at(-1)).slice(0, 300)}`;
  return waitFor(`idle after ${eventId}`, tail, async () => {
    const all = await events(sessionId);
    const start = all.findIndex((event) => event.id === eventId);
    if (start === -1) return undefined;
    const idle = all.slice(start + 1).find((event) => event.type === "session.status_idle");
    return idle ? { stop: idle.stop_reason, all } : undefined;
  });
}

async function say(sessionId: string, text: string): Promise<{ stop: any; all: any[]; eventId: string }> {
  const sent = await ok<{ data: Array<{ id: string }> }>("POST", `/v1/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  const eventId = sent.data[0]!.id;
  return { ...(await idleAfter(sessionId, eventId)), eventId };
}

async function preview(toolUseId: string, sessionId = assistantSessionId): Promise<any> {
  return ok("POST", "/v1/oma/platform-mcp/preview", { session_id: sessionId, tool_use_id: toolUseId });
}

/** Preview, confirm with the digest of the card and wait for the next idle. */
async function confirm(toolUseId: string): Promise<{ result: any; stop: any; all: any[] }> {
  const card = await preview(toolUseId);
  const response = await call("POST", "/v1/oma/platform-mcp/confirm", {
    session_id: assistantSessionId,
    tool_use_id: toolUseId,
    result: "allow",
    preview_digest: card.preview_digest,
  });
  const body = await response.json() as any;
  expect(response.status, JSON.stringify(body)).toBe(200);
  const all = await waitFor(`result of ${toolUseId}`, async () => {
    const list = await events(assistantSessionId);
    const resultIndex = list.findIndex((event) => event.type === "agent.mcp_tool_result" && event.mcp_tool_use_id === toolUseId);
    if (resultIndex === -1) return undefined;
    return list.slice(resultIndex).some((event) => event.type === "session.status_idle") ? list : undefined;
  });
  const resultIndex = all.findIndex((event) => event.type === "agent.mcp_tool_result" && event.mcp_tool_use_id === toolUseId);
  const result = all[resultIndex];
  const stop = all.slice(resultIndex).find((event) => event.type === "session.status_idle")!.stop_reason;
  return { result, stop, all };
}

/** The console denies the call; the runner answers the model and the turn goes on. */
async function deny(toolUseId: string): Promise<void> {
  await ok("POST", "/v1/oma/platform-mcp/confirm", { session_id: assistantSessionId, tool_use_id: toolUseId, result: "deny" });
  await waitFor(`denial of ${toolUseId}`, async () => {
    const list = await events(assistantSessionId);
    const index = list.findIndex((event) => event.type === "agent.mcp_tool_result" && event.mcp_tool_use_id === toolUseId);
    return index !== -1 && list.slice(index).some((event) => event.type === "session.status_idle") ? true : undefined;
  });
}

function resultText(result: any): string {
  return textOf(result?.content);
}

/** One proposed call: the model asks for it, the console confirms it. */
async function proposeAndRun(key: string, tool: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean; toolUseId: string }> {
  steps.set(key, (results) => (results.length === 0 ? [{ type: "tool_use", name: `mcp__platform__${tool}`, input }] : [{ type: "text", text: `done ${key}` }]));
  const asked = await say(assistantSessionId, `E2E:${key}`);
  expect(asked.stop).toMatchObject({ type: "requires_action" });
  const toolUseId = asked.stop.event_ids[0] as string;
  const done = await confirm(toolUseId);
  return { text: resultText(done.result), isError: done.result.is_error === true, toolUseId };
}

async function actionRows(toolUseId: string): Promise<any[]> {
  const page = await ok<{ actions: any[] }>("GET", `/v1/oma/platform-mcp/actions?session_id=${assistantSessionId}&limit=200`);
  return page.actions.filter((row) => row.tool_use_id === toolUseId).sort((a, b) => a.op_index - b.op_index);
}

beforeAll(async () => {
  const modelUrl = await startModel();
  const config = loadNodeConfig({
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    PUBLIC_BASE_URL: BASE,
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    PLATFORM_ROOT_SECRET: Buffer.alloc(32, 9).toString("base64"),
    ANTHROPIC_API_KEY: "local-test-model-key",
    ANTHROPIC_BASE_URL: modelUrl,
    OMA_BUILTIN_SKILLS_DIR: "off",
  });
  const components = await nodeDefaults(config, { sandbox: fakeSandbox });
  runtime = await createNodeRuntime(components, disposables, { current: null });
  const app = await mountNodeHttp(runtime, disposables);
  appFetch = (request) => app.fetch(request);
  // Count the nested requests of the server: they go through app.fetch.
  runtime.platformMcp.bindApp(async (request) => {
    innerCalls.push({ method: request.method, path: new URL(request.url).pathname });
    return app.fetch(request);
  });

  const signUp = await appFetch(new Request(`${BASE}/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "owner@e2e.test", password: "password-123456", name: "Анна" }),
  }));
  expect(signUp.status).toBe(200);
  cookie = signUp.headers.getSetCookie().map((value) => value.split(";")[0]!).join("; ");
  const me = await ok<{ user: { id: string }; tenant: { id: string } }>("GET", "/v1/oma/me");
  userId = me.user.id;
  workspaceId = me.tenant.id;

  // Install the assistant the way the console does: bundle, environment, agent.
  const bundle = await ok<any>("GET", `/v1/oma/platform-mcp/builder-bundle?model=${MODEL}`);
  platformUrl = bundle.agent.mcp_servers[0].url;
  const environment = await ok<{ id: string }>("POST", "/v1/environments", bundle.environment);
  const agent = await ok<{ id: string }>("POST", "/v1/agents", bundle.agent);
  const session = await ok<{ id: string }>("POST", "/v1/sessions", { agent: agent.id, environment_id: environment.id });
  assistantSessionId = session.id;
}, 60_000);

afterEach(() => {
  runtime.platformMcp.hooks.afterConfirm = undefined;
  runtime.platformMcp.hooks.afterDigestCheck = undefined;
});

afterAll(async () => {
  await disposables.dispose();
  await new Promise<void>((resolve) => (modelServer ? modelServer.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("platform MCP end to end", () => {
  it("serves the platform URL from the config and records the owner of the assistant session", async () => {
    expect(platformUrl).toBe(`${BASE}/v1/oma/platform-mcp`);
    await expect(runtime.platformMcp.deps.owners.ownerOf(workspaceId, assistantSessionId)).resolves.toMatchObject({ userId });
  });

  it("a batch creates an environment, an agent and an idle session; send_message starts the agent there", async () => {
    steps.set("batch", (results) =>
      results.length === 0
        ? [{
            type: "tool_use",
            name: "mcp__platform__apply_changes",
            input: {
              title: "Рабочее место",
              operations: [
                { ref: "env", tool: "create_environment", args: { config: { name: "E2E env", config: { type: "cloud", networking: { type: "unrestricted" } } } } },
                { ref: "agent", tool: "create_agent", args: { config: { name: "E2E worker", model: MODEL, system: "Ты рабочий агент." } } },
                { ref: "sess", tool: "create_session", args: { agent: { id: "$ref:agent" }, environment_id: "$ref:env", title: "E2E target" } },
              ],
            },
          }]
        : [{ type: "text", text: "Готово: окружение, агент и сессия." }],
    );
    const asked = await say(assistantSessionId, "E2E:batch");
    expect(asked.stop).toMatchObject({ type: "requires_action" });
    expect(asked.stop.event_ids).toHaveLength(1);
    const use = asked.all.find((event) => event.id === asked.stop.event_ids[0]);
    expect(use).toMatchObject({ type: "agent.mcp_tool_use", evaluated_permission: "ask", name: "mcp__platform__apply_changes", mcp_server_name: "platform" });

    const card = await preview(use.id);
    expect(card.operations).toHaveLength(3);
    expect(card.can_confirm).toBe(true);

    innerCalls.length = 0;
    const done = await confirm(use.id);
    expect(done.result.is_error ?? false, resultText(done.result)).toBe(false);
    expect(resultText(done.result)).toContain("Пачка выполнена");
    expect(done.stop).toMatchObject({ type: "end_turn" });
    expect(done.all.some((event) => event.type === "agent.message" && textOf(event.content).includes("Готово"))).toBe(true);
    expect(innerCalls.filter((entry) => entry.method === "POST" && entry.path === "/v1/sessions")).toHaveLength(1);

    const rows = await actionRows(use.id);
    expect(rows.map((row) => [row.tool, row.result])).toEqual([
      ["create_environment", "ok"],
      ["create_agent", "ok"],
      ["create_session", "ok"],
    ]);
    const targetSessionId = rows[2].target_id as string;
    const target = await ok<any>("GET", `/v1/sessions/${targetSessionId}`);
    expect(target).toMatchObject({
      status: "idle",
      title: "E2E target",
      agent: { id: rows[1].target_id, version: 1 },
      environment_id: rows[0].target_id,
      metadata: { oma_created_via: "assistant", oma_assistant_session: assistantSessionId },
    });
    expect((await events(targetSessionId)).filter((event) => String(event.type).startsWith("user."))).toEqual([]);
    await expect(runtime.platformMcp.deps.owners.ownerOf(workspaceId, targetSessionId)).resolves.toMatchObject({ userId });

    // The first message goes on its own card in the next turn.
    steps.set("target", () => [{ type: "text", text: "TARGET_DONE" }]);
    const sent = await proposeAndRun("send", "send_message", { session_id: targetSessionId, text: "E2E:target привет" });
    expect(sent.isError, sent.text).toBe(false);
    const targetEvents = await waitFor("target turn", async () => {
      const list = await events(targetSessionId);
      return list.some((event) => event.type === "session.status_idle") ? list : undefined;
    });
    expect(targetEvents.filter((event) => event.type === "user.message")).toHaveLength(1);
    expect(targetEvents.some((event) => event.type === "agent.message" && textOf(event.content) === "TARGET_DONE")).toBe(true);

    // A second message into the same session is out of v1: the card refuses it.
    steps.set("send2", (results) =>
      results.length === 0
        ? [{ type: "tool_use", name: "mcp__platform__send_message", input: { session_id: targetSessionId, text: "ещё" } }]
        : [{ type: "text", text: "понял" }],
    );
    const again = await say(assistantSessionId, "E2E:send2");
    const againId = again.stop.event_ids[0] as string;
    expect(await preview(againId)).toMatchObject({ class: "out_of_v1" });
    const refused = await call("POST", "/v1/oma/platform-mcp/confirm", { session_id: assistantSessionId, tool_use_id: againId, result: "allow", preview_digest: "x" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as any).error.type).toBe("class");
    await deny(againId);
    expect((await events(targetSessionId)).filter((event) => event.type === "user.message")).toHaveLength(1);
  });

  it("two confirmed calls in one turn both run", async () => {
    steps.set("two", (results) =>
      results.length === 0
        ? [
            { type: "tool_use", name: "mcp__platform__create_memory_store", input: { name: "E2E store one" } },
            { type: "tool_use", name: "mcp__platform__create_memory_store", input: { name: "E2E store two" } },
          ]
        : [{ type: "text", text: `two results ${results.length}` }],
    );
    const asked = await say(assistantSessionId, "E2E:two");
    expect(asked.stop).toMatchObject({ type: "requires_action" });
    const [first, second] = asked.stop.event_ids as string[];
    expect(second).toBeDefined();

    const one = await confirm(first!);
    expect(one.result.is_error ?? false, resultText(one.result)).toBe(false);
    expect(one.stop).toEqual({ type: "requires_action", event_ids: [second] });

    const two = await confirm(second!);
    expect(two.result.is_error ?? false, resultText(two.result)).toBe(false);
    expect(two.stop).toMatchObject({ type: "end_turn" });
    expect(two.all.some((event) => event.type === "agent.message" && textOf(event.content) === "two results 2")).toBe(true);

    const stores = await ok<{ data: Array<{ name: string }> }>("GET", "/v1/memory_stores?limit=100");
    expect(stores.data.map((store) => store.name)).toEqual(expect.arrayContaining(["E2E store one", "E2E store two"]));
  });

  it("a second member of the workspace gets the preview without the buttons; confirm is refused", async () => {
    const signUp = await appFetch(new Request(`${BASE}/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "member@e2e.test", password: "password-123456", name: "Борис" }),
    }));
    expect(signUp.status).toBe(200);
    const memberCookie = signUp.headers.getSetCookie().map((value) => value.split(";")[0]!).join("; ");
    const invite = await ok<{ token: string }>("POST", `/v1/oma/tenants/${workspaceId}/invitations`, { role: "member" });
    const accepted = await appFetch(new Request(`${BASE}/v1/oma/tenants/invitations/accept`, {
      method: "POST",
      headers: { cookie: memberCookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ token: invite.token }),
    }));
    expect(accepted.status).toBe(200);
    const asMember = (path: string, body: unknown) => appFetch(new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { cookie: memberCookie, origin: BASE, "anthropic-beta": BETA, "x-active-tenant": workspaceId, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    steps.set("member", (results) => (results.length === 0 ? [{ type: "tool_use", name: "mcp__platform__create_memory_store", input: { name: "E2E member store" } }] : [{ type: "text", text: "ok" }]));
    const asked = await say(assistantSessionId, "E2E:member");
    const toolUseId = asked.stop.event_ids[0] as string;
    const owner = await preview(toolUseId);

    const seen = await asMember("/v1/oma/platform-mcp/preview", { session_id: assistantSessionId, tool_use_id: toolUseId });
    const body = await seen.json() as any;
    expect(seen.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ can_confirm: false, owner_name: "Анна", pending: true });
    expect(body.preview_digest).toBe(owner.preview_digest);

    const refused = await asMember("/v1/oma/platform-mcp/confirm", { session_id: assistantSessionId, tool_use_id: toolUseId, result: "allow", preview_digest: owner.preview_digest });
    expect(refused.status).toBe(403);
    await deny(toolUseId);
  });

  it("a session with bash gets no platform tools", async () => {
    const environment = await ok<{ id: string }>("POST", "/v1/environments", { name: "E2E bash env", config: { type: "cloud", networking: { type: "unrestricted" } } });
    const agent = await ok<{ id: string }>("POST", "/v1/agents", {
      name: "E2E bash assistant",
      model: MODEL,
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "mcp_toolset", mcp_server_name: "platform" },
      ],
      mcp_servers: [{ type: "url", name: "platform", url: platformUrl }],
    });
    const session = await ok<{ id: string }>("POST", "/v1/sessions", { agent: agent.id, environment_id: environment.id });
    steps.set("bash", () => [{ type: "text", text: "bash probe" }]);
    const before = modelRequests.length;
    const done = await say(session.id, "E2E:bash");
    expect(done.stop).toMatchObject({ type: "end_turn" });
    const names = modelRequests.slice(before).flatMap((request) => (request.tools ?? []).map((tool: any) => String(tool.name)));
    expect(names).toContain("bash");
    expect(names.filter((name) => name.startsWith("mcp__platform__"))).toEqual([]);
    // The refused platform server shows up in the session, not only in the server log (6.3).
    const warning = done.all.find((event) => event.type === "session.warning");
    expect(warning?.message).toContain('MCP setup failed for "platform"');
  });

  it("an object changed between confirm and execution gives refused_stale and no write", async () => {
    const environment = await ok<{ id: string }>("POST", "/v1/environments", { name: "E2E stale env", config: { type: "cloud", networking: { type: "unrestricted" } } });
    runtime.platformMcp.hooks.afterConfirm = async () => {
      await ok("POST", `/v1/environments/${environment.id}`, { description: "правка третьего лица" });
    };
    const run = await proposeAndRun("stale", "update_environment", { environment_id: environment.id, changes: { description: "правка ассистента" } });
    expect(run.isError).toBe(true);
    expect(run.text).toContain("Объект изменился после подтверждения");
    expect(await ok<any>("GET", `/v1/environments/${environment.id}`)).toMatchObject({ description: "правка третьего лица" });
    expect((await actionRows(run.toolUseId)).map((row) => row.result)).toEqual(["refused_stale"]);
  });

  it("a class that grew between confirm and execution gives refused_class and no write", async () => {
    const store = await ok<{ id: string }>("POST", "/v1/memory_stores", { name: "E2E class store" });
    runtime.platformMcp.hooks.afterConfirm = async () => {
      await ok("POST", `/v1/memory_stores/${store.id}/memories`, { path: "/notes/a.md", content: "третье лицо" });
    };
    const run = await proposeAndRun("cls", "write_memory", { memory_store_id: store.id, path: "/notes/a.md", content: "ассистент" });
    expect(run.isError).toBe(true);
    expect(run.text).toContain("Операция стала опаснее");
    const list = await ok<{ data: Array<{ id: string; path: string }> }>("GET", `/v1/memory_stores/${store.id}/memories?limit=10`);
    const memory = await ok<any>("GET", `/v1/memory_stores/${store.id}/memories/${list.data[0]!.id}`);
    expect(memory.content).toBe("третье лицо");
    expect((await actionRows(run.toolUseId)).map((row) => row.result)).toEqual(["refused_class"]);
  });

  describe("a write after the last digest check reaches the real route with the confirmed revision", () => {
    it("environment: 412 and no assistant write", async () => {
      const environment = await ok<{ id: string }>("POST", "/v1/environments", { name: "E2E late env", config: { type: "cloud", networking: { type: "unrestricted" } } });
      runtime.platformMcp.hooks.afterDigestCheck = async () => {
        await ok("POST", `/v1/environments/${environment.id}`, { description: "поздняя правка" });
      };
      const run = await proposeAndRun("late_env", "update_environment", { environment_id: environment.id, changes: { description: "ассистент" } });
      expect(run.isError).toBe(true);
      expect(await ok<any>("GET", `/v1/environments/${environment.id}`)).toMatchObject({ description: "поздняя правка" });
      expect((await actionRows(run.toolUseId)).map((row) => row.result)).toEqual(["refused_stale"]);
    });

    it("paused deployment: 412 and no assistant write", async () => {
      const environment = await ok<{ id: string }>("POST", "/v1/environments", { name: "E2E deploy env", config: { type: "cloud", networking: { type: "unrestricted" } } });
      const agent = await ok<{ id: string }>("POST", "/v1/agents", { name: "E2E deploy agent", model: MODEL });
      const deployment = await ok<{ id: string; status: string }>("POST", "/v1/deployments", {
        name: "E2E paused",
        agent: { type: "agent", id: agent.id },
        environment_id: environment.id,
        initial_events: [{ type: "user.message", content: [{ type: "text", text: "go" }] }],
        _oma: { paused: true },
      });
      expect(deployment.status).toBe("paused");
      runtime.platformMcp.hooks.afterDigestCheck = async () => {
        await ok("POST", `/v1/deployments/${deployment.id}`, { name: "Поздняя правка" });
      };
      const run = await proposeAndRun("late_dep", "update_deployment", { deployment_id: deployment.id, changes: { name: "Ассистент" } });
      expect(run.isError).toBe(true);
      expect(await ok<any>("GET", `/v1/deployments/${deployment.id}`)).toMatchObject({ name: "Поздняя правка" });
      expect((await actionRows(run.toolUseId)).map((row) => row.result)).toEqual(["refused_stale"]);
    });

    it("skill version: 412 or 409 and no assistant version", async () => {
      const skillFile = (title: string) => [{ path: "e2e-skill/SKILL.md", content: `---\nname: e2e-skill\ndescription: ${title}. Use it in the end-to-end test.\n---\n\n# E2E\n` }];
      const created = await proposeAndRun("skill_new", "create_skill", { display_title: "E2E skill", files: skillFile("Первая версия") });
      expect(created.isError, created.text).toBe(false);
      const skillId = (await actionRows(created.toolUseId))[0].target_id as string;
      runtime.platformMcp.hooks.afterDigestCheck = async () => {
        const form = new FormData();
        form.append("files[]", new File([skillFile("Третье лицо")[0]!.content], "e2e-skill/SKILL.md"));
        const response = await appFetch(new Request(`${BASE}/v1/skills/${skillId}/versions`, { method: "POST", headers: headers(), body: form }));
        expect(response.status, await response.clone().text()).toBeLessThan(300);
      };
      const run = await proposeAndRun("late_skill", "create_skill_version", { skill_id: skillId, files: skillFile("Ассистент") });
      expect(run.isError).toBe(true);
      const versions = await ok<{ data: unknown[] }>("GET", `/v1/skills/${skillId}/versions?limit=10`);
      expect(versions.data).toHaveLength(2);
      expect((await actionRows(run.toolUseId)).map((row) => row.result)).toEqual(["refused_stale"]);
    });
  });

  describe("create_deployment on the real routes and tokens", () => {
    let agentId = "";
    let environmentId = "";

    beforeAll(async () => {
      agentId = (await ok<{ id: string }>("POST", "/v1/agents", { name: "E2E cron agent", model: MODEL })).id;
      environmentId = (await ok<{ id: string }>("POST", "/v1/environments", { name: "E2E cron env", config: { type: "cloud", networking: { type: "unrestricted" } } })).id;
    });

    async function deploymentCount(): Promise<number> {
      return (await ok<{ data: unknown[] }>("GET", "/v1/deployments?limit=100&include_archived=true")).data.length;
    }

    const args = (environment: string, cron = "0 9 * * *") => ({
      name: "E2E nightly",
      agent: { id: agentId },
      environment_id: environment,
      initial_events: [{ type: "user.message", content: [{ type: "text", text: "отчёт" }] }],
      schedule: { cron, timezone: "Europe/Moscow" },
    });

    it("makes one POST and a paused deployment with updated_at equal to created_at", async () => {
      innerCalls.length = 0;
      const run = await proposeAndRun("dep", "create_deployment", args(environmentId));
      expect(run.isError, run.text).toBe(false);
      expect(innerCalls.filter((entry) => entry.method === "POST" && entry.path.startsWith("/v1/deployments"))).toEqual([
        { method: "POST", path: "/v1/deployments" },
      ]);
      const id = (await actionRows(run.toolUseId))[0].target_id as string;
      const deployment = await ok<any>("GET", `/v1/deployments/${id}`);
      expect(deployment).toMatchObject({ status: "paused", schedule: { type: "cron", expression: "0 9 * * *" } });
      expect(deployment.updated_at).toBe(deployment.created_at);
    });

    it("a bad cron or an archived environment leaves no deployment", async () => {
      const before = await deploymentCount();
      steps.set("badcron", (results) => (results.length === 0 ? [{ type: "tool_use", name: "mcp__platform__create_deployment", input: args(environmentId, "not a cron") }] : [{ type: "text", text: "ok" }]));
      const asked = await say(assistantSessionId, "E2E:badcron");
      const card = await preview(asked.stop.event_ids[0]);
      const refused = await call("POST", "/v1/oma/platform-mcp/confirm", { session_id: assistantSessionId, tool_use_id: asked.stop.event_ids[0], result: "allow", preview_digest: card.preview_digest });
      expect(refused.status).toBe(409);
      await deny(asked.stop.event_ids[0]);

      const archived = await ok<{ id: string }>("POST", "/v1/environments", { name: "E2E archived env", config: { type: "cloud", networking: { type: "unrestricted" } } });
      runtime.platformMcp.hooks.afterDigestCheck = async () => {
        await ok("POST", `/v1/environments/${archived.id}/archive`, {});
      };
      const run = await proposeAndRun("dep_archived", "create_deployment", args(archived.id));
      expect(run.isError).toBe(true);
      expect(await deploymentCount()).toBe(before);
    });

    it("a route token on pause, unpause, run, archive or a create without _oma.paused gets 403", async () => {
      const deployments = await ok<{ data: Array<{ id: string }> }>("GET", "/v1/deployments?limit=1");
      const id = deployments.data[0]!.id;
      const tokens = runtime.platformMcp.tokens;
      const send = async (path: string, body: unknown) => {
        const raw = JSON.stringify(body);
        const token = tokens.issueRoute({
          workspaceId,
          userId,
          sessionId: assistantSessionId,
          method: "POST",
          path,
          bodySha256: createHash("sha256").update(raw).digest("hex"),
          issuer: "handler",
        });
        return appFetch(new Request(`${BASE}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "anthropic-beta": BETA },
          body: raw,
        }));
      };
      for (const action of ["pause", "unpause", "run", "archive"]) {
        expect((await send(`/v1/deployments/${id}/${action}`, {})).status, action).toBe(403);
      }
      const before = await deploymentCount();
      const plain = await send("/v1/deployments", {
        name: "E2E no pause",
        agent: { type: "agent", id: agentId },
        environment_id: environmentId,
        initial_events: [{ type: "user.message", content: [{ type: "text", text: "x" }] }],
      });
      expect(plain.status).toBe(403);
      expect(await deploymentCount()).toBe(before);
    });
  });

  it("switching the assistant off in the middle of a batch stops the next operations", async () => {
    let first = true;
    runtime.platformMcp.hooks.afterDigestCheck = async () => {
      if (!first) return;
      first = false;
      await ok("POST", "/v1/oma/platform-mcp/settings", { enabled: false });
    };
    try {
      const run = await proposeAndRun("off", "apply_changes", {
        operations: [
          { tool: "create_memory_store", args: { name: "E2E off one" } },
          { tool: "create_memory_store", args: { name: "E2E off two" } },
        ],
      });
      expect(run.isError).toBe(true);
      expect((await actionRows(run.toolUseId)).map((row) => row.result)).toEqual(["ok", "refused_disabled"]);
      const stores = await ok<{ data: Array<{ name: string }> }>("GET", "/v1/memory_stores?limit=100");
      expect(stores.data.map((store) => store.name)).toContain("E2E off one");
      expect(stores.data.map((store) => store.name)).not.toContain("E2E off two");
    } finally {
      await ok("POST", "/v1/oma/platform-mcp/settings", { enabled: true });
    }
  });
});
