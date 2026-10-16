import type { SqlClient, SqlStatement } from "@open-managed-agents/sql-client";
import type { TraceCoverage, TraceScope, TraceTurnState, TraceTurnWrite } from "./types.js";

/** trace_turns: one summary row per top-level turn (plan section 3.1). */

export interface TraceTurnRow {
  turn_id: string;
  thread_id: string;
  attempt_id: string | null;
  attempt_generation: number;
  state: Exclude<TraceTurnState, "not_built">;
  frames_lost: boolean;
  lost: string[];
  history_cursor: string | null;
  start_ms: number;
  end_ms: number | null;
  span_count: number;
  error_count: number;
  waiting_count: number;
  coverage: TraceCoverage;
  version: number;
  updated_at: number;
}

const DEFAULT_COVERAGE: TraceCoverage = { model_calls: "absent", tools: "absent", sandbox: "attempts" };

const TURN_COLUMNS = `turn_id, thread_id, attempt_id, attempt_generation, state, frames_lost, lost,
  history_cursor, start_ms, end_ms, span_count, error_count, waiting_count, coverage, version, updated_at`;

interface RawTurnRow {
  turn_id: string;
  thread_id: string;
  attempt_id: string | null;
  attempt_generation: number | string | null;
  state: string;
  frames_lost: number | string;
  lost: string;
  history_cursor: string | null;
  start_ms: number | string;
  end_ms: number | string | null;
  span_count: number | string;
  error_count: number | string;
  waiting_count: number | string;
  coverage: string;
  version: number | string;
  updated_at: number | string;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (typeof text !== "string" || text.length === 0) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toTurnRow(raw: RawTurnRow): TraceTurnRow {
  return {
    turn_id: raw.turn_id,
    thread_id: raw.thread_id,
    attempt_id: raw.attempt_id,
    attempt_generation: Number(raw.attempt_generation ?? 0),
    state: raw.state as TraceTurnRow["state"],
    frames_lost: Number(raw.frames_lost) === 1,
    lost: parseJson<string[]>(raw.lost, []),
    history_cursor: raw.history_cursor,
    start_ms: Number(raw.start_ms),
    end_ms: raw.end_ms === null ? null : Number(raw.end_ms),
    span_count: Number(raw.span_count),
    error_count: Number(raw.error_count),
    waiting_count: Number(raw.waiting_count),
    coverage: { ...DEFAULT_COVERAGE, ...parseJson<Partial<TraceCoverage>>(raw.coverage, {}) },
    version: Number(raw.version),
    updated_at: Number(raw.updated_at),
  };
}

export class TraceTurnStore {
  constructor(private readonly sql: SqlClient) {}

  async find(scope: TraceScope, turnId: string): Promise<TraceTurnRow | null> {
    const raw = await this.sql.prepare(
      `SELECT ${TURN_COLUMNS} FROM trace_turns WHERE workspace_id = ? AND session_id = ? AND turn_id = ?`,
    ).bind(scope.workspaceId, scope.sessionId, turnId).first<RawTurnRow>();
    return raw === null ? null : toTurnRow(raw);
  }

  async list(scope: TraceScope): Promise<TraceTurnRow[]> {
    const rows = await this.sql.prepare(
      `SELECT ${TURN_COLUMNS} FROM trace_turns WHERE workspace_id = ? AND session_id = ?
        ORDER BY start_ms, turn_id`,
    ).bind(scope.workspaceId, scope.sessionId).all<RawTurnRow>();
    return (rows.results ?? []).map(toTurnRow);
  }

  async changes(scope: TraceScope, after: { u: number; t: string } | null, limit: number): Promise<TraceTurnRow[]> {
    const u = after?.u ?? -1;
    const t = after?.t ?? "";
    const rows = await this.sql.prepare(
      `SELECT ${TURN_COLUMNS} FROM trace_turns WHERE workspace_id = ? AND session_id = ?
        AND (updated_at > ? OR (updated_at = ? AND turn_id > ?))
        ORDER BY updated_at, turn_id LIMIT ?`,
    ).bind(scope.workspaceId, scope.sessionId, u, u, t, limit).all<RawTurnRow>();
    return (rows.results ?? []).map(toTurnRow);
  }

