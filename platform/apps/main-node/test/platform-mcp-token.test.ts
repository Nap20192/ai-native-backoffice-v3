// Tokens of the platform MCP server (builder-agent.md 3.3, 3.5, 6.1 "токены").

import { createHash } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware, type AuthSession } from "@open-managed-agents/auth";
import {
  ACTOR_TOKEN_PREFIX,
  createActorTokenGuard,
  createActorTokens,
  type ActorTokenClaims,
} from "../src/lib/platform-mcp/actor-token";
import { buildPlatformMcpRoutes } from "../src/lib/platform-mcp/routes";
import type { PlatformMcpDeps } from "../src/lib/platform-mcp/ports";
import { routeAllowlist } from "../src/lib/platform-mcp/tool-table";

const WS = "ws_1";
const USER = "user_owner";
const SESSION = "sesn_assistant";
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function setup(options: { member?: boolean; current?: (claims: ActorTokenClaims) => boolean } = {}) {
  let clock = Date.parse("2026-10-16T10:00:00.000Z");
  const membership = { value: options.member ?? true };
  const tokens = createActorTokens({
    now: () => clock,
    isCurrent: async (claims) => options.current?.(claims) ?? true,
  });
  const reached: { method: string; path: string; body: string; actor?: unknown; tenant?: string; user?: string }[] = [];
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use(
    "*",
    createAuthMiddleware({
      disabled: false,
      resolveSession: async (headers): Promise<AuthSession | null> =>
        headers.get("cookie") === "session=ok" ? { userId: USER } : null,
      resolveApiKey: async (key) => (key === "workspace-key" ? { tenantId: WS, credential: { type: "workspace" } } : null),
      resolveBearerToken: (request) => tokens.resolve(request),
      defaultTenantForUser: async () => WS,
      hasMembership: async () => membership.value,
      ensureTenantForUser: async () => WS,
    }),
  );
  app.use("*", createActorTokenGuard({ allowlist: routeAllowlist }));
  app.route("/v1/oma/platform-mcp", buildPlatformMcpRoutes({} as PlatformMcpDeps));
  app.all("*", async (c) => {
    reached.push({
      method: c.req.method,
      path: c.req.path,
      body: await c.req.text(),
      tenant: c.get("tenant_id") as string,
      user: c.get("user_id") as string,
    });
    return c.json({ ok: true });
  });
  const route = (method: string, path: string, body: string | Uint8Array = "", issuer: "handler" | "confirm" = "handler", toolUseId?: string) =>
    tokens.issueRoute({ workspaceId: WS, userId: USER, sessionId: SESSION, method, path, bodySha256: sha(body), issuer, ...(toolUseId ? { toolUseId } : {}) });
  const send = (method: string, path: string, token: string, body?: string, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body }),
    });
  return { app, tokens, reached, route, send, membership, tick: (ms: number) => (clock += ms) };
}

