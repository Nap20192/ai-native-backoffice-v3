import type { Event } from "./events";
import { formatShortDurationRu, sessionErrorText } from "../components/session/format-ru";

export type SessionEvent = Event;

export type SelectionSource = "transcript" | "minimap" | "events" | "tools" | "url";
export interface EventSelection {
  eventId: string | null;
  source: SelectionSource;
  
  seq: number;
}

export interface ModelRequest {
  
  id: string;
  startEventId: string | null;
  endEventId: string | null;
  threadId: string;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  isError: boolean;
}

export type EventGroup =
  | { kind: "single"; event: SessionEvent }
  | { kind: "request"; id: string; events: SessionEvent[] };

export type EventFamily = "agent" | "user" | "span" | "session" | "system" | "other";

export type EventFilter =
  | { mode: "all" }
  | { mode: "transcript" }
  | { mode: "types"; types: ReadonlySet<string> };

export interface EventIndex {
  byId: ReadonlyMap<string, SessionEvent>;
  toolNameByUseId: ReadonlyMap<string, string>;
  requestByEndId: ReadonlyMap<string, ModelRequest>;
}

export type ToolKind = "builtin" | "mcp" | "custom";
export type ToolPermission = "auto" | "ask";
export interface ToolCatalogEntry {
  name: string;
  kind: ToolKind;
  permission: ToolPermission;
  mcpServerName?: string;
}

export type ToolCallStatus = "completed" | "failed" | "denied" | "interrupted" | "running";
export interface ToolCall {
  useEventId: string;
  resultEventId: string | null;
  confirmationEventId: string | null;
  name: string;
  kind: ToolKind;
  mcpServerName?: string;
  input: unknown;
  
  output: unknown;
  isError: boolean;
  
  status: ToolCallStatus;
  startMs: number | null;
  endMs: number | null;
  
  durationMs: number | null;
  
  waitingMs: number;
  threadId: string;
  
  requestId: string | null;
}

export interface ToolStatusCounts {
  completed: number; failed: number; denied: number; interrupted: number; running: number;
}
export interface ToolStatsRow {
  name: string;
  kind: ToolKind;
  
  permission: ToolPermission | null;
  calls: number;
  failed: number;
  failedRatio: number | null;
  
  p50Ms: number | null;
  counts: ToolStatusCounts;
  callList: ToolCall[];
}
export interface ToolsSummary {
  toolCount: number;
  usedCount: number;
  callCount: number;
  counts: ToolStatusCounts;
  time: { totalMs: number; executingMs: number; waitingMs: number };
}

export interface SessionTotals {
  requestCount: number;
  erroredRequestCount: number;
  
  activeMs: number;
  firstEventMs: number | null;
  lastEventMs: number | null;
}

export interface ThreadStats extends SessionTotals {
  threadId: string;
}

export interface OutcomeEvaluation {
  
  iteration: number;
  result: string;
  explanation: string;
  startEventId: string | null;
  endEventId: string;
  /** Время span.outcome_evaluation_start: от него мини-карта рисует отрезок оценки. */
  startMs: number | null;
  atMs: number | null;
}
export interface OutcomeView {
  outcomeId: string;
  eventId: string;
  description: string;
  rubric: { type: "text"; content: string } | { type: "file"; fileId: string };
  maxIterations: number | null;
  definedAtMs: number | null;
  evaluations: OutcomeEvaluation[];
}

export type RequestItem =
  | { kind: "text"; eventId: string; text: string }
  | { kind: "tool"; call: ToolCall }
  | {
      kind: "thread_message";
      eventId: string;
      direction: "sent" | "received";
      agentName: string | null;
      text: string;
    };

interface BlockBase {
  
  id: string;
  atMs: number | null;
  
  eventIds: string[];
}
export type TranscriptBlock =
  | (BlockBase & {
      kind: "user";
      eventId: string;
      text: string;
      status: "processed" | "pending" | "cancelled";
      wakeup: boolean;
    })
  | (BlockBase & {
      kind: "request";
      request: ModelRequest | null;
      endMs: number | null;
      thinking: boolean;
      
      thoughtMs: number | null;
      items: RequestItem[];
    })
  | (BlockBase & { kind: "outcome_defined"; eventId: string; outcome: OutcomeView })
  | (BlockBase & {
      kind: "grading";
      eventId: string;
      outcomeId: string;
      evaluation: OutcomeEvaluation;
      
      index: number;
      count: number;
    })
  | (BlockBase & { kind: "gap"; gapMs: number })
  | (BlockBase & {
      kind: "error";
      eventId: string;
      message: string;
      errorType: string | null;
      retrying: boolean;
    })
  | (BlockBase & { kind: "warning"; eventId: string; source: string; message: string });

