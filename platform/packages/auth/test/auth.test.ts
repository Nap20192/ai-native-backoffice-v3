import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import {
  PLATFORM_MCP_ENDPOINT_PATH,
  allowsApiKeyRequest,
  createAuthMiddleware,
  type ApiKeyResolution,
} from "../src/index";

function dependencies() {
  return {
    disabled: false,
    resolveSession: vi.fn(async () => null),
    resolveApiKey: vi.fn(async (token: string) =>
      token === "environment-key"
        ? {
            tenantId: "workspace_environment",
            credential: { type: "environment" as const, environmentId: "env_01" },
          }
        : token === "workspace-key"
          ? {
              tenantId: "workspace_admin",
              credential: { type: "workspace" as const },
            }
        : null,
    ),
    resolveBearerToken: vi.fn(async ({ token, path }: { token: string; path: string }) => {
      if (token !== "session-token") return null;
      if (
        path !== "/v1/sessions/session_01"
        && path !== "/v1/environments/env_01/work/work_01/heartbeat"
      ) return null;
      return {
        tenantId: "workspace_session",
        credential: {
          type: "environment_work_session" as const,
        },
      };
    }),
    defaultTenantForUser: vi.fn(async () => null),
    hasMembership: vi.fn(async () => false),
    ensureTenantForUser: vi.fn(async () => "workspace_default"),
  };
}

describe("managed worker bearer authentication", () => {
  it("returns Anthropic authentication errors from official Managed Agents routes", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/agents", (context) => context.json({ ok: true }));

    const missing = await app.request("/v1/agents");
    const invalid = await app.request("/v1/agents", {
      headers: { "x-api-key": "invalid" },
    });

    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Unauthorized" },
    });
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toEqual({
      type: "error",
      error: { type: "authentication_error", message: "Invalid API key" },
    });
  });

  it("keeps OpenMA Console authentication errors on the existing envelope", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/oma/sessions", (context) => context.json({ ok: true }));

    const response = await app.request("/v1/oma/sessions");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns Anthropic permission errors when a credential escapes its official scope", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/agents", (context) => context.json({ ok: true }));

    const response = await app.request("/v1/agents", {
      headers: { Authorization: "Bearer environment-key" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "permission_error",
        message: "Bearer token is not authorized for this resource",
      },
    });
  });

  it("accepts a scoped session bearer resolution before the API-key fallback", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/sessions/:sessionId", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );

    const response = await app.request("/v1/sessions/session_01", {
      headers: { Authorization: "Bearer session-token" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "workspace_session" });
    expect(deps.resolveApiKey).not.toHaveBeenCalled();
  });

  it("accepts an environment service key as the official environment bearer", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/environments/:environmentId/work/poll", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );

    const response = await app.request("/v1/environments/env_01/work/poll", {
      headers: { Authorization: "Bearer environment-key" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "workspace_environment" });
    expect(deps.resolveBearerToken).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/environments/env_01/work/poll",
      token: "environment-key",
    });
  });

  it("does not accept a workspace key as a standing worker bearer", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/environments/:environmentId/work/poll", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );

    const worker = await app.request("/v1/environments/env_01/work/poll", {
      headers: { Authorization: "Bearer workspace-key" },
    });
    const administrator = await app.request("/v1/environments/env_01/work/poll", {
      headers: { "x-api-key": "workspace-key" },
    });

    expect(worker.status).toBe(403);
    expect(administrator.status).toBe(200);
  });

  it("allows the claimed Work session bearer to maintain its own Work", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.post(
      "/v1/environments/:environmentId/work/:workId/heartbeat",
      (context) => context.json({ tenantId: context.get("tenant_id") }),
    );

    const response = await app.request(
      "/v1/environments/env_01/work/work_01/heartbeat",
      { method: "POST", headers: { Authorization: "Bearer session-token" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tenantId: "workspace_session" });
  });

  it("rejects an environment key outside its exact Work route", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/environments/:environmentId/work/poll", (context) =>
      context.json({ tenantId: context.get("tenant_id") }),
    );
    app.get("/v1/sessions/:sessionId", (context) => context.json({ ok: true }));

    const wrongEnvironment = await app.request(
      "/v1/environments/env_02/work/poll",
      { headers: { Authorization: "Bearer environment-key" } },
    );
    const session = await app.request("/v1/sessions/session_01", {
      headers: { Authorization: "Bearer environment-key" },
    });
    const header = await app.request("/v1/environments/env_01/work/poll", {
      headers: { "x-api-key": "environment-key" },
    });

    expect(wrongEnvironment.status).toBe(403);
    expect(session.status).toBe(403);
    expect(header.status).toBe(403);
  });

  // The hosted inference proxy was removed with the ACP harnesses (D41):
  // a Work session token no longer opens anything through x-api-key.
  it("refuses a Work session token through x-api-key on the removed inference proxy", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.post("/v1/oma/inference-proxy/:sessionId/*", (context) =>
      context.json({ ok: true }),
    );

    const response = await app.request(
      "/v1/oma/inference-proxy/session_01/v1/messages",
      { method: "POST", headers: { "x-api-key": "session-token" } },
    );

    expect(response.status).toBe(401);
    expect(
      allowsApiKeyRequest(
        { tenantId: "workspace_session", credential: { type: "environment_work_session" } as ApiKeyResolution["credential"] },
        { path: "/v1/oma/inference-proxy/session_01/v1/messages", transport: "x-api-key" },
      ),
    ).toBe(false);
  });

  it("rejects an unresolved bearer without falling through to cookie auth", async () => {
    const deps = dependencies();
    const app = new Hono();
    app.use("*", createAuthMiddleware(deps));
    app.get("/v1/sessions/:sessionId", (context) => context.json({ ok: true }));

    const response = await app.request("/v1/sessions/session_01", {
      headers: { Authorization: "Bearer invalid" },
    });

    expect(response.status).toBe(401);
    expect(deps.resolveSession).not.toHaveBeenCalled();
  });
});

