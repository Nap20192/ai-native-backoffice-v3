// `GET /v1/oma/platform-mcp/actions` (builder-agent.md 3.6). The console
// reads the action log and the confirmations with its normal login; the tab
// «Изменения» of the assistant panel shows them. The assistant token gets 403.

import { Hono } from "hono";
import type { ActionStore } from "./action-store";
import type { ConfirmationListStore } from "./confirmation-store";
import type { ActionRow, ConfirmationRow } from "./ports";
import { decodeCursor } from "./schema";

export interface ActionsRoutesDeps {
  actions: ActionStore;
  confirmations: ConfirmationListStore;
}

type Vars = { Variables: { tenant_id: string; auth_credential?: unknown } };

function actionJson(row: ActionRow) {
  return {
    id: row.id,
    user_id: row.userId,
    session_id: row.sessionId,
    agent_id: row.agentId,
    agent_version: row.agentVersion,
    model: row.model,
    tool: row.tool,
    class: row.class,
    tool_use_id: row.toolUseId,
    op_index: row.opIndex,
    input_digest: row.inputDigest,
    input_redacted: row.inputRedacted,
    target_kind: row.targetKind,
    target_id: row.targetId,
    target_revision: row.targetRevision,
    result: row.result,
    error_message: row.errorMessage,
    confirmation_id: row.confirmationId,
    preview_digest: row.previewDigest,
    masked_count: row.maskedCount,
    created_at: row.createdAt,
    finished_at: row.finishedAt,
    duration_ms: row.durationMs,
  };
}

function confirmationJson(row: ConfirmationRow) {
  return {
    id: row.id,
    session_id: row.sessionId,
    tool_use_id: row.toolUseId,
    user_id: row.userId,
    result: row.result,
    preview_digest: row.previewDigest,
    op_classes: row.opClasses,
    target_revisions: row.targetRevisions,
    event_id: row.eventId,
    created_at: row.createdAt,
    used_at: row.usedAt,
  };
}

const badRequest = (message: string) => Response.json({ error: { type: "invalid_request", message } }, { status: 400 });

export function buildActionsRoutes(deps: ActionsRoutesDeps): Hono<Vars> {
  const app = new Hono<Vars>();
  app.get("/", async (c) => {
    const credential = c.get("auth_credential") as { type?: unknown } | undefined;
    if (credential?.type === "platform_mcp_actor") {
      return c.json({ error: { type: "forbidden", message: "Ассистенту этот маршрут закрыт" } }, 403);
    }
    const query = c.req.query();
    for (const field of ["from", "to"] as const) {
      if (query[field] !== undefined && Number.isNaN(Date.parse(query[field]))) return badRequest(`Поле ${field} должно быть временем ISO`);
    }
    if (query.cursor !== undefined && decodeCursor(query.cursor) === null) return badRequest("Неверный cursor");
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return badRequest("Поле limit должно быть целым числом от 1");
    const workspaceId = c.get("tenant_id");
    const filter = {
      ...(query.session_id ? { sessionId: query.session_id } : {}),
      ...(query.user_id ? { userId: query.user_id } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
    };
    const page = await deps.actions.list(workspaceId, {
      ...filter,
      ...(query.target_id ? { targetId: query.target_id } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(limit === undefined ? {} : { limit }),
    });
    // Confirmations have no target, so `target_id` and the cursor leave them out.
    const confirmations = query.target_id || query.cursor ? { data: [] } : await deps.confirmations.list(workspaceId, filter);
    return c.json({
      actions: page.data.map(actionJson),
      confirmations: confirmations.data.map(confirmationJson),
      next_cursor: page.next_cursor,
    });
  });
  return app;
}
