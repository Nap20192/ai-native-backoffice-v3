// The platform MCP server behind the MCP proxy (builder-agent.md 2.1, 3.3).
// The target carries `fetcher` (`app.fetch`), so the request never leaves the
// process. The public HTTP proxy route refuses such a target with 403.

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "@open-managed-agents/auth";
import type { Session } from "@open-managed-agents/managed-agents-application";
import { buildNodeHttpMcpProxyRoutes, createNodeMcpProxyBinding, type NodeMcpProxyTarget } from "../src/lib/http-mcp-proxy";
import { ACTOR_TOKEN_PREFIX, createActorTokenGuard, createActorTokens } from "../src/lib/platform-mcp/actor-token";
import { createActorIsCurrent, createPlatformMcpTargetResolver } from "../src/lib/platform-mcp/proxy-target";
import { buildPlatformMcpRoutes } from "../src/lib/platform-mcp/routes";
import type { PlatformMcpDeps, SessionOwner, SessionToolCheckResult } from "../src/lib/platform-mcp/ports";
import { routeAllowlist } from "../src/lib/platform-mcp/tool-table";

const PLATFORM_URL = "http://127.0.0.1:8787/v1/oma/platform-mcp";
const WS = "ws_1";
const OWNER = "user_owner";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "sesn_assistant",
    agent: {
      id: "agent_builder",
      description: null,
      mcpServers: [
        { name: "platform", type: "url", url: PLATFORM_URL },
        { name: "linear", type: "url", url: "https://mcp.linear.app/sse" },
      ],
      model: { id: "qwen3.6-35b" },
      multiagent: null,
      name: "Помощник",
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    environmentId: "env_1",
    metadata: {},
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status: "idle",
    title: null,
    updatedAt: "2026-10-16T10:00:00.000Z",
    usage: {},
    vaultIds: [],
    ...overrides,
  };
}

function setup(options: { owner?: SessionOwner | null; check?: SessionToolCheckResult; session?: Session | null } = {}) {
  const state = {
    session: options.session === undefined ? session() : options.session,
    owner: options.owner === undefined ? { userId: OWNER, displayName: "Анна" } : options.owner,
    check: options.check ?? ({ ok: true } as SessionToolCheckResult),
  };
  const loadSession = async () => state.session;
  const owners = { ownerOf: async () => state.owner };
  const toolCheck = { check: vi.fn(async () => state.check) };
  const tokens = createActorTokens({ isCurrent: createActorIsCurrent({ loadSession, owners, toolCheck }) });

  const app = new Hono();
  app.use(
    "*",
    createAuthMiddleware({
      disabled: false,
      resolveSession: async () => ({ userId: OWNER }),
      resolveApiKey: async () => null,
      resolveBearerToken: (request) => tokens.resolve(request),
      defaultTenantForUser: async () => WS,
      hasMembership: async () => true,
      ensureTenantForUser: async () => WS,
    }),
  );
  app.use("*", createActorTokenGuard({ allowlist: routeAllowlist }));
  app.route("/v1/oma/platform-mcp", buildPlatformMcpRoutes({} as PlatformMcpDeps));
  const appFetch = vi.fn(async (request: Request) => app.fetch(request));

  const resolver = createPlatformMcpTargetResolver({ platformMcpUrl: PLATFORM_URL, loadSession, owners, toolCheck, tokens, fetcher: appFetch });
  const vault = vi.fn(async (): Promise<NodeMcpProxyTarget | null> => ({ upstreamUrl: "https://mcp.linear.app/sse", accessToken: "vault-token" }));
  const resolveTarget = async (input: { tenantId: string; sessionId: string; serverName: string }) => {
    const platform = await resolver.resolve(input);
    return platform.kind === "platform" ? platform.target : vault();
  };
  const network = vi.fn(async () => new Response("{}", { status: 200 }));
  app.route("/v1/oma/mcp-proxy", buildNodeHttpMcpProxyRoutes({ resolveTarget, fetcher: network as typeof fetch }));
  const binding = createNodeMcpProxyBinding({ resolveTarget, fetcher: network as typeof fetch });
  return { state, tokens, resolver, binding, app, appFetch, network, vault, toolCheck };
}

const ping = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" });
const bindingRequest = (serverName = "platform") =>
  new Request(PLATFORM_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-oma-tenant": WS, "x-oma-session": "sesn_assistant", "x-oma-mcp-server": serverName },
    body: ping,
  });

describe("platform MCP target", () => {
  it("sends the binding request through app.fetch with a one-time endpoint token", async () => {
    const { binding, appFetch, network, tokens } = setup();
    const response = await binding.fetch(bindingRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(network).not.toHaveBeenCalled();
    expect(appFetch).toHaveBeenCalledTimes(1);
    const sent = appFetch.mock.calls[0]![0] as Request;
    expect(sent.headers.get("authorization")?.startsWith(`Bearer ${ACTOR_TOKEN_PREFIX}`)).toBe(true);
    expect(tokens.size()).toBe(0);
  });

  it("leaves other servers to the vault", async () => {
    const { binding, network, vault, appFetch } = setup();
    expect((await binding.fetch(bindingRequest("linear"))).status).toBe(200);
    expect(vault).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
    expect(appFetch).not.toHaveBeenCalled();
  });

  it("answers the public HTTP proxy route with 403 for the platform server", async () => {
    const { app, appFetch, network } = setup();
    const response = await app.request("/v1/oma/mcp-proxy/sesn_assistant/platform", {
      method: "POST",
      headers: { cookie: "session=ok", "content-type": "application/json" },
      body: ping,
    });
    expect(response.status).toBe(403);
    expect(network).not.toHaveBeenCalled();
    expect(appFetch).not.toHaveBeenCalled();
  });

  it("issues no token for a session without an owner, with a bad tool set or archived", async () => {
    for (const state of [
      { owner: null },
      { check: { ok: false as const, message: "В сессии ассистента есть встроенные инструменты" } },
      { session: session({ archivedAt: "2026-10-16T11:00:00.000Z" }) },
    ]) {
      const { binding, appFetch, tokens } = setup(state);
      expect((await binding.fetch(bindingRequest())).status).toBe(403);
      expect(appFetch).not.toHaveBeenCalled();
      expect(tokens.size()).toBe(0);
    }
  });

  it("leaves an unknown session to the vault lookup", async () => {
    const { resolver } = setup({ session: null });
    expect(await resolver.resolve({ tenantId: WS, sessionId: "sesn_missing", serverName: "platform" })).toEqual({ kind: "other" });
  });

  it("refuses the token when the session changes between issue and use", async () => {
    const { resolver, state, app } = setup();
    const resolved = await resolver.resolve({ tenantId: WS, sessionId: "sesn_assistant", serverName: "platform" });
    expect(resolved.kind).toBe("platform");
    const target = (resolved as { target: NodeMcpProxyTarget }).target;
    state.check = { ok: false, message: "bash" };
    const response = await app.request(PLATFORM_URL, { method: "POST", headers: { authorization: `Bearer ${target.accessToken}` }, body: ping });
    expect(response.status).toBe(403);
  });

  it("refuses the token of a user who no longer owns the session", async () => {
    const { resolver, state, app } = setup();
    const resolved = await resolver.resolve({ tenantId: WS, sessionId: "sesn_assistant", serverName: "platform" });
    const target = (resolved as { target: NodeMcpProxyTarget }).target;
    state.owner = { userId: "user_other", displayName: null };
    expect((await app.request(PLATFORM_URL, { method: "POST", headers: { authorization: `Bearer ${target.accessToken}` }, body: ping })).status).toBe(403);
  });
});
