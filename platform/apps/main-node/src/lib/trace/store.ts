import type { SqlClient, SqlStatement } from "@open-managed-agents/sql-client";
import { turnSpanIdFor } from "./ids.js";
import { TraceTurnStore, type TraceTurnRow } from "./turn-store.js";
import type {
  TraceAttrs,
  TraceOp,
  TraceScope,
  TraceSpan,
  TraceSpanPatch,
  TraceSpanWrite,
  TraceStatus,
} from "./types.js";

export type { TraceTurnRow } from "./turn-store.js";

/**
 * trace_spans and trace_turns on SQLite and Postgres (plan section 3.1).
 * Tables are created on first access with their own migration list.
 */
export type TraceSqlDialect = "sqlite" | "postgres";

export const TRACE_MIGRATIONS = [
  {
    id: "0001_trace_spans_turns",
    statements: [
      `CREATE TABLE IF NOT EXISTS trace_spans (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  turn_id TEXT,
  attempt_id TEXT,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  precision TEXT NOT NULL,
  start_ms BIGINT NOT NULL,
  end_ms BIGINT,
  status TEXT NOT NULL,
  error_type TEXT,
  error_message TEXT,
  harness TEXT,
  model TEXT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  ttft_ms BIGINT,
  finish_reason TEXT,
  tool_name TEXT,
  tool_call_id TEXT,
  primary_event_id TEXT,
  event_ids TEXT NOT NULL,
  attrs TEXT NOT NULL,
  version BIGINT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, session_id, span_id)
)`,
      `CREATE INDEX IF NOT EXISTS trace_spans_changes_idx ON trace_spans (workspace_id, session_id, updated_at, span_id)`,
      `CREATE INDEX IF NOT EXISTS trace_spans_turn_idx ON trace_spans (workspace_id, session_id, turn_id, start_ms, span_id)`,
      `CREATE INDEX IF NOT EXISTS trace_spans_call_idx ON trace_spans (workspace_id, session_id, tool_call_id)`,
      `CREATE INDEX IF NOT EXISTS trace_spans_ws_updated_idx ON trace_spans (workspace_id, updated_at)`,
      `CREATE TABLE IF NOT EXISTS trace_turns (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  attempt_id TEXT,
  attempt_generation BIGINT NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  frames_lost INTEGER NOT NULL DEFAULT 0,
  lost TEXT NOT NULL,
  history_cursor TEXT,
  start_ms BIGINT NOT NULL,
  end_ms BIGINT,
  span_count BIGINT NOT NULL DEFAULT 0,
  error_count BIGINT NOT NULL DEFAULT 0,
  waiting_count BIGINT NOT NULL DEFAULT 0,
  coverage TEXT NOT NULL,
  version BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, session_id, turn_id)
)`,
      `CREATE INDEX IF NOT EXISTS trace_turns_session_idx ON trace_turns (workspace_id, session_id, start_ms, turn_id)`,
      `CREATE INDEX IF NOT EXISTS trace_turns_updated_idx ON trace_turns (workspace_id, session_id, updated_at, turn_id)`,
    ],
  },
] as const;

const schemaReady = new WeakMap<SqlClient, Promise<void>>();

export function ensureTraceSchema(sql: SqlClient): Promise<void> {
  const cached = schemaReady.get(sql);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    await sql.exec("CREATE TABLE IF NOT EXISTS trace_schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)");
    const applied = new Set(
      ((await sql.prepare("SELECT id FROM trace_schema_migrations").all<{ id: string }>()).results ?? [])
        .map((row) => row.id),
    );
    for (const step of TRACE_MIGRATIONS) {
      if (applied.has(step.id)) continue;
      for (const statement of step.statements) await sql.exec(statement);
      await sql.prepare(
        "INSERT INTO trace_schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING",
      ).bind(step.id, Date.now()).run();
    }
  })().catch((error: unknown) => {
    schemaReady.delete(sql);
    throw error;
  });
  schemaReady.set(sql, pending);
  return pending;
}

export interface TraceApplyBatch {
  turnId: string;
  attemptId: string | null;
  ops: readonly TraceOp[];
}

export interface TraceApplyResult {
  /** Spans of the own turn were refused: another attempt holds the turn. */
  fenced: boolean;
  /** Patched or inherited spans whose row does not exist yet. */
  missing: Array<{ span_id: string; key_event_id: string }>;
}