export const PRIMARY_THREAD_ID = "sthr_primary";
export const TRANSCRIPT_GAP_MS = 30 * 60_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const str = (value: unknown): string => typeof value === "string" ? value : "";
const num = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const idOf = (event: SessionEvent): string => event.id ?? "";
const elapsed = (start: number | null, end: number | null): number | null =>
  start === null || end === null ? null : Math.max(0, end - start);

export function eventTimeMs(event: SessionEvent): number | null {
  for (const [key, value] of [["processed_at", event.processed_at], ["processed_at_ms", event.processed_at_ms], ["ts", event.ts]] as const) {
    if (value === null || value === undefined || value === "") continue;
    const n = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(n)) return typeof value === "number" && key !== "processed_at_ms" && n < 1e11 ? n * 1000 : n;
  }
  return null;
}
export function eventThreadId(event: SessionEvent): string { return str(event.session_thread_id) || PRIMARY_THREAD_ID; }
export function eventsOfThread(events: readonly SessionEvent[], threadId: string): SessionEvent[] {
  return events.filter(event => eventThreadId(event) === threadId);
}

export function collectModelRequests(events: readonly SessionEvent[]): ModelRequest[] {
  const requests: ModelRequest[] = [];
  const starts = new Map<string, ModelRequest>();
  for (const event of events) {
    if (event.type === "span.model_request_start") {
      const request: ModelRequest = { id: idOf(event), startEventId: idOf(event), endEventId: null, threadId: eventThreadId(event), startMs: eventTimeMs(event), endMs: null, durationMs: null, isError: false };
      requests.push(request);
      starts.set(`${request.threadId}:${request.id}`, request);
    } else if (event.type === "span.model_request_end") {
      const request = starts.get(`${eventThreadId(event)}:${str(event.model_request_start_id)}`);
      const endMs = eventTimeMs(event);
      const end = { endEventId: idOf(event), endMs, isError: event.is_error === true };
      if (request && request.endEventId === null) Object.assign(request, end, { durationMs: elapsed(request.startMs, endMs) });
      else requests.push({ id: idOf(event), startEventId: null, threadId: eventThreadId(event), startMs: null, durationMs: null, ...end });
    }
  }
  return requests;
}

