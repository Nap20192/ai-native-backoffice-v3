import { Hono, type Context } from "hono";
import type { SqlClient } from "@open-managed-agents/sql-client";
import {
  encodeCursor,
  readChangesCursor,
  readSearchCursor,
  readSpansCursor,
  readTurnsCursor,
  TraceCursorError,
  type ChangesCursor,
} from "./cursor.js";
import { createExecutionsReader, executionStopped, type TraceExecutionRow, type TraceExecutionsReader } from "./executions-reader.js";
import { toOtlpTraceExport } from "./genai.js";
import {
  createHistoryWindow,
  createSessionInfoReader,
  type TraceHistoryWindow,
  type TraceSessionInfoReader,
} from "./history-window.js";
import { traceIdFor, turnSpanIdFor } from "./ids.js";
import { createTraceRepair, type TraceRepair } from "./repair.js";
import { searchTrace } from "./search.js";
import { createTraceStore, type TraceStore, type TraceTurnRow } from "./store.js";
import type { TraceScope, TraceSpan, TraceStatus, TraceTurnSummary } from "./types.js";

/**
 * GET /v1/oma/sessions/:id/trace and its pages (plan section 3.2), the search
 * and the OTLP JSON download. Mount before the generic /oma/sessions routes.
 */
export interface TraceRoutesOptions {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  store?: TraceStore;
  executions?: TraceExecutionsReader;
  history?: TraceHistoryWindow;
  sessions?: TraceSessionInfoReader;
  now?: () => number;
  /** Time search may spend building turns per request. */
  searchBudgetMs?: number;
}

type TraceEnv = { Variables: { tenant_id: string } };

const TURNS_PAGE = 500;
const SPANS_PAGE = 2000;
const CHANGES_PAGE = 2000;
const SEARCH_LIMIT = 200;
const LAG_MS = 2000;
const COLLECTING_GRACE_MS = 10_000;
const EMPTY_COVERAGE = { model_calls: "absent", tools: "absent", sandbox: "attempts" } as const;

interface TurnEntry {
  turnId: string;
  start: number;
  execution?: TraceExecutionRow;
  row?: TraceTurnRow;
}

interface Backend {
  store: TraceStore;
  repair: TraceRepair;
}

function sqlBackend(options: TraceRoutesOptions, readers: Readers): Backend {
  const store = options.store ?? createTraceStore({ sql: options.sql, dialect: options.dialect === "postgres" ? "postgres" : "sqlite" });
  return {
    store,
    repair: createTraceRepair({ store, ...readers, ...(options.now !== undefined && { now: options.now }) }),
  };
}

interface Readers {
  executions: TraceExecutionsReader;
  history: TraceHistoryWindow;
  sessions: TraceSessionInfoReader;
}

function statusOfExecution(execution: TraceExecutionRow): TraceStatus {
  switch (execution.state) {
    case "completed": return "ok";
    case "failed": return "error";
    case "cancelled": return "interrupted";
    default: return "running";
  }
}

/** Turn span of a turn without stored trace, from the executions table. */
function syntheticTurnSpan(scope: TraceScope, entry: TurnEntry): TraceSpan {
  const execution = entry.execution;
  return {
    span_id: turnSpanIdFor(scope.sessionId, entry.turnId),
    parent_span_id: null,
    turn_id: entry.turnId,
    attempt_id: execution?.attempt_id ?? entry.row?.attempt_id ?? null,
    thread_id: execution?.lane_id ?? entry.row?.thread_id ?? "sthr_primary",
    kind: "turn",
    name: "turn",
    sources: ["events"],
    precision: "by_events",
    start_ms: entry.start,
    end_ms: execution?.settled_at_ms ?? entry.row?.end_ms ?? null,
    status: execution !== undefined ? statusOfExecution(execution) : "running",
    error: execution?.state === "failed" && execution.failure !== null ? { type: "execution_failed", message: execution.failure.slice(0, 500) } : null,
    harness: null,
    model: null,
    usage: null,
    ttft_ms: null,
    finish_reason: null,
    tool: null,
    primary_event_id: entry.turnId,
    event_ids: [entry.turnId],
    attrs: {},
    version: 0,
    deleted: false,
    updated_at: execution?.settled_at_ms ?? entry.start,
  };
}