describe('removed workspace members', () => {
  it.each(['x-api-key', 'authorization'])('rejects a removed member through %s', async header => {
    const deps = dependencies();
    const app = new Hono();
    app.use('*', createAuthMiddleware({ ...deps, resolveApiKey: async () => ({ tenantId: 't', userId: 'removed' }) }));
    app.get('/v1/agents', c => c.json({ ok: true }));
    const res = await app.request('/v1/agents', { headers: { [header]: header === 'authorization' ? 'Bearer old-key' : 'old-key' } });
    expect(res.status).toBe(403);
  });
});

describe("platform MCP actor token", () => {
  const base = {
    sessionId: "sesn_assistant",
    method: "POST",
    expiresAt: "2026-10-16T12:00:00.000Z",
  };
  const endpoint: ApiKeyResolution = {
    tenantId: "ws_1",
    userId: "user_owner",
    credential: { type: "platform_mcp_actor", kind: "endpoint", path: PLATFORM_MCP_ENDPOINT_PATH, ...base },
  };
  const route = (path: string, method = "GET"): ApiKeyResolution => ({
    tenantId: "ws_1",
    userId: "user_owner",
    credential: { type: "platform_mcp_actor", kind: "route", issuer: "handler", bodySha256: "0".repeat(64), ...base, method, path },
  });

  it.each([
    [PLATFORM_MCP_ENDPOINT_PATH, "bearer", true],
    [PLATFORM_MCP_ENDPOINT_PATH, "x-api-key", false],
    ["/v1/oma/platform-mcp/settings", "bearer", false],
    ["/v1/oma/platform-mcp/confirm", "bearer", false],
    ["/v1/agents", "bearer", false],
  ] as const)("an endpoint token on %s through %s: %s", (path, transport, allowed) => {
    expect(allowsApiKeyRequest(endpoint, { path, transport })).toBe(allowed);
  });

  it.each([
    ["/v1/agents", "/v1/agents", true],
    ["/v1/agents/agent_1?limit=5", "/v1/agents/agent_1", true],
    ["/v1/agents/agent_1", "/v1/agents/agent_2", false],
    ["/v1/oma/platform-mcp", "/v1/oma/platform-mcp", false],
    ["/v1/oma/platform-mcp/settings", "/v1/oma/platform-mcp/settings", false],
    ["/v1/oma/platform-mcp/preview", "/v1/oma/platform-mcp/preview", false],
    ["/v1/oma/mcp-proxy/sesn_1/platform", "/v1/oma/mcp-proxy/sesn_1/platform", false],
    ["/v1/oma/internal/x", "/v1/oma/internal/x", false],
    ["/v1/oma/api_keys", "/v1/oma/api_keys", false],
    // The route went away with the oma CLI on 2026-10-19; the entry stays as a guard.
    ["/v1/oma/me/cli-tokens", "/v1/oma/me/cli-tokens", false],
    ["/v1/oma/tenants/ws_1/members", "/v1/oma/tenants/ws_1/members", false],
    ["/v1/oma/inference-proxy/sesn_1/v1/messages", "/v1/oma/inference-proxy/sesn_1/v1/messages", false],
    ["/v1/oma/sessions/sesn_1/exec", "/v1/oma/sessions/sesn_1/exec", false],
    ["/v1/environments/env_1/work", "/v1/environments/env_1/work", false],
    ["/v1/tunnels/tun_1/reveal_token", "/v1/tunnels/tun_1/reveal_token", false],
    ["/metrics", "/metrics", false],
  ] as const)("a route token for %s on %s: %s", (tokenPath, path, allowed) => {
    expect(allowsApiKeyRequest(route(tokenPath), { path, transport: "bearer" })).toBe(allowed);
  });

  it("refuses a route token through x-api-key and a refused token anywhere", () => {
    expect(allowsApiKeyRequest(route("/v1/agents"), { path: "/v1/agents", transport: "x-api-key" })).toBe(false);
    const refused: ApiKeyResolution = { tenantId: "", credential: { type: "platform_mcp_actor", kind: "refused", path: "/v1/agents", ...base } };
    expect(allowsApiKeyRequest(refused, { path: "/v1/agents", transport: "bearer" })).toBe(false);
  });

  function actorApp(resolution: ApiKeyResolution | null, member = true) {
    const deps = {
      ...dependencies(),
      resolveBearerToken: vi.fn(async () => resolution),
      resolveApiKey: vi.fn(async () => null),
      hasMembership: vi.fn(async () => member),
    };
    const app = new Hono<{ Variables: { tenant_id: string; user_id?: string; auth_credential?: unknown } }>();
    app.use("*", createAuthMiddleware(deps));
    const echo = (c: any) => c.json({ tenant: c.get("tenant_id"), user: c.get("user_id"), credential: c.get("auth_credential") });
    app.post(PLATFORM_MCP_ENDPOINT_PATH, echo);
    app.get("/v1/agents", echo);
    return { app, deps };
  }

  it("takes the workspace only from the token and ignores x-active-tenant", async () => {
    const { app, deps } = actorApp(endpoint);
    const response = await app.request(PLATFORM_MCP_ENDPOINT_PATH, {
      method: "POST",
      headers: { authorization: "Bearer oma-mcp-v1.abc", "x-active-tenant": "ws_other" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ tenant: "ws_1", user: "user_owner", credential: { type: "platform_mcp_actor", kind: "endpoint" } });
    expect(deps.hasMembership).toHaveBeenCalledWith("user_owner", "ws_1");
    expect(deps.resolveApiKey).not.toHaveBeenCalled();
  });

  it("refuses a removed member and a refused token with 403", async () => {
    const removed = actorApp(route("/v1/agents"), false);
    expect((await removed.app.request("/v1/agents", { headers: { authorization: "Bearer oma-mcp-v1.abc" } })).status).toBe(403);
    const refused = actorApp({ tenantId: "", credential: { type: "platform_mcp_actor", kind: "refused", path: "/v1/agents", ...base } });
    expect((await refused.app.request("/v1/agents", { headers: { authorization: "Bearer oma-mcp-v1.abc" } })).status).toBe(403);
  });
});