function topLevel(type: string): boolean {
  return type.startsWith("user.") || type.startsWith("session.status_") || type.startsWith("session.thread_status_") || ["session.thread_created", "session.updated", "session.deleted"].includes(type);
}
/** Оценка результата идёт после запроса к модели и в его рамку не входит. */
function outsideRequest(type: string): boolean {
  return topLevel(type) || type.startsWith("span.outcome_evaluation_");
}
export function groupEventsByRequest(events: readonly SessionEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let current: Extract<EventGroup, { kind: "request" }> | null = null;
  for (const event of events) {
    if (event.type === "span.model_request_start") {
      current = { kind: "request", id: idOf(event), events: [event] };
      groups.push(current);
    } else if (outsideRequest(event.type)) {
      current = null;
      groups.push({ kind: "single", event });
    } else if (current) current.events.push(event);
    else groups.push({ kind: "single", event });
  }
  return groups;
}
export function eventFamily(type: string): EventFamily {
  const family = type.split(".")[0];
  return ["agent", "user", "span", "session", "system"].includes(family) ? family as EventFamily : "other";
}
export const TRANSCRIPT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "user.message", "user.define_outcome", "user.interrupt", "user.tool_confirmation", "user.custom_tool_result",
  "agent.message", "agent.thinking", "agent.tool_use", "agent.tool_result", "agent.mcp_tool_use", "agent.mcp_tool_result", "agent.custom_tool_use",
  "agent.thread_message_sent", "agent.thread_message_received", "session.error", "span.outcome_evaluation_end",
]);
export function filterEvents(events: readonly SessionEvent[], filter: EventFilter): SessionEvent[] {
  return events.filter(event => filter.mode === "all" || (filter.mode === "transcript" ? TRANSCRIPT_EVENT_TYPES : filter.types).has(event.type));
}
export function eventTypesPresent(events: readonly SessionEvent[]): string[] { return [...new Set(events.map(e => e.type))].sort(); }
export function buildEventIndex(events: readonly SessionEvent[]): EventIndex {
  return {
    byId: new Map(events.map(e => [idOf(e), e])),
    toolNameByUseId: new Map(events.filter(e => toolKind(e.type) !== null).map(e => [idOf(e), e.name ?? ""])),
    requestByEndId: new Map(collectModelRequests(events).filter(r => r.endEventId !== null).map(r => [r.endEventId!, r])),
  };
}
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map(block => str(record(block).text)).filter(Boolean).join("\n") : "";
}
/** Первая непустая строка: ответ модели часто начинается с пустых строк. */
function firstLine(text: string): string {
  return text.split("\n").map(line => line.trim()).find(Boolean) ?? "";
}
const outcomeLabels: Record<string, string> = { satisfied: "выполнено", needs_revision: "нужна доработка", max_iterations_reached: "итерации исчерпаны", failed: "оценка не удалась", interrupted: "прервано" };
export function eventPreview(event: SessionEvent, index: EventIndex): string {
  if (event.type === "user.message" || event.type === "agent.message") return firstLine(contentText(event.content));
  if (toolKind(event.type) !== null) return `${event.name ?? ""} ${toolInputPreview(event.name ?? "", event.input)}`.trim();
  const resultId = toolResultId(event);
  if (resultId) return `${index.toolNameByUseId.get(resultId) ?? ""} ${firstLine(contentText(event.content))}`.trim();
  if (event.type === "span.model_request_end") {
    const durationMs = index.requestByEndId.get(idOf(event))?.durationMs;
    return durationMs !== null && durationMs !== undefined ? formatShortDurationRu(durationMs) : "";
  }
  if (event.type.startsWith("span.outcome_evaluation_")) {
    const iteration = `Итерация ${num(event.iteration) + 1}`;
    return event.type.endsWith("_end") ? `${outcomeLabels[str(event.result)] ?? str(event.result)}, ${iteration.toLowerCase()}` : iteration;
  }
  if (event.type.startsWith("session.thread_status_")) return str(event.agent_name) || str(record(event.agent).name);
  if (event.type === "session.error") return sessionErrorText(event.error);
  if (event.type === "user.define_outcome") return str(event.description);
  return "";
}
const FILE_PATH_KEYS = ["file_path", "filePath", "path"] as const;
export function toolInputPreview(name: string, input: unknown): string {
  if (typeof input === "string") return input;
  const value = record(input);
  // Харнессы называют путь по-разному: file_path, filePath или path.
  const keys = ({ bash: ["command"], read: FILE_PATH_KEYS, write: FILE_PATH_KEYS, edit: FILE_PATH_KEYS, glob: ["pattern"], grep: ["pattern"], web_fetch: ["url"], web_search: ["query"] } as Record<string, readonly string[]>)[name] ?? [];
  const primary = keys.map(key => str(value[key])).find(Boolean);
  return primary || Object.values(value).find((v): v is string => typeof v === "string") || JSON.stringify(input ?? {});
}
export function eventJson(event: SessionEvent): string {
  function sorted(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, sorted(item)]));
    return value;
  }
  const { ts, ...rest } = event;
  return JSON.stringify(sorted(event.processed_at ? rest : event), null, 2);
}

