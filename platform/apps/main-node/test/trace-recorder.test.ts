import { afterEach, describe, expect, it, vi } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { DefaultNodeManagedSessionRunnerDependencies } from "../src/lib/node-managed-session-runner";
import type { NodeManagedWorkspaceCheckpoints } from "../src/lib/node-managed-workspace-checkpoints";
import { spanIdFor } from "../src/lib/trace/ids";
import { createTraceObserver, decorateRunnerDependencies } from "../src/lib/trace/observer";
import { createTraceRecorder } from "../src/lib/trace/recorder";
import { createTraceStore, type TraceStore } from "../src/lib/trace/store";
import type { TraceOp, TraceProjectorInput, TraceScope } from "../src/lib/trace/types";
import { loadTraceFixture, type TraceMultiTurnFixture } from "./_helpers/trace-harness-conformance";

afterEach(() => {
  vi.useRealTimers();
});

function logger() {
  const entries: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  return {
    entries,
    warn: (obj: Record<string, unknown>, msg: string) => { entries.push({ level: "warn", obj, msg }); },
    error: (obj: Record<string, unknown>, msg: string) => { entries.push({ level: "error", obj, msg }); },
  };
}

/** Feeds fixture inputs through the observer API the driver calls. */
async function drive(observer: ReturnType<typeof createTraceObserver>, scope: TraceScope, inputs: readonly TraceProjectorInput[], harness = "pi") {
  for (const input of inputs) {
    switch (input.kind) {
      case "execution_started":
        observer.executionStarted({ ...scope, events: input.events, atMs: input.atMs, harness, ...(input.fence !== undefined && { fence: { workspaceId: scope.workspaceId, sessionId: scope.sessionId, executionId: input.fence.executionId ?? "", attemptId: input.fence.attemptId, ownerId: "node:test", generation: input.fence.generation ?? 1, expiresAt: new Date(0).toISOString() } }) });
        break;
      case "start_attempt": observer.startAttempt({ ...scope, attempt: input.attempt, atMs: input.atMs }); break;
      case "start_attempt_settled": observer.startAttemptSettled({ ...scope, attempt: input.attempt, atMs: input.atMs, outcome: input.outcome, ...(input.error !== undefined && { error: input.error }), ...(input.retryInMs !== undefined && { retryInMs: input.retryInMs }) }); break;
      case "start_cancelled": observer.startCancelled({ ...scope, atMs: input.atMs, ...(input.reason !== undefined && { reason: input.reason }) }); break;
      case "frame": observer.frame(scope, input.frame); break;
      case "execution_settled": await observer.executionSettled({ ...scope, atMs: input.atMs, outcome: input.outcome === "process_lost" ? "failed" : input.outcome, ...(input.reason !== undefined && { reason: input.reason }) }); break;
      default: break;
    }
  }
}

describe("trace recorder", () => {
  it("writes one batch per session every 250 ms, in order", async () => {
    vi.useFakeTimers();
    const applied: Array<{ turnId: string; ops: readonly TraceOp[] }> = [];
    const store = { apply: vi.fn(async (_scope: TraceScope, batch: { turnId: string; ops: readonly TraceOp[] }) => { applied.push(batch); return { fenced: false, missing: [] }; }) } as unknown as TraceStore;
    const recorder = createTraceRecorder({ store });
    const scope = { workspaceId: "ws", sessionId: "s1" };
    const turn = { turn_id: "t1", thread_id: "sthr_primary", attempt_id: null, attempt_generation: 0, start_ms: 1, end_ms: null, coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } } as const;
    recorder.record(scope, { turnId: "t1", attemptId: null, ops: [{ op: "turn", turn }] });
    recorder.record(scope, { turnId: "t1", attemptId: null, ops: [{ op: "turn", turn: { ...turn, end_ms: 2 } }] });
    expect(applied).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(applied).toHaveLength(1);
    expect(applied[0]!.ops).toHaveLength(2);
    recorder.record(scope, { turnId: "t1", attemptId: null, ops: [{ op: "turn", turn: { ...turn, end_ms: 3 } }] });
    await recorder.flush(scope);
    expect(applied).toHaveLength(2);
  });

  it("retries a failed batch three times, then logs, marks the turn and never completes it", async () => {
    vi.useFakeTimers();
    const log = logger();
    const calls: number[] = [];
    const store = {
      apply: vi.fn(async () => { calls.push(Date.now()); throw new Error("database is locked"); }),
      markFramesLost: vi.fn(async () => undefined),
      finalizeTurn: vi.fn(async () => true),
    } as unknown as TraceStore;
    const recorder = createTraceRecorder({ store, logger: log });
    const scope = { workspaceId: "ws", sessionId: "s2" };
    recorder.record(scope, { turnId: "t1", attemptId: "a1", ops: [{ op: "patch", span_id: "x", key_event_id: "e", expect: ["waiting"], set: { status: "ok" } }] });
    const flushed = recorder.flush(scope);
    await vi.advanceTimersByTimeAsync(2000);
    await flushed;
    expect(calls).toHaveLength(4);
    expect(calls[1]! - calls[0]!).toBe(250);
    expect(calls[2]! - calls[1]!).toBe(500);
    expect(calls[3]! - calls[2]!).toBe(1000);
    expect(log.entries.map((entry) => entry.obj.op)).toContain("main-node.trace.record_failed");
    expect(store.markFramesLost).toHaveBeenCalledWith(scope, "t1", "a1");
    await recorder.settle(scope, { turnId: "t1", attemptId: "a1", complete: true, historyCursor: "e9" });
    expect(store.finalizeTurn).not.toHaveBeenCalled();
  });
});

