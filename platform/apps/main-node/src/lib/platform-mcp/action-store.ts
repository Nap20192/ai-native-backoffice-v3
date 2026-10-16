// Store `platform_mcp_actions` (builder-agent.md 3.6): one row per
// `tools/call`, one row per operation of a batch. The unique
// `(session_id, tool_use_id, op_index)` makes a repeated call a no-op.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { ActionLog, ActionResult, ActionRow, OpClass } from "./ports";
import { decodeCursor, encodeCursor, ensurePlatformMcpSchema, fromIso, toIso, toMs } from "./schema";

export interface ActionListFilter {
  sessionId?: string;
  userId?: string;
  targetId?: string;
  /** ISO time, inclusive. */
  from?: string;
  /** ISO time, exclusive. */
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface ActionPage {
  data: ActionRow[];
  next_cursor: string | null;
}

export interface ActionStore extends ActionLog {
  /** Newest first. */
  list(workspaceId: string, filter: ActionListFilter): Promise<ActionPage>;
}

export const ACTION_LIST_DEFAULT_LIMIT = 50;
export const ACTION_LIST_MAX_LIMIT = 200;

interface Row {
  workspace_id: string;
  id: string;
  user_id: string;
  session_id: string;
  agent_id: string | null;
  agent_version: number | string | null;
  model: string | null;
  tool: string;
  class: string;
  tool_use_id: string;
  op_index: number | string;
  input_digest: string;
  input_redacted_json: string | null;
  target_kind: string | null;
  target_id: string | null;
  target_revision: string | null;
  result: string;
  error_message: string | null;
  confirmation_id: string | null;
  preview_digest: string | null;
  masked_count: number | string;
  created_at: number | string;
  finished_at: number | string | null;
  duration_ms: number | string | null;
}

const COLUMNS =
  "workspace_id, id, user_id, session_id, agent_id, agent_version, model, tool, class, tool_use_id, op_index, input_digest, input_redacted_json, target_kind, target_id, target_revision, result, error_message, confirmation_id, preview_digest, masked_count, created_at, finished_at, duration_ms";

function toRow(row: Row): ActionRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    agentVersion: toMs(row.agent_version),
    model: row.model,
    tool: row.tool,
    class: row.class as OpClass,
    toolUseId: row.tool_use_id,
    opIndex: Number(row.op_index),
    inputDigest: row.input_digest,
    inputRedacted: row.input_redacted_json === null ? null : JSON.parse(row.input_redacted_json),
    targetKind: row.target_kind,
    targetId: row.target_id,
    targetRevision: row.target_revision,
    result: row.result as ActionResult,
    errorMessage: row.error_message,
    confirmationId: row.confirmation_id,
    previewDigest: row.preview_digest,
    maskedCount: Number(row.masked_count),
    createdAt: toIso(row.created_at)!,
    finishedAt: toIso(row.finished_at),
    durationMs: toMs(row.duration_ms),
  };
}

export function createActionStore(sql: SqlClient): ActionStore {
  return {
    async insert(row) {
      await ensurePlatformMcpSchema(sql);
      const result = await sql
        .prepare(
          `INSERT INTO platform_mcp_actions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (workspace_id, session_id, tool_use_id, op_index) DO NOTHING`,
        )
        .bind(
          row.workspaceId,
          row.id,
          row.userId,
          row.sessionId,
          row.agentId,
          row.agentVersion,
          row.model,
          row.tool,
          row.class,
          row.toolUseId,
          row.opIndex,
          row.inputDigest,
          row.inputRedacted === null || row.inputRedacted === undefined ? null : JSON.stringify(row.inputRedacted),
          row.targetKind,
          row.targetId,
          row.targetRevision,
          row.result,
          row.errorMessage,
          row.confirmationId,
          row.previewDigest,
          row.maskedCount,
          fromIso(row.createdAt),
          fromIso(row.finishedAt),
          row.durationMs,
        )
        .run();
      return { inserted: result.meta.changes > 0 };
    },

    async findByToolUse(workspaceId, sessionId, toolUseId) {
      await ensurePlatformMcpSchema(sql);
      const rows = await sql
        .prepare(
          `SELECT ${COLUMNS} FROM platform_mcp_actions WHERE workspace_id = ? AND session_id = ? AND tool_use_id = ? ORDER BY op_index`,
        )
        .bind(workspaceId, sessionId, toolUseId)
        .all<Row>();
      return (rows.results ?? []).map(toRow);
    },

    async findSessionCreatedBy(workspaceId, assistantSessionId, createdSessionId) {
      await ensurePlatformMcpSchema(sql);
      const row = await sql
        .prepare(
          "SELECT id FROM platform_mcp_actions WHERE workspace_id = ? AND session_id = ? AND tool = 'create_session' AND result = 'ok' AND target_id = ? LIMIT 1",
        )
        .bind(workspaceId, assistantSessionId, createdSessionId)
        .first<{ id: string }>();
      return row !== null;
    },

    async list(workspaceId, filter) {
      await ensurePlatformMcpSchema(sql);
      const limit = Math.min(Math.max(filter.limit ?? ACTION_LIST_DEFAULT_LIMIT, 1), ACTION_LIST_MAX_LIMIT);
      const where = ["workspace_id = ?"];
      const params: unknown[] = [workspaceId];
      if (filter.sessionId) (where.push("session_id = ?"), params.push(filter.sessionId));
      if (filter.userId) (where.push("user_id = ?"), params.push(filter.userId));
      if (filter.targetId) (where.push("target_id = ?"), params.push(filter.targetId));
      if (filter.from) (where.push("created_at >= ?"), params.push(fromIso(filter.from)));
      if (filter.to) (where.push("created_at < ?"), params.push(fromIso(filter.to)));
      if (filter.cursor) {
        const cursor = decodeCursor(filter.cursor);
        if (cursor === null) throw new RangeError("cursor");
        where.push("(created_at < ? OR (created_at = ? AND id < ?))");
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      const rows = await sql
        .prepare(`SELECT ${COLUMNS} FROM platform_mcp_actions WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...params, limit + 1)
        .all<Row>();
      const all = (rows.results ?? []).map(toRow);
      const data = all.slice(0, limit);
      const last = data.at(-1);
      return {
        data,
        next_cursor: all.length > limit && last ? encodeCursor(Date.parse(last.createdAt), last.id) : null,
      };
    },
  };
}
