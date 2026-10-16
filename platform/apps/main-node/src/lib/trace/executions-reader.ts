import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionExecutionState } from "@open-managed-agents/session-runtime-contract/coordination";
import type { TraceScope } from "./types.js";

/** Read-only view of managed_session_executions: one execution is one top-level turn. */
export interface TraceExecutionRow {
  id: string;
  lane_id: string;
  admitted_at_ms: number;
  state: SessionExecutionState;
  attempt_id: string | null;
  generation: number;
  claimed_at_ms: number | null;
  lease_expires_at_ms: number | null;
  settled_at_ms: number | null;
  failure: string | null;
  /** Accepted events of the turn. Empty in list(), filled by find(). */
  events: unknown[];
}

export interface TraceExecutionsReader {
  list(scope: TraceScope): Promise<TraceExecutionRow[]>;
  find(scope: TraceScope, executionId: string): Promise<TraceExecutionRow | null>;
}

interface RawExecution {
  id: string;
  lane_id: string;
  admitted_at_ms: number | string;
  state: string;
  attempt_id: string | null;
  generation: number | string | null;
  claimed_at_ms: number | string | null;
  lease_expires_at_ms: number | string | null;
  settled_at_ms: number | string | null;
  failure: string | null;
  events_json?: string | unknown[] | null;
}

const COLUMNS = `id, lane_id, admitted_at_ms, state, attempt_id, generation, claimed_at_ms,
  lease_expires_at_ms, settled_at_ms, failure`;

const numOrNull = (value: number | string | null): number | null => value === null ? null : Number(value);

function toRow(raw: RawExecution): TraceExecutionRow {
  let events: unknown[] = [];
  if (Array.isArray(raw.events_json)) events = raw.events_json;
  else if (typeof raw.events_json === "string") {
    try {
      const parsed = JSON.parse(raw.events_json) as unknown;
      if (Array.isArray(parsed)) events = parsed;
    } catch {
      events = [];
    }
  }
  return {
    id: raw.id,
    lane_id: raw.lane_id,
    admitted_at_ms: Number(raw.admitted_at_ms),
    state: raw.state as SessionExecutionState,
    attempt_id: raw.attempt_id,
    generation: Number(raw.generation ?? 0),
    claimed_at_ms: numOrNull(raw.claimed_at_ms),
    lease_expires_at_ms: numOrNull(raw.lease_expires_at_ms),
    settled_at_ms: numOrNull(raw.settled_at_ms),
    failure: raw.failure,
    events,
  };
}

export function createExecutionsReader(sql: SqlClient): TraceExecutionsReader {
  return {
    async list(scope) {
      const rows = await sql.prepare(
        `SELECT ${COLUMNS} FROM managed_session_executions
         WHERE workspace_id = ? AND session_id = ? ORDER BY admitted_at_ms, id`,
      ).bind(scope.workspaceId, scope.sessionId).all<RawExecution>();
      return (rows.results ?? []).map(toRow);
    },
    async find(scope, executionId) {
      const raw = await sql.prepare(
        `SELECT ${COLUMNS}, events_json FROM managed_session_executions
         WHERE workspace_id = ? AND session_id = ? AND id = ?`,
      ).bind(scope.workspaceId, scope.sessionId, executionId).first<RawExecution>();
      return raw === null ? null : toRow(raw);
    },
  };
}

/** The execution no longer runs: it settled, or its lease ran out. */
export function executionStopped(execution: TraceExecutionRow, nowMs: number): boolean {
  if (execution.state === "completed" || execution.state === "failed" || execution.state === "cancelled") return true;
  if (execution.state === "running") return execution.lease_expires_at_ms !== null && execution.lease_expires_at_ms < nowMs;
  return false;
}