describe("actor tokens", () => {
  it("is the prefix and 32 random bytes in base64url", () => {
    const { tokens } = setup();
    const token = tokens.issueEndpoint({ workspaceId: WS, userId: USER, sessionId: SESSION });
    expect(token.startsWith(ACTOR_TOKEN_PREFIX)).toBe(true);
    expect(Buffer.from(token.slice(ACTOR_TOKEN_PREFIX.length), "base64url")).toHaveLength(32);
    expect(tokens.issueEndpoint({ workspaceId: WS, userId: USER, sessionId: SESSION })).not.toBe(token);
  });

  it("ignores a bearer of another kind", async () => {
    const { tokens } = setup();
    expect(await tokens.resolve({ token: "environment-key", method: "GET", path: "/v1/agents" })).toBeNull();
  });

  it("opens one request: the second use, an expired token and a cleared map give 403", async () => {
    const { route, send, tick, tokens, reached } = setup();
    const token = route("GET", "/v1/agents");
    expect((await send("GET", "/v1/agents", token)).status).toBe(200);
    expect((await send("GET", "/v1/agents", token)).status).toBe(403);

    const late = route("GET", "/v1/agents");
    tick(60_001);
    expect((await send("GET", "/v1/agents", late)).status).toBe(403);

    const beforeRestart = route("GET", "/v1/agents");
    tokens.clear();
    expect((await send("GET", "/v1/agents", beforeRestart)).status).toBe(403);
    expect((await send("GET", "/v1/agents", `${ACTOR_TOKEN_PREFIX}never-issued`)).status).toBe(403);
    expect(reached).toHaveLength(1);
  });

  it("lets exactly one of two concurrent requests with one token through", async () => {
    const { route, send, reached } = setup();
    const token = route("GET", "/v1/agents");
    const statuses = (await Promise.all([send("GET", "/v1/agents", token), send("GET", "/v1/agents", token)])).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 403]);
    expect(reached).toHaveLength(1);
  });

  it("drops expired tokens from the map", () => {
    const { route, tokens, tick } = setup();
    route("GET", "/v1/agents");
    route("GET", "/v1/agents");
    expect(tokens.size()).toBe(2);
    tick(60_001);
    tokens.sweep();
    expect(tokens.size()).toBe(0);
  });

  it("checks the method, the exact path with the query and the body hash", async () => {
    const { route, send, reached } = setup();
    expect((await send("POST", "/v1/agents", route("GET", "/v1/agents"), "{}")).status).toBe(403);
    expect((await send("GET", "/v1/agents/agent_2", route("GET", "/v1/agents/agent_1"))).status).toBe(403);
    expect((await send("GET", "/v1/agents?limit=100", route("GET", "/v1/agents?limit=5"))).status).toBe(403);
    expect((await send("POST", "/v1/agents", route("POST", "/v1/agents", '{"name":"a"}'), '{"name":"b"}')).status).toBe(403);
    expect(reached).toHaveLength(0);
    expect((await send("GET", "/v1/agents?limit=5", route("GET", "/v1/agents?limit=5"))).status).toBe(200);
    expect((await send("POST", "/v1/agents", route("POST", "/v1/agents", '{"name":"a"}'), '{"name":"a"}')).status).toBe(200);
    expect(reached.map((r) => r.body)).toEqual(["", '{"name":"a"}']);
  });

  it("hashes a multipart body as raw bytes", async () => {
    const { route, app, reached } = setup();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array([0xff, 0x00, 0xd0, 0x9f])]), "a.bin");
    const encoded = new Response(form);
    const contentType = encoded.headers.get("content-type")!;
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const token = route("POST", "/v1/files", bytes);
    const response = await app.request("/v1/files", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body: bytes,
    });
    expect(response.status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("takes the workspace from the token, never from x-active-tenant", async () => {
    const { route, send, reached } = setup();
    expect((await send("GET", "/v1/agents", route("GET", "/v1/agents"), undefined, { "x-active-tenant": "ws_other" })).status).toBe(200);
    expect(reached[0]).toMatchObject({ tenant: WS, user: USER });
  });
});

describe("the platform MCP endpoint", () => {
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });

  it("answers an endpoint token once and sets the actor", async () => {
    const { tokens, send } = setup();
    const token = tokens.issueEndpoint({ workspaceId: WS, userId: USER, sessionId: SESSION });
    const first = await send("POST", "/v1/oma/platform-mcp", token, ping);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect((await send("POST", "/v1/oma/platform-mcp", token, ping)).status).toBe(403);
  });

  it("refuses a cookie, an API key and a route token", async () => {
    const { app, route, send } = setup();
    const cookie = await app.request("/v1/oma/platform-mcp", { method: "POST", headers: { cookie: "session=ok" }, body: ping });
    expect(cookie.status).toBe(403);
    const apiKey = await app.request("/v1/oma/platform-mcp", { method: "POST", headers: { "x-api-key": "workspace-key" }, body: ping });
    expect(apiKey.status).toBe(403);
    expect((await send("POST", "/v1/oma/platform-mcp", route("POST", "/v1/oma/platform-mcp", ping), ping)).status).toBe(403);
  });

  it("refuses an endpoint token on any other path", async () => {
    const { tokens, send, reached } = setup();
    const token = tokens.issueEndpoint({ workspaceId: WS, userId: USER, sessionId: SESSION, path: "/v1/agents" });
    expect((await send("POST", "/v1/agents", token, "{}")).status).toBe(403);
    expect(reached).toHaveLength(0);
  });
});