describe("trace recorder after a lost batch", () => {
  it("keeps writing later batches of the turn but never completes it", async () => {
    let failures = 4;
    const written: number[] = [];
    const store = {
      apply: vi.fn(async (_scope: TraceScope, batch: { ops: readonly TraceOp[] }) => {
        if (failures > 0) { failures -= 1; throw new Error("database is locked"); }
        written.push(batch.ops.length);
        return { fenced: false, missing: [] };
      }),
      markFramesLost: vi.fn(async () => undefined),
      finalizeTurn: vi.fn(async () => true),
    } as unknown as TraceStore;
    const recorder = createTraceRecorder({ store, retryDelaysMs: [1, 1, 1] });
    const scope = { workspaceId: "ws", sessionId: "s_lost" };
    const op: TraceOp = { op: "patch", span_id: "x", key_event_id: "e", expect: ["waiting"], set: { status: "ok" } };
    recorder.record(scope, { turnId: "t1", attemptId: "a1", ops: [op] });
    await recorder.flush(scope);
    recorder.record(scope, { turnId: "t1", attemptId: "a1", ops: [op, op] });
    await recorder.settle(scope, { turnId: "t1", attemptId: "a1", complete: true, historyCursor: null });
    expect(written).toEqual([2]);
    expect(store.markFramesLost).toHaveBeenCalledTimes(1);
    expect(store.finalizeTurn).not.toHaveBeenCalled();
  });
});

describe("trace observer with the SQLite store", () => {
  it("records a Pi turn and completes it with the history cursor", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createTraceStore({ sql, dialect: "sqlite" });
    const observer = createTraceObserver({ recorder: createTraceRecorder({ store }) });
    const fixture = loadTraceFixture("pi-turn-frames.json");
    const scope = { workspaceId: "ws", sessionId: fixture.scope.sessionId };
    await drive(observer, scope, fixture.inputs);
    const [turn] = await store.readTurns(scope);
    expect(turn).toMatchObject({ turn_id: fixture.execution!.id, state: "complete", history_cursor: "sevt_0fk9BrGzCg-MSmBRidgDU", span_count: 6, frames_lost: false });
  });

  it("keeps running when the store fails and logs observer failures", async () => {
    const log = logger();
    const store = {
      apply: async () => { throw new Error("disk full"); },
      markFramesLost: async () => { throw new Error("disk full"); },
      finalizeTurn: async () => true,
    } as unknown as TraceStore;
    const observer = createTraceObserver({ recorder: createTraceRecorder({ store, logger: log, retryDelaysMs: [1, 1, 1] }), logger: log });
    const fixture = loadTraceFixture("pi-turn-frames.json");
    await expect(drive(observer, { workspaceId: "ws", sessionId: "s" }, fixture.inputs)).resolves.toBeUndefined();
    const live = { workspaceId: "ws", sessionId: "s3" };
    observer.executionStarted({ ...live, events: [{ type: "user.message", id: "sevt_broken_user" }], atMs: 1 });
    expect(() => observer.frame(live, { get type(): string { throw new Error("broken frame"); } })).not.toThrow();
    expect(log.entries.some((entry) => entry.obj.op === "main-node.trace.observer_failed")).toBe(true);
  });

  it("repairs the parent turn when a patch finds no row, then applies the patch again", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createTraceStore({ sql, dialect: "sqlite" });
    const fixture = loadTraceFixture<TraceMultiTurnFixture>("confirmation-frames.json");
    const scope = { workspaceId: "ws", sessionId: fixture.scope.sessionId };
    const repaired: string[] = [];
    const recorder = createTraceRecorder({
      store,
      repairMissing: async (_scope, keyEventId) => {
        repaired.push(keyEventId);
        // Stand-in for repair.ts: rebuild turn 1 from its frames.
        await drive(createTraceObserver({ recorder: createTraceRecorder({ store }) }), scope, fixture.turns[0]!.inputs);
      },
    });
    await drive(createTraceObserver({ recorder }), scope, fixture.turns[1]!.inputs);
    expect(repaired).toEqual(["toolu_fixtureConfirmBash1"]);
    const call = spanIdFor(scope.sessionId, "events", "tool_call", "toolu_fixtureConfirmBash1");
    const exec = spanIdFor(scope.sessionId, "events", "tool_exec", "toolu_fixtureConfirmBash1");
    const [callRow, execRow] = await store.readSpansByIds(scope, [call, exec]);
    expect(callRow).toMatchObject({ status: "ok" });
    expect(execRow).toMatchObject({ status: "ok", turn_id: fixture.turns[0]!.executionId });
  });

  it("cancels waiting tools of earlier turns when the session stops", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createTraceStore({ sql, dialect: "sqlite" });
    const observer = createTraceObserver({ recorder: createTraceRecorder({ store }) });
    const fixture = loadTraceFixture<TraceMultiTurnFixture>("confirmation-frames.json");
    const scope = { workspaceId: "ws", sessionId: fixture.scope.sessionId };
    await drive(observer, scope, fixture.turns[0]!.inputs);
    await observer.sessionStopped!({ ...scope, atMs: 1792200250000, reason: "session_archived" });
    const [call] = await store.readSpansByIds(scope, [spanIdFor(scope.sessionId, "events", "tool_call", "toolu_fixtureConfirmBash1")]);
    expect(call).toMatchObject({ status: "cancelled", end_ms: 1792200250000 });
  });
});

