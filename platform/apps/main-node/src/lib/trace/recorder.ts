import type { TraceApplyResult, TraceStore } from "./store.js";
import type { TraceOp, TraceScope } from "./types.js";

/**
 * Batching writer of plan section 2.1. Operations of a session are written
 * in order, one batch every 250 ms and on settle. A failed batch is retried
 * after 250, 500 and 1000 ms; then the turn is marked frames_lost and stays
 * open, so the repair from history finishes it later. The turn never fails
 * because of the trace.
 */
export interface TraceRecorderLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error?(obj: Record<string, unknown>, msg: string): void;
}

export interface TraceRecorderOptions {
  store: TraceStore;
  flushMs?: number;
  retryDelaysMs?: readonly number[];
  logger?: TraceRecorderLogger;
  /** Rebuilds the earlier turn that owns a span a patch did not find (repair.ts). */
  repairMissing?: (scope: TraceScope, keyEventId: string) => Promise<void>;
}

export interface TraceRecordBatch {
  turnId: string;
  attemptId: string | null;
  ops: readonly TraceOp[];
}

export interface TraceRecorder {
  readonly store: TraceStore;
  record(scope: TraceScope, batch: TraceRecordBatch): void;
  flush(scope: TraceScope): Promise<void>;
  /** Final flush. `complete` sets trace_turns.state = complete when no batch was lost. */
  settle(scope: TraceScope, input: { turnId: string; attemptId: string | null; complete: boolean; historyCursor: string | null }): Promise<void>;
  cancelWaiting(scope: TraceScope, atMs: number): Promise<void>;
}

export function createTraceRecorder(options: TraceRecorderOptions): TraceRecorder {
  return new BatchingTraceRecorder(options);
}

interface SessionQueue {
  pending: TraceRecordBatch[];
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
  lostTurns: Set<string>;
}

const keyOf = (scope: TraceScope) => `${scope.workspaceId}\u0000${scope.sessionId}`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class BatchingTraceRecorder implements TraceRecorder {
  readonly store: TraceStore;
  private readonly flushMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly logger: TraceRecorderLogger | undefined;
  private readonly repairMissing: TraceRecorderOptions["repairMissing"];
  private readonly queues = new Map<string, SessionQueue>();

  constructor(options: TraceRecorderOptions) {
    this.store = options.store;
    this.flushMs = options.flushMs ?? 250;
    this.retryDelaysMs = options.retryDelaysMs ?? [250, 500, 1000];
    this.logger = options.logger;
    this.repairMissing = options.repairMissing;
  }

  private queue(scope: TraceScope): SessionQueue {
    const key = keyOf(scope);
    let queue = this.queues.get(key);
    if (queue === undefined) {
      queue = { pending: [], timer: null, chain: Promise.resolve(), lostTurns: new Set() };
      this.queues.set(key, queue);
    }
    return queue;
  }

  record(scope: TraceScope, batch: TraceRecordBatch): void {
    if (batch.ops.length === 0) return;
    const queue = this.queue(scope);
    queue.pending.push(batch);
    if (queue.timer === null) {
      queue.timer = setTimeout(() => {
        queue.timer = null;
        void this.flush(scope);
      }, this.flushMs);
    }
  }

  flush(scope: TraceScope): Promise<void> {
    const queue = this.queue(scope);
    if (queue.timer !== null) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    const batches = queue.pending.splice(0);
    const run = async () => {
      for (const batch of mergeBatches(batches)) await this.write(scope, queue, batch);
    };
    queue.chain = queue.chain.then(run, run);
    return queue.chain;
  }

  private async write(scope: TraceScope, queue: SessionQueue, batch: TraceRecordBatch): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.store.apply(scope, batch);
        if (result.missing.length > 0) await this.retryMissing(scope, batch, result);
        return;
      } catch (error) {
        const wait = this.retryDelaysMs[attempt];
        if (wait !== undefined) {
          await delay(wait);
          continue;
        }
        queue.lostTurns.add(lostKey(batch));
        this.logger?.warn({
          op: "main-node.trace.record_failed",
          workspace_id: scope.workspaceId,
          session_id: scope.sessionId,
          turn_id: batch.turnId,
          ops: batch.ops.length,
          err: error instanceof Error ? error.message : String(error),
        }, "trace batch was not written; the turn will be repaired from history");
        try {
          await this.store.markFramesLost(scope, batch.turnId, batch.attemptId);
        } catch {
          // The open trace_turns row already makes the repair pick the turn up.
        }
        return;
      }
    }
  }

  private async retryMissing(scope: TraceScope, batch: TraceRecordBatch, result: TraceApplyResult): Promise<void> {
    if (this.repairMissing === undefined) return;
    const keys = [...new Set(result.missing.map((item) => item.key_event_id))];
    for (const key of keys) {
      try {
        await this.repairMissing(scope, key);
      } catch (error) {
        this.logger?.warn({
          op: "main-node.trace.repair_failed",
          workspace_id: scope.workspaceId,
          session_id: scope.sessionId,
          key_event_id: key,
          err: error instanceof Error ? error.message : String(error),
        }, "trace repair of an earlier turn failed");
      }
    }
    const missing = new Set(result.missing.map((item) => item.span_id));
    const again = batch.ops.filter((op) =>
      (op.op === "patch" && missing.has(op.span_id)) ||
      (op.op === "upsert" && op.inherit_from !== undefined && missing.has(op.span.span_id)));
    if (again.length > 0) await this.store.apply(scope, { ...batch, ops: again });
  }

  async settle(scope: TraceScope, input: { turnId: string; attemptId: string | null; complete: boolean; historyCursor: string | null }): Promise<void> {
    await this.flush(scope);
    const queue = this.queue(scope);
    const lost = queue.lostTurns.has(`${input.turnId}\u0000${input.attemptId ?? ""}`);
    if (input.complete && !lost) {
      try {
        await this.store.finalizeTurn(scope, {
          turnId: input.turnId,
          attemptId: input.attemptId,
          state: "complete",
          historyCursor: input.historyCursor,
          lost: [],
        });
      } catch (error) {
        this.logger?.warn({
          op: "main-node.trace.record_failed",
          workspace_id: scope.workspaceId,
          session_id: scope.sessionId,
          turn_id: input.turnId,
          err: error instanceof Error ? error.message : String(error),
        }, "trace turn was not finalized; the turn will be repaired from history");
      }
    }
    if (queue.pending.length === 0 && queue.timer === null) this.queues.delete(keyOf(scope));
  }

  async cancelWaiting(scope: TraceScope, atMs: number): Promise<void> {
    await this.flush(scope);
    await this.store.cancelWaiting(scope, atMs);
  }
}

function lostKey(batch: TraceRecordBatch): string {
  return `${batch.turnId}\u0000${batch.attemptId ?? ""}`;
}

/** Consecutive batches of one turn and attempt go out as one store call. */
function mergeBatches(batches: readonly TraceRecordBatch[]): TraceRecordBatch[] {
  const merged: TraceRecordBatch[] = [];
  for (const batch of batches) {
    const last = merged.at(-1);
    if (last !== undefined && last.turnId === batch.turnId && last.attemptId === batch.attemptId) {
      merged[merged.length - 1] = { ...last, ops: [...last.ops, ...batch.ops] };
    } else {
      merged.push({ ...batch, ops: [...batch.ops] });
    }
  }
  return merged;
}
