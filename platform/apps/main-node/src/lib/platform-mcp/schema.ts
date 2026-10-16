// Tables of the platform MCP server, created by code on first use
// (builder-agent.md 3.6). The same SQL runs on SQLite and Postgres:
// `*_json` columns hold JSON as text, times are BIGINT milliseconds.
// There is no drizzle migration and `meta/_journal.json` stays untouched.

import type { SqlClient } from "@open-managed-agents/sql-client";

export const PLATFORM_MCP_MIGRATIONS = [
  {
    id: "0001_platform_mcp",
    statements: [
      `CREATE TABLE IF NOT EXISTS platform_mcp_actions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  agent_version BIGINT,
  model TEXT,
  tool TEXT NOT NULL,
  class TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  op_index BIGINT NOT NULL,
  input_digest TEXT NOT NULL,
  input_redacted_json TEXT,
  target_kind TEXT,
  target_id TEXT,
  target_revision TEXT,
  result TEXT NOT NULL,
  error_message TEXT,
  confirmation_id TEXT,
  preview_digest TEXT,
  masked_count BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  finished_at BIGINT,
  duration_ms BIGINT,
  PRIMARY KEY (workspace_id, id)
)`,
      "CREATE UNIQUE INDEX IF NOT EXISTS platform_mcp_actions_call_uq ON platform_mcp_actions (workspace_id, session_id, tool_use_id, op_index)",
      "CREATE INDEX IF NOT EXISTS platform_mcp_actions_ws_created_idx ON platform_mcp_actions (workspace_id, created_at, id)",
      "CREATE INDEX IF NOT EXISTS platform_mcp_actions_ws_target_idx ON platform_mcp_actions (workspace_id, target_id)",
      `CREATE TABLE IF NOT EXISTS platform_mcp_confirmations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  result TEXT NOT NULL,
  preview_digest TEXT NOT NULL,
  op_classes_json TEXT NOT NULL,
  target_revisions_json TEXT NOT NULL,
  event_id TEXT,
  created_at BIGINT NOT NULL,
  used_at BIGINT
)`,
      "CREATE INDEX IF NOT EXISTS platform_mcp_confirmations_call_idx ON platform_mcp_confirmations (workspace_id, session_id, tool_use_id, created_at)",
      `CREATE TABLE IF NOT EXISTS session_owners (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
)`,
      `CREATE TABLE IF NOT EXISTS platform_mcp_settings (
  workspace_id TEXT PRIMARY KEY,
  enabled BIGINT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at BIGINT NOT NULL
)`,
    ],
  },
] as const;

const ready = new WeakMap<SqlClient, Promise<void>>();

/** Runs the missing steps once per client. A failed run is forgotten, so the
 * next call tries again. */
export function ensurePlatformMcpSchema(sql: SqlClient): Promise<void> {
  const cached = ready.get(sql);
  if (cached) return cached;
  const pending = (async () => {
    await sql.exec(
      "CREATE TABLE IF NOT EXISTS platform_mcp_schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)",
    );
    const rows = await sql.prepare("SELECT id FROM platform_mcp_schema_migrations").all<{ id: string }>();
    const applied = new Set((rows.results ?? []).map((row) => row.id));
    for (const step of PLATFORM_MCP_MIGRATIONS) {
      if (applied.has(step.id)) continue;
      for (const statement of step.statements) await sql.exec(statement);
      await sql
        .prepare("INSERT INTO platform_mcp_schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING")
        .bind(step.id, Date.now())
        .run();
    }
  })().catch((error: unknown) => {
    ready.delete(sql);
    throw error;
  });
  ready.set(sql, pending);
  return pending;
}

/** BIGINT columns come back as strings from Postgres. */
export function toMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function toIso(value: number | string | null | undefined): string | null {
  const ms = toMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

export function fromIso(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${value}`);
  return ms;
}

/** Keyset cursor `<created_at ms>.<id>`, base64url. */
export function encodeCursor(createdAt: number, id: string): string {
  return Buffer.from(`${createdAt}.${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const dot = text.indexOf(".");
  if (dot <= 0) return null;
  const createdAt = Number(text.slice(0, dot));
  if (!Number.isFinite(createdAt)) return null;
  return { createdAt, id: text.slice(dot + 1) };
}
