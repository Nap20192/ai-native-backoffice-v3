// Guard of the assistant session (builder-agent.md 3.1, 2.5 step 6).
//
// An assistant session is a session whose agent has an MCP server at
// `PLATFORM_MCP_URL`. Only its owner writes into it. `user.interrupt` and the
// archive pass for the owner and for `owner` or `admin` of the workspace.
// A direct `user.tool_confirmation` with `allow` on a platform call gets 403
// even from the owner: the console confirms through the card, and only the
// `confirm` route token may write it. The guard also records the owner of
// every new session from the user of the request.

import type { Context, MiddlewareHandler } from "hono";
import type { Session } from "@open-managed-agents/managed-agents-application";
import type { SessionOwnerStore } from "./owner-store";
import type { MembershipRoles } from "./settings-store";
import { PLATFORM_MCP_SERVER_NAME, isAssistantSession, sameUrl } from "./session-tool-check";

/** Event types only the owner may send into an assistant session. */
export const CLOSED_EVENT_TYPES = [
  "user.message",
  "system.message",
  "user.define_outcome",
  "user.tool_confirmation",
  "user.tool_result",
  "user.custom_tool_result",
] as const;

/** Event types the owner, a workspace owner and an admin may send. */
export const OPEN_EVENT_TYPES = ["user.interrupt"] as const;

const CLOSED = new Set<string>(CLOSED_EVENT_TYPES);

export interface SessionGuardDeps {
  platformMcpUrl: string;
  loadSession(workspaceId: string, sessionId: string): Promise<Session | null>;
  owners: Pick<SessionOwnerStore, "ownerOf" | "record">;
  roles: MembershipRoles;
  /** The `agent.mcp_tool_use` (or other tool use) event with this id, if any. */
  findToolUse(workspaceId: string, sessionId: string, toolUseId: string): Promise<{ mcpServerName: string | null } | null>;
}

type Vars = { Variables: { tenant_id?: string; user_id?: string; auth_credential?: unknown } };

type Action =
  | { type: "events"; sessionId: string }
  | { type: "update"; sessionId: string }
  | { type: "resources"; sessionId: string }
  | { type: "archive"; sessionId: string }
  | { type: "confirm" };

function classify(method: string, path: string): Action | null {
  if (method === "POST" && path === "/v1/oma/platform-mcp/confirm") return { type: "confirm" };
  const match = /^\/v1\/sessions\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return null;
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const rest = match[2] ?? "";
  if (method === "POST" && rest === "/events") return { type: "events", sessionId };
  if (method === "POST" && rest === "") return { type: "update", sessionId };
  if (method === "DELETE" && rest === "") return { type: "archive", sessionId };
  if (method === "POST" && (rest === "/archive" || /^\/threads\/[^/]+\/archive$/.test(rest))) return { type: "archive", sessionId };
  if (method !== "GET" && method !== "HEAD" && (rest === "/resources" || rest.startsWith("/resources/"))) return { type: "resources", sessionId };
  return null;
}

async function jsonBody(c: Context<Vars>): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.raw.clone().json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function forbidden(message: string): Response {
  return Response.json({ type: "error", error: { type: "permission_error", message } }, { status: 403 });
}

function isConfirmToken(credential: unknown): boolean {
  const value = credential as { type?: unknown; kind?: unknown; issuer?: unknown } | undefined;
  return value?.type === "platform_mcp_actor" && value.kind === "route" && value.issuer === "confirm";
}

function addsPlatformServer(body: Record<string, unknown> | null, platformMcpUrl: string): boolean {
  const agent = body?.agent as { mcp_servers?: unknown } | undefined;
  if (!Array.isArray(agent?.mcp_servers)) return false;
  return agent.mcp_servers.some(
    (server) => typeof (server as { url?: unknown })?.url === "string" && sameUrl((server as { url: string }).url, platformMcpUrl),
  );
}

export function createSessionGuard(deps: SessionGuardDeps): MiddlewareHandler<Vars> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    const workspaceId = c.get("tenant_id");
    const userId = c.get("user_id") ?? null;
    if (!workspaceId) return next();

    if (method === "POST" && c.req.path === "/v1/sessions") {
      await next();
      if (userId === null || c.res.status < 200 || c.res.status >= 300) return;
      try {
        const created = (await c.res.clone().json()) as { id?: unknown };
        if (typeof created.id === "string") await deps.owners.record(workspaceId, created.id, userId);
      } catch {
        // A response without JSON has no session to record.
      }
      return;
    }

    const action = classify(method, c.req.path);
    if (action === null) return next();
    const body = method === "POST" ? await jsonBody(c) : null;
    const sessionId = action.type === "confirm" ? (typeof body?.session_id === "string" ? body.session_id : null) : action.sessionId;
    if (sessionId === null) return next();

    const session = await deps.loadSession(workspaceId, sessionId);
    if (session === null) return next();
    const owner = await deps.owners.ownerOf(workspaceId, sessionId);
    const isOwner = owner !== null && userId !== null && owner.userId === userId;

    // A session becomes an assistant session only for its own owner.
    if (action.type === "update" && !isOwner && addsPlatformServer(body, deps.platformMcpUrl)) {
      return forbidden("Подключить сервер платформы может только владелец сессии");
    }
    if (!isAssistantSession(session, deps.platformMcpUrl)) return next();

    const ownerOnly = forbidden(`Писать в разговор с ассистентом может только ${owner?.displayName ?? "владелец сессии"}`);
    const isAdmin = async () => {
      if (userId === null) return false;
      const role = await deps.roles.roleOf(workspaceId, userId);
      return role === "owner" || role === "admin";
    };

    switch (action.type) {
      case "confirm":
      case "update":
      case "resources":
        return isOwner ? next() : ownerOnly;
      case "archive":
        return isOwner || (await isAdmin()) ? next() : ownerOnly;
      case "events": {
        const events = Array.isArray(body?.events) ? (body.events as Record<string, unknown>[]) : [];
        const types = events.map((event) => String(event?.type ?? ""));
        for (const event of events) {
          if (event?.type !== "user.tool_confirmation" || event.result !== "allow" || isConfirmToken(c.get("auth_credential"))) continue;
          const use = await deps.findToolUse(workspaceId, sessionId, String(event.tool_use_id ?? ""));
          // Every tool of an assistant session is a platform tool; an unknown
          // id counts as one.
          if (use === null || use.mcpServerName === PLATFORM_MCP_SERVER_NAME || use.mcpServerName === null) {
            return forbidden("Подтверждайте через карточку");
          }
        }
        if (isOwner) return next();
        if (types.some((type) => CLOSED.has(type) || !OPEN_EVENT_TYPES.includes(type as "user.interrupt"))) return ownerOnly;
        return (await isAdmin()) ? next() : ownerOnly;
      }
    }
  };
}
