import { useMemo } from "react";
import { useApi } from "./api";

/**
 * Контракт API трейса сессии (docs/plans/agent-trace.md, разделы 1.2 и 3.2) и
 * клиент к нему. Сервер хранит трейс в готовом виде, консоль только читает
 * страницы и применяет строки по `span_id` и `version`.
 *
 * Маршруты:
 *   GET /v1/oma/sessions/:id/trace                        первый ответ
 *   GET .../trace?turns_before=<курсор>                   более ранние сводки ходов
 *   GET .../trace?turn_id=<id>&page=<курсор>              поддерево хода страницами
 *   GET .../trace?page=<курсор>                           остаток первого ответа (spans_next)
 *   GET .../trace?after=<курсор>                          изменения строк и сводок
 *   GET .../trace/search?q=<текст>&after=<курсор>         поиск по всем ходам
 *
 * Контракт раздела 3.2 описывает форму только первого ответа. Остальные
 * страницы читаются по маршрутам сервера (M/src/lib/trace/routes.ts):
 *   ?turns_before   {turns, turns_before}
 *   ?turn_id[&page] {turn_id, turn, spans, page_next, collecting}
 *   ?page           {spans, spans_next}
 *   ?after          {spans, turns, cursor, more, collecting}
 * Отсутствующее поле читается как пустое, лишнее игнорируется.
 */

/**
 * `acp_prompt` встречается только в старых трейсах: сервер такие отрезки больше
 * не пишет. Вид остаётся в списке, иначе разбор выбросил бы сохранённые отрезки.
 */
export type TraceSpanKind =
  | "turn" | "sandbox" | "sandbox_phase" | "harness_start" | "acp_prompt"
  | "agent_step" | "model_call" | "tool_call" | "tool_wait" | "tool_exec" | "subagent"
  | "outcome_eval" | "compaction" | "retry_wait" | "hook" | "event";

export const TRACE_SPAN_KINDS: readonly TraceSpanKind[] = [
  "turn", "sandbox", "sandbox_phase", "harness_start", "acp_prompt",
  "agent_step", "model_call", "tool_call", "tool_wait", "tool_exec", "subagent",
  "outcome_eval", "compaction", "retry_wait", "hook", "event",
];

export type TraceSource = "events" | "runner" | "otel" | "rollout";
export type TracePrecision = "measured" | "by_events";
export type TraceStatus = "running" | "ok" | "error" | "denied" | "interrupted" | "cancelled" | "waiting";
export type TraceToolKind = "builtin" | "mcp" | "custom";

export interface TraceUsage { input: number; output: number; cache_read: number; cache_write: number }
export interface TraceSpanError { type: string | null; message: string | null; retry_status?: "retrying" | "exhausted" }
export interface TraceToolRef { name: string; call_id: string; kind: TraceToolKind; mcp_server: string | null }

export interface TraceSpan {
  span_id: string;
  parent_span_id: string | null;
  turn_id: string | null;
  attempt_id: string | null;
  thread_id: string;
  kind: TraceSpanKind;
  name: string;
  sources: TraceSource[];
  precision: TracePrecision;
  start_ms: number;
  /** null: узел ещё идёт. */
  end_ms: number | null;
  status: TraceStatus;
  error: TraceSpanError | null;
  harness: string | null;
  model: string | null;
  usage: TraceUsage | null;
  ttft_ms: number | null;
  finish_reason: string | null;
  tool: TraceToolRef | null;
  primary_event_id: string | null;
  event_ids: string[];
  attrs: Record<string, string | number | boolean>;
  version: number;
  /** Строку убрало слияние, консоль её удаляет. */
  deleted: boolean;
  updated_at: number;
}

export type TraceTurnState = "open" | "settling" | "complete" | "repaired" | "not_built";
export interface TraceCoverage {
  model_calls: "measured" | "by_events" | "turn_only" | "absent";
  tools: "measured" | "by_events" | "absent";
  sandbox: "phases" | "attempts";
}

export interface TraceTurnSummary {
  turn: TraceSpan;
  state: TraceTurnState;
  partial: boolean;
  lost: string[];
  coverage: TraceCoverage;
  span_count: number | null;
  error_count: number | null;
  waiting_count: number | null;
  version: number;
}

