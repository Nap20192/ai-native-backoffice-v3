// Session tables the trace reads (events, executions, sessions) on an in-memory SQLite.
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { sessionExecutionCoordinatorSqlSchema } from "@open-managed-agents/session-runtime-sql/coordination";
import type { TraceProjectorInput } from "../../src/lib/trace/types";
import type { TraceTurnFixture } from "./trace-harness-conformance";

/** Same columns as the Drizzle baseline (migrations-sqlite). */
const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS managed_session_events (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  type text NOT NULL,
  document text NOT NULL,
  processed_at integer NOT NULL,
  thread_id text,
  PRIMARY KEY (workspace_id, session_id, id)
)`;
const EVENTS_INDEX = `CREATE INDEX IF NOT EXISTS idx_managed_session_events_workspace_session_time_id
  ON managed_session_events (workspace_id, session_id, processed_at, id)`;
const SESSIONS_DDL = `CREATE TABLE IF NOT EXISTS managed_sessions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  agent_version integer NOT NULL,
  environment_id text NOT NULL,
  deployment_id text,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
)`;

export async function createHistoryDb(): Promise<SqlClient> {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  for (const statement of sessionExecutionCoordinatorSqlSchema.split(";\n").map((part) => part.trim().replace(/;$/u, "")).filter(Boolean)) {
    await sql.exec(statement);
  }
  await sql.exec(EVENTS_DDL);
  await sql.exec(EVENTS_INDEX);
  await sql.exec(SESSIONS_DDL);
  return sql;
}

export async function insertSession(sql: SqlClient, workspaceId: string, sessionId: string, options: { harness?: string; agentName?: string } = {}): Promise<void> {
  const document = { id: sessionId, agent: { name: options.agentName ?? "agent", ...(options.harness !== undefined && { openma: { harness: options.harness } }) } };
  await sql.prepare(
    `INSERT INTO managed_sessions (id, workspace_id, document, revision, agent_id, agent_version, environment_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'agent_1', 1, 'env_1', 'idle', 0, 0)`,
  ).bind(sessionId, workspaceId, JSON.stringify(document)).run();
}

export async function insertEvent(sql: SqlClient, workspaceId: string, sessionId: string, row: { id: string; type: string; processed_at: number; thread_id?: string | null; document: Record<string, unknown> }): Promise<void> {
  await sql.prepare(
    `INSERT INTO managed_session_events (workspace_id, session_id, id, type, document, processed_at, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(workspaceId, sessionId, row.id, row.type, JSON.stringify(row.document), row.processed_at, row.thread_id ?? null).run();
}

export interface ExecutionRowInput {
  id: string;
  lane_id?: string;
  admitted_at_ms: number;
  events: unknown[];
  state: string;
  attempt_id: string | null;
  owner_id?: string | null;
  generation?: number;
  claimed_at_ms: number | null;
  lease_expires_at_ms: number | null;
  settled_at_ms: number | null;
  failure?: string | null;
}

export async function insertExecution(sql: SqlClient, workspaceId: string, sessionId: string, row: ExecutionRowInput): Promise<void> {
  await sql.prepare(
    `INSERT INTO managed_session_executions (workspace_id, session_id, lane_id, id, admitted_at_ms, events_json,
       events_fingerprint, state, attempt_id, owner_id, generation, attempt_count, max_attempts, deadline_at_ms,
       claimed_at_ms, lease_expires_at_ms, settled_at_ms, failure)
     VALUES (?, ?, ?, ?, ?, ?, 'fp', ?, ?, ?, ?, 1, 10, ?, ?, ?, ?, ?)`,
  ).bind(
    workspaceId, sessionId, row.lane_id ?? "sthr_primary", row.id, row.admitted_at_ms, JSON.stringify(row.events),
    row.state, row.attempt_id, row.owner_id ?? null, row.generation ?? 1, row.admitted_at_ms + 3_600_000,
    row.claimed_at_ms, row.lease_expires_at_ms, row.settled_at_ms, row.failure ?? null,
  ).run();
}