export interface TraceCloseOpenSpansInput {
  atMs: number;
  endReason: string;
  exceptAttemptId?: string | null;
  owner?: { attemptId: string | null; generation: number };
}

export interface TraceStore {
  readonly dialect: TraceSqlDialect;
  ensureSchema(): Promise<void>;
  apply(scope: TraceScope, batch: TraceApplyBatch): Promise<TraceApplyResult>;
  finalizeTurn(scope: TraceScope, input: {
    turnId: string;
    attemptId: string | null;
    state: "complete" | "repaired";
    historyCursor: string | null;
    lost: string[];
    framesLost?: boolean;
  }): Promise<boolean>;
  markFramesLost(scope: TraceScope, turnId: string, attemptId: string | null): Promise<void>;
  /**
   * Closes open spans of a turn as interrupted, except waiting ones and the
   * turn span. With `owner` it closes only while that attempt and generation
   * hold the turn: a repair must not close what a newer attempt writes.
   */
  closeOpenSpans(scope: TraceScope, turnId: string, input: TraceCloseOpenSpansInput): Promise<number>;
  /** Session stop, archive or delete: waiting tools get cancelled, open confirmed executions interrupted. */
  cancelWaiting(scope: TraceScope, atMs: number): Promise<number>;
  markDeleted(scope: TraceScope, spanId: string): Promise<void>;
  deleteSession(scope: TraceScope): Promise<void>;
  purgeUpdatedBefore(cutoffMs: number): Promise<void>;
  readTurns(scope: TraceScope): Promise<TraceTurnRow[]>;
  readTurn(scope: TraceScope, turnId: string): Promise<TraceTurnRow | null>;
  readTurnChanges(scope: TraceScope, after: { u: number; t: string } | null, limit: number): Promise<TraceTurnRow[]>;
  readSpansByIds(scope: TraceScope, spanIds: readonly string[]): Promise<TraceSpan[]>;
  readTurnSpans(scope: TraceScope, turnIds: readonly string[], after: { m: number; s: string } | null, limit: number): Promise<TraceSpan[]>;
  readChanges(scope: TraceScope, after: { u: number; s: string } | null, limit: number): Promise<TraceSpan[]>;
  readSessionSpans(scope: TraceScope, after: { m: number; s: string } | null, limit: number): Promise<TraceSpan[]>;
  search(scope: TraceScope, query: string, after: { m: number; s: string } | null, limit: number): Promise<TraceSpan[]>;
}

export interface TraceStoreOptions {
  sql: SqlClient;
  dialect: TraceSqlDialect;
  now?: () => number;
}

export function createTraceStore(options: TraceStoreOptions): TraceStore {
  return new SqlTraceStore(options);
}

const ATTRS_LIMIT = 8 * 1024;
/** Fields of TraceSpan without own columns, kept in attrs under these keys. */
const HIDDEN_ATTRS = ["tool_kind", "mcp_server", "retry_status"] as const;

const SPAN_COLUMNS = [
  "workspace_id", "session_id", "span_id", "parent_span_id", "turn_id", "attempt_id", "thread_id",
  "kind", "name", "source", "precision", "start_ms", "end_ms", "status", "error_type", "error_message",
  "harness", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "ttft_ms", "finish_reason", "tool_name", "tool_call_id", "primary_event_id", "event_ids", "attrs",
  "version", "deleted", "updated_at",
] as const;
type SpanColumn = typeof SPAN_COLUMNS[number];

const BIGINT_COLUMNS = new Set<SpanColumn>([
  "start_ms", "end_ms", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  "ttft_ms", "version", "deleted", "updated_at",
]);
const KEY_COLUMNS = new Set<SpanColumn>(["workspace_id", "session_id", "span_id"]);
/** Columns an upsert may replace. version, deleted and updated_at are handled apart. */
const VALUE_COLUMNS = SPAN_COLUMNS.filter((column) =>
  !KEY_COLUMNS.has(column) && column !== "version" && column !== "deleted" && column !== "updated_at");
const TIMING_COLUMNS = new Set<SpanColumn>(["start_ms", "precision"]);

/**
 * Merge rules of plan 3.1 inside ON CONFLICT:
 * - keep: a measured row keeps its timing against a by-events copy (repair);
 * - hold: a closed row is not reopened, a resolved row does not go back to waiting,
 *   and a closed measured row ignores a by-events copy entirely.
 */
