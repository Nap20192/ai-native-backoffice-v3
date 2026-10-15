import type { SqlClient } from "@open-managed-agents/sql-client";

export const ANALYTICS_MIGRATIONS = [
  { id: "0001_model_calls", statements: [
    `CREATE TABLE IF NOT EXISTS model_calls (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_version INTEGER,
  agent_name TEXT NOT NULL,
  environment_id TEXT,
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  card_id TEXT,
  provider TEXT,
  wire_model TEXT,
  model_source TEXT NOT NULL,
  effort TEXT,
  speed TEXT NOT NULL,
  provider_response_id TEXT,
  started_at BIGINT,
  ended_at BIGINT NOT NULL,
  day TEXT NOT NULL,
  latency_ms BIGINT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  usage_reported INTEGER NOT NULL,
  is_error INTEGER NOT NULL,
  finish_reason TEXT,
  error_message TEXT,
  cost_usd_micros BIGINT,
  cost_input_usd_micros BIGINT,
  cost_output_usd_micros BIGINT,
  cost_cache_read_usd_micros BIGINT,
  cost_cache_write_usd_micros BIGINT,
  price_source TEXT NOT NULL,
  recorded_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, id)
)`,
    `CREATE INDEX IF NOT EXISTS model_calls_ws_day_idx ON model_calls (workspace_id, day)`,
    `CREATE INDEX IF NOT EXISTS model_calls_ws_ended_idx ON model_calls (workspace_id, ended_at, id)`,
    `CREATE INDEX IF NOT EXISTS model_calls_ws_session_idx ON model_calls (workspace_id, session_id, ended_at)`,
    `CREATE INDEX IF NOT EXISTS model_calls_ws_card_ended_idx ON model_calls (workspace_id, card_id, ended_at)`,
  ] },
  { id: "0002_model_card_limits", statements: [
    `CREATE TABLE IF NOT EXISTS model_card_limits (
  workspace_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  requests_per_minute BIGINT,
  input_tokens_per_minute BIGINT,
  output_tokens_per_minute BIGINT,
  updated_at BIGINT NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (workspace_id, card_id)
)`,
  ] },
] as const;
const ready = new WeakMap<SqlClient, Promise<void>>();
export function ensureAnalyticsSchema(sql: SqlClient): Promise<void> {
  const cached = ready.get(sql);
  if (cached) return cached;
  const pending = (async () => {
    await sql.exec("CREATE TABLE IF NOT EXISTS analytics_schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
    const applied = new Set((await sql.prepare("SELECT id FROM analytics_schema_migrations").all<{id: string}>()).results?.map(row => row.id));
    for (const step of ANALYTICS_MIGRATIONS) {
      if (applied.has(step.id)) continue;
      for (const statement of step.statements) await sql.exec(statement);
      await sql.prepare("INSERT INTO analytics_schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING").bind(step.id, Date.now()).run();
    }
  })().catch(error => { ready.delete(sql); throw error; });
  ready.set(sql, pending);
  return pending;
}
