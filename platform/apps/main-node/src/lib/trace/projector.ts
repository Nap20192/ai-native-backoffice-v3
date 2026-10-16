import { isAcpHarness } from "./harness-coverage.js";
import { spanIdFor, turnSpanIdFor, type TraceIdSpace } from "./ids.js";
import type {
  TraceAttrs,
  TraceCoverage,
  TraceExecutionOutcome,
  TraceOp,
  TracePrecision,
  TraceProjectorInput,
  TraceSpanError,
  TraceSpanKind,
  TraceSpanPatch,
  TraceSpanWrite,
  TraceStatus,
  TraceToolRef,
  TraceTurnWrite,
  TraceUsage,
} from "./types.js";

/**
 * Pure projector of plan section 2.1: observer calls, raw runner frames and
 * history events in, store operations out. It never reads the database, so
 * the live recorder and the repair from history produce the same span ids.
 */
export interface TraceProjectorOptions {
  sessionId: string;
  harness?: string | null;
  /** `history` rebuilds a turn from recorded events: sandbox attempts are derived from status events. */
  mode?: "live" | "history";
  /** The runner decorator reports sandbox phases: an attempt without phases reused a warm sandbox. */
  runnerPhases?: boolean;
}

export interface TraceProjector {
  push(input: TraceProjectorInput): TraceOp[];
  turnId(): string | null;
  attemptId(): string | null;
  /** Id of the last recorded event the projector saw (trace_turns.history_cursor). */
  lastEventId(): string | null;
  closed(): boolean;
  spans(): TraceSpanWrite[];
}

export function createTraceProjector(options: TraceProjectorOptions): TraceProjector {
  return new Projector(options);
}

export const PRIMARY_THREAD = "sthr_primary";
const MESSAGE_LIMIT = 500;

type Rec = Record<string, unknown>;

function asRec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Rec : null;
}