const KEEP = "(trace_spans.precision = 'measured' AND excluded.precision = 'by_events')";
const HOLD = `((trace_spans.end_ms IS NOT NULL AND excluded.end_ms IS NULL)
  OR (excluded.status = 'waiting' AND trace_spans.status <> 'waiting')
  OR (${KEEP} AND trace_spans.end_ms IS NOT NULL))`;

function upsertSetClause(): string {
  const sets = VALUE_COLUMNS.map((column) => {
    if (TIMING_COLUMNS.has(column)) {
      return `${column} = CASE WHEN ${HOLD} OR ${KEEP} THEN trace_spans.${column} ELSE excluded.${column} END`;
    }
    if (column === "ttft_ms") {
      return `ttft_ms = CASE WHEN ${HOLD} THEN trace_spans.ttft_ms ELSE COALESCE(excluded.ttft_ms, trace_spans.ttft_ms) END`;
    }
    return `${column} = CASE WHEN ${HOLD} THEN trace_spans.${column} ELSE excluded.${column} END`;
  });
  sets.push("version = trace_spans.version + 1", "updated_at = excluded.updated_at");
  return sets.join(",\n  ");
}

const UPSERT_SET = upsertSetClause();

function castOf(column: SpanColumn): string {
  return BIGINT_COLUMNS.has(column) ? "BIGINT" : "TEXT";
}

/** SELECT list for INSERT ... SELECT: every value bound and cast, so Postgres knows the types. */
function selectList(inherit: boolean): string {
  return SPAN_COLUMNS.map((column) => {
    if (inherit && column === "turn_id") return "p.turn_id";
    if (inherit && column === "thread_id") return "p.thread_id";
    return `CAST(? AS ${castOf(column)})`;
  }).join(", ");
}

const FENCED_UPSERT = `INSERT INTO trace_spans (${SPAN_COLUMNS.join(", ")})
SELECT ${selectList(false)}
WHERE EXISTS (SELECT 1 FROM trace_turns t WHERE t.workspace_id = ? AND t.session_id = ? AND t.turn_id = ?
  AND COALESCE(t.attempt_id, '') = ?)
ON CONFLICT (workspace_id, session_id, span_id) DO UPDATE SET
  ${UPSERT_SET}`;

const INHERIT_UPSERT = `INSERT INTO trace_spans (${SPAN_COLUMNS.join(", ")})
SELECT ${selectList(true)}
FROM trace_spans p WHERE p.workspace_id = ? AND p.session_id = ? AND p.span_id = ?
ON CONFLICT (workspace_id, session_id, span_id) DO UPDATE SET
  ${UPSERT_SET}`;

function encodeAttrs(span: TraceSpanWrite): string {
  const attrs: TraceAttrs = { ...span.attrs };
  if (span.tool !== null) {
    attrs.tool_kind = span.tool.kind;
    if (span.tool.mcp_server !== null) attrs.mcp_server = span.tool.mcp_server;
  }
  if (span.error?.retry_status !== undefined) attrs.retry_status = span.error.retry_status;
  let text = JSON.stringify(attrs);
  if (text.length <= ATTRS_LIMIT) return text;
  // Drop the longest values until the JSON fits.
  const entries = Object.entries(attrs).sort((a, b) => String(b[1]).length - String(a[1]).length);
  while (text.length > ATTRS_LIMIT && entries.length > 0) {
    const [key] = entries.shift()!;
    delete attrs[key];
    attrs.attrs_truncated = true;
    text = JSON.stringify(attrs);
  }
  return text;
}

function spanValues(scope: TraceScope, span: TraceSpanWrite, now: number, inherit: boolean): unknown[] {
  const values: Record<SpanColumn, unknown> = {
    workspace_id: scope.workspaceId,
    session_id: scope.sessionId,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id,
    turn_id: span.turn_id,
    attempt_id: span.attempt_id,
    thread_id: span.thread_id,
    kind: span.kind,
    name: span.name.slice(0, 256),
    source: span.sources[0] ?? "events",
    precision: span.precision,
    start_ms: Math.round(span.start_ms),
    end_ms: span.end_ms === null ? null : Math.round(span.end_ms),
    status: span.status,
    error_type: span.error?.type ?? null,
    error_message: span.error?.message ?? null,
    harness: span.harness,
    model: span.model,
    input_tokens: span.usage?.input ?? null,
    output_tokens: span.usage?.output ?? null,
    cache_read_tokens: span.usage?.cache_read ?? null,
    cache_write_tokens: span.usage?.cache_write ?? null,
    ttft_ms: span.ttft_ms === null ? null : Math.round(span.ttft_ms),
    finish_reason: span.finish_reason,
    tool_name: span.tool?.name ?? null,
    tool_call_id: span.tool?.call_id ?? null,
    primary_event_id: span.primary_event_id,
    event_ids: JSON.stringify(span.event_ids),
    attrs: encodeAttrs(span),
    version: 1,
    deleted: 0,
    updated_at: now,
  };
  return SPAN_COLUMNS
    .filter((column) => !(inherit && (column === "turn_id" || column === "thread_id")))
    .map((column) => values[column]);
}

