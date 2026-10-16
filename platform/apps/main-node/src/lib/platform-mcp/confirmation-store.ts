// Store `platform_mcp_confirmations` (builder-agent.md 2.5, 3.6). The
// `confirm` route writes a row, the gate marks it used with one conditional
// UPDATE: a confirmation works once.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { ConfirmationRow, ConfirmationStore, OpClass } from "./ports";
import { ensurePlatformMcpSchema, fromIso, toIso } from "./schema";

export interface ConfirmationListFilter {
  sessionId?: string;
  userId?: string;
  /** ISO time, inclusive. */
  from?: string;
  /** ISO time, exclusive. */
  to?: string;
  limit?: number;
}

export interface ConfirmationListStore extends ConfirmationStore {
  /** Newest first. */
  list(workspaceId: string, filter: ConfirmationListFilter): Promise<{ data: ConfirmationRow[] }>;
}

interface Row {
  id: string;
  workspace_id: string;
  session_id: string;
  tool_use_id: string;
  user_id: string;
  result: string;
  preview_digest: string;
  op_classes_json: string;
  target_revisions_json: string;
  event_id: string | null;
  created_at: number | string;
  used_at: number | string | null;
}

const COLUMNS =
  "id, workspace_id, session_id, tool_use_id, user_id, result, preview_digest, op_classes_json, target_revisions_json, event_id, created_at, used_at";

function toRow(row: Row): ConfirmationRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    toolUseId: row.tool_use_id,
    userId: row.user_id,
    result: row.result as "allow" | "deny",
    previewDigest: row.preview_digest,
    opClasses: JSON.parse(row.op_classes_json) as OpClass[],
    targetRevisions: JSON.parse(row.target_revisions_json) as (string | null)[],
    eventId: row.event_id,
    createdAt: toIso(row.created_at)!,
    usedAt: toIso(row.used_at),
  };
}

export function createConfirmationStore(sql: SqlClient): ConfirmationListStore {
  return {
    async insert(row) {
      await ensurePlatformMcpSchema(sql);
      await sql
        .prepare(`INSERT INTO platform_mcp_confirmations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          row.id,
          row.workspaceId,
          row.sessionId,
          row.toolUseId,
          row.userId,
          row.result,
          row.previewDigest,
          JSON.stringify(row.opClasses),
          JSON.stringify(row.targetRevisions),
          row.eventId,
          fromIso(row.createdAt),
          fromIso(row.usedAt),
        )
        .run();
    },

    async delete(id) {
      await ensurePlatformMcpSchema(sql);
      await sql.prepare("DELETE FROM platform_mcp_confirmations WHERE id = ?").bind(id).run();
    },

    async attachEvent(id, eventId) {
      await ensurePlatformMcpSchema(sql);
      await sql.prepare("UPDATE platform_mcp_confirmations SET event_id = ? WHERE id = ?").bind(eventId, id).run();
    },

    async findAllow(workspaceId, sessionId, toolUseId) {
      await ensurePlatformMcpSchema(sql);
      const row = await sql
        .prepare(
          `SELECT ${COLUMNS} FROM platform_mcp_confirmations
WHERE workspace_id = ? AND session_id = ? AND tool_use_id = ? AND result = 'allow'
ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .bind(workspaceId, sessionId, toolUseId)
        .first<Row>();
      return row === null ? null : toRow(row);
    },

    async markUsed(id, usedAt) {
      await ensurePlatformMcpSchema(sql);
      const result = await sql
        .prepare("UPDATE platform_mcp_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL")
        .bind(fromIso(usedAt), id)
        .run();
      return result.meta.changes > 0;
    },

    async list(workspaceId, filter) {
      await ensurePlatformMcpSchema(sql);
      const where = ["workspace_id = ?"];
      const params: unknown[] = [workspaceId];
      if (filter.sessionId) (where.push("session_id = ?"), params.push(filter.sessionId));
      if (filter.userId) (where.push("user_id = ?"), params.push(filter.userId));
      if (filter.from) (where.push("created_at >= ?"), params.push(fromIso(filter.from)));
      if (filter.to) (where.push("created_at < ?"), params.push(fromIso(filter.to)));
      const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
      const rows = await sql
        .prepare(`SELECT ${COLUMNS} FROM platform_mcp_confirmations WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .bind(...params, limit)
        .all<Row>();
      return { data: (rows.results ?? []).map(toRow) };
    },
  };
}
