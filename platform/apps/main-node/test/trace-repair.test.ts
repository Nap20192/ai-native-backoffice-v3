import { describe, expect, it } from "vitest";
import { spanIdFor } from "../src/lib/trace/ids";
import { createTraceProjector } from "../src/lib/trace/projector";
import { createExecutionsReader } from "../src/lib/trace/executions-reader";
import { createHistoryWindow } from "../src/lib/trace/history-window";
import { createTraceRepair } from "../src/lib/trace/repair";
import { createTraceStore, type TraceStore } from "../src/lib/trace/store";
import type { TraceProjectorInput, TraceScope } from "../src/lib/trace/types";
import { loadTraceFixture, type TraceMultiTurnFixture } from "./_helpers/trace-harness-conformance";
import {
  createHistoryDb,
  insertEvent,
  insertExecution,
  insertSession,
  loadFixtureHistory,
  loadTurnInputsAsHistory,
} from "./_helpers/trace-history-db";

const WS = "ws_repair";

async function setup(name: string, override: Parameters<typeof loadFixtureHistory>[3] = {}) {
  const sql = await createHistoryDb();
  const fixture = loadTraceFixture(name);
  await loadFixtureHistory(sql, WS, fixture, override);
  let clock = 1792500000000;
  const store = createTraceStore({ sql, dialect: "sqlite", now: () => clock });
  const executions = createExecutionsReader(sql);
  const history = createHistoryWindow(sql);
  const repair = createTraceRepair({ store, executions, history, now: () => clock });
  const scope: TraceScope = { workspaceId: WS, sessionId: fixture.scope.sessionId };
  return { sql, fixture, store, executions, history, repair, scope, tick: (ms = 1000) => { clock += ms; } };
}

async function live(store: TraceStore, scope: TraceScope, inputs: readonly TraceProjectorInput[]) {
  const projector = createTraceProjector({ sessionId: scope.sessionId, harness: "pi" });
  for (const input of inputs) {
    const ops = projector.push(input);
    if (ops.length > 0) await store.apply(scope, { turnId: projector.turnId()!, attemptId: projector.attemptId(), ops });
  }
  return projector;
}

describe("executions reader and history window", () => {
  it("reads executions on the coordinator schema and the events of one turn", async () => {
    const { fixture, executions, history, scope } = await setup("pi-turn-frames.json");
    const rows = await executions.list(scope);
    expect(rows.map((row) => [row.id, row.state, row.attempt_id, row.settled_at_ms])).toEqual([
      [fixture.execution!.id, "completed", "attempt_rlY_zx-uyJlCOD6HCkpNM", 1792097299534],
    ]);
    const execution = (await executions.find(scope, fixture.execution!.id))!;
    expect(execution.events).toHaveLength(1);
    const events = await history.read(scope, execution);
    expect(events.map((event) => event.type)).toEqual([
      "session.status_running", "span.model_request_start", "agent.thinking", "agent.tool_use", "span.model_request_end",
      "session.usage", "agent.tool_result", "span.model_request_start", "agent.thinking", "agent.message",
      "span.model_request_end", "session.usage", "session.status_idle",
    ]);
    expect(events[4]).toMatchObject({ model_request_start_id: "sevt-i2havp34duc1fap1", finish_reason: "toolUse" });
    expect(events[4]).not.toHaveProperty("source_position");
    expect(await history.executionOfEvent(scope, "chatcmpl-tool-ab6ba647636a85b4")).toBe(fixture.execution!.id);
  });
});

