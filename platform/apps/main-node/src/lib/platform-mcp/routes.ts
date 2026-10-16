// HTTP routes of the platform MCP server (builder-agent.md 2.1).
// `POST /v1/oma/platform-mcp` takes only the `endpoint` token: the token
// middleware of BS2 sets `platform_mcp_actor`. Cookies and API keys get 403.

import { Hono } from "hono";
import { buildConfirmRoutes } from "./confirm-routes";
import { handleJsonRpc } from "./handler";
import type { ActorClaims, PlatformMcpDeps } from "./ports";

export interface PlatformMcpVariables {
  Variables: { platform_mcp_actor?: ActorClaims };
}

export function buildPlatformMcpRoutes(deps: PlatformMcpDeps): Hono<PlatformMcpVariables> {
  const app = new Hono<PlatformMcpVariables>();
  app.post("/", async (c) => {
    const actor = c.get("platform_mcp_actor");
    if (!actor) return c.json({ error: { type: "forbidden", message: "Сервер платформы принимает только токен сессии ассистента" } }, 403);
    let message: unknown;
    try {
      message = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(message)) {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } }, 400);
    }
    const answer = await handleJsonRpc(deps, actor, message);
    if (answer.body === null) return c.body(null, answer.status as 202);
    return c.json(answer.body, answer.status as 200);
  });
  const notAllowed = () => new Response(null, { status: 405, headers: { allow: "POST" } });
  app.get("/", notAllowed);
  app.delete("/", notAllowed);
  return app;
}

export { buildConfirmRoutes };
