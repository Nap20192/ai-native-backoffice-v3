// Table `harness_cards`, created by code on first use
// (docs/plans/models-harness.md, 3.7). The same SQL runs on SQLite and
// Postgres: `*_json` columns hold JSON as text, times are BIGINT ms.
import type { SqlClient } from "@open-managed-agents/sql-client";

export const HARNESS_CARD_MIGRATIONS = [
  {
    id: "0001_harness_cards",
    statements: [
      `CREATE TABLE IF NOT EXISTS harness_cards (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,
  cwd TEXT,
  install_json TEXT NOT NULL,
  protocols_json TEXT NOT NULL,
  allowed_env_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  archived_at BIGINT,
  PRIMARY KEY (workspace_id, id)
)`,
      "CREATE UNIQUE INDEX IF NOT EXISTS harness_cards_ws_harness_uq ON harness_cards (workspace_id, harness_id)",
      "CREATE INDEX IF NOT EXISTS harness_cards_ws_created_idx ON harness_cards (workspace_id, created_at, id)",
    ],
  },
] as const;

const ready = new WeakMap<SqlClient, Promise<void>>();

/** Runs the missing steps once per client. A failed run is forgotten, so the
 * next call tries again. */
export function ensureHarnessCardSchema(sql: SqlClient): Promise<void> {
  const cached = ready.get(sql);
  if (cached) return cached;
  const pending = (async () => {
    await sql.exec(
      "CREATE TABLE IF NOT EXISTS harness_card_schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)",
    );
    const rows = await sql.prepare("SELECT id FROM harness_card_schema_migrations").all<{ id: string }>();
    const applied = new Set((rows.results ?? []).map((row) => row.id));
    for (const step of HARNESS_CARD_MIGRATIONS) {
      if (applied.has(step.id)) continue;
      for (const statement of step.statements) await sql.exec(statement);
      await sql
        .prepare("INSERT INTO harness_card_schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING")
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