describe("trace repair from history (plan 3.3)", () => {
  it("builds a turn without a trace_turns row and a second call changes nothing", async () => {
    const { fixture, store, repair, scope, executions, tick } = await setup("pi-turn-frames.json");
    const execution = (await executions.find(scope, fixture.execution!.id))!;
    expect(await repair.repairTurn(scope, execution)).toBe("repaired");
    const [turn] = await store.readTurns(scope);
    expect(turn).toMatchObject({ state: "repaired", span_count: 5, history_cursor: "sevt_0fk9BrGzCg-MSmBRidgDU" });
    expect(turn!.lost).toEqual(["sandbox_phases", "harness_timing", "ttft", "tool_exec"]);
    const spans = await store.readSessionSpans(scope, null, 100);
    expect(spans.filter((span) => span.status === "running")).toEqual([]);
    expect(spans.find((span) => span.kind === "turn")).toMatchObject({ status: "ok", precision: "by_events" });
    expect(spans.find((span) => span.kind === "sandbox")).toMatchObject({ status: "ok", start_ms: 1792097242487, end_ms: Date.parse("2026-10-15T20:47:22.495Z") });
    const models = spans.filter((span) => span.kind === "model_call");
    expect(models.map((span) => span.precision)).toEqual(["by_events", "by_events"]);
    tick();
    expect(await repair.repairTurn(scope, execution)).toBe("skipped");
    const again = await store.readSessionSpans(scope, null, 100);
    expect(again.map((span) => span.version)).toEqual(spans.map((span) => span.version));
  });

  it("gives the same span ids as the live write and keeps live measurements", async () => {
    const { fixture, store, repair, scope, executions } = await setup("pi-turn-frames.json");
    // The live write stops in the second model call: the process died.
    const cut = fixture.inputs.findIndex((input) => input.kind === "frame" && (input.frame as { id?: string }).id === "sevt-ljlcx8x37wi3ajvj");
    await live(store, scope, fixture.inputs.slice(0, cut + 1));
    const liveSpans = await store.readSessionSpans(scope, null, 100);
    const liveModel = liveSpans.find((span) => span.kind === "model_call" && span.status === "ok")!;
    const execution = (await executions.find(scope, fixture.execution!.id))!;
    expect(repair.needsRepair(await store.readTurn(scope, execution.id), execution)).toBe(true);
    await repair.repairTurn(scope, execution);
    const repaired = await store.readSessionSpans(scope, null, 100);
    for (const span of liveSpans) expect(repaired.some((candidate) => candidate.span_id === span.span_id)).toBe(true);
    expect(repaired.find((span) => span.span_id === liveModel.span_id)).toMatchObject({ precision: "measured", start_ms: liveModel.start_ms, end_ms: liveModel.end_ms });
    const exec = repaired.find((span) => span.kind === "tool_exec")!;
    expect(exec.precision).toBe("measured");
    expect(repaired.filter((span) => span.status === "running")).toEqual([]);
    expect(await store.readTurn(scope, execution.id)).toMatchObject({ state: "repaired" });
  });

  it("repairs a turn whose batches were lost", async () => {
    const { fixture, store, repair, scope, executions } = await setup("tool-error-frames.json");
    const projector = await live(store, scope, fixture.inputs.slice(0, 8));
    await store.markFramesLost(scope, projector.turnId()!, projector.attemptId());
    const execution = (await executions.find(scope, fixture.execution!.id))!;
    await repair.repairTurn(scope, execution);
    const turn = (await store.readTurn(scope, execution.id))!;
    expect(turn).toMatchObject({ state: "repaired", frames_lost: true });
    const spans = await store.readSessionSpans(scope, null, 100);
    expect(spans.filter((span) => span.kind === "tool_call").map((span) => span.status)).toEqual(["ok", "error", "ok"]);
    expect(spans.filter((span) => span.status === "running")).toEqual([]);
  });

  it("closes what a dead owner left open when the lease expired", async () => {
    const { sql, fixture, store, repair, scope, executions } = await setup("interrupted-turn-frames.json", {
      state: "running", settled_at_ms: null, lease_expires_at_ms: 1792108976229, failure: null,
    });
    // History of a dead process: nothing after the model request start.
    await sql.prepare("DELETE FROM managed_session_events WHERE processed_at > ?").bind(1792108946295).run();
    const cut = fixture.inputs.findIndex((input) => input.kind === "frame" && (input.frame as { type?: string }).type === "span.model_request_start");
    await live(store, scope, fixture.inputs.slice(0, cut + 1));
    const execution = (await executions.find(scope, fixture.execution!.id))!;
    expect(repair.needsRepair(await store.readTurn(scope, execution.id), execution)).toBe(true);
    await repair.repairTurn(scope, execution);
    const spans = await store.readSessionSpans(scope, null, 100);
    expect(spans.filter((span) => span.status === "running")).toEqual([]);
    const turn = spans.find((span) => span.kind === "turn")!;
    expect(turn.status).toBe("interrupted");
    expect(turn.attrs.end_reason).toBe("process_lost");
    expect((await store.readTurn(scope, execution.id))!.lost.length).toBeGreaterThan(0);
  });

  it("does not repair a turn that is still running under a live lease", async () => {
    const { fixture, repair, scope, executions } = await setup("pi-turn-frames.json", {
      state: "running", settled_at_ms: null, lease_expires_at_ms: 1792500030000,
    });
    const execution = (await executions.find(scope, fixture.execution!.id))!;
    expect(repair.needsRepair(null, execution)).toBe(false);
  });

  it("finds and repairs the turn of an event", async () => {
    const { fixture, store, repair, scope } = await setup("pi-turn-frames.json");
    await repair.repairForEvent(scope, "chatcmpl-tool-ab6ba647636a85b4");
    expect(await store.readTurn(scope, fixture.execution!.id)).toMatchObject({ state: "repaired" });
  });

  it("repairs the turn of a tool call first when its confirmation turn is repaired before it", async () => {
    const sql = await createHistoryDb();
    const fixture = loadTraceFixture<TraceMultiTurnFixture>("confirmation-frames.json");
    const sessionId = fixture.scope.sessionId;
    await insertSession(sql, WS, sessionId, { harness: "pi" });
    const [turn1, turn2] = fixture.turns;
    for (const turn of [turn1!, turn2!]) await loadTurnInputsAsHistory(sql, WS, sessionId, turn.executionId, turn.inputs);
    const store = createTraceStore({ sql, dialect: "sqlite" });
    const executions = createExecutionsReader(sql);
    const repair = createTraceRepair({ store, executions, history: createHistoryWindow(sql) });
    const scope = { workspaceId: WS, sessionId };
    // Search builds the newest turn first: the allow of turn 2 comes before the tool call of turn 1.
    expect(await repair.repairTurn(scope, (await executions.find(scope, turn2!.executionId))!)).toBe("repaired");
    const bash = "toolu_fixtureConfirmBash1";
    const spans = new Map((await store.readSessionSpans(scope, null, 100)).map((span) => [span.span_id, span]));
    const call = spanIdFor(sessionId, "events", "tool_call", bash);
    expect(spans.get(call)).toMatchObject({ status: "ok", end_ms: 1792200260640, turn_id: turn1!.executionId });
    expect(spans.get(spanIdFor(sessionId, "events", "tool_wait", bash))).toMatchObject({ status: "ok", end_ms: 1792200260000 });
    expect(spans.get(spanIdFor(sessionId, "events", "tool_exec", bash))).toMatchObject({
      status: "ok", parent_span_id: call, turn_id: turn1!.executionId, start_ms: 1792200260000, end_ms: 1792200260640,
    });
    expect(await store.readTurn(scope, turn1!.executionId)).toMatchObject({ state: "repaired", waiting_count: 0 });
    expect(await repair.repairTurn(scope, (await executions.find(scope, turn1!.executionId))!)).toBe("skipped");
  });

  it("leaves a complete earlier turn as it is when a later turn patches a span that turn never had", async () => {
    const { sql, fixture, store, repair, scope, executions } = await setup("pi-turn-frames.json");
    const projector = await live(store, scope, fixture.inputs);
    await store.finalizeTurn(scope, { turnId: projector.turnId()!, attemptId: projector.attemptId(), state: "complete", historyCursor: projector.lastEventId(), lost: [] });
    // The client answers the bash call of turn 1 with user.tool_result: that call never waited, so it has no tool_wait.
    const at = 1792097400000;
    const event = { id: "sevt_repairLateResult1", type: "user.tool_result", toolUseId: "chatcmpl-tool-ab6ba647636a85b4", content: [], processedAt: new Date(at).toISOString() };
    await insertEvent(sql, WS, scope.sessionId, { id: event.id, type: event.type, processed_at: at, document: event });
    await insertExecution(sql, WS, scope.sessionId, {
      id: event.id, admitted_at_ms: at, events: [event], state: "completed", attempt_id: "attempt_repairLate1",
      claimed_at_ms: at + 1, lease_expires_at_ms: at + 30_000, settled_at_ms: at + 100,
    });
    expect(await repair.repairTurn(scope, (await executions.find(scope, event.id))!)).toBe("repaired");
    expect(await store.readTurn(scope, fixture.execution!.id)).toMatchObject({ state: "complete", lost: [] });
  });

  it("derives three failed sandbox attempts of a start failure from the driver events", async () => {
    const sql = await createHistoryDb();
    const fixture = loadTraceFixture("start-failure-frames.json");
    const { insertEvent, insertExecution, insertSession } = await import("./_helpers/trace-history-db");
    await insertSession(sql, WS, fixture.scope.sessionId);
    const execution = fixture.execution as never as Parameters<typeof insertExecution>[3];
    for (const input of fixture.inputs) {
      if (input.kind !== "frame") continue;
      const frame = input.frame as { id: string; type: string; processed_at: string; error?: { type: string; message: string; retry_status: string }; stop_reason?: unknown };
      const document: Record<string, unknown> = { id: frame.id, type: frame.type, processedAt: frame.processed_at, source_position: { execution_id: execution.id } };
      if (frame.error !== undefined) document.error = { type: frame.error.type, message: frame.error.message, retryStatus: frame.error.retry_status };
      if (frame.stop_reason !== undefined) document.stopReason = frame.stop_reason;
      await insertEvent(sql, WS, fixture.scope.sessionId, { id: frame.id, type: frame.type, processed_at: Date.parse(frame.processed_at), document });
    }
    await insertExecution(sql, WS, fixture.scope.sessionId, execution);
    const store = createTraceStore({ sql, dialect: "sqlite" });
    const repair = createTraceRepair({ store, executions: createExecutionsReader(sql), history: createHistoryWindow(sql) });
    const scope = { workspaceId: WS, sessionId: fixture.scope.sessionId };
    await repair.repairTurn(scope, (await createExecutionsReader(sql).find(scope, execution.id))!);
    const spans = await store.readSessionSpans(scope, null, 100);
    expect(spans.find((span) => span.kind === "turn")!.status).toBe("error");
    expect(spans.filter((span) => span.kind === "sandbox").map((span) => span.status)).toEqual(["error", "error", "error"]);
    expect(spans.filter((span) => span.kind === "event")).toHaveLength(1);
  });
});