export interface TraceOverview {
  trace_id: string;
  session_id: string;
  turns: TraceTurnSummary[];
  turns_before: string | null;
  spans: TraceSpan[];
  spans_next: string | null;
  cursor: string;
  collecting: boolean;
}
export interface TraceTurnsPage { turns: TraceTurnSummary[]; turns_before: string | null }
export interface TraceSpansPage {
  spans: TraceSpan[];
  /** Курсор следующей страницы. Сервер называет его spans_next у остатка первого ответа и page_next у поддерева хода. */
  spans_next: string | null;
  /** Свежая сводка хода: приходит с первой страницей поддерева, после восстановления хода она новее прежней. */
  turn?: TraceTurnSummary | null;
  /** Серверный признак «ход ещё собирается». */
  collecting?: boolean | null;
}
export interface TraceChangesPage {
  spans: TraceSpan[];
  turns: TraceTurnSummary[];
  cursor: string;
  more: boolean;
  collecting?: boolean | null;
}
export interface TraceSearchMatch { span_id: string; turn_id: string | null; kind: string; name: string }
export interface TraceSearchPage { matches: TraceSearchMatch[]; next: string | null; remaining_turns: number }

/* ---------- Разбор ---------- */

const STATUSES: readonly TraceStatus[] = ["running", "ok", "error", "denied", "interrupted", "cancelled", "waiting"];
const SOURCES: readonly TraceSource[] = ["events", "runner", "otel", "rollout"];
const TURN_STATES: readonly TraceTurnState[] = ["open", "settling", "complete", "repaired", "not_built"];
const MODEL_COVERAGE = ["measured", "by_events", "turn_only", "absent"] as const;
const TOOL_COVERAGE = ["measured", "by_events", "absent"] as const;
const SANDBOX_COVERAGE = ["phases", "attempts"] as const;
const TOOL_KINDS: readonly TraceToolKind[] = ["builtin", "mcp", "custom"];

export const PRIMARY_THREAD_ID = "sthr_primary";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const count = (value: unknown): number | null => {
  const n = finite(value);
  return n === null ? null : Math.max(0, n);
};
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function readUsage(value: unknown): TraceUsage | null {
  if (!isRecord(value)) return null;
  return {
    input: count(value.input) ?? 0,
    output: count(value.output) ?? 0,
    cache_read: count(value.cache_read) ?? 0,
    cache_write: count(value.cache_write) ?? 0,
  };
}

function readError(value: unknown): TraceSpanError | null {
  if (!isRecord(value)) return null;
  const retry = oneOf(value.retry_status, ["retrying", "exhausted"] as const);
  return { type: str(value.type), message: str(value.message), ...(retry ? { retry_status: retry } : {}) };
}

function readTool(value: unknown): TraceToolRef | null {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  if (name === null) return null;
  return {
    name,
    call_id: str(value.call_id) ?? "",
    kind: oneOf(value.kind, TOOL_KINDS) ?? "builtin",
    mcp_server: str(value.mcp_server),
  };
}

function readAttrs(value: unknown): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {};
  if (!isRecord(value)) return attrs;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") attrs[key] = item;
  }
  return attrs;
}

/**
 * Строка спана с полями по умолчанию. Принимает и полную строку сервера, и
 * неполную (тесты и фикстуры задают только нужное). Вид и начало обязательны.
 */
export function normalizeSpan(raw: Partial<TraceSpan> & { span_id: string; kind: TraceSpanKind }): TraceSpan {
  const sources = Array.isArray(raw.sources) ? raw.sources.filter((item): item is TraceSource => !!oneOf(item, SOURCES)) : [];
  return {
    span_id: raw.span_id,
    parent_span_id: str(raw.parent_span_id),
    turn_id: str(raw.turn_id),
    attempt_id: str(raw.attempt_id),
    thread_id: str(raw.thread_id) ?? PRIMARY_THREAD_ID,
    kind: raw.kind,
    name: str(raw.name) ?? "",
    sources: sources.length ? sources : ["events"],
    precision: oneOf(raw.precision, ["measured", "by_events"] as const) ?? "measured",
    start_ms: finite(raw.start_ms) ?? 0,
    end_ms: finite(raw.end_ms),
    status: oneOf(raw.status, STATUSES) ?? "ok",
    error: readError(raw.error),
    harness: str(raw.harness),
    model: str(raw.model),
    usage: readUsage(raw.usage),
    ttft_ms: finite(raw.ttft_ms),
    finish_reason: str(raw.finish_reason),
    tool: readTool(raw.tool),
    primary_event_id: str(raw.primary_event_id),
    event_ids: Array.isArray(raw.event_ids) ? raw.event_ids.filter((item): item is string => typeof item === "string") : [],
    attrs: readAttrs(raw.attrs),
    version: finite(raw.version) ?? 1,
    deleted: raw.deleted === true,
    updated_at: finite(raw.updated_at) ?? 0,
  };
}