function str(record: Rec | null, ...keys: string[]): string | undefined {
  if (record === null) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function num(record: Rec | null, ...keys: string[]): number | undefined {
  if (record === null) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function flag(record: Rec | null, ...keys: string[]): boolean {
  if (record === null) return false;
  return keys.some((key) => record[key] === true);
}

function eventMs(record: Rec | null): number | undefined {
  if (record === null) return undefined;
  const value = record.processed_at ?? record.processedAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clip(message: string | undefined | null): string | null {
  if (message === undefined || message === null) return null;
  return message.length > MESSAGE_LIMIT ? message.slice(0, MESSAGE_LIMIT) : message;
}

function usageOf(record: Rec | null): TraceUsage | null {
  if (record === null) return null;
  return {
    input: num(record, "input_tokens", "inputTokens") ?? 0,
    output: num(record, "output_tokens", "outputTokens") ?? 0,
    cache_read: num(record, "cache_read_input_tokens", "cacheReadInputTokens") ?? 0,
    cache_write: num(record, "cache_creation_input_tokens", "cacheCreationInputTokens") ?? 0,
  };
}

interface Node {
  span: TraceSpanWrite;
  /** Child of a span from an earlier turn: written with inherit_from. */
  inheritFrom?: string;
  continuedThread?: string;
}

interface ToolState {
  callSpan: string;
  waitSpan?: string;
  execSpan?: string;
  /** The call belongs to an earlier turn: changes go out as patches. */
  foreign: boolean;
  denied: boolean;
  /** Pi starts the call when the model response ends. */
  modelStartId?: string;
}

interface TopTurn {
  turnId: string;
  spanId: string;
  threadId: string;
  attemptId: string | null;
  generation: number;
  closed: boolean;
  startSucceeded: boolean;
  startCancelled: boolean;
  failed: boolean;
  settled: boolean;
}

interface ThreadState {
  subagentSpan?: string;
  openTurn?: string;
  failed: boolean;
  turnSpans: string[];
}

class Projector implements TraceProjector {
  private readonly sessionId: string;
  private readonly harness: string | null;
  private readonly mode: "live" | "history";
  private readonly acp: boolean;
  private readonly runnerPhases: boolean;
  private readonly nodes = new Map<string, Node>();
  private readonly dirty = new Set<string>();
  private pendingPatches: TraceOp[] = [];
  private pendingClaim: TraceOp | null = null;
  private turnDirty = false;
  private top: TopTurn | null = null;
  private readonly threads = new Map<string, ThreadState>();
  private readonly tools = new Map<string, ToolState>();
  private readonly modelCalls = new Map<string, string>();
  /** First token time per model call span, kept until the call ends and its start is final. */
  private readonly firstTokens = new Map<string, { at: number; measured: boolean }>();
  private readonly pendingTools = new Map<string, string[]>();
  private readonly outcomeEvals = new Map<string, string>();
  private readonly compactions = new Map<string, string[]>();
  private readonly runnerPauses = new Map<string, string>();
  private runnerPauseCount = 0;
  private sandboxSpan: string | null = null;
  private lastSandboxSpan: string | null = null;
  private sandboxCount = 0;
  private sandboxPhases = new Set<string>();
  private driverPause: string | null = null;
  private driverPauseCount = 0;
  /** History mode: where the next derived sandbox attempt starts. */
  private startBoundary = 0;
  private lastEvent: string | null = null;

  constructor(options: TraceProjectorOptions) {
    this.sessionId = options.sessionId;
    this.harness = options.harness ?? null;
    this.mode = options.mode ?? "live";
    this.acp = isAcpHarness(options.harness);
    this.runnerPhases = options.runnerPhases === true;
  }

  turnId(): string | null { return this.top?.turnId ?? null; }
  attemptId(): string | null { return this.top?.attemptId ?? null; }
  lastEventId(): string | null { return this.lastEvent; }
  closed(): boolean { return this.top?.closed ?? false; }
  spans(): TraceSpanWrite[] { return [...this.nodes.values()].map((node) => node.span); }

  push(input: TraceProjectorInput): TraceOp[] {
    switch (input.kind) {
      case "execution_started": this.executionStarted(input); break;
      case "start_attempt": this.startAttempt(input.attempt, input.atMs); break;
      case "start_attempt_settled": this.startAttemptSettled(input); break;
      case "start_cancelled": this.startCancelled(input.atMs, input.reason); break;
      case "sandbox_phase": this.sandboxPhase(input); break;
      case "frame": this.frame(input.frame); break;
      case "execution_settled": this.executionSettled(input.atMs, input.outcome, input.reason); break;
    }
    return this.drain();
  }

  // ---------- emission ----------

  private drain(): TraceOp[] {
    const ops: TraceOp[] = [];
    if (this.pendingClaim !== null) ops.push(this.pendingClaim);
    this.pendingClaim = null;
    for (const id of this.dirty) {
      const node = this.nodes.get(id);
      if (node === undefined) continue;
      const span = { ...node.span, attrs: { ...node.span.attrs }, event_ids: [...node.span.event_ids] };
      ops.push({
        op: "upsert",
        span,
        ...(node.inheritFrom !== undefined && { inherit_from: node.inheritFrom }),
        ...(node.continuedThread !== undefined && { continued_thread: node.continuedThread }),
      });
    }
    this.dirty.clear();
    ops.push(...this.pendingPatches);
    this.pendingPatches = [];
    if (this.turnDirty && this.top !== null) ops.push({ op: "turn", turn: this.turnWrite() });
    this.turnDirty = false;
    return ops;
  }

  private turnWrite(): TraceTurnWrite {
    const top = this.top!;
    const span = this.nodes.get(top.spanId)!.span;
    return {
      turn_id: top.turnId,
      thread_id: top.threadId,
      attempt_id: top.attemptId,
      attempt_generation: top.generation,
      start_ms: span.start_ms,
      end_ms: span.end_ms,
      coverage: this.coverage(),
    };
  }

  private coverage(): TraceCoverage {
    const spans = this.spans();
    const models = spans.filter((span) => span.kind === "model_call");
    const prompts = spans.filter((span) => span.kind === "acp_prompt");
    const tools = spans.filter((span) => span.kind === "tool_call");
    const execs = spans.filter((span) => span.kind === "tool_exec");
    const modelCalls: TraceCoverage["model_calls"] = models.length > 0
      ? models.every((span) => span.precision === "measured") ? "measured" : "by_events"
      : prompts.length > 0 ? "turn_only" : "absent";
    const executed = tools.filter((span) => span.status !== "waiting" && span.status !== "denied" && span.status !== "cancelled");
    const toolCoverage: TraceCoverage["tools"] = tools.length === 0
      ? "absent"
      : executed.length > 0 && executed.every((tool) => execs.some((exec) => exec.parent_span_id === tool.span_id && exec.precision === "measured"))
        ? "measured"
        : "by_events";
    return {
      model_calls: modelCalls,
      tools: toolCoverage,
      sandbox: spans.some((span) => span.kind === "sandbox_phase") ? "phases" : "attempts",
    };
  }

  // ---------- node helpers ----------

  private touch(id: string): void {
    this.dirty.add(id);
    if (this.top !== null && id === this.top.spanId) this.turnDirty = true;
  }

  private open(input: {
    kind: TraceSpanKind;
    space: TraceIdSpace;
    key: string;
    parent: string | null;
    thread: string;
    name: string;
    start: number;
    precision: TracePrecision;
    status?: TraceStatus;
    primary?: string | null;
    eventIds?: string[];
    recordMs?: number;
    attrs?: TraceAttrs;
    inheritFrom?: string;
  }): Node {
    const top = this.top!;
    const id = input.kind === "turn" && input.parent === null
      ? turnSpanIdFor(this.sessionId, input.key)
      : spanIdFor(this.sessionId, input.space, input.kind, input.key);
    const existing = this.nodes.get(id);
    if (existing !== undefined) return existing;
    const attrs: TraceAttrs = { ...(input.attrs ?? {}) };
    if (input.recordMs !== undefined) attrs.record_start_ms = input.recordMs;
    const span: TraceSpanWrite = {
      span_id: id,
      parent_span_id: input.parent,
      turn_id: top.turnId,
      attempt_id: top.attemptId,
      thread_id: input.thread,
      kind: input.kind,
      name: input.name,
      sources: [input.space === "runner" ? "runner" : "events"],
      precision: input.precision,
      start_ms: input.start,
      end_ms: null,
      status: input.status ?? "running",
      error: null,
      harness: this.harness,
      model: null,
      usage: null,
      ttft_ms: null,
      finish_reason: null,
      tool: null,
      primary_event_id: input.primary ?? null,
      event_ids: input.eventIds ?? [],
      attrs,
    };
    const node: Node = { span, ...(input.inheritFrom !== undefined && { inheritFrom: input.inheritFrom }) };
    this.nodes.set(id, node);
    this.touch(id);
    return node;
  }

  private span(id: string | undefined | null): TraceSpanWrite | undefined {
    return id === undefined || id === null ? undefined : this.nodes.get(id)?.span;
  }

  private update(id: string, change: (span: TraceSpanWrite) => void): void {
    const node = this.nodes.get(id);
    if (node === undefined) return;
    change(node.span);
    this.touch(id);
  }

  private close(id: string, end: number, status: TraceStatus, extra?: { error?: TraceSpanError | null; recordMs?: number; eventId?: string }): void {
    this.update(id, (span) => {
      span.end_ms = Math.max(end, span.start_ms);
      span.status = status;
      if (extra?.error !== undefined) span.error = extra.error;
      if (extra?.recordMs !== undefined) span.attrs.record_end_ms = extra.recordMs;
      if (extra?.eventId !== undefined && !span.event_ids.includes(extra.eventId)) span.event_ids.push(extra.eventId);
    });
  }

  private addEvent(id: string | undefined, eventId: string | undefined): void {
    if (id === undefined || eventId === undefined) return;
    this.update(id, (span) => {
      if (!span.event_ids.includes(eventId)) span.event_ids.push(eventId);
    });
  }

  private patch(spanId: string, keyEventId: string, expect: TraceStatus[], set: TraceSpanPatch): void {
    this.pendingPatches.push({ op: "patch", span_id: spanId, key_event_id: keyEventId, expect, set });
  }

  private thread(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (state === undefined) {
      state = { failed: false, turnSpans: [] };
      this.threads.set(threadId, state);
    }
    return state;
  }

  private parentFor(threadId: string): string {
    const top = this.top!;
    if (threadId === top.threadId) return top.spanId;
    const state = this.threads.get(threadId);
    return state?.openTurn ?? state?.subagentSpan ?? top.spanId;
  }

  // ---------- execution and start ----------

  private executionStarted(input: Extract<TraceProjectorInput, { kind: "execution_started" }>): void {
    const events = input.events.map(asRec).filter((event): event is Rec => event !== null);
    const actionable = events.filter((event) => str(event, "type") !== "system.message" && str(event, "type") !== "user.interrupt");
    const first = actionable[0] ?? events[0] ?? null;
    const turnId = input.fence?.executionId ?? str(first, "id");
    if (turnId === undefined) return;
    const threadId = str(first, "session_thread_id", "sessionThreadId") ?? PRIMARY_THREAD;
    this.top = {
      turnId,
      spanId: turnSpanIdFor(this.sessionId, turnId),
      threadId,
      attemptId: input.fence?.attemptId || null,
      generation: input.fence?.generation ?? 0,
      closed: false,
      startSucceeded: false,
      startCancelled: false,
      failed: false,
      settled: false,
    };
    const firstMs = eventMs(first);
    const attrs: TraceAttrs = {};
    if (firstMs !== undefined) attrs.queue_ms = Math.max(0, input.atMs - firstMs);
    this.open({
      kind: "turn",
      space: "events",
      key: turnId,
      parent: null,
      thread: threadId,
      name: input.agentName ?? "turn",
      start: input.atMs,
      precision: this.mode === "live" ? "measured" : "by_events",
      primary: str(first, "id") ?? turnId,
      eventIds: actionable.map((event) => str(event, "id")).filter((id): id is string => id !== undefined),
      attrs,
    });
    this.startBoundary = input.atMs;
    this.pendingClaim = { op: "claim", turn: this.turnWrite() };
    for (const event of actionable) {
      const type = str(event, "type");
      if (type === "user.tool_confirmation") this.confirmation(event, input.atMs);
      else if (type === "user.custom_tool_result" || type === "user.tool_result") this.userToolResult(event, input.atMs);
    }
  }

  private sandboxKey(attempt: number): string {
    return `${this.top!.attemptId ?? "local"}:${attempt}`;
  }

  private startAttempt(attempt: number, atMs: number): void {
    if (this.top === null || this.top.closed) return;
    if (this.driverPause !== null) {
      this.close(this.driverPause, atMs, "ok");
      this.driverPause = null;
    }
    this.sandboxCount = Math.max(this.sandboxCount, attempt);
    const node = this.open({
      kind: "sandbox",
      space: "runner",
      key: this.sandboxKey(attempt),
      parent: this.top.spanId,
      thread: this.top.threadId,
      name: "sandbox",
      start: atMs,
      precision: "measured",
      attrs: { attempt },
    });
    this.sandboxSpan = node.span.span_id;
    this.lastSandboxSpan = node.span.span_id;
    this.sandboxPhases = new Set();
  }

  private startAttemptSettled(input: Extract<TraceProjectorInput, { kind: "start_attempt_settled" }>): void {
    if (this.top === null) return;
    const id = this.sandboxSpan ?? spanIdFor(this.sessionId, "runner", "sandbox", this.sandboxKey(input.attempt));
    if (!this.nodes.has(id)) this.startAttempt(input.attempt, input.atMs);
    const status: TraceStatus = input.outcome === "ok" ? "ok" : input.outcome === "error" ? "error" : "cancelled";
    this.close(id, input.atMs, status, input.outcome === "error"
      ? { error: { type: "start_failed", message: clip(input.error) } }
      : undefined);
    if (input.outcome === "ok") {
      this.top.startSucceeded = true;
      if (this.runnerPhases && this.sandboxPhases.size === 0) this.update(id, (span) => { span.attrs.reused = true; });
    }
    this.sandboxSpan = null;
    if (input.outcome === "error" && input.retryInMs !== undefined && !this.top.closed) {
      this.driverPauseCount += 1;
      const pause = this.open({
        kind: "retry_wait",
        space: "runner",
        key: `${this.top.turnId}:p${this.driverPauseCount}`,
        parent: this.top.spanId,
        thread: this.top.threadId,
        name: "retry_wait",
        start: input.atMs,
        precision: "measured",
        attrs: { planned_ms: input.retryInMs, after_attempt: input.attempt },
      });
      this.driverPause = pause.span.span_id;
    }
  }

  private startCancelled(atMs: number, reason: string | undefined): void {
    if (this.top === null) return;
    this.top.startCancelled = true;
    if (this.sandboxSpan !== null) {
      this.close(this.sandboxSpan, atMs, "cancelled");
      this.sandboxSpan = null;
    }
    if (this.driverPause !== null) {
      this.close(this.driverPause, atMs, "cancelled");
      this.driverPause = null;
    }
    if (reason !== undefined) this.update(this.top.spanId, (span) => { span.attrs.cancel_reason = reason; });
  }

  private sandboxPhase(input: Extract<TraceProjectorInput, { kind: "sandbox_phase" }>): void {
    if (this.top === null) return;
    const sandbox = this.sandboxSpan ?? this.lastSandboxSpan;
    if (sandbox === null) return;
    const key = `${sandbox}:${input.name}`;
    const id = spanIdFor(this.sessionId, "runner", "sandbox_phase", key);
    this.sandboxPhases.add(input.name);
    const existing = this.span(id);
    if (existing !== undefined) {
      this.update(id, (span) => {
        span.start_ms = Math.min(span.start_ms, input.startMs);
        span.end_ms = Math.max(span.end_ms ?? input.endMs, input.endMs);
        if (input.error !== undefined) {
          span.status = "error";
          span.error = { type: "phase_failed", message: clip(input.error) };
        }
      });
      return;
    }
    const node = this.open({
      kind: "sandbox_phase",
      space: "runner",
      key,
      parent: sandbox,
      thread: this.top.threadId,
      name: input.name,
      start: input.startMs,
      precision: "measured",
      attrs: input.attrs ?? {},
    });
    this.close(node.span.span_id, input.endMs, input.error === undefined ? "ok" : "error", input.error === undefined
      ? undefined
      : { error: { type: "phase_failed", message: clip(input.error) } });
  }

  /** History mode: an attempt that ended at `end`, derived from status events. */
  private derivedAttempt(end: number, error: TraceSpanError | null, eventId: string | undefined): void {
    const top = this.top!;
    this.sandboxCount += 1;
    const node = this.open({
      kind: "sandbox",
      space: "runner",
      key: this.sandboxKey(this.sandboxCount),
      parent: top.spanId,
      thread: top.threadId,
      name: "sandbox",
      start: this.startBoundary,
      precision: "by_events",
      attrs: { attempt: this.sandboxCount },
    });
    this.close(node.span.span_id, end, error === null ? "ok" : "error", { error, ...(eventId !== undefined && { eventId }) });
    this.lastSandboxSpan = node.span.span_id;
    this.startBoundary = end;
  }

  // ---------- frames ----------

  private frame(raw: unknown): void {
    const frame = asRec(raw);
    const top = this.top;
    if (frame === null || top === null) return;
    const type = str(frame, "type");
    if (type === undefined) return;
    const id = str(frame, "id");
    const at = eventMs(frame) ?? Date.now();
    const thread = str(frame, "session_thread_id", "sessionThreadId") ?? top.threadId;
    if (id !== undefined && !type.includes("_stream_") && !type.endsWith("_chunk")) this.lastEvent = id;
    if (top.closed) return;
    const pause = this.runnerPauses.get(thread);
    if (pause !== undefined && type !== "session.status_rescheduled" && type !== "session.thread_status_rescheduled") {
      this.close(pause, at, "ok");
      this.runnerPauses.delete(thread);
    }
    switch (type) {
      case "session.status_running": return this.statusRunning(at, id);
      case "session.status_rescheduled":
      case "session.thread_status_rescheduled": return this.rescheduled(thread, at, id);
      case "session.error": return this.sessionError(frame, thread, at, id);
      case "session.warning": return this.warning(frame, thread, at, id);
      case "session.status_idle": return this.statusIdle(frame, thread, at, id);
      case "session.status_terminated": return this.closeTop(at, "cancelled", id);
      case "session.thread_created": return this.threadCreated(frame, thread, at, id);
      case "agent.thread_message_sent": return this.threadMessageSent(frame, at, id);
      case "agent.thread_message_received": return this.addEvent(this.threads.get(thread)?.subagentSpan, id);
      case "session.thread_status_running": return this.threadRunning(frame, thread, at, id);
      case "session.thread_status_idle": return this.threadIdle(frame, thread, at, id);
      case "session.thread_status_terminated": return this.threadTerminated(frame, thread, at, id);
      case "span.model_request_start": return this.modelStart(frame, thread, at, id);
      case "span.model_first_token": return this.firstToken(frame, at);
      case "span.model_request_end": return this.modelEnd(frame, thread, at, id);
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use": return this.toolUse(frame, type, thread, at, id);
      case "span.tool_execution_start": return this.execStart(frame, at);
      case "span.tool_execution_end": return this.execEnd(frame, at);
      case "agent.tool_result":
      case "agent.mcp_tool_result": return this.toolResult(frame, at, id);
      case "span.outcome_evaluation_start": return this.outcomeStart(frame, thread, at, id);
      case "span.outcome_evaluation_end": return this.outcomeEnd(frame, at, id);
      case "span.compaction_summarize_start": return this.compactionStart(frame, thread, at, id);
      case "span.compaction_summarize_end": return this.compactionEnd(frame, thread, at, id);
      default: return;
    }
  }

  private statusRunning(at: number, id: string | undefined): void {
    const top = this.top!;
    if (!top.startSucceeded && this.mode === "history") this.derivedAttempt(at, null, id);
    top.startSucceeded = true;
  }

  private rescheduled(thread: string, at: number, id: string | undefined): void {
    const top = this.top!;
    if (thread === top.threadId && !top.startSucceeded) {
      if (this.mode === "history") this.startBoundary = at;
      return;
    }
    this.runnerPauseCount += 1;
    const node = this.open({
      kind: "retry_wait",
      space: "events",
      key: `${top.turnId}:r${this.runnerPauseCount}`,
      parent: this.parentFor(thread),
      thread,
      name: "retry_wait",
      start: at,
      precision: "by_events",
      primary: id ?? null,
      eventIds: id === undefined ? [] : [id],
      recordMs: at,
    });
    this.runnerPauses.set(thread, node.span.span_id);
  }

  private errorOf(frame: Rec): TraceSpanError {
    const error = asRec(frame.error);
    const retry = str(error, "retry_status", "retryStatus");
    return {
      type: str(error, "type") ?? "unknown_error",
      message: clip(str(error, "message") ?? (typeof frame.error === "string" ? frame.error : null)),
      ...((retry === "retrying" || retry === "exhausted") && { retry_status: retry }),
    };
  }

  private sessionError(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const top = this.top!;
    const error = this.errorOf(frame);
    if (thread === top.threadId && !top.startSucceeded) {
      if (this.mode === "history") {
        this.derivedAttempt(at, { type: "start_failed", message: error.message }, id);
      } else if (this.lastSandboxSpan !== null && error.retry_status === "retrying") {
        this.update(this.lastSandboxSpan, (span) => {
          if (id !== undefined && !span.event_ids.includes(id)) span.event_ids.push(id);
          span.error = { type: span.error?.type ?? "start_failed", message: span.error?.message ?? error.message, retry_status: "retrying" };
          if (span.status === "running") span.status = "error";
        });
      }
      if (error.retry_status === "retrying") return;
    }
    const node = this.open({
      kind: "event",
      space: "events",
      key: id ?? `${top.turnId}:error:${at}`,
      parent: this.parentFor(thread),
      thread,
      name: "error",
      start: at,
      precision: "by_events",
      status: "error",
      primary: id ?? null,
      eventIds: id === undefined ? [] : [id],
      recordMs: at,
    });
    this.close(node.span.span_id, at, "error", { error, recordMs: at });
    if (error.retry_status === "exhausted") {
      if (thread === top.threadId) top.failed = true;
      else this.thread(thread).failed = true;
    }
  }

  private warning(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const node = this.open({
      kind: "event",
      space: "events",
      key: id ?? `${this.top!.turnId}:warning:${at}`,
      parent: this.parentFor(thread),
      thread,
      name: "warning",
      start: at,
      precision: "by_events",
      status: "ok",
      primary: id ?? null,
      eventIds: id === undefined ? [] : [id],
      recordMs: at,
      attrs: {
        ...(str(frame, "source") !== undefined && { source: str(frame, "source")! }),
        ...(str(frame, "message") !== undefined && { message: clip(str(frame, "message"))! }),
      },
    });
    this.close(node.span.span_id, at, "ok", { recordMs: at });
  }

  private statusIdle(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const top = this.top!;
    if (thread !== top.threadId) return this.threadIdle(frame, thread, at, id);
    if (top.closed) return;
    const stop = str(asRec(frame.stop_reason ?? frame.stopReason), "type");
    let status: TraceStatus = "ok";
    if (top.startCancelled) status = "interrupted";
    else if (stop === "retries_exhausted" || top.failed) status = "error";
    if (stop !== undefined && stop !== "end_turn") this.update(top.spanId, (span) => { span.attrs.stop_reason = stop; });
    this.closeTop(at, status, id);
  }

  private closeTop(at: number, status: TraceStatus, eventId: string | undefined, endReason?: string): void {
    const top = this.top!;
    if (top.closed) return;
    top.closed = true;
    // Subagent participation ends with the turn (plan 1.4).
    for (const [threadId, state] of this.threads) {
      if (state.openTurn !== undefined) {
        this.closeOpenDescendants(state.openTurn, at, endReason);
        this.close(state.openTurn, at, "interrupted");
        state.openTurn = undefined;
      }
      if (state.subagentSpan === undefined) continue;
      const turns = state.turnSpans.map((spanId) => this.span(spanId)!).filter(Boolean);
      const last = turns.at(-1);
      const subagent = this.span(state.subagentSpan)!;
      const end = turns.reduce((max, span) => Math.max(max, span.end_ms ?? at), subagent.start_ms);
      const nodeStatus: TraceStatus = turns.some((span) => span.status === "error") ? "error" : last?.status ?? "ok";
      this.close(state.subagentSpan, end, nodeStatus === "running" ? "interrupted" : nodeStatus);
      void threadId;
    }
    this.closeOpenDescendants(top.spanId, at, endReason);
    this.update(top.spanId, (span) => {
      span.end_ms = Math.max(at, span.start_ms);
      span.status = status;
      span.attrs.record_end_ms = at;
      if (eventId !== undefined && !span.event_ids.includes(eventId)) span.event_ids.push(eventId);
      if (endReason !== undefined) span.attrs.end_reason = endReason;
      const failed = [...this.nodes.values()].some((node) => node.span.span_id !== top.spanId && node.inheritFrom === undefined && node.span.status === "error");
      if (failed) span.attrs.has_error = true;
    });
  }

  /**
   * Open nodes of the turn get interrupted at its end, except waiting ones.
   * The top turn closes every node it wrote. A thread turn closes only its own
   * subtree: all threads share the turn_id of the top turn.
   */
  private closeOpenDescendants(rootId: string, at: number, endReason?: string): void {
    const wholeTurn = rootId === this.top!.spanId;
    for (const node of this.nodes.values()) {
      const span = node.span;
      if (span.span_id === rootId || span.end_ms !== null || span.status === "waiting") continue;
      if (node.inheritFrom === undefined && span.turn_id !== this.top!.turnId) continue;
      if (!wholeTurn && !this.descends(span, rootId)) continue;
      this.update(span.span_id, (open) => {
        open.end_ms = Math.max(at, open.start_ms);
        open.status = "interrupted";
        if (endReason !== undefined) open.attrs.end_reason = endReason;
      });
    }
  }

  /** The node lies under `rootId` by its parent links. */
  private descends(span: TraceSpanWrite, rootId: string): boolean {
    let parent = span.parent_span_id;
    for (let depth = 0; parent !== null && depth < 64; depth += 1) {
      if (parent === rootId) return true;
      parent = this.nodes.get(parent)?.span.parent_span_id ?? null;
    }
    return false;
  }

  // ---------- subagents ----------

  private ensureSubagent(threadId: string, at: number, input: { name?: string; parent?: string; eventId?: string; continued: boolean }): string {
    const state = this.thread(threadId);
    if (state.subagentSpan !== undefined) {
      this.addEvent(state.subagentSpan, input.eventId);
      return state.subagentSpan;
    }
    const top = this.top!;
    const node = this.open({
      kind: "subagent",
      space: "events",
      key: `${threadId}:${top.turnId}`,
      parent: input.parent ?? top.spanId,
      thread: threadId,
      name: input.name ?? "subagent",
      start: at,
      precision: "by_events",
      primary: input.eventId ?? null,
      eventIds: input.eventId === undefined ? [] : [input.eventId],
      recordMs: at,
      attrs: { thread_state: "open" },
    });
    if (input.continued) node.continuedThread = threadId;
    state.subagentSpan = node.span.span_id;
    return node.span.span_id;
  }

  private threadCreated(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const parentTool = str(frame, "parent_tool_use_id", "parentToolUseId");
    const toolSpan = parentTool === undefined ? undefined : this.tools.get(parentTool)?.callSpan;
    const parentThread = str(frame, "parent_thread_id", "parentThreadId");
    const parent = toolSpan ?? (parentThread !== undefined ? this.parentFor(parentThread) : undefined);
    this.ensureSubagent(thread, at, { name: str(frame, "agent_name", "agentName"), ...(parent !== undefined && { parent }), ...(id !== undefined && { eventId: id }), continued: false });
  }

  private threadMessageSent(frame: Rec, at: number, id: string | undefined): void {
    const target = str(frame, "to_session_thread_id", "toSessionThreadId");
    if (target === undefined) return;
    const parentTool = str(frame, "parent_tool_use_id", "parentToolUseId");
    const toolSpan = parentTool === undefined ? undefined : this.tools.get(parentTool)?.callSpan;
    const existed = this.threads.get(target)?.subagentSpan !== undefined;
    const span = this.ensureSubagent(target, at, { name: str(frame, "to_agent_name", "toAgentName"), ...(toolSpan !== undefined && { parent: toolSpan }), ...(id !== undefined && { eventId: id }), continued: true });
    if (existed) this.update(span, (node) => { if (node.attrs.thread_state === "closed") node.attrs.thread_state = "open"; });
  }

  private threadRunning(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const state = this.thread(thread);
    const subagent = this.ensureSubagent(thread, at, { name: str(frame, "agent_name", "agentName"), continued: true });
    if (state.openTurn !== undefined) this.close(state.openTurn, at, "interrupted");
    const node = this.open({
      kind: "turn",
      space: "events",
      key: id ?? `${thread}:${at}`,
      parent: subagent,
      thread,
      name: str(frame, "agent_name", "agentName") ?? "subagent",
      start: at,
      precision: "by_events",
      primary: id ?? null,
      eventIds: id === undefined ? [] : [id],
      recordMs: at,
    });
    state.openTurn = node.span.span_id;
    state.failed = false;
    state.turnSpans.push(node.span.span_id);
  }

  private threadIdle(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const state = this.thread(thread);
    if (state.openTurn === undefined) {
      // Resume without a message: the thread is open again.
      const span = this.ensureSubagent(thread, at, { name: str(frame, "agent_name", "agentName"), ...(id !== undefined && { eventId: id }), continued: true });
      this.update(span, (node) => { node.attrs.thread_state = "open"; });
      return;
    }
    const stop = str(asRec(frame.stop_reason ?? frame.stopReason), "type");
    let status: TraceStatus = "ok";
    if (flag(frame, "interrupted")) status = "interrupted";
    else if (stop === "retries_exhausted" || state.failed) status = "error";
    const turnSpan = state.openTurn;
    this.closeOpenDescendants(turnSpan, at);
    this.close(turnSpan, at, status, { recordMs: at, ...(id !== undefined && { eventId: id }) });
    state.openTurn = undefined;
    state.failed = false;
  }

  private threadTerminated(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const span = this.ensureSubagent(thread, at, { name: str(frame, "agent_name", "agentName"), ...(id !== undefined && { eventId: id }), continued: true });
    this.update(span, (node) => { node.attrs.thread_state = "closed"; });
  }

  // ---------- model calls ----------

  private modelStart(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const key = id ?? `${thread}:${at}`;
    const atMs = num(frame, "at_ms");
    const node = this.open({
      kind: this.acp ? "acp_prompt" : "model_call",
      space: "events",
      key,
      parent: this.parentFor(thread),
      thread,
      name: str(frame, "model") ?? "model",
      start: atMs ?? at,
      precision: atMs !== undefined ? "measured" : "by_events",
      primary: id ?? null,
      eventIds: id === undefined ? [] : [id],
      recordMs: at,
    });
    node.span.model = str(frame, "model") ?? null;
    this.modelCalls.set(key, node.span.span_id);
  }

  private firstToken(frame: Rec, at: number): void {
    const startId = str(frame, "model_request_start_id", "modelRequestStartId");
    const spanId = startId === undefined ? undefined : this.modelCalls.get(startId);
    const span = this.span(spanId);
    if (span === undefined || span.ttft_ms !== null) return;
    const atMs = num(frame, "at_ms");
    const measured = atMs !== undefined && span.precision === "measured";
    const first = measured ? atMs : at;
    const start = measured ? span.start_ms : Number(span.attrs.record_start_ms ?? span.start_ms);
    this.firstTokens.set(spanId!, { at: first, measured });
    this.update(spanId!, (node) => { node.ttft_ms = Math.max(0, first - start); });
  }

  private modelEnd(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const startId = str(frame, "model_request_start_id", "modelRequestStartId");
    let spanId = startId === undefined ? undefined : this.modelCalls.get(startId);
    if (spanId === undefined) {
      this.modelStart({ type: "span.model_request_start", ...(startId !== undefined && { id: startId }), model: frame.model }, thread, num(frame, "started_at_ms") ?? at, startId);
      spanId = this.modelCalls.get(startId ?? `${thread}:${num(frame, "started_at_ms") ?? at}`);
      if (spanId === undefined) return;
    }
    const startedAt = num(frame, "started_at_ms");
    const duration = num(frame, "duration_ms");
    const endAt = num(frame, "at_ms");
    const isError = flag(frame, "is_error", "isError");
    const finish = str(frame, "finish_reason", "finishReason") ?? null;
    const status: TraceStatus = isError ? "error" : finish === "aborted" ? "interrupted" : "ok";
    this.update(spanId, (span) => {
      if (startedAt !== undefined && duration !== undefined) {
        span.start_ms = startedAt;
        span.end_ms = startedAt + duration;
        span.precision = "measured";
        span.attrs.harness_duration_ms = duration;
      } else if (span.precision === "measured" && endAt !== undefined) {
        span.end_ms = Math.max(endAt, span.start_ms);
      } else {
        span.precision = "by_events";
        span.start_ms = Number(span.attrs.record_start_ms ?? span.start_ms);
        span.end_ms = Math.max(at, span.start_ms);
      }
      span.status = status;
      span.finish_reason = finish;
      span.model = str(frame, "model") ?? span.model;
      if (span.model !== null) span.name = span.model;
      span.usage = usageOf(asRec(frame.model_usage ?? frame.modelUsage));
      if (isError) span.error = { type: "model_error", message: clip(str(frame, "error_message", "errorMessage")) };
      const responseId = str(frame, "provider_response_id", "providerResponseId");
      if (responseId !== undefined) span.attrs.provider_response_id = responseId;
      span.attrs.record_end_ms = at;
      if (id !== undefined && !span.event_ids.includes(id)) span.event_ids.push(id);
      const first = this.firstTokens.get(span.span_id);
      if (first !== undefined) {
        const start = first.measured && span.precision === "measured" ? span.start_ms : Number(span.attrs.record_start_ms ?? span.start_ms);
        span.ttft_ms = Math.max(0, first.at - start);
      }
    });
    this.firstTokens.delete(spanId);
    const call = this.span(spanId)!;
    for (const toolSpan of this.pendingTools.get(startId ?? "") ?? []) {
      if (call.precision !== "measured") continue;
      this.update(toolSpan, (span) => {
        span.start_ms = call.end_ms!;
        span.attrs.start_from_model_end = true;
      });
      const wait = [...this.tools.values()].find((tool) => tool.callSpan === toolSpan)?.waitSpan;
      if (wait !== undefined) this.update(wait, (span) => { span.start_ms = call.end_ms!; });
    }
    this.pendingTools.delete(startId ?? "");
    if (startId !== undefined) this.modelCalls.delete(startId);
  }

  // ---------- tools ----------

  private toolUse(frame: Rec, type: string, thread: string, at: number, id: string | undefined): void {
    if (id === undefined) return;
    const name = str(frame, "name") ?? "tool";
    const kind: TraceToolRef["kind"] = type === "agent.mcp_tool_use" ? "mcp" : type === "agent.custom_tool_use" ? "custom" : "builtin";
    const waits = kind === "custom" || str(frame, "evaluated_permission", "evaluatedPermission") === "ask";
    const parent = this.parentFor(thread);
    const node = this.open({
      kind: "tool_call",
      space: "events",
      key: id,
      parent,
      thread,
      name,
      start: at,
      precision: "by_events",
      status: waits ? "waiting" : "running",
      primary: id,
      eventIds: [id],
      recordMs: at,
    });
    node.span.tool = { name, call_id: id, kind, mcp_server: kind === "mcp" ? str(frame, "mcp_server_name", "mcpServerName") ?? null : null };
    const state: ToolState = { callSpan: node.span.span_id, foreign: false, denied: false };
    // The model call that produced this tool use is the open one on the same thread.
    const openModel = [...this.modelCalls.entries()].reverse().find(([, spanId]) => this.span(spanId)?.thread_id === thread);
    if (openModel !== undefined) {
      state.modelStartId = openModel[0];
      const pending = this.pendingTools.get(openModel[0]) ?? [];
      pending.push(node.span.span_id);
      this.pendingTools.set(openModel[0], pending);
    }
    if (waits) {
      const wait = this.open({
        kind: "tool_wait",
        space: "events",
        key: id,
        parent: node.span.span_id,
        thread,
        name: "wait",
        start: at,
        precision: "by_events",
        status: "waiting",
        primary: id,
        eventIds: [id],
      });
      state.waitSpan = wait.span.span_id;
    }
    this.tools.set(id, state);
  }

  private execStart(frame: Rec, at: number): void {
    const toolUseId = str(frame, "tool_use_id", "toolUseId");
    const tool = toolUseId === undefined ? undefined : this.tools.get(toolUseId);
    if (tool === undefined || tool.foreign) return;
    const call = this.span(tool.callSpan);
    if (call === undefined || call.status === "waiting") return;
    const atMs = num(frame, "at_ms");
    const node = this.open({
      kind: "tool_exec",
      space: "events",
      key: toolUseId!,
      parent: tool.callSpan,
      thread: call.thread_id,
      name: "exec",
      start: atMs ?? at,
      precision: atMs !== undefined ? "measured" : "by_events",
      primary: toolUseId!,
      recordMs: at,
    });
    tool.execSpan = node.span.span_id;
  }

  private execEnd(frame: Rec, at: number): void {
    const toolUseId = str(frame, "tool_use_id", "toolUseId");
    const tool = toolUseId === undefined ? undefined : this.tools.get(toolUseId);
    const exec = this.span(tool?.execSpan);
    if (tool === undefined || exec === undefined || exec.end_ms !== null) return;
    const atMs = num(frame, "at_ms");
    const duration = num(frame, "duration_ms");
    const failed = flag(frame, "is_error", "isError");
    this.update(tool.execSpan!, (span) => {
      if (span.precision === "measured" && duration !== undefined) span.end_ms = span.start_ms + duration;
      else if (span.precision === "measured" && atMs !== undefined) span.end_ms = Math.max(atMs, span.start_ms);
      else {
        span.precision = "by_events";
        span.end_ms = Math.max(at, span.start_ms);
      }
      if (duration !== undefined) span.attrs.harness_duration_ms = duration;
      span.attrs.record_end_ms = at;
      span.status = failed ? "error" : "ok";
    });
  }

  private toolResult(frame: Rec, at: number, id: string | undefined): void {
    const toolUseId = str(frame, "tool_use_id", "toolUseId", "mcp_tool_use_id", "mcpToolUseId");
    if (toolUseId === undefined) return;
    const failed = flag(frame, "is_error", "isError");
    const tool = this.tools.get(toolUseId);
    if (tool === undefined || tool.foreign) return this.foreignResult(toolUseId, tool, failed, at, id);
    const exec = this.span(tool.execSpan);
    if (exec !== undefined && exec.end_ms === null) this.close(tool.execSpan!, at, failed ? "error" : "ok", { recordMs: at });
    if (exec !== undefined) this.addEvent(tool.execSpan, id);
    if (tool.waitSpan !== undefined && this.span(tool.waitSpan)?.end_ms === null) this.close(tool.waitSpan, at, "cancelled");
    const closedExec = this.span(tool.execSpan);
    this.update(tool.callSpan, (span) => {
      const measured = closedExec?.precision === "measured" && span.attrs.start_from_model_end === true;
      span.end_ms = Math.max(measured ? closedExec!.end_ms! : at, span.start_ms);
      span.precision = measured ? "measured" : "by_events";
      if (!measured) span.start_ms = Number(span.attrs.record_start_ms ?? span.start_ms);
      span.status = tool.denied ? "denied" : failed ? "error" : "ok";
      if (failed) span.error = { type: "tool_error", message: null };
      span.attrs.record_end_ms = at;
      if (id !== undefined && !span.event_ids.includes(id)) span.event_ids.push(id);
    });
  }

  /** Result of a call from an earlier turn: the confirmed or waiting tool (plan 1.4). */
  private foreignResult(toolUseId: string, tool: ToolState | undefined, failed: boolean, at: number, id: string | undefined): void {
    const callSpan = tool?.callSpan ?? spanIdFor(this.sessionId, "events", "tool_call", toolUseId);
    const waitSpan = spanIdFor(this.sessionId, "events", "tool_wait", toolUseId);
    const status: TraceStatus = tool?.denied ? "denied" : failed ? "error" : "ok";
    this.patch(callSpan, toolUseId, ["waiting", "running"], {
      status,
      end_ms: at,
      event_ids: id === undefined ? [toolUseId] : [toolUseId, id],
      ...(failed && !tool?.denied && { error: { type: "tool_error", message: null } }),
    });
    if (tool === undefined) this.patch(waitSpan, toolUseId, ["waiting"], { status: "cancelled", end_ms: at });
    const exec = this.span(tool?.execSpan);
    if (exec !== undefined && exec.end_ms === null) {
      this.update(tool!.execSpan!, (span) => {
        span.end_ms = Math.max(at, span.start_ms);
        span.status = failed ? "error" : "ok";
        span.attrs.record_end_ms = at;
        if (id !== undefined && !span.event_ids.includes(id)) span.event_ids.push(id);
      });
    }
  }

  private confirmation(event: Rec, startedAt: number): void {
    const top = this.top!;
    const toolUseId = str(event, "tool_use_id", "toolUseId");
    const id = str(event, "id");
    if (toolUseId === undefined || id === undefined) return;
    const at = eventMs(event) ?? startedAt;
    const allow = str(event, "result") !== "deny";
    const callSpan = spanIdFor(this.sessionId, "events", "tool_call", toolUseId);
    const waitSpan = spanIdFor(this.sessionId, "events", "tool_wait", toolUseId);
    const node = this.open({
      kind: "event",
      space: "events",
      key: id,
      parent: top.spanId,
      thread: top.threadId,
      name: "confirmation",
      start: at,
      precision: "by_events",
      status: allow ? "ok" : "denied",
      primary: id,
      eventIds: [id],
      attrs: { link_span_id: callSpan, result: allow ? "allow" : "deny", tool_use_id: toolUseId },
    });
    node.span.end_ms = at;
    this.patch(waitSpan, toolUseId, ["waiting"], { status: allow ? "ok" : "denied", end_ms: at, event_ids: [toolUseId, id] });
    const state: ToolState = { callSpan, waitSpan, foreign: true, denied: !allow };
    if (allow) {
      this.patch(callSpan, toolUseId, ["waiting"], { status: "running" });
      const exec = this.open({
        kind: "tool_exec",
        space: "events",
        key: toolUseId,
        parent: callSpan,
        thread: top.threadId,
        name: "exec",
        start: at,
        precision: "by_events",
        primary: toolUseId,
        eventIds: [id],
        attrs: { executed_in_turn: top.turnId },
        inheritFrom: callSpan,
      });
      exec.span.turn_id = null;
      state.execSpan = exec.span.span_id;
    }
    this.tools.set(toolUseId, state);
  }

  private userToolResult(event: Rec, startedAt: number): void {
    const toolUseId = str(event, "custom_tool_use_id", "customToolUseId", "tool_use_id", "toolUseId");
    const id = str(event, "id");
    if (toolUseId === undefined) return;
    const at = eventMs(event) ?? startedAt;
    const failed = flag(event, "is_error", "isError");
    this.patch(spanIdFor(this.sessionId, "events", "tool_wait", toolUseId), toolUseId, ["waiting"], { status: "ok", end_ms: at });
    this.patch(spanIdFor(this.sessionId, "events", "tool_call", toolUseId), toolUseId, ["waiting", "running"], {
      status: failed ? "error" : "ok",
      end_ms: at,
      event_ids: id === undefined ? [toolUseId] : [toolUseId, id],
    });
  }

  // ---------- outcome and compaction ----------

  private outcomeStart(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const key = id ?? `${thread}:outcome:${at}`;
    const node = this.open({
      kind: "outcome_eval",
      space: "events",
      key,
      parent: this.parentFor(thread),
      thread,
      name: "outcome_evaluation",
      start: at,
      precision: "by_events",
      primary: id ?? null,
      eventIds: id === undefined ? [] : [id],
      recordMs: at,
      attrs: {
        ...(num(frame, "iteration") !== undefined && { iteration: num(frame, "iteration")! }),
        ...(str(frame, "outcome_id", "outcomeId") !== undefined && { outcome_id: str(frame, "outcome_id", "outcomeId")! }),
      },
    });
    this.outcomeEvals.set(key, node.span.span_id);
  }

  private outcomeEnd(frame: Rec, at: number, id: string | undefined): void {
    const startId = str(frame, "outcome_evaluation_start_id", "outcomeEvaluationStartId");
    const spanId = startId === undefined ? undefined : this.outcomeEvals.get(startId);
    if (spanId === undefined) return;
    const result = str(frame, "result") ?? "unknown";
    const status: TraceStatus = result === "failed" ? "error" : result === "interrupted" ? "interrupted" : "ok";
    this.close(spanId, at, status, { recordMs: at, ...(id !== undefined && { eventId: id }) });
    this.update(spanId, (span) => {
      span.attrs.result = result;
      span.usage = usageOf(asRec(frame.usage));
    });
    this.outcomeEvals.delete(startId!);
  }

  private compactionStart(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const node = this.open({
      kind: "compaction",
      space: "events",
      key: id ?? `${thread}:compaction:${at}`,
      parent: this.parentFor(thread),
      thread,
      name: "compaction",
      start: at,
      precision: "by_events",
      primary: id ?? null,
      eventIds: id === undefined ? [] : [id],
      recordMs: at,
    });
    node.span.model = str(frame, "model") ?? null;
    const stack = this.compactions.get(thread) ?? [];
    stack.push(node.span.span_id);
    this.compactions.set(thread, stack);
  }

  private compactionEnd(frame: Rec, thread: string, at: number, id: string | undefined): void {
    const spanId = this.compactions.get(thread)?.pop();
    if (spanId === undefined) return;
    const finish = str(frame, "finish_reason", "finishReason") ?? null;
    this.close(spanId, at, finish === "error" ? "error" : "ok", { recordMs: at, ...(id !== undefined && { eventId: id }) });
    this.update(spanId, (span) => {
      span.finish_reason = finish;
      span.usage = usageOf(asRec(frame.model_usage ?? frame.modelUsage));
    });
  }

  // ---------- settle ----------

  private executionSettled(atMs: number, outcome: TraceExecutionOutcome, reason: string | undefined): void {
    const top = this.top;
    if (top === null || top.settled) return;
    top.settled = true;
    if (outcome === "lease_lost") return;
    const sessionGone = reason?.startsWith("session_") === true;
    if (!top.closed) {
      const status: TraceStatus = outcome === "completed"
        ? top.failed ? "error" : "ok"
        : outcome === "failed" ? "error"
          : sessionGone ? "cancelled" : "interrupted";
      const endReason = outcome === "process_lost" ? "process_lost" : outcome === "failed" && this.mode === "history" ? "execution_failed" : undefined;
      this.closeTop(atMs, status, undefined, endReason);
    } else if (outcome === "cancelled") {
      const span = this.span(top.spanId)!;
      if (span.status === "ok") this.update(top.spanId, (node) => { node.status = sessionGone ? "cancelled" : "interrupted"; });
    }
    if (reason !== undefined && outcome !== "completed") this.update(top.spanId, (span) => { span.attrs.settle_reason = clip(reason)!; });
    this.turnDirty = true;
  }
}