describe("routes outside the allowlist", () => {
  // Every route of 2.4 and of the second version, with a token issued for
  // exactly that request. Each gets 403 and the route never runs.
  // The CRUD wave (docs/plans/crud.md, B2 to B5) opened session update,
  // session resource delete, deployment run, pause and unpause, memory
  // delete and file delete to the assistant, so they are no longer here.
  const denied: [string, string][] = [
    ["GET", "/v1/oma/model_cards/mc_1/key"],
    ["POST", "/v1/tunnels/tun_1/reveal_token"],
    ["GET", "/v1/tunnels/tun_1/reveal_token"],
    ["POST", "/v1/vaults/vlt_1/credentials"],
    ["POST", "/v1/vaults/vlt_1/credentials/cred_1"],
    ["POST", "/v1/oma/model_cards"],
    ["POST", "/v1/oma/harness_cards"],
    ["GET", "/v1/oma/api_keys"],
    ["POST", "/v1/oma/api_keys"],
    ["POST", "/v1/oma/me/cli-tokens"],
    ["GET", "/v1/oma/tenants"],
    ["POST", "/v1/oma/tenants/ws_1/members"],
    ["GET", "/v1/oma/platform-mcp/settings"],
    ["POST", "/v1/oma/platform-mcp/settings"],
    ["POST", "/v1/oma/sessions/sesn_1/exec"],
    ["GET", "/metrics"],
    ["POST", "/v1/oma/internal/anything"],
    ["POST", "/v1/oma/mcp-proxy/sesn_1/platform"],
    ["POST", "/v1/environments/env_1/work"],
    ["GET", "/v1/environments/env_1/work/poll"],
    ["POST", "/v1/oma/platform-mcp/preview"],
    ["POST", "/v1/oma/platform-mcp/confirm"],
    ["POST", "/v1/sessions/sesn_1/resources"],
    ["POST", "/v1/sessions/sesn_1/resources/res_1"],
    ["POST", "/v1/sessions/sesn_1/archive"],
    ["DELETE", "/v1/sessions/sesn_1"],
    ["POST", "/v1/deployments/dep_1/archive"],
    ["DELETE", "/v1/deployments/dep_1"],
    ["POST", "/v1/agents/agent_1/archive"],
    ["DELETE", "/v1/agents/agent_1"],
    ["POST", "/v1/environments/env_1/archive"],
    ["DELETE", "/v1/environments/env_1"],
    ["DELETE", "/v1/skills/skill_1"],
    ["POST", "/v1/memory_stores/ms_1/archive"],
    ["POST", "/v1/oma/evals/runs"],
    ["POST", "/v1/oma/skills/install"],
    ["POST", "/v1/oma/model_cards/mc_1/archive"],
    ["DELETE", "/v1/oma/model_cards/mc_1"],
    // Harness cards are gone (D41): no token opens their routes.
    ["DELETE", "/v1/oma/harness_cards/hc_1"],
    ["POST", "/v1/oma/harness_cards/hc_1"],
    ["GET", "/v1/oma/harnesses"],
  ];

  it.each(denied)("%s %s gives 403", async (method, path) => {
    const { route, send, reached } = setup();
    const body = method === "GET" || method === "DELETE" ? "" : "{}";
    const response = await send(method, path, route(method, path, body), body === "" ? undefined : body);
    expect(response.status).toBe(403);
    expect(reached).toHaveLength(0);
  });
});