/** Строка с сервера или null, если у неё нет id, вида или времени начала. */
function parseSpan(raw: unknown): TraceSpan | null {
  if (!isRecord(raw)) return null;
  const spanId = str(raw.span_id);
  const kind = oneOf(raw.kind, TRACE_SPAN_KINDS);
  if (!spanId || !kind || finite(raw.start_ms) === null) return null;
  return normalizeSpan({ ...raw, span_id: spanId, kind } as never);
}

export function parseSpans(raw: unknown): TraceSpan[] {
  if (!Array.isArray(raw)) return [];
  const spans: TraceSpan[] = [];
  for (const item of raw) {
    const span = parseSpan(item);
    if (span) spans.push(span);
  }
  return spans;
}

function readCoverage(value: unknown): TraceCoverage {
  const source = isRecord(value) ? value : {};
  return {
    model_calls: oneOf(source.model_calls, MODEL_COVERAGE) ?? "absent",
    tools: oneOf(source.tools, TOOL_COVERAGE) ?? "absent",
    sandbox: oneOf(source.sandbox, SANDBOX_COVERAGE) ?? "attempts",
  };
}

/** Сводка хода. Без корректной строки хода внутри бросает ошибку: сводка без хода бесполезна. */
export function normalizeTurn(raw: unknown): TraceTurnSummary {
  const source = isRecord(raw) ? raw : {};
  const turn = parseSpan(source.turn);
  if (!turn) throw new Error("В сводке хода нет строки хода");
  return {
    turn,
    state: oneOf(source.state, TURN_STATES) ?? "complete",
    partial: source.partial === true,
    lost: Array.isArray(source.lost) ? source.lost.filter((item): item is string => typeof item === "string") : [],
    coverage: readCoverage(source.coverage),
    span_count: count(source.span_count),
    error_count: count(source.error_count),
    waiting_count: count(source.waiting_count),
    version: finite(source.version) ?? turn.version,
  };
}

export function parseTurns(raw: unknown): TraceTurnSummary[] {
  if (!Array.isArray(raw)) return [];
  const turns: TraceTurnSummary[] = [];
  for (const item of raw) {
    try {
      turns.push(normalizeTurn(item));
    } catch {
      // Сводка без хода не показывается: остальные ходы остаются.
    }
  }
  return turns;
}

export function parseOverview(raw: unknown): TraceOverview {
  const source = isRecord(raw) ? raw : {};
  return {
    trace_id: str(source.trace_id) ?? "",
    session_id: str(source.session_id) ?? "",
    turns: parseTurns(source.turns),
    turns_before: str(source.turns_before),
    spans: parseSpans(source.spans),
    spans_next: str(source.spans_next),
    cursor: str(source.cursor) ?? "",
    collecting: source.collecting === true,
  };
}

export function parseTurnsPage(raw: unknown): TraceTurnsPage {
  const source = isRecord(raw) ? raw : {};
  return { turns: parseTurns(source.turns), turns_before: str(source.turns_before) };
}

function parseTurnOrNull(raw: unknown): TraceTurnSummary | null {
  if (raw === undefined || raw === null) return null;
  try {
    return normalizeTurn(raw);
  } catch {
    return null;
  }
}

export function parseSpansPage(raw: unknown): TraceSpansPage {
  const source = isRecord(raw) ? raw : {};
  return {
    spans: parseSpans(source.spans),
    spans_next: str(source.spans_next) ?? str(source.page_next),
    turn: parseTurnOrNull(source.turn),
    collecting: typeof source.collecting === "boolean" ? source.collecting : null,
  };
}