const builtinNames = ["bash", "edit", "read", "write", "glob", "grep", "web_fetch", "web_search"];
export function toolCatalogFromAgent(tools: readonly unknown[] | undefined): ToolCatalogEntry[] {
  const catalog: ToolCatalogEntry[] = [];
  for (const item of tools ?? []) {
    const tool = record(item);
    if (tool.type === "custom" && str(tool.name)) catalog.push({ name: str(tool.name), kind: "custom", permission: "auto" });
    if (tool.type !== "agent_toolset_20260401" && tool.type !== "mcp_toolset") continue;
    const configs = Array.isArray(tool.configs) ? tool.configs.map(record) : [];
    const defaults = record(tool.default_config);
    const names = tool.type === "agent_toolset_20260401" ? builtinNames : configs.map(c => str(c.name));
    for (const name of names) {
      const config = configs.find(c => c.name === name) ?? {};
      if ((config.enabled ?? defaults.enabled) === false || !name) continue;
      const entry: ToolCatalogEntry = { name, kind: tool.type === "mcp_toolset" ? "mcp" : "builtin", permission: (config.permission_policy ?? defaults.permission_policy) === "always_ask" ? "ask" : "auto" };
      if (entry.kind === "mcp") entry.mcpServerName = str(tool.mcp_server_name);
      catalog.push(entry);
    }
  }
  return catalog;
}
function toolKind(type: string): ToolKind | null {
  return type === "agent.tool_use" ? "builtin" : type === "agent.mcp_tool_use" ? "mcp" : type === "agent.custom_tool_use" ? "custom" : null;
}
function toolResultId(event: SessionEvent): string | null {
  if (event.type === "agent.tool_result") return str(event.tool_use_id) || null;
  if (event.type === "agent.mcp_tool_result") return str(event.mcp_tool_use_id) || null;
  if (event.type === "user.custom_tool_result") return str(event.custom_tool_use_id) || null;
  return null;
}
function closesTool(type: string): boolean {
  return ["session.status_idle", "session.status_terminated", "session.thread_status_idle", "session.thread_status_terminated", "session.error", "user.interrupt"].includes(type);
}
export function collectToolCalls(events: readonly SessionEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const requestIds = new Map<string, string>();
  for (const event of events) {
    const threadId = eventThreadId(event);
    if (event.type === "span.model_request_start") requestIds.set(threadId, idOf(event));
    else if (topLevel(event.type)) requestIds.delete(threadId);
    const kind = toolKind(event.type);
    if (kind) {
      const call: ToolCall = { useEventId: idOf(event), resultEventId: null, confirmationEventId: null, name: event.name ?? "", kind, input: event.input, output: undefined, isError: false, status: "running", startMs: eventTimeMs(event), endMs: null, durationMs: null, waitingMs: 0, threadId, requestId: requestIds.get(threadId) ?? null };
      if (kind === "mcp") call.mcpServerName = event.mcp_server_name;
      calls.push(call);
      byId.set(call.useEventId, call);
    }
    const resultId = toolResultId(event);
    if (resultId) {
      const call = byId.get(resultId);
      if (call) {
        call.resultEventId = idOf(event);
        call.output = event.content;
        call.isError = event.is_error === true;
        if (call.status !== "denied") call.status = call.isError ? "failed" : "completed";
        call.endMs = eventTimeMs(event);
        call.durationMs = elapsed(call.startMs, call.endMs);
      }
    }
    if (event.type === "user.tool_confirmation") {
      const call = byId.get(str(event.tool_use_id));
      if (call) {
        call.confirmationEventId = idOf(event);
        call.waitingMs = elapsed(call.startMs, eventTimeMs(event)) ?? 0;
        if (event.result === "deny") { call.status = "denied"; call.endMs = eventTimeMs(event); }
      }
    }
    if (closesTool(event.type)) {
      for (const call of calls) if (call.threadId === threadId && call.status === "running") {
        call.status = "interrupted";
        call.endMs = eventTimeMs(event);
      }
    }
  }
  return calls;
}
const emptyCounts = (): ToolStatusCounts => ({ completed: 0, failed: 0, denied: 0, interrupted: 0, running: 0 });
function toolKey(tool: { kind: ToolKind; name: string; mcpServerName?: string }): string { return `${tool.kind}:${tool.mcpServerName ?? ""}:${tool.name}`; }
export function computeToolStats(calls: readonly ToolCall[], catalog: readonly ToolCatalogEntry[]): { rows: ToolStatsRow[]; summary: ToolsSummary } {
  const rows: ToolStatsRow[] = [];
  const byKey = new Map<string, ToolStatsRow>();
  function add(tool: ToolCatalogEntry | ToolCall, permission: ToolPermission | null): ToolStatsRow {
    const key = toolKey(tool);
    const old = byKey.get(key);
    if (old) return old;
    const row: ToolStatsRow = { name: tool.name, kind: tool.kind, permission, calls: 0, failed: 0, failedRatio: null, p50Ms: null, counts: emptyCounts(), callList: [] };
    rows.push(row); byKey.set(key, row); return row;
  }
  catalog.forEach(tool => add(tool, tool.permission));
  const summary: ToolsSummary = { toolCount: 0, usedCount: 0, callCount: calls.length, counts: emptyCounts(), time: { totalMs: 0, executingMs: 0, waitingMs: 0 } };
  for (const call of calls) {
    const row = add(call, null);
    row.callList.push(call); row.calls++; row.counts[call.status]++; summary.counts[call.status]++;
    const total = Math.max(call.waitingMs, elapsed(call.startMs, call.endMs) ?? 0);
    summary.time.totalMs += total;
    summary.time.waitingMs += call.waitingMs;
    summary.time.executingMs += Math.max(0, total - call.waitingMs);
  }
  for (const row of rows) {
    row.failed = row.counts.failed;
    row.failedRatio = row.calls ? row.failed / row.calls : null;
    const durations = row.callList.filter(c => c.resultEventId !== null && c.durationMs !== null).map(c => c.durationMs!).sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    row.p50Ms = durations.length ? durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2 : null;
  }
  summary.toolCount = rows.length; summary.usedCount = rows.filter(r => r.calls > 0).length;
  rows.sort((a, b) => b.calls - a.calls);
  return { rows, summary };
}

