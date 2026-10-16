import { describe, expect, it } from "vitest";
import { spanIdFor } from "../src/lib/trace/ids";
import type { TraceOp, TraceProjectorInput } from "../src/lib/trace/types";
import {
  emptyProjectedTrace,
  loadTraceFixture,
  runProjectorInputs,
  spansOfKind,
  type TraceMultiTurnFixture,
} from "./_helpers/trace-harness-conformance";

const fixture = loadTraceFixture<TraceMultiTurnFixture>("confirmation-frames.json");
const options = { sessionId: fixture.scope.sessionId, harness: fixture.harness };
const sessionId = fixture.scope.sessionId;
const bash1 = "toolu_fixtureConfirmBash1";
const bash3 = "toolu_fixtureConfirmBash3";
const callOf = (toolUseId: string) => spanIdFor(sessionId, "events", "tool_call", toolUseId);
const waitOf = (toolUseId: string) => spanIdFor(sessionId, "events", "tool_wait", toolUseId);
const execOf = (toolUseId: string) => spanIdFor(sessionId, "events", "tool_exec", toolUseId);

describe("trace of a tool that waits for confirmation (plan 1.4)", () => {
  it("requires_action keeps the call and the wait in waiting after the turn closes", () => {
    const trace = runProjectorInputs(fixture.turns[0]!.inputs, options);
    const [turn] = spansOfKind(trace, "turn");
    expect(turn).toMatchObject({ status: "ok" });
    expect(turn!.attrs.stop_reason).toBe("requires_action");
    expect(trace.spans.get(callOf(bash1))).toMatchObject({ status: "waiting", end_ms: null, turn_id: fixture.turns[0]!.executionId });
    expect(trace.spans.get(waitOf(bash1))).toMatchObject({ status: "waiting", end_ms: null, parent_span_id: callOf(bash1) });
    expect(spansOfKind(trace, "tool_exec")).toHaveLength(0);
    expect(trace.turns.get(fixture.turns[0]!.executionId)!.coverage.tools).toBe("by_events");
  });

  it("ignores Pi execution frames of a tool that waits", () => {
    const head = fixture.turns[0]!.inputs.slice(0, 6);
    const trace = runProjectorInputs([
      ...head,
      { kind: "frame", frame: { type: "span.tool_execution_start", tool_use_id: bash1, at_ms: 1792200200950, processed_at: new Date(1792200200950).toISOString() } },
    ], options);
    expect(spansOfKind(trace, "tool_exec")).toHaveLength(0);
  });

  it("allow in turn 2 patches the nodes of turn 1 from a new projector instance", () => {
    const trace = runProjectorInputs(fixture.turns[0]!.inputs, options);
    const turn2 = fixture.turns[1]!;
    const before = trace.ops.length;
    runProjectorInputs(turn2.inputs, options, trace);
    const ops = trace.ops.slice(before);
    const patches = ops.filter((op): op is Extract<TraceOp, { op: "patch" }> => op.op === "patch");
    expect(patches.map((patch) => [patch.span_id, patch.expect, patch.set.status])).toEqual([
      [waitOf(bash1), ["waiting"], "ok"],
      [callOf(bash1), ["waiting"], "running"],
      [callOf(bash1), ["waiting", "running"], "ok"],
    ]);
    const confirmedAt = 1792200260000;
    expect(trace.spans.get(waitOf(bash1))).toMatchObject({ status: "ok", end_ms: confirmedAt });
    const exec = trace.spans.get(execOf(bash1))!;
    expect(exec).toMatchObject({ status: "ok", start_ms: confirmedAt, end_ms: 1792200260640, precision: "by_events", parent_span_id: callOf(bash1), turn_id: fixture.turns[0]!.executionId });
    expect(exec.attrs.executed_in_turn).toBe(turn2.executionId);
    expect(trace.spans.get(callOf(bash1))).toMatchObject({ status: "ok", end_ms: 1792200260640, turn_id: fixture.turns[0]!.executionId });
    expect(trace.spans.get(callOf(bash1))!.event_ids).toEqual([bash1, "sevt_fixtureConfirmRes001"]);
    const confirmation = spansOfKind(trace, "event").find((span) => span.name === "confirmation")!;
    expect(confirmation).toMatchObject({ turn_id: turn2.executionId, status: "ok", start_ms: confirmedAt, end_ms: confirmedAt });
    expect(confirmation.attrs.link_span_id).toBe(callOf(bash1));
    expect(spansOfKind(trace, "tool_call")).toHaveLength(1);
  });

  it("deny gives denied on the wait and on the call", () => {
    const trace = emptyProjectedTrace();
    for (const turn of fixture.turns) runProjectorInputs(turn.inputs, options, trace);
    expect(trace.spans.get(waitOf(bash3))).toMatchObject({ status: "denied", end_ms: 1792200360000 });
    expect(trace.spans.get(callOf(bash3))).toMatchObject({ status: "denied", end_ms: 1792200360025 });
    expect(trace.spans.has(execOf(bash3))).toBe(false);
    const confirmations = spansOfKind(trace, "event").filter((span) => span.name === "confirmation");
    expect(confirmations.map((span) => span.status)).toEqual(["ok", "denied"]);
  });

  it("a result without confirmation closes the call and cancels the wait", () => {
    const trace = runProjectorInputs(fixture.turns[0]!.inputs, options);
    const t = 1792200280000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const inputs: TraceProjectorInput[] = [
      { kind: "execution_started", atMs: t + 1, events: [{ type: "user.message", id: "sevt_fixtureConfirmOther", content: [], processedAt: iso(t) }] },
      { kind: "frame", frame: { type: "agent.tool_result", id: "sevt_fixtureConfirmLateRes", tool_use_id: bash1, is_error: true, content: [], processed_at: iso(t + 30) } },
      { kind: "frame", frame: { type: "session.status_idle", id: "sevt_fixtureConfirmOtherIdle", stop_reason: { type: "end_turn" }, processed_at: iso(t + 40) } },
    ];
    runProjectorInputs(inputs, options, trace);
    expect(trace.spans.get(callOf(bash1))).toMatchObject({ status: "error", end_ms: t + 30 });
    expect(trace.spans.get(waitOf(bash1))).toMatchObject({ status: "cancelled", end_ms: t + 30 });
  });

  it("a new user message instead of a confirmation leaves the wait open", () => {
    const trace = runProjectorInputs(fixture.turns[0]!.inputs, options);
    const t = 1792200290000;
    const iso = (ms: number) => new Date(ms).toISOString();
    runProjectorInputs([
      { kind: "execution_started", atMs: t + 1, events: [{ type: "user.message", id: "sevt_fixtureConfirmMsg", content: [], processedAt: iso(t) }] },
      { kind: "frame", frame: { type: "session.status_idle", id: "sevt_fixtureConfirmMsgIdle", stop_reason: { type: "end_turn" }, processed_at: iso(t + 40) } },
    ], options, trace);
    expect(trace.spans.get(waitOf(bash1))).toMatchObject({ status: "waiting", end_ms: null });
  });
});