export function parseChangesPage(raw: unknown): TraceChangesPage {
  const source = isRecord(raw) ? raw : {};
  return {
    spans: parseSpans(source.spans),
    turns: parseTurns(source.turns),
    cursor: str(source.cursor) ?? "",
    more: source.more === true,
    collecting: typeof source.collecting === "boolean" ? source.collecting : null,
  };
}

export function parseSearchPage(raw: unknown): TraceSearchPage {
  const source = isRecord(raw) ? raw : {};
  const matches: TraceSearchMatch[] = [];
  if (Array.isArray(source.matches)) {
    for (const item of source.matches) {
      if (!isRecord(item)) continue;
      const spanId = str(item.span_id);
      if (!spanId) continue;
      matches.push({ span_id: spanId, turn_id: str(item.turn_id), kind: str(item.kind) ?? "", name: str(item.name) ?? "" });
    }
  }
  return { matches, next: str(source.next), remaining_turns: count(source.remaining_turns) ?? 0 };
}

/* ---------- Клиент ---------- */

export function tracePath(sessionId: string, params?: Record<string, string | undefined>, suffix = ""): string {
  const base = `/v1/oma/sessions/${encodeURIComponent(sessionId)}/trace${suffix}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

export type TraceFetch = <T>(path: string) => Promise<T>;

export interface TraceClient {
  /** Сводки ходов и поддеревья двух последних ходов. */
  getOverview(): Promise<TraceOverview>;
  getTurnsBefore(cursor: string): Promise<TraceTurnsPage>;
  /** Поддерево хода страницами по 2000 строк. */
  getTurnPage(turnId: string, page?: string | null): Promise<TraceSpansPage>;
  /** Остаток первого ответа по spans_next. */
  getSpansPage(page: string): Promise<TraceSpansPage>;
  getChanges(after: string): Promise<TraceChangesPage>;
  search(query: string, after?: string | null): Promise<TraceSearchPage>;
}

export function createTraceClient(sessionId: string, fetchJson: TraceFetch): TraceClient {
  return {
    async getOverview() {
      return parseOverview(await fetchJson<unknown>(tracePath(sessionId)));
    },
    async getTurnsBefore(cursor) {
      return parseTurnsPage(await fetchJson<unknown>(tracePath(sessionId, { turns_before: cursor })));
    },
    async getTurnPage(turnId, page) {
      return parseSpansPage(await fetchJson<unknown>(tracePath(sessionId, { turn_id: turnId, page: page ?? undefined })));
    },
    async getSpansPage(page) {
      return parseSpansPage(await fetchJson<unknown>(tracePath(sessionId, { page })));
    },
    async getChanges(after) {
      return parseChangesPage(await fetchJson<unknown>(tracePath(sessionId, { after })));
    },
    async search(query, after) {
      return parseSearchPage(await fetchJson<unknown>(tracePath(sessionId, { q: query, after: after ?? undefined }, "/search")));
    },
  };
}

/* ---------- Выгрузка трейса ---------- */

/** Весь трейс одним запросом OTLP в JSON (раздел 3.2 плана): файл для кнопки «Скачать трейс». */
export function traceExportPath(sessionId: string): string {
  return tracePath(sessionId, undefined, "/otlp.json");
}

export function traceExportFileName(sessionId: string): string {
  return `trace-${sessionId}.otlp.json`;
}

/** Через сколько после щелчка освобождать адрес файла: браузер читает его уже после щелчка. */
const EXPORT_URL_LIFETIME_MS = 1_000;

/**
 * Запрашивает файл трейса и сохраняет его в браузере. Запрос идёт через `api`
 * консоли, потому что ссылке не передать заголовки пространства и входа.
 * Ошибка запроса уходит вызывающему, файл тогда не сохраняется.
 */
export async function downloadTrace(sessionId: string, fetchRaw: (path: string) => Promise<Response>): Promise<void> {
  const response = await fetchRaw(traceExportPath(sessionId));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = traceExportFileName(sessionId);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), EXPORT_URL_LIFETIME_MS);
}

/** Клиент поверх `useApi`: те же заголовки и вход, без тоста об ошибке (вкладка рисует её сама). */
export function useTraceClient(sessionId: string): TraceClient {
  const { api } = useApi();
  return useMemo(
    () => createTraceClient(sessionId, <T>(path: string) => api<T>(path, { quiet: true })),
    [api, sessionId],
  );
}