  /** A new attempt takes the turn. A stale (lower generation) claim changes nothing. */
  claim(scope: TraceScope, turn: TraceTurnWrite, now: number): SqlStatement {
    return this.sql.prepare(
      `INSERT INTO trace_turns (workspace_id, session_id, turn_id, thread_id, attempt_id, attempt_generation,
         state, frames_lost, lost, history_cursor, start_ms, end_ms, span_count, error_count, waiting_count,
         coverage, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 0, '[]', NULL, ?, NULL, 0, 0, 0, ?, 1, ?)
       ON CONFLICT (workspace_id, session_id, turn_id) DO UPDATE SET
         attempt_id = excluded.attempt_id,
         attempt_generation = excluded.attempt_generation,
         thread_id = excluded.thread_id,
         state = 'open',
         end_ms = NULL,
         version = trace_turns.version + 1,
         updated_at = excluded.updated_at
       WHERE trace_turns.attempt_generation <= excluded.attempt_generation`,
    ).bind(
      scope.workspaceId, scope.sessionId, turn.turn_id, turn.thread_id, turn.attempt_id,
      turn.attempt_generation, turn.start_ms, JSON.stringify(turn.coverage), now,
    );
  }

  /** Updates of the attempt that holds the turn. */
  update(scope: TraceScope, turn: TraceTurnWrite, now: number): SqlStatement {
    return this.sql.prepare(
      `UPDATE trace_turns SET thread_id = ?, end_ms = ?, coverage = ?,
         version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ? AND COALESCE(attempt_id, '') = ?`,
    ).bind(
      turn.thread_id, turn.end_ms, JSON.stringify(turn.coverage), now,
      scope.workspaceId, scope.sessionId, turn.turn_id, turn.attempt_id ?? "",
    );
  }

  /** Span counts come from trace_spans, so patches of later turns stay correct. */
  recount(scope: TraceScope, turnId: string, now: number): SqlStatement {
    const base = `FROM trace_spans s WHERE s.workspace_id = trace_turns.workspace_id
      AND s.session_id = trace_turns.session_id AND s.turn_id = trace_turns.turn_id AND s.deleted = 0`;
    return this.sql.prepare(
      `UPDATE trace_turns SET
         span_count = (SELECT COUNT(*) ${base}),
         error_count = (SELECT COUNT(*) ${base} AND s.status = 'error'),
         waiting_count = (SELECT COUNT(*) ${base} AND s.status = 'waiting'),
         version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ?`,
    ).bind(now, scope.workspaceId, scope.sessionId, turnId);
  }

  async finalize(scope: TraceScope, input: {
    turnId: string;
    attemptId: string | null;
    state: "complete" | "repaired";
    historyCursor: string | null;
    lost: string[];
    framesLost?: boolean;
  }, now: number): Promise<boolean> {
    const result = await this.sql.prepare(
      `UPDATE trace_turns SET state = ?, history_cursor = ?, lost = ?,
         frames_lost = CASE WHEN ? = 1 THEN 1 ELSE frames_lost END,
         version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ? AND COALESCE(attempt_id, '') = ?
         AND (? = 'repaired' OR frames_lost = 0)`,
    ).bind(
      input.state, input.historyCursor, JSON.stringify(input.lost), input.framesLost ? 1 : 0, now,
      scope.workspaceId, scope.sessionId, input.turnId, input.attemptId ?? "", input.state,
    ).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async markFramesLost(scope: TraceScope, turnId: string, attemptId: string | null, now: number): Promise<void> {
    await this.sql.prepare(
      `UPDATE trace_turns SET frames_lost = 1, version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ? AND COALESCE(attempt_id, '') = ?`,
    ).bind(now, scope.workspaceId, scope.sessionId, turnId, attemptId ?? "").run();
  }
}
