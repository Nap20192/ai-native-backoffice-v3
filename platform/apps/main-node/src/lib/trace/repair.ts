import { expectedHarnessLevel } from "./harness-coverage.js";
import { executionStopped, type TraceExecutionRow, type TraceExecutionsReader } from "./executions-reader.js";
import type { TraceHistoryWindow, TraceSessionInfoReader } from "./history-window.js";
import { createTraceProjector } from "./projector.js";
import type { TraceApplyBatch, TraceStore, TraceTurnRow } from "./store.js";
import type { TraceExecutionOutcome, TraceOp, TraceScope } from "./types.js";

/**
 * Repair of plan section 3.3: a turn whose trace is not complete and whose
 * execution no longer runs is rebuilt from history by the same projector.
 * Span ids match the live write; live measurements stay (store merge rules).
 * What history cannot give back is listed in trace_turns.lost.
 */
export interface TraceRepairOptions {
  store: TraceStore;
  executions: TraceExecutionsReader;
  history: TraceHistoryWindow;
  sessions?: TraceSessionInfoReader;
  now?: () => number;
}

export interface TraceRepair {
  needsRepair(turn: TraceTurnRow | null, execution: TraceExecutionRow): boolean;
  /** `force` rebuilds a complete turn too (a later turn did not find its span). */
  repairTurn(scope: TraceScope, execution: TraceExecutionRow, options?: { force?: boolean }): Promise<"repaired" | "skipped">;
  repairForEvent(scope: TraceScope, eventId: string): Promise<void>;
}

export function createTraceRepair(options: TraceRepairOptions): TraceRepair {
  const now = options.now ?? Date.now;

  const needsRepair = (turn: TraceTurnRow | null, execution: TraceExecutionRow): boolean => {
    if (turn !== null && (turn.state === "complete" || turn.state === "repaired")) return false;
    return executionStopped(execution, now());
  };

  const outcomeOf = (execution: TraceExecutionRow): { outcome: TraceExecutionOutcome; endReason: string } => {
    switch (execution.state) {
      case "completed": return { outcome: "completed", endReason: "process_lost" };
      case "failed": return { outcome: "failed", endReason: "execution_failed" };
      case "cancelled": return { outcome: "cancelled", endReason: "process_lost" };
      default: return { outcome: "process_lost", endReason: "process_lost" };
    }
  };

  /**
   * Writes the ops of a turn. A patch or an inherited child of a span that is
   * not written yet (the turn of the tool call was not built: search builds
   * newest turns first) builds that earlier turn when it needs a repair, then
   * goes again, as the live recorder does (plan 1.4). A complete earlier turn
   * stays as it is. `visiting` stops a loop between turns. Returns true when
   * the store refused the spans of the turn: another attempt holds it.
   */
  const applyResolving = async (scope: TraceScope, batch: TraceApplyBatch, visiting: Set<string>): Promise<boolean> => {
    const result = await options.store.apply(scope, batch);
    if (result.fenced) return true;
    if (result.missing.length === 0) return false;
    for (const key of new Set(result.missing.map((item) => item.key_event_id))) {
      const ownerId = await options.history.executionOfEvent(scope, key);
      if (ownerId === null || visiting.has(ownerId)) continue;
      const owner = await options.executions.find(scope, ownerId);
      if (owner !== null) await repairIn(scope, owner, {}, visiting);
    }
    const missing = new Set(result.missing.map((item) => item.span_id));
    const again = batch.ops.filter((op) =>
      (op.op === "patch" && missing.has(op.span_id)) ||
      (op.op === "upsert" && op.inherit_from !== undefined && missing.has(op.span.span_id)));
    if (again.length > 0) return (await options.store.apply(scope, { ...batch, ops: again })).fenced;
    return false;
  };

  const repairTurn: TraceRepair["repairTurn"] = (scope, execution, repairOptions = {}) =>
    repairIn(scope, execution, repairOptions, new Set());

  const repairIn = async (
    scope: TraceScope,
    execution: TraceExecutionRow,
    repairOptions: { force?: boolean },
    visiting: Set<string>,
  ): Promise<"repaired" | "skipped"> => {
    visiting.add(execution.id);
    // The row as it is now, not the caller's snapshot: the execution may have
    // gone back to the queue and a new attempt may hold it.
    const full = await options.executions.find(scope, execution.id);
    if (full === null) return "skipped";
    const existing = await options.store.readTurn(scope, full.id);
    if (!repairOptions.force && !needsRepair(existing, full)) return "skipped";
    const info = await options.sessions?.read(scope) ?? null;
    const harness = info?.harness ?? null;
    const projector = createTraceProjector({ sessionId: scope.sessionId, harness, mode: "history" });
    const attemptId = full.attempt_id ?? existing?.attempt_id ?? null;
    // The generation of the execution as it is. A higher one would let this
    // repair take the turn from the attempt that wrote it (claim checks <=).
    const generation = full.generation;
    const ops: TraceOp[] = [];
    ops.push(...projector.push({
      kind: "execution_started",
      atMs: full.claimed_at_ms ?? full.admitted_at_ms,
      events: full.events,
      fence: { executionId: full.id, attemptId: attemptId ?? "", generation },
      agentName: info?.agentName ?? null,
      harness,
    }));
    for (const frame of await options.history.read(scope, full)) ops.push(...projector.push({ kind: "frame", frame }));
    const turnId = projector.turnId() ?? full.id;
    const writer = projector.attemptId() ?? "";
    if (!executionStopped(full, now())) {
      // Forced build of a turn that still runs: it stays open.
      const fenced = await applyResolving(scope, { turnId, attemptId: writer, ops }, visiting);
      return fenced ? "skipped" : "repaired";
    }
    const { outcome, endReason } = outcomeOf(full);
    const endAt = full.settled_at_ms ?? full.lease_expires_at_ms ?? now();
    ops.push(...projector.push({
      kind: "execution_settled",
      atMs: endAt,
      outcome,
      ...(full.failure !== null && { reason: full.failure }),
    }));
    if (await applyResolving(scope, { turnId, attemptId: writer, ops }, visiting)) return "skipped";
    // A newer attempt took the turn after the write: its spans stay open.
    const owner = await options.store.readTurn(scope, turnId);
    if (owner === null || (owner.attempt_id ?? "") !== writer || owner.attempt_generation !== generation) return "skipped";
    // Live rows the history cannot see (Pi execution frames, sandbox phases)
    // close here, while this attempt still holds the turn.
    await options.store.closeOpenSpans(scope, turnId, {
      atMs: endAt,
      endReason,
      owner: { attemptId: writer, generation },
    });
    const lost = ["sandbox_phases", ...(expectedHarnessLevel(harness) >= 2 ? ["harness_timing", "ttft", "tool_exec"] : [])];
    await options.store.finalizeTurn(scope, {
      turnId,
      attemptId: writer,
      state: "repaired",
      historyCursor: projector.lastEventId(),
      lost,
      framesLost: existing?.frames_lost === true,
    });
    return "repaired";
  };

  return {
    needsRepair,
    repairTurn,
    async repairForEvent(scope, eventId) {
      const executionId = await options.history.executionOfEvent(scope, eventId);
      if (executionId === null) return;
      const execution = await options.executions.find(scope, executionId);
      if (execution === null) return;
      await repairTurn(scope, execution, { force: true });
    },
  };
}
