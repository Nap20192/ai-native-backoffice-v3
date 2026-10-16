import { describe, expect, it } from "vitest";
import { spanIdFor, turnSpanIdFor } from "../src/lib/trace/ids";
import type { TraceProjectorInput, TraceSpanWrite } from "../src/lib/trace/types";
import {
  emptyProjectedTrace,
  loadTraceFixture,
  runProjectorInputs,
  spansOfKind,
  type TraceMultiTurnFixture,
} from "./_helpers/trace-harness-conformance";

const fixture = loadTraceFixture<TraceMultiTurnFixture>("subagent-frames.json");
const options = { sessionId: fixture.scope.sessionId, harness: fixture.harness };
const A = fixture.threads!.A!;
const B = fixture.threads!.B!;
const [turn1, turn2, turn3] = fixture.turns;
const sessionId = fixture.scope.sessionId;
const subagentOf = (thread: string, turnId: string) => spanIdFor(sessionId, "events", "subagent", `${thread}:${turnId}`);

function childrenOf(spans: Map<string, TraceSpanWrite>, parent: string): TraceSpanWrite[] {
  return [...spans.values()].filter((span) => span.parent_span_id === parent);
}

describe("trace of subagent threads (plan 1.4)", () => {
  it("two parallel threads: the failure of one closes only its own turn", () => {
    const trace = runProjectorInputs(turn1!.inputs, options);
    const top = spansOfKind(trace, "turn").find((span) => span.parent_span_id === null)!;
    expect(top).toMatchObject({ status: "ok", turn_id: turn1!.executionId });
    expect(top.attrs.has_error).toBe(true);
    const createA = spanIdFor(sessionId, "events", "tool_call", "toolu_fixtureSubCreateA");
    const createB = spanIdFor(sessionId, "events", "tool_call", "toolu_fixtureSubCreateB");
    const nodeA = trace.spans.get(subagentOf(A, turn1!.executionId))!;
    const nodeB = trace.spans.get(subagentOf(B, turn1!.executionId))!;
    expect(nodeA).toMatchObject({ parent_span_id: createA, thread_id: A, name: "researcher", status: "ok", turn_id: turn1!.executionId });
    expect(nodeB).toMatchObject({ parent_span_id: createB, thread_id: B, name: "checker", status: "error" });
    expect(nodeA.attrs.thread_state).toBe("open");
    const [turnA] = childrenOf(trace.spans, nodeA.span_id);
    const [turnB] = childrenOf(trace.spans, nodeB.span_id);
    expect(turnA).toMatchObject({ kind: "turn", status: "ok", thread_id: A, end_ms: 1792200401502 });
    expect(turnB).toMatchObject({ kind: "turn", status: "error", thread_id: B, end_ms: 1792200401202 });
    expect(nodeA.end_ms).toBe(turnA!.end_ms);
    const underB = childrenOf(trace.spans, turnB!.span_id);
    expect(underB.map((span) => [span.kind, span.status])).toEqual(expect.arrayContaining([["model_call", "error"], ["event", "error"]]));
    const underA = childrenOf(trace.spans, turnA!.span_id);
    expect(underA.map((span) => [span.kind, span.status])).toEqual([["model_call", "ok"]]);
    const mainModels = childrenOf(trace.spans, top.span_id).filter((span) => span.kind === "model_call");
    expect(mainModels).toHaveLength(3);
    for (const span of trace.spans.values()) expect(span.turn_id).toBe(turn1!.executionId);
  });

  it("a message to the thread in the next turn opens a new node that links the previous one", () => {
    const trace = emptyProjectedTrace();
    runProjectorInputs(turn1!.inputs, options, trace);
    runProjectorInputs(turn2!.inputs, options, trace);
    const node = trace.spans.get(subagentOf(A, turn2!.executionId))!;
    expect(node).toMatchObject({ turn_id: turn2!.executionId, thread_id: A, parent_span_id: spanIdFor(sessionId, "events", "turn", turn2!.executionId) });
    expect(node.attrs.continued_from).toBe(subagentOf(A, turn1!.executionId));
    expect(node.attrs.thread_state).toBe("closed");
    const update = trace.ops.find((op) => op.op === "upsert" && op.span.span_id === node.span_id);
    expect(update).toMatchObject({ continued_thread: A });
    expect(trace.spans.get(subagentOf(A, turn1!.executionId))!.attrs.thread_state).toBe("open");
  });

  it("resuming the closed thread in a later turn gives an open node", () => {
    const trace = emptyProjectedTrace();
    for (const turn of [turn1!, turn2!, turn3!]) runProjectorInputs(turn.inputs, options, trace);
    const node = trace.spans.get(subagentOf(A, turn3!.executionId))!;
    expect(node.attrs.thread_state).toBe("open");
    expect(node.attrs.continued_from).toBe(subagentOf(A, turn2!.executionId));
    expect(node.status).toBe("ok");
  });

  it("the end of one thread turn leaves the main thread and the other thread running", () => {
    const wait = "toolu_fixtureSubWait0001";
    const iso = (ms: number) => new Date(ms).toISOString();
    // Pi measures the wait tool of the main thread while both threads work.
    const inputs: TraceProjectorInput[] = [];
    for (const input of turn1!.inputs) {
      inputs.push(input);
      const frameId = input.kind === "frame" ? (input.frame as { id?: string }).id : undefined;
      if (frameId === "sevt_fixtureSubEnd000002") {
        inputs.push({ kind: "frame", frame: { type: "span.tool_execution_start", id: "sevt-fixture-sub-exec-start", tool_use_id: wait, name: "wait_for_subagents", at_ms: 1792200400903, processed_at: iso(1792200400903) } });
      }
      if (frameId === "sevt_fixtureSubIdleA0001") {
        inputs.push({ kind: "frame", frame: { type: "span.tool_execution_end", id: "sevt-fixture-sub-exec-end", tool_use_id: wait, at_ms: 1792200401502, duration_ms: 599, is_error: false, processed_at: iso(1792200401502) } });
      }
    }
    const idleB = inputs.findIndex((input) => input.kind === "frame" && (input.frame as { id?: string }).id === "sevt_fixtureSubIdleB0001");
    const during = runProjectorInputs(inputs.slice(0, idleB + 1), options);
    const exec = spanIdFor(sessionId, "events", "tool_exec", wait);
    expect(during.spans.get(turnSpanIdFor(sessionId, turn1!.executionId))).toMatchObject({ status: "running", end_ms: null });
    expect(during.spans.get(spanIdFor(sessionId, "events", "tool_call", wait))).toMatchObject({ status: "running", end_ms: null });
    expect(during.spans.get(exec)).toMatchObject({ status: "running", end_ms: null });
    const nodeA = during.spans.get(subagentOf(A, turn1!.executionId))!;
    expect(nodeA).toMatchObject({ status: "running", end_ms: null });
    const [turnA] = childrenOf(during.spans, nodeA.span_id);
    expect(turnA).toMatchObject({ status: "running", end_ms: null });
    expect(childrenOf(during.spans, turnA!.span_id).map((span) => [span.kind, span.status, span.end_ms])).toEqual([["model_call", "running", null]]);

    const after = runProjectorInputs(inputs, options);
    expect(after.spans.get(exec)).toMatchObject({ status: "ok", precision: "measured", start_ms: 1792200400903, end_ms: 1792200401502 });
  });

  it("closes a thread turn that is still running when the main turn ends", () => {
    const inputs = turn1!.inputs.filter((input) => !(input.kind === "frame" && (input.frame as { id?: string }).id === "sevt_fixtureSubIdleA0001"));
    const trace = runProjectorInputs(inputs, options);
    const nodeA = trace.spans.get(subagentOf(A, turn1!.executionId))!;
    const [turnA] = childrenOf(trace.spans, nodeA.span_id);
    expect(turnA).toMatchObject({ status: "interrupted", end_ms: 1792200401810 });
    expect(nodeA.status).toBe("interrupted");
  });
});