function activeTime(events: readonly SessionEvent[], prefix: string, nowMs?: number): number {
  let start: number | null = null;
  let activeMs = 0;
  for (const event of events) {
    const at = eventTimeMs(event);
    if (at === null) continue;
    if (event.type === `${prefix}running` && start === null) start = at;
    if ([`${prefix}idle`, `${prefix}terminated`, "session.error"].includes(event.type) && start !== null) {
      activeMs += elapsed(start, at) ?? 0; start = null;
    }
  }
  if (start !== null) activeMs += elapsed(start, nowMs ?? events.reduce<number | null>((last, e) => eventTimeMs(e) ?? last, null)) ?? 0;
  return activeMs;
}
export function computeSessionTotals(events: readonly SessionEvent[], options: { threadId?: string; nowMs?: number } = {}): SessionTotals {
  const scoped = options.threadId ? eventsOfThread(events, options.threadId) : events;
  const requests = collectModelRequests(scoped);
  const times = scoped.map(eventTimeMs).filter((n): n is number => n !== null);
  return {
    requestCount: requests.length, erroredRequestCount: requests.filter(r => r.isError).length,
    activeMs: activeTime(scoped, "session.status_", options.nowMs), firstEventMs: times[0] ?? null, lastEventMs: times.at(-1) ?? null,
  };
}
export function computeThreadStats(events: readonly SessionEvent[], threadId: string, nowMs?: number): ThreadStats {
  const scoped = eventsOfThread(events, threadId);
  // Сервер может не слать статусы потока: тогда считаем по статусам сессии в событиях потока.
  const hasThreadStatuses = scoped.some(event => event.type.startsWith("session.thread_status_"));
  const activeMs = activeTime(scoped, hasThreadStatuses ? "session.thread_status_" : "session.status_", nowMs);
  return { ...computeSessionTotals(scoped, { nowMs }), activeMs, threadId };
}

export function collectOutcomes(events: readonly SessionEvent[]): OutcomeView[] {
  const outcomes: OutcomeView[] = [];
  const starts = new Map<string, SessionEvent>();
  for (const event of events) {
    if (event.type === "user.define_outcome") {
      const rubric = record(event.rubric);
      outcomes.push({ outcomeId: str(event.outcome_id), eventId: idOf(event), description: str(event.description), rubric: rubric.type === "file" ? { type: "file", fileId: str(rubric.file_id) } : { type: "text", content: str(rubric.content) }, maxIterations: typeof event.max_iterations === "number" ? event.max_iterations : null, definedAtMs: eventTimeMs(event), evaluations: [] });
    } else if (event.type === "span.outcome_evaluation_start") starts.set(idOf(event), event);
    else if (event.type === "span.outcome_evaluation_end") {
      const outcome = outcomes.find(o => o.outcomeId === event.outcome_id);
      const start = starts.get(str(event.outcome_evaluation_start_id)) ?? [...starts.values()].find(e => e.outcome_id === event.outcome_id && e.iteration === event.iteration);
      outcome?.evaluations.push({ iteration: num(event.iteration), result: str(event.result), explanation: str(event.explanation), startEventId: start ? idOf(start) : null, endEventId: idOf(event), startMs: start ? eventTimeMs(start) : null, atMs: eventTimeMs(event) });
    }
  }
  return outcomes;
}