/** Loads a recorded fixture turn into the session tables. */
export async function loadFixtureHistory(sql: SqlClient, workspaceId: string, fixture: TraceTurnFixture, override: Partial<ExecutionRowInput> = {}): Promise<void> {
  const sessionId = fixture.scope.sessionId;
  const existing = await sql.prepare("SELECT id FROM managed_sessions WHERE id = ?").bind(sessionId).first();
  if (existing === null) await insertSession(sql, workspaceId, sessionId, { ...(fixture.harness !== null && { harness: fixture.harness }) });
  for (const row of fixture.history ?? []) await insertEvent(sql, workspaceId, sessionId, row);
  const execution = fixture.execution as unknown as ExecutionRowInput;
  await insertExecution(sql, workspaceId, sessionId, { ...execution, ...override });
}

const HISTORY_TYPES = new Set([
  "agent.custom_tool_use", "agent.mcp_tool_result", "agent.mcp_tool_use", "agent.message", "agent.thinking",
  "agent.thread_message_received", "agent.thread_message_sent", "agent.tool_result", "agent.tool_use",
  "session.error", "session.warning", "session.status_idle", "session.status_rescheduled", "session.status_running",
  "session.status_terminated", "session.thread_created", "session.thread_status_idle", "session.thread_status_running",
  "session.thread_status_terminated", "session.usage", "span.model_request_start", "span.model_request_end",
  "span.outcome_evaluation_start", "span.outcome_evaluation_ongoing", "span.outcome_evaluation_end",
]);

const camelKey = (key: string) => key.replace(/_([a-z0-9])/gu, (_match, letter: string) => letter.toUpperCase());
function camel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camel);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [camelKey(key), camel(item)]));
}

/** History rows and the execution row of a synthetic fixture turn, as the runtime would store them. */
export async function loadTurnInputsAsHistory(sql: SqlClient, workspaceId: string, sessionId: string, executionId: string, inputs: readonly TraceProjectorInput[], options: { attemptId?: string } = {}): Promise<void> {
  const started = inputs.find((input) => input.kind === "execution_started");
  const settled = inputs.find((input) => input.kind === "execution_settled");
  const events = started?.kind === "execution_started" ? [...started.events] : [];
  for (const event of events) {
    const record = event as { id: string; type: string; processedAt?: string };
    await insertEvent(sql, workspaceId, sessionId, { id: record.id, type: record.type, processed_at: Date.parse(record.processedAt ?? new Date(0).toISOString()), document: { ...record } });
  }
  for (const input of inputs) {
    if (input.kind !== "frame") continue;
    const frame = input.frame as Record<string, unknown> & { id: string; type: string; processed_at: string };
    if (!HISTORY_TYPES.has(frame.type)) continue;
    const document = { ...(camel(frame) as Record<string, unknown>), source_position: { execution_id: executionId } };
    await insertEvent(sql, workspaceId, sessionId, { id: frame.id, type: frame.type, processed_at: Date.parse(frame.processed_at), thread_id: (frame.session_thread_id as string | undefined) ?? null, document });
  }
  const first = events[0] as { processedAt?: string } | undefined;
  const admitted = Date.parse(first?.processedAt ?? new Date(0).toISOString());
  const outcome = settled?.kind === "execution_settled" ? settled.outcome : "completed";
  await insertExecution(sql, workspaceId, sessionId, {
    id: executionId,
    admitted_at_ms: admitted,
    events,
    state: outcome === "completed" ? "completed" : outcome === "failed" ? "failed" : "cancelled",
    attempt_id: options.attemptId ?? (started?.kind === "execution_started" ? started.fence?.attemptId ?? null : null),
    claimed_at_ms: started?.kind === "execution_started" ? started.atMs - 1 : admitted,
    lease_expires_at_ms: admitted + 30_000,
    settled_at_ms: settled?.kind === "execution_settled" ? settled.atMs : admitted + 1,
  });
}