function summaryOf(scope: TraceScope, entry: TurnEntry, span: TraceSpan | undefined): TraceTurnSummary {
  const row = entry.row;
  if (row === undefined) {
    return {
      turn: syntheticTurnSpan(scope, entry),
      state: "not_built",
      partial: false,
      lost: [],
      coverage: { ...EMPTY_COVERAGE },
      span_count: null,
      error_count: null,
      waiting_count: null,
      version: 0,
    };
  }
  return {
    turn: span ?? syntheticTurnSpan(scope, entry),
    state: row.state,
    partial: row.frames_lost || row.lost.length > 0,
    lost: row.lost,
    coverage: row.coverage,
    span_count: row.span_count,
    error_count: row.error_count,
    waiting_count: row.waiting_count,
    version: row.version,
  };
}

const compareEntries = (a: TurnEntry, b: TurnEntry) => a.start - b.start || (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0);

function laterKey(a: { u: number; s: string }, b: { u: number; s: string }): { u: number; s: string } {
  if (a.u !== b.u) return a.u > b.u ? a : b;
  return a.s >= b.s ? a : b;
}

export function buildTraceRoutes(options: TraceRoutesOptions): Hono<TraceEnv> {
  const now = options.now ?? Date.now;
  const readers: Readers = {
    executions: options.executions ?? createExecutionsReader(options.sql),
    history: options.history ?? createHistoryWindow(options.sql),
    sessions: options.sessions ?? createSessionInfoReader(options.sql),
  };
  const backend = sqlBackend(options, readers);
  const routes = new Hono<TraceEnv>();

  const scopeOf = async (c: Context<TraceEnv>): Promise<TraceScope | Response> => {
    const workspaceId = c.get("tenant_id");
    if (typeof workspaceId !== "string" || workspaceId.length === 0) return c.json({ error: "Unauthorized" }, 401);
    const scope = { workspaceId, sessionId: c.req.param("id") ?? "" };
    if (await readers.sessions.read(scope) === null) return c.json({ error: "Session not found" }, 404);
    return scope;
  };

  const loadEntries = async (scope: TraceScope): Promise<TurnEntry[]> => {
    const [executions, rows] = await Promise.all([readers.executions.list(scope), backend.store.readTurns(scope)]);
    const entries = new Map<string, TurnEntry>();
    for (const execution of executions) {
      entries.set(execution.id, { turnId: execution.id, start: execution.claimed_at_ms ?? execution.admitted_at_ms, execution });
    }
    for (const row of rows) {
      const entry = entries.get(row.turn_id) ?? { turnId: row.turn_id, start: row.start_ms };
      entry.row = row;
      entry.start = row.start_ms;
      entries.set(row.turn_id, entry);
    }
    return [...entries.values()].sort(compareEntries);
  };

  /** Rebuilds the turns from history when their trace is not complete and the execution stopped. */
  const repairEntries = async (scope: TraceScope, entries: TurnEntry[]): Promise<boolean> => {
    let changed = false;
    for (const entry of entries) {
      if (entry.execution === undefined) continue;
      if (!backend.repair.needsRepair(entry.row ?? null, entry.execution)) continue;
      changed = (await backend.repair.repairTurn(scope, entry.execution)) === "repaired" || changed;
    }
    return changed;
  };

  const summaries = async (scope: TraceScope, entries: readonly TurnEntry[]): Promise<TraceTurnSummary[]> => {
    const built = entries.filter((entry) => entry.row !== undefined);
    const spans = new Map((await backend.store.readSpansByIds(scope, built.map((entry) => turnSpanIdFor(scope.sessionId, entry.turnId))))
      .map((span) => [span.span_id, span]));
    return entries.map((entry) => summaryOf(scope, entry, spans.get(turnSpanIdFor(scope.sessionId, entry.turnId))));
  };

  const collecting = (entries: readonly TurnEntry[]): boolean => {
    const at = now();
    return entries.some((entry) => {
      const execution = entry.execution;
      if (execution !== undefined && !executionStopped(execution, at)) return true;
      const open = entry.row !== undefined && (entry.row.state === "open" || entry.row.state === "settling");
      if (!open) return false;
      const settledAt = execution?.settled_at_ms ?? entry.row!.updated_at;
      return at - settledAt < COLLECTING_GRACE_MS;
    });
  };

  const spansPage = async (scope: TraceScope, turnIds: string[], after: { m: number; s: string } | null) => {
    const found = await backend.store.readTurnSpans(scope, turnIds, after, SPANS_PAGE + 1);
    const spans = found.slice(0, SPANS_PAGE);
    const last = spans.at(-1);
    const next = found.length > SPANS_PAGE && last !== undefined
      ? encodeCursor({ turns: turnIds, m: last.start_ms, s: last.span_id })
      : null;
    return { spans, next };
  };

  const lagCursor = (): ChangesCursor => ({ u: now() - LAG_MS, s: "", tu: now() - LAG_MS, tt: "" });

  routes.get("/:id/trace", async (c) => {
    const resolved = await scopeOf(c);
    if (resolved instanceof Response) return resolved;
    const scope = resolved;
    const base = { trace_id: traceIdFor(scope.sessionId), session_id: scope.sessionId };
    try {
      const after = c.req.query("after");
      if (after !== undefined) {
        const cursor = readChangesCursor(after);
        // As the overview: a stopped turn whose final records never came is
        // rebuilt before the read, so the feed carries it closed and polling
        // does not end on an open turn.
        await repairEntries(scope, (await loadEntries(scope)).slice(-2));
        const spans = await backend.store.readChanges(scope, { u: cursor.u, s: cursor.s }, CHANGES_PAGE + 1);
        const turnRows = await backend.store.readTurnChanges(scope, { u: cursor.tu, t: cursor.tt }, CHANGES_PAGE + 1);
        const spansMore = spans.length > CHANGES_PAGE;
        const turnsMore = turnRows.length > CHANGES_PAGE;
        const spanPage = spans.slice(0, CHANGES_PAGE);
        const turnPage = turnRows.slice(0, CHANGES_PAGE);
        const lag = lagCursor();
        const lastSpan = spanPage.at(-1);
        const lastTurn = turnPage.at(-1);
        const spanKey = spansMore && lastSpan !== undefined
          ? { u: lastSpan.updated_at, s: lastSpan.span_id }
          : laterKey({ u: cursor.u, s: cursor.s }, { u: lag.u, s: lag.s });
        const turnKey = turnsMore && lastTurn !== undefined
          ? { u: lastTurn.updated_at, s: lastTurn.turn_id }
          : laterKey({ u: cursor.tu, s: cursor.tt }, { u: lag.tu, s: lag.tt });
        // Read after the changes: a turn in the page has its row here.
        const entries = await loadEntries(scope);
        const changedTurns = new Set(turnPage.map((row) => row.turn_id));
        return c.json({
          ...base,
          spans: spanPage,
          turns: await summaries(scope, entries.filter((entry) => changedTurns.has(entry.turnId))),
          cursor: encodeCursor({ u: spanKey.u, s: spanKey.s, tu: turnKey.u, tt: turnKey.s }),
          more: spansMore || turnsMore,
          collecting: collecting(entries),
        });
      }

      const turnId = c.req.query("turn_id");
      const page = c.req.query("page");
      if (turnId !== undefined) {
        let entries = await loadEntries(scope);
        const entry = entries.find((candidate) => candidate.turnId === turnId);
        if (entry === undefined) return c.json({ error: "Turn not found" }, 404);
        if (await repairEntries(scope, [entry])) entries = await loadEntries(scope);
        const current = entries.find((candidate) => candidate.turnId === turnId)!;
        const position = page === undefined ? null : readSpansCursor(page);
        if (position !== null && (position.turns.length !== 1 || position.turns[0] !== turnId)) throw new TraceCursorError();
        const { spans, next } = await spansPage(scope, [turnId], position === null ? null : { m: position.m, s: position.s });
        const [summary] = await summaries(scope, [current]);
        return c.json({ ...base, turn_id: turnId, turn: summary, spans, page_next: next, collecting: collecting(entries) });
      }
      if (page !== undefined) {
        const position = readSpansCursor(page);
        const { spans, next } = await spansPage(scope, position.turns, { m: position.m, s: position.s });
        return c.json({ ...base, spans, spans_next: next });
      }

      let entries = await loadEntries(scope);
      const before = c.req.query("turns_before");
      if (before !== undefined) {
        const cursor = readTurnsCursor(before);
        const older = entries.filter((entry) => compareEntries(entry, { turnId: cursor.t, start: cursor.m }) < 0);
        const pageEntries = older.slice(-TURNS_PAGE);
        const first = pageEntries[0];
        return c.json({
          ...base,
          turns: await summaries(scope, pageEntries),
          turns_before: older.length > TURNS_PAGE && first !== undefined ? encodeCursor({ m: first.start, t: first.turnId }) : null,
        });
      }

      const lastTwo = entries.slice(-2);
      if (await repairEntries(scope, lastTwo)) entries = await loadEntries(scope);
      const pageEntries = entries.slice(-TURNS_PAGE);
      const first = pageEntries[0];
      const { spans, next } = await spansPage(scope, entries.slice(-2).map((entry) => entry.turnId), null);
      const lag = lagCursor();
      return c.json({
        ...base,
        turns: await summaries(scope, pageEntries),
        turns_before: entries.length > TURNS_PAGE && first !== undefined ? encodeCursor({ m: first.start, t: first.turnId }) : null,
        spans,
        spans_next: next,
        cursor: encodeCursor({ u: lag.u, s: lag.s, tu: lag.tu, tt: lag.tt }),
        collecting: collecting(entries),
      });
    } catch (error) {
      if (error instanceof TraceCursorError) return c.json({ error: "Invalid cursor" }, 400);
      throw error;
    }
  });

  routes.get("/:id/trace/otlp.json", async (c) => {
    const resolved = await scopeOf(c);
    if (resolved instanceof Response) return resolved;
    const scope = resolved;
    await repairEntries(scope, await loadEntries(scope));
    const spans: TraceSpan[] = [];
    let after: { m: number; s: string } | null = null;
    for (;;) {
      const page = await backend.store.readSessionSpans(scope, after, SPANS_PAGE);
      spans.push(...page);
      if (page.length < SPANS_PAGE) break;
      const last = page[page.length - 1]!;
      after = { m: last.start_ms, s: last.span_id };
    }
    return c.body(JSON.stringify(toOtlpTraceExport(scope.sessionId, spans)), 200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="trace-${scope.sessionId.replace(/[^A-Za-z0-9_-]/gu, "_")}.json"`,
    });
  });

  routes.get("/:id/trace/search", async (c) => {
    const resolved = await scopeOf(c);
    if (resolved instanceof Response) return resolved;
    const scope = resolved;
    const query = (c.req.query("q") ?? "").trim();
    if (query.length === 0 || query.length > 200) return c.json({ error: "q must have 1 to 200 characters" }, 400);
    const limitText = c.req.query("limit");
    const limit = limitText === undefined ? SEARCH_LIMIT : Math.trunc(Number(limitText));
    if (!Number.isFinite(limit) || limit < 1 || limit > SEARCH_LIMIT) return c.json({ error: "limit must be between 1 and 200" }, 400);
    try {
      const afterText = c.req.query("after");
      const result = await searchTrace(
        { store: backend.store, repair: backend.repair, executions: readers.executions },
        scope,
        {
          query,
          after: afterText === undefined ? null : readSearchCursor(afterText),
          limit,
          budgetMs: options.searchBudgetMs ?? 2_000,
        },
      );
      return c.json(result);
    } catch (error) {
      if (error instanceof TraceCursorError) return c.json({ error: "Invalid cursor" }, 400);
      throw error;
    }
  });

  return routes;
}