interface RawSpanRow {
  span_id: string;
  parent_span_id: string | null;
  turn_id: string | null;
  attempt_id: string | null;
  thread_id: string;
  kind: string;
  name: string;
  source: string;
  precision: string;
  start_ms: number | string;
  end_ms: number | string | null;
  status: string;
  error_type: string | null;
  error_message: string | null;
  harness: string | null;
  model: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  ttft_ms: number | string | null;
  finish_reason: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  primary_event_id: string | null;
  event_ids: string;
  attrs: string;
  version: number | string;
  deleted: number | string;
  updated_at: number | string;
}

const READ_COLUMNS = SPAN_COLUMNS.filter((column) => column !== "workspace_id" && column !== "session_id").join(", ");

const numOrNull = (value: number | string | null): number | null => value === null ? null : Number(value);

function parseObject(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function toTraceSpan(raw: RawSpanRow): TraceSpan {
  const stored = parseObject(raw.attrs);
  const attrs: TraceAttrs = {};
  for (const [key, value] of Object.entries(stored)) {
    if ((HIDDEN_ATTRS as readonly string[]).includes(key)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") attrs[key] = value;
  }
  const retry = stored.retry_status;
  const tokens = [raw.input_tokens, raw.output_tokens, raw.cache_read_tokens, raw.cache_write_tokens];
  let eventIds: string[] = [];
  try {
    const parsed = JSON.parse(raw.event_ids) as unknown;
    if (Array.isArray(parsed)) eventIds = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    eventIds = [];
  }
  return {
    span_id: raw.span_id,
    parent_span_id: raw.parent_span_id,
    turn_id: raw.turn_id,
    attempt_id: raw.attempt_id,
    thread_id: raw.thread_id,
    kind: raw.kind as TraceSpan["kind"],
    name: raw.name,
    sources: [raw.source as TraceSpan["sources"][number]],
    precision: raw.precision as TraceSpan["precision"],
    start_ms: Number(raw.start_ms),
    end_ms: numOrNull(raw.end_ms),
    status: raw.status as TraceStatus,
    error: raw.error_type === null && raw.error_message === null
      ? null
      : {
          type: raw.error_type,
          message: raw.error_message,
          ...((retry === "retrying" || retry === "exhausted") && { retry_status: retry }),
        },
    harness: raw.harness,
    model: raw.model,
    usage: tokens.every((value) => value === null)
      ? null
      : {
          input: Number(raw.input_tokens ?? 0),
          output: Number(raw.output_tokens ?? 0),
          cache_read: Number(raw.cache_read_tokens ?? 0),
          cache_write: Number(raw.cache_write_tokens ?? 0),
        },
    ttft_ms: numOrNull(raw.ttft_ms),
    finish_reason: raw.finish_reason,
    tool: raw.tool_name === null || raw.tool_call_id === null
      ? null
      : {
          name: raw.tool_name,
          call_id: raw.tool_call_id,
          kind: stored.tool_kind === "mcp" || stored.tool_kind === "custom" ? stored.tool_kind : "builtin",
          mcp_server: typeof stored.mcp_server === "string" ? stored.mcp_server : null,
        },
    primary_event_id: raw.primary_event_id,
    event_ids: eventIds,
    attrs,
    version: Number(raw.version),
    deleted: Number(raw.deleted) === 1,
    updated_at: Number(raw.updated_at),
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

interface PlannedStatement {
  statement: SqlStatement;
  kind: "own" | "inherit" | "patch" | "turn" | "other";
  spanId?: string;
  keyEventId?: string;
}

class SqlTraceStore implements TraceStore {
  readonly dialect: TraceSqlDialect;
  private readonly sql: SqlClient;
  private readonly now: () => number;
  private readonly turns: TraceTurnStore;

  constructor(options: TraceStoreOptions) {
    this.sql = options.sql;
    this.dialect = options.dialect;
    this.now = options.now ?? Date.now;
    this.turns = new TraceTurnStore(options.sql);
  }

  ensureSchema(): Promise<void> {
    return ensureTraceSchema(this.sql);
  }

  async apply(scope: TraceScope, batch: TraceApplyBatch): Promise<TraceApplyResult> {
    await this.ensureSchema();
    const now = this.now();
    const result: TraceApplyResult = { fenced: false, missing: [] };
    const claim = batch.ops.find((op): op is Extract<TraceOp, { op: "claim" }> => op.op === "claim");
    if (claim !== undefined) await this.claim(scope, claim.turn, now);

    // Last write of a span in the batch wins; the projector always sends the full row.
    const upserts = new Map<string, Extract<TraceOp, { op: "upsert" }>>();
    const patches: Array<Extract<TraceOp, { op: "patch" }>> = [];
    let turn: Extract<TraceOp, { op: "turn" }> | undefined;
    for (const op of batch.ops) {
      if (op.op === "upsert") {
        upserts.delete(op.span.span_id);
        upserts.set(op.span.span_id, op);
      } else if (op.op === "patch") patches.push(op);
      else if (op.op === "turn") turn = op;
    }

    const planned: PlannedStatement[] = [];
    for (const op of upserts.values()) {
      const span = { ...op.span, attrs: { ...op.span.attrs } };
      if (op.continued_thread !== undefined && span.attrs.continued_from === undefined) {
        const previous = await this.sql.prepare(
          `SELECT span_id FROM trace_spans WHERE workspace_id = ? AND session_id = ? AND kind = 'subagent'
             AND thread_id = ? AND COALESCE(turn_id, '') <> ? AND deleted = 0
           ORDER BY start_ms DESC, span_id DESC LIMIT 1`,
        ).bind(scope.workspaceId, scope.sessionId, op.continued_thread, span.turn_id ?? "").first<{ span_id: string }>();
        if (previous !== null) span.attrs.continued_from = previous.span_id;
      }
      if (op.inherit_from !== undefined) {
        planned.push({
          statement: this.sql.prepare(INHERIT_UPSERT).bind(
            ...spanValues(scope, span, now, true), scope.workspaceId, scope.sessionId, op.inherit_from,
          ),
          kind: "inherit",
          spanId: span.span_id,
          keyEventId: span.primary_event_id ?? span.span_id,
        });
      } else {
        planned.push({
          statement: this.sql.prepare(FENCED_UPSERT).bind(
            ...spanValues(scope, span, now, false),
            scope.workspaceId, scope.sessionId, batch.turnId, batch.attemptId ?? "",
          ),
          kind: "own",
          spanId: span.span_id,
        });
      }
    }
    for (const patch of patches) {
      planned.push({ statement: this.patchStatement(scope, patch.span_id, patch.expect, patch.set, now), kind: "patch", spanId: patch.span_id, keyEventId: patch.key_event_id });
    }
    if (turn !== undefined) planned.push({ statement: this.turns.update(scope, turn.turn, now), kind: "turn" });
    if (planned.length === 0) return result;

    const outcomes = await this.sql.batch(planned.map((item) => item.statement));
    const touchedSpans: string[] = [];
    const unresolved: PlannedStatement[] = [];
    planned.forEach((item, index) => {
      const changes = outcomes[index]?.meta?.changes ?? 0;
      if (item.kind === "own" && changes === 0) result.fenced = true;
      if (item.kind === "turn" && changes === 0) result.fenced = true;
      if ((item.kind === "patch" || item.kind === "inherit") && changes === 0) unresolved.push(item);
      if ((item.kind === "patch" || item.kind === "inherit") && changes > 0) touchedSpans.push(item.spanId!);
    });
    for (const item of unresolved) {
      if (item.kind === "inherit") {
        result.missing.push({ span_id: item.spanId!, key_event_id: item.keyEventId! });
        continue;
      }
      const exists = await this.sql.prepare(
        "SELECT 1 AS one FROM trace_spans WHERE workspace_id = ? AND session_id = ? AND span_id = ?",
      ).bind(scope.workspaceId, scope.sessionId, item.spanId).first();
      if (exists === null) result.missing.push({ span_id: item.spanId!, key_event_id: item.keyEventId! });
    }
    const turnIds = new Set<string>([batch.turnId]);
    if (touchedSpans.length > 0) {
      for (const span of await this.readSpansByIds(scope, touchedSpans)) {
        if (span.turn_id !== null) turnIds.add(span.turn_id);
      }
    }
    await this.sql.batch([...turnIds].map((turnId) => this.turns.recount(scope, turnId, now)));
    return result;
  }

  private async claim(scope: TraceScope, turn: Extract<TraceOp, { op: "claim" }>["turn"], now: number): Promise<void> {
    const previous = await this.turns.find(scope, turn.turn_id);
    await this.sql.batch([this.turns.claim(scope, turn, now)]);
    const current = await this.turns.find(scope, turn.turn_id);
    if (
      previous !== null && current !== null &&
      (current.attempt_id ?? "") === (turn.attempt_id ?? "") &&
      (previous.attempt_id ?? "") !== (turn.attempt_id ?? "")
    ) {
      await this.closeOpenSpans(scope, turn.turn_id, {
        atMs: turn.start_ms,
        endReason: "owner_changed",
        exceptAttemptId: turn.attempt_id,
      });
    }
  }

  private patchStatement(scope: TraceScope, spanId: string, expect: readonly TraceStatus[], set: TraceSpanPatch, now: number): SqlStatement {
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (set.status !== undefined) { assignments.push("status = ?"); values.push(set.status); }
    if (set.end_ms !== undefined) { assignments.push("end_ms = ?"); values.push(set.end_ms === null ? null : Math.round(set.end_ms)); }
    if (set.error !== undefined) {
      assignments.push("error_type = ?", "error_message = ?");
      values.push(set.error?.type ?? null, set.error?.message ?? null);
    }
    if (set.event_ids !== undefined) { assignments.push("event_ids = ?"); values.push(JSON.stringify(set.event_ids)); }
    assignments.push("version = version + 1", "updated_at = ?");
    values.push(now);
    const statuses = expect.length > 0 ? expect : ["running"];
    return this.sql.prepare(
      `UPDATE trace_spans SET ${assignments.join(", ")}
       WHERE workspace_id = ? AND session_id = ? AND span_id = ? AND deleted = 0
         AND status IN (${statuses.map(() => "?").join(", ")})`,
    ).bind(...values, scope.workspaceId, scope.sessionId, spanId, ...statuses);
  }

  async finalizeTurn(scope: TraceScope, input: Parameters<TraceStore["finalizeTurn"]>[1]): Promise<boolean> {
    await this.ensureSchema();
    return this.turns.finalize(scope, input, this.now());
  }

  async markFramesLost(scope: TraceScope, turnId: string, attemptId: string | null): Promise<void> {
    await this.ensureSchema();
    await this.turns.markFramesLost(scope, turnId, attemptId, this.now());
  }

  async closeOpenSpans(scope: TraceScope, turnId: string, input: TraceCloseOpenSpansInput): Promise<number> {
    await this.ensureSchema();
    const now = this.now();
    const turnSpan = turnSpanIdFor(scope.sessionId, turnId);
    const exceptAttempt = input.exceptAttemptId === undefined ? null : input.exceptAttemptId ?? "";
    const rows = await this.sql.prepare(
      `SELECT span_id, start_ms, attrs, version FROM trace_spans
       WHERE workspace_id = ? AND session_id = ? AND turn_id = ? AND end_ms IS NULL
         AND status <> 'waiting' AND deleted = 0 AND span_id <> ?
         ${exceptAttempt === null ? "" : "AND COALESCE(attempt_id, '') <> ?"}`,
    ).bind(...[scope.workspaceId, scope.sessionId, turnId, turnSpan, ...(exceptAttempt === null ? [] : [exceptAttempt])])
      .all<{ span_id: string; start_ms: number | string; attrs: string; version: number | string }>();
    const owner = input.owner;
    // The owner check goes into each UPDATE: a claim between the SELECT and
    // the write then leaves the spans of the new attempt open.
    const ownerClause = owner === undefined ? "" : `AND EXISTS (SELECT 1 FROM trace_turns t
           WHERE t.workspace_id = ? AND t.session_id = ? AND t.turn_id = ?
             AND COALESCE(t.attempt_id, '') = ? AND t.attempt_generation = ?)`;
    const ownerValues = owner === undefined
      ? []
      : [scope.workspaceId, scope.sessionId, turnId, owner.attemptId ?? "", owner.generation];
    const statements = (rows.results ?? []).map((row) => {
      const attrs = parseObject(row.attrs);
      attrs.end_reason = input.endReason;
      return this.sql.prepare(
        `UPDATE trace_spans SET status = 'interrupted', end_ms = ?, attrs = ?, version = version + 1, updated_at = ?
         WHERE workspace_id = ? AND session_id = ? AND span_id = ? AND version = ? AND end_ms IS NULL
         ${ownerClause}`,
      ).bind(
        Math.max(input.atMs, Number(row.start_ms)), JSON.stringify(attrs), now,
        scope.workspaceId, scope.sessionId, row.span_id, Number(row.version), ...ownerValues,
      );
    });
    if (statements.length === 0) return 0;
    const results = await this.sql.batch([...statements, this.turns.recount(scope, turnId, now)]);
    return results.slice(0, statements.length).reduce((sum, item) => sum + (item.meta?.changes ?? 0), 0);
  }

  async cancelWaiting(scope: TraceScope, atMs: number): Promise<number> {
    await this.ensureSchema();
    const now = this.now();
    const affected = await this.sql.prepare(
      `SELECT DISTINCT turn_id FROM trace_spans WHERE workspace_id = ? AND session_id = ? AND deleted = 0
         AND (status = 'waiting' OR (kind = 'tool_exec' AND end_ms IS NULL))`,
    ).bind(scope.workspaceId, scope.sessionId).all<{ turn_id: string | null }>();
    const results = await this.sql.batch([
      this.sql.prepare(
        `UPDATE trace_spans SET status = 'cancelled', end_ms = CASE WHEN start_ms > ? THEN start_ms ELSE ? END,
           version = version + 1, updated_at = ?
         WHERE workspace_id = ? AND session_id = ? AND status = 'waiting' AND deleted = 0`,
      ).bind(atMs, atMs, now, scope.workspaceId, scope.sessionId),
      this.sql.prepare(
        `UPDATE trace_spans SET status = 'interrupted', end_ms = CASE WHEN start_ms > ? THEN start_ms ELSE ? END,
           version = version + 1, updated_at = ?
         WHERE workspace_id = ? AND session_id = ? AND kind = 'tool_exec' AND end_ms IS NULL AND deleted = 0`,
      ).bind(atMs, atMs, now, scope.workspaceId, scope.sessionId),
      ...(affected.results ?? [])
        .filter((row): row is { turn_id: string } => row.turn_id !== null)
        .map((row) => this.turns.recount(scope, row.turn_id, now)),
    ]);
    return (results[0]?.meta?.changes ?? 0) + (results[1]?.meta?.changes ?? 0);
  }

  async markDeleted(scope: TraceScope, spanId: string): Promise<void> {
    await this.ensureSchema();
    await this.sql.prepare(
      `UPDATE trace_spans SET deleted = 1, version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND session_id = ? AND span_id = ?`,
    ).bind(this.now(), scope.workspaceId, scope.sessionId, spanId).run();
  }

  async deleteSession(scope: TraceScope): Promise<void> {
    await this.ensureSchema();
    await this.sql.batch([
      this.sql.prepare("DELETE FROM trace_spans WHERE workspace_id = ? AND session_id = ?").bind(scope.workspaceId, scope.sessionId),
      this.sql.prepare("DELETE FROM trace_turns WHERE workspace_id = ? AND session_id = ?").bind(scope.workspaceId, scope.sessionId),
    ]);
  }

  async purgeUpdatedBefore(cutoffMs: number): Promise<void> {
    await this.ensureSchema();
    await this.sql.batch([
      this.sql.prepare("DELETE FROM trace_spans WHERE updated_at < ?").bind(cutoffMs),
      this.sql.prepare("DELETE FROM trace_turns WHERE updated_at < ?").bind(cutoffMs),
    ]);
  }

  async readTurns(scope: TraceScope): Promise<TraceTurnRow[]> {
    await this.ensureSchema();
    return this.turns.list(scope);
  }

  async readTurn(scope: TraceScope, turnId: string): Promise<TraceTurnRow | null> {
    await this.ensureSchema();
    return this.turns.find(scope, turnId);
  }

  async readTurnChanges(scope: TraceScope, after: { u: number; t: string } | null, limit: number): Promise<TraceTurnRow[]> {
    await this.ensureSchema();
    return this.turns.changes(scope, after, limit);
  }

  async readSpansByIds(scope: TraceScope, spanIds: readonly string[]): Promise<TraceSpan[]> {
    await this.ensureSchema();
    if (spanIds.length === 0) return [];
    const found = new Map<string, TraceSpan>();
    for (let index = 0; index < spanIds.length; index += 200) {
      const chunk = spanIds.slice(index, index + 200);
      const rows = await this.sql.prepare(
        `SELECT ${READ_COLUMNS} FROM trace_spans WHERE workspace_id = ? AND session_id = ?
           AND span_id IN (${chunk.map(() => "?").join(", ")})`,
      ).bind(scope.workspaceId, scope.sessionId, ...chunk).all<RawSpanRow>();
      for (const raw of rows.results ?? []) found.set(raw.span_id, toTraceSpan(raw));
    }
    return spanIds.map((id) => found.get(id)).filter((span): span is TraceSpan => span !== undefined);
  }

  async readTurnSpans(scope: TraceScope, turnIds: readonly string[], after: { m: number; s: string } | null, limit: number): Promise<TraceSpan[]> {
    await this.ensureSchema();
    if (turnIds.length === 0) return [];
    const m = after?.m ?? Number.MIN_SAFE_INTEGER;
    const s = after?.s ?? "";
    const rows = await this.sql.prepare(
      `SELECT ${READ_COLUMNS} FROM trace_spans WHERE workspace_id = ? AND session_id = ?
         AND turn_id IN (${turnIds.map(() => "?").join(", ")}) AND deleted = 0
         AND (start_ms > ? OR (start_ms = ? AND span_id > ?))
       ORDER BY start_ms, span_id LIMIT ?`,
    ).bind(scope.workspaceId, scope.sessionId, ...turnIds, m, m, s, limit).all<RawSpanRow>();
    return (rows.results ?? []).map(toTraceSpan);
  }

  async readSessionSpans(scope: TraceScope, after: { m: number; s: string } | null, limit: number): Promise<TraceSpan[]> {
    await this.ensureSchema();
    const m = after?.m ?? Number.MIN_SAFE_INTEGER;
    const s = after?.s ?? "";
    const rows = await this.sql.prepare(
      `SELECT ${READ_COLUMNS} FROM trace_spans WHERE workspace_id = ? AND session_id = ? AND deleted = 0
         AND (start_ms > ? OR (start_ms = ? AND span_id > ?))
       ORDER BY start_ms, span_id LIMIT ?`,
    ).bind(scope.workspaceId, scope.sessionId, m, m, s, limit).all<RawSpanRow>();
    return (rows.results ?? []).map(toTraceSpan);
  }

  async readChanges(scope: TraceScope, after: { u: number; s: string } | null, limit: number): Promise<TraceSpan[]> {
    await this.ensureSchema();
    const u = after?.u ?? -1;
    const s = after?.s ?? "";
    const rows = await this.sql.prepare(
      `SELECT ${READ_COLUMNS} FROM trace_spans WHERE workspace_id = ? AND session_id = ?
         AND (updated_at > ? OR (updated_at = ? AND span_id > ?))
       ORDER BY updated_at, span_id LIMIT ?`,
    ).bind(scope.workspaceId, scope.sessionId, u, u, s, limit).all<RawSpanRow>();
    return (rows.results ?? []).map(toTraceSpan);
  }

  async search(scope: TraceScope, query: string, after: { m: number; s: string } | null, limit: number): Promise<TraceSpan[]> {
    await this.ensureSchema();
    const pattern = `%${escapeLike(query.toLowerCase())}%`;
    const m = after?.m ?? Number.MIN_SAFE_INTEGER;
    const s = after?.s ?? "";
    const fields = ["name", "tool_name", "model", "span_id", "primary_event_id", "event_ids", "error_message"];
    const where = fields.map((field) => `LOWER(COALESCE(${field}, '')) LIKE ? ESCAPE '\\'`).join(" OR ");
    const rows = await this.sql.prepare(
      `SELECT ${READ_COLUMNS} FROM trace_spans WHERE workspace_id = ? AND session_id = ? AND deleted = 0
         AND (${where})
         AND (start_ms > ? OR (start_ms = ? AND span_id > ?))
       ORDER BY start_ms, span_id LIMIT ?`,
    ).bind(scope.workspaceId, scope.sessionId, ...fields.map(() => pattern), m, m, s, limit).all<RawSpanRow>();
    return (rows.results ?? []).map(toTraceSpan);
  }
}