describe("runner decorator for sandbox phases", () => {
  it("times buildSandbox, the workspace restore and prepareSandbox under the current attempt", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createTraceStore({ sql, dialect: "sqlite" });
    let now = 1000;
    const observer = createTraceObserver({ recorder: createTraceRecorder({ store }), runnerPhases: true, now: () => now });
    const sandbox = { exec: async () => "" } as unknown as SandboxExecutor;
    const port = {
      materialize: async () => { now += 30; return { id: "binding" }; },
      attach: async () => { now += 5; },
      capabilities: async () => ({}),
    };
    const checkpoints = { port: () => port, active: async () => null } as unknown as NodeManagedWorkspaceCheckpoints;
    const deps = {
      buildSandbox: async () => { now += 100; return sandbox; },
      prepareSandbox: async () => { now += 20; throw new Error("upload failed"); },
      workspaceCheckpoints: checkpoints,
    } as unknown as DefaultNodeManagedSessionRunnerDependencies;
    const decorated = decorateRunnerDependencies(deps, observer);
    const scope = { workspaceId: "ws", sessionId: "session_phases" };
    const session = { id: scope.sessionId } as never;
    observer.executionStarted({ ...scope, events: [{ type: "user.message", id: "sevt_phase_user" }], atMs: 990 });
    observer.startAttempt({ ...scope, attempt: 1, atMs: 995 });
    expect(await decorated.buildSandbox({ workspaceId: "ws", session, environment: {} as never })).toBe(sandbox);
    const wrappedPort = decorated.workspaceCheckpoints!.port(sandbox);
    await wrappedPort.materialize({ scope: { workspaceId: "ws", sessionId: scope.sessionId } } as never);
    await wrappedPort.attach({ scope: { workspaceId: "ws", sessionId: scope.sessionId } } as never);
    await expect(decorated.prepareSandbox!({ workspaceId: "ws", session, environment: {} as never, sandbox, runtimeGeneration: "g" })).rejects.toThrow("upload failed");
    observer.startAttemptSettled({ ...scope, attempt: 1, atMs: now, outcome: "error", error: "upload failed" });
    observer.startAttempt({ ...scope, attempt: 2, atMs: now + 1 });
    observer.startAttemptSettled({ ...scope, attempt: 2, atMs: now + 2, outcome: "ok" });
    await observer.executionSettled({ ...scope, atMs: now + 3, outcome: "completed" });
    const spans = await store.readSessionSpans(scope, null, 100);
    const phases = spans.filter((span) => span.kind === "sandbox_phase").map((span) => [span.name, span.end_ms! - span.start_ms, span.status]);
    expect(phases).toEqual([["acquire", 100, "ok"], ["restore", 35, "ok"], ["inputs", 20, "error"]]);
    const sandboxes = spans.filter((span) => span.kind === "sandbox");
    expect(sandboxes.map((span) => [span.status, span.attrs.reused ?? false])).toEqual([["error", false], ["ok", true]]);
    expect((await store.readTurns(scope))[0]!.coverage.sandbox).toBe("phases");
  });
});
