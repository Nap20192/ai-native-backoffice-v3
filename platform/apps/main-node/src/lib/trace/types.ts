import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";

/** Agent trace model (docs/plans/agent-trace.md, section 1). */

export type TraceSpanKind =
  | "turn"
  | "sandbox"
  | "sandbox_phase"
  | "harness_start"
  | "acp_prompt"
  | "agent_step"
  | "model_call"
  | "tool_call"
  | "tool_wait"
  | "tool_exec"
  | "subagent"
  | "outcome_eval"
  | "compaction"
  | "retry_wait"
  | "hook"
  | "event";

export type TraceSource = "events" | "runner" | "otel" | "rollout";

export type TracePrecision = "measured" | "by_events";

export type TraceStatus =
  | "running"
  | "ok"
  | "error"
  | "denied"
  | "interrupted"
  | "cancelled"
  | "waiting";

export type TraceAttrValue = string | number | boolean;
export type TraceAttrs = Record<string, TraceAttrValue>;

export interface TraceSpanError {
  type: string | null;
  message: string | null;
  retry_status?: "retrying" | "exhausted";
}

export interface TraceUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface TraceToolRef {
  name: string;
  call_id: string;
  kind: "builtin" | "mcp" | "custom";
  mcp_server: string | null;
}

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
  attrs: TraceAttrs;
  version: number;
  deleted: boolean;
  updated_at: number;
}

/** A span as the projector writes it. The store owns version, deleted and updated_at. */
export type TraceSpanWrite = Omit<TraceSpan, "version" | "deleted" | "updated_at">;

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

/** Row of trace_turns as the projector and the recorder write it. */
export interface TraceTurnWrite {
  turn_id: string;
  thread_id: string;
  attempt_id: string | null;
  attempt_generation: number;
  start_ms: number;
  end_ms: number | null;
  coverage: TraceCoverage;
}

export interface TraceSpanPatch {
  status?: TraceStatus;
  end_ms?: number | null;
  error?: TraceSpanError | null;
  event_ids?: string[];
}

/**
 * Store operations produced by the projector. The projector never reads the
 * database. `claim` takes a turn for a new attempt and closes what the previous
 * attempt left open. Spans of the own turn are written only while the writer
 * still holds the turn. `inherit_from` writes a child of a span from an earlier
 * turn: the store copies turn_id and thread_id from that parent. `patch`
 * changes a span of an earlier turn only while its status is still expected.
 */
export type TraceOp =
  | { op: "claim"; turn: TraceTurnWrite }
  | { op: "turn"; turn: TraceTurnWrite }
  | {
      op: "upsert";
      span: TraceSpanWrite;
      inherit_from?: string;
      /** Thread id: the store links attrs.continued_from to the previous subagent node of the thread. */
      continued_thread?: string;
    }
  | {
      op: "patch";
      span_id: string;
      /** Event id that keys the span (agent.tool_use id). Repair finds the turn by it. */
      key_event_id: string;
      expect: TraceStatus[];
      set: TraceSpanPatch;
    };

export type TraceExecutionOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "lease_lost"
  | "process_lost";

export type TraceProjectorInput =
  | {
      kind: "execution_started";
      atMs: number;
      events: readonly unknown[];
      fence?: Pick<SessionExecutionFence, "attemptId"> & Partial<Pick<SessionExecutionFence, "executionId" | "generation">>;
      agentName?: string | null;
      harness?: string | null;
    }
  | { kind: "start_attempt"; attempt: number; atMs: number }
  | {
      kind: "start_attempt_settled";
      attempt: number;
      atMs: number;
      outcome: "ok" | "error" | "cancelled";
      error?: string;
      retryInMs?: number;
    }
  | { kind: "start_cancelled"; atMs: number; reason?: string }
  | {
      kind: "sandbox_phase";
      name: string;
      startMs: number;
      endMs: number;
      error?: string;
      attrs?: TraceAttrs;
    }
  | { kind: "frame"; frame: unknown }
  | {
      kind: "execution_settled";
      atMs: number;
      outcome: TraceExecutionOutcome;
      reason?: string;
    };

export interface TraceScope {
  workspaceId: string;
  sessionId: string;
}

/** Driver hook (plan section 2.1). TW1 calls it from DefaultNodeManagedSessionRuntimeDriver. */
export interface SessionExecutionObserver {
  executionStarted(input: TraceScope & {
    events: readonly unknown[];
    fence?: SessionExecutionFence;
    atMs: number;
    agentName?: string | null;
    harness?: string | null;
  }): void;
  startAttempt(input: TraceScope & { attempt: number; atMs: number }): void;
  /** Called before projectStartFailure. */
  startAttemptSettled(input: TraceScope & {
    attempt: number;
    atMs: number;
    outcome: "ok" | "error" | "cancelled";
    error?: string;
    retryInMs?: number;
  }): void;
  /** Called at the start of finishCancelledStart. */
  startCancelled(input: TraceScope & { atMs: number; reason?: string }): void;
  /** Synchronous, in enqueueOutput, before the frame reaches history. */
  frame(scope: TraceScope, frame: unknown): void;
  /** Flushes the recorder. The driver waits at most 2 s. */
  executionSettled(input: TraceScope & {
    atMs: number;
    outcome: "completed" | "failed" | "cancelled" | "lease_lost";
    reason?: string;
  }): Promise<void>;
  /** Session stop, archive or delete: waiting tools of earlier turns get cancelled. */
  sessionStopped?(input: TraceScope & { atMs: number; reason: string }): Promise<void>;
}

/** Sandbox phases reported by the runner decorator (decorateRunnerDependencies). */
export interface TracePhaseSink {
  /** Clock of the phase times; Date.now when absent. */
  now?(): number;
  sandboxPhase(scope: TraceScope, phase: {
    name: string;
    startMs: number;
    endMs: number;
    error?: string;
    attrs?: TraceAttrs;
  }): void;
}