export function buildTranscriptBlocks(events: readonly SessionEvent[], options: { previousEventMs?: number | null; gapMs?: number } = {}): TranscriptBlock[] {
  const requests = collectModelRequests(events);
  const requestByStart = new Map(requests.map(r => [r.startEventId, r]));
  const calls = collectToolCalls(events);
  const callByEvent = new Map<string, ToolCall>();
  for (const call of calls) for (const id of [call.useEventId, call.resultEventId, call.confirmationEventId]) if (id) callByEvent.set(id, call);
  const outcomes = collectOutcomes(events);
  const blocks: TranscriptBlock[] = [];
  let current: Extract<TranscriptBlock, { kind: "request" }> | null = null;
  let previous = options.previousEventMs ?? null;
  let gradingIds: string[] = [];
  for (const event of events) {
    const atMs = eventTimeMs(event);
    const eventId = idOf(event);
    if (previous !== null && atMs !== null && atMs - previous >= (options.gapMs ?? TRANSCRIPT_GAP_MS)) {
      blocks.push({ kind: "gap", id: `gap-${eventId}`, atMs, eventIds: [], gapMs: atMs - previous }); current = null;
    }
    if (atMs !== null) previous = atMs;
    const base = { id: eventId, atMs, eventIds: [eventId] };
    if (topLevel(event.type)) current = null;
    if (event.type === "user.message") {
      const status = event.status === "pending" || event.status === "cancelled" ? event.status : event.processed_at === null ? "pending" : "processed";
      blocks.push({ ...base, kind: "user", eventId, text: contentText(event.content), status, wakeup: event.wakeup === true || event.is_wakeup === true });
    } else if (event.type === "user.define_outcome") {
      const outcome = outcomes.find(o => o.eventId === eventId);
      if (outcome) blocks.push({ ...base, kind: "outcome_defined", eventId, outcome });
    } else if (event.type.startsWith("span.outcome_evaluation_")) {
      current = null; gradingIds.push(eventId);
      if (event.type.endsWith("_end")) {
        const outcome = outcomes.find(o => o.outcomeId === event.outcome_id);
        const index = outcome?.evaluations.findIndex(e => e.endEventId === eventId) ?? -1;
        const evaluation = outcome?.evaluations[index];
        if (evaluation && outcome) blocks.push({ ...base, id: gradingIds[0], eventIds: gradingIds, kind: "grading", eventId, outcomeId: outcome.outcomeId, evaluation, index, count: outcome.evaluations.length });
        gradingIds = [];
      }
    } else if (event.type === "session.error") {
      const error = record(event.error); current = null;
      blocks.push({ ...base, kind: "error", eventId, message: sessionErrorText(event.error), errorType: str(error.type) || null, retrying: error.retry_status === "retrying" });
    } else if (event.type === "session.warning") {
      current = null; blocks.push({ ...base, kind: "warning", eventId, source: event.source ?? "", message: event.message ?? "" });
    } else if (event.type === "span.model_request_start" || event.type.startsWith("agent.") || event.type === "span.model_request_end") {
      const linked = callByEvent.get(eventId);
      const target = linked && blocks.find((b): b is Extract<TranscriptBlock, { kind: "request" }> => b.kind === "request" && b.items.some(i => i.kind === "tool" && i.call.useEventId === linked.useEventId));
      if (target && target !== current && toolKind(event.type) === null) { target.eventIds.push(eventId); continue; }
      if (!current || event.type === "span.model_request_start") {
        const request = requestByStart.get(eventId) ?? null;
        current = { ...base, kind: "request", request, endMs: request?.endMs ?? null, thinking: false, thoughtMs: null, items: [] }; blocks.push(current);
      } else current.eventIds.push(eventId);
      if (event.type === "agent.thinking") { current.thinking = true; current.thoughtMs = elapsed(current.request?.startMs ?? null, atMs); }
      if (event.type === "agent.message") current.items.push({ kind: "text", eventId, text: contentText(event.content) });
      if (toolKind(event.type) && linked) current.items.push({ kind: "tool", call: linked });
      if (event.type === "agent.thread_message_sent" || event.type === "agent.thread_message_received") current.items.push({ kind: "thread_message", eventId, direction: event.type.endsWith("sent") ? "sent" : "received", agentName: str(event.to_agent_name ?? event.from_agent_name) || null, text: contentText(event.content) });
    } else if (callByEvent.has(eventId)) {
      const call = callByEvent.get(eventId)!;
      const block = blocks.find(b => b.kind === "request" && b.items.some(i => i.kind === "tool" && i.call.useEventId === call.useEventId));
      block?.eventIds.push(eventId);
    } else if (current && !topLevel(event.type)) current.eventIds.push(eventId);
  }
  return blocks;
}
export function blockIdByEventId(blocks: readonly TranscriptBlock[], events: readonly SessionEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of blocks) for (const id of block.eventIds) map.set(id, block.id);
  const following: Array<string | undefined> = new Array(events.length);
  let next: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) { next = map.get(idOf(events[i])) ?? next; following[i] = next; }
  let previous: string | undefined;
  for (let i = 0; i < events.length; i++) {
    const id = idOf(events[i]);
    const block = map.get(id) ?? following[i] ?? previous;
    if (block) { map.set(id, block); previous = block; }
  }
  return map;
}