describe("body rules of the allowlist (2.4)", () => {
  const json = (value: unknown) => JSON.stringify(value);
  const sessionBody = { agent: { type: "agent", id: "agent_1", version: 2 }, environment_id: "env_1" };
  const message = { events: [{ type: "user.message", content: [{ type: "text", text: "Привет" }] }] };

  const refusedBodies: [string, string, unknown, Record<string, string>?][] = [
    ["deployment without _oma.paused", "/v1/deployments", { name: "d", agent: { id: "a" } }],
    ["deployment with paused false", "/v1/deployments", { name: "d", _oma: { paused: false } }],
    ["model card with base_url", "/v1/oma/model_cards/mc_1", { base_url: "https://evil.test" }],
    ["model card with api_key", "/v1/oma/model_cards/mc_1", { api_key: "x" }],
    ["session with initial_events", "/v1/sessions", { ...sessionBody, initial_events: [] }],
    ["session with budget", "/v1/sessions", { ...sessionBody, budget: { amount: 1 } }],
    ["session with vault_ids", "/v1/sessions", { ...sessionBody, vault_ids: ["vlt_1"] }],
    ["session with a GitHub resource", "/v1/sessions", { ...sessionBody, resources: [{ type: "github_repository", url: "u", authorization_token: "t" }] }],
    ["session with agent_with_overrides", "/v1/sessions", { ...sessionBody, agent: { type: "agent_with_overrides", id: "agent_1", version: 2 } }],
    ["session without an agent version", "/v1/sessions", { ...sessionBody, agent: { type: "agent", id: "agent_1" } }],
    ["user.interrupt", "/v1/sessions/sesn_2/events", { events: [{ type: "user.interrupt" }] }, { "if-match": '"3"' }],
    ["user.define_outcome", "/v1/sessions/sesn_2/events", { events: [{ type: "user.define_outcome", description: "d", rubric: {} }] }, { "if-match": '"3"' }],
    ["system.message", "/v1/sessions/sesn_2/events", { events: [{ type: "system.message", content: [{ type: "text", text: "x" }] }] }, { "if-match": '"3"' }],
    ["two events", "/v1/sessions/sesn_2/events", { events: [message.events[0], message.events[0]] }, { "if-match": '"3"' }],
    ["an image block", "/v1/sessions/sesn_2/events", { events: [{ type: "user.message", content: [{ type: "image", source: {} }] }] }, { "if-match": '"3"' }],
    ["a message without If-Match", "/v1/sessions/sesn_2/events", message],
    ["user.tool_confirmation with a handler token", "/v1/sessions/sesn_2/events", { events: [{ type: "user.tool_confirmation", result: "allow", tool_use_id: "tu_1" }] }, { "if-match": '"3"' }],
  ];

  it.each(refusedBodies)("refuses %s and runs nothing", async (_name, path, body, headers = {}) => {
    const { route, send, reached } = setup();
    const text = json(body);
    expect((await send("POST", path, route("POST", path, text), text, headers)).status).toBe(403);
    expect(reached).toHaveLength(0);
  });

  it("passes the bodies the tools send", async () => {
    const { route, send, reached } = setup();
    const ok: [string, unknown, Record<string, string>?][] = [
      ["/v1/deployments", { name: "d", _oma: { paused: true } }],
      ["/v1/oma/model_cards/mc_1", { model: "m" }],
      ["/v1/sessions", { ...sessionBody, resources: [{ type: "file", file_id: "file_1" }], metadata: { oma_created_via: "assistant" } }],
      ["/v1/sessions/sesn_2/events", message, { "if-match": '"3"' }],
    ];
    for (const [path, body, headers] of ok) {
      const text = json(body);
      expect((await send("POST", path, route("POST", path, text), text, headers ?? {})).status).toBe(200);
    }
    expect(reached).toHaveLength(ok.length);
  });

  it("lets a confirm token write only the confirmation of its own call", async () => {
    const { route, send, reached } = setup();
    const path = `/v1/sessions/${SESSION}/events`;
    const own = json({ events: [{ type: "user.tool_confirmation", result: "allow", tool_use_id: "tu_1" }] });
    const other = json({ events: [{ type: "user.tool_confirmation", result: "allow", tool_use_id: "tu_2" }] });
    expect((await send("POST", path, route("POST", path, other, "confirm", "tu_1"), other)).status).toBe(403);
    expect((await send("POST", path, route("POST", path, json(message), "confirm", "tu_1"), json(message), { "if-match": '"1"' })).status).toBe(403);
    expect((await send("POST", path, route("POST", path, own, "confirm", "tu_1"), own)).status).toBe(200);
    expect(reached).toHaveLength(1);
  });

  it("refuses a confirm token on a route the confirm route never calls", async () => {
    const { route, send } = setup();
    expect((await send("GET", "/v1/agents", route("GET", "/v1/agents", "", "confirm", "tu_1"))).status).toBe(403);
  });
});

describe("revocation (3.5)", () => {
  it("refuses a user removed from the workspace", async () => {
    const { route, send, membership } = setup();
    membership.value = false;
    expect((await send("GET", "/v1/agents", route("GET", "/v1/agents"))).status).toBe(403);
  });

  it("refuses a token whose session is no longer current", async () => {
    const current = vi.fn((_claims: ActorTokenClaims) => false);
    const { route, send, reached } = setup({ current });
    expect((await send("GET", "/v1/agents", route("GET", "/v1/agents"))).status).toBe(403);
    expect(current).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, userId: USER, sessionId: SESSION }));
    expect(reached).toHaveLength(0);
  });
});
