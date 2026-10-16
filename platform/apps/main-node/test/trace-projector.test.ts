import { describe, expect, it } from "vitest";
import { spanIdFor, traceIdFor, turnSpanIdFor } from "../src/lib/trace/ids";
import type { TraceProjectorInput } from "../src/lib/trace/types";
import {
  loadTraceFixture,
  projectorOptionsFor,
  runProjectorInputs,
  spansOfKind,
  type TraceTurnFixture,
} from "./_helpers/trace-harness-conformance";

describe("trace ids", () => {
  it("derives the trace id and span ids from sha256, the same on every run", () => {
    const traceId = traceIdFor("session_a");
    expect(traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(traceIdFor("session_a")).toBe(traceId);
    expect(traceIdFor("session_b")).not.toBe(traceId);
    const span = spanIdFor("session_a", "events", "model_call", "sevt_1");
    expect(span).toMatch(/^[0-9a-f]{16}$/u);
    expect(spanIdFor("session_a", "events", "model_call", "sevt_1")).toBe(span);
    expect(spanIdFor("session_a", "runner", "model_call", "sevt_1")).not.toBe(span);
    expect(spanIdFor("session_a", "events", "tool_call", "sevt_1")).not.toBe(span);
    expect(turnSpanIdFor("session_a", "sevt_u")).toBe(spanIdFor("session_a", "events", "turn", "sevt_u"));
  });
});

describe("trace projector on a recorded Pi turn", () => {
  const fixture = loadTraceFixture("pi-turn-frames.json");
  const trace = runProjectorInputs(fixture.inputs, projectorOptionsFor(fixture));
  const turnId = fixture.execution!.id;

  it("builds the turn tree of plan section 6 (trace.turn_tree)", () => {
    const turns = spansOfKind(trace, "turn");
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn).toMatchObject({ turn_id: turnId, parent_span_id: null, status: "ok", thread_id: "sthr_primary", harness: "pi" });
    expect(turn.span_id).toBe(turnSpanIdFor(fixture.scope.sessionId, turnId));
    const children = [...trace.spans.values()].filter((span) => span.parent_span_id === turn.span_id);
    expect(children.filter((span) => span.kind === "sandbox").length).toBeGreaterThanOrEqual(1);
    const models = children.filter((span) => span.kind === "model_call");
    expect(models).toHaveLength(2);
    const tools = children.filter((span) => span.kind === "tool_call");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool).toEqual({ name: "bash", call_id: "chatcmpl-tool-ab6ba647636a85b4", kind: "builtin", mcp_server: null });
    for (const span of trace.spans.values()) {
      expect(span.turn_id).toBe(turnId);
      expect(span.end_ms).not.toBeNull();
      if (span.parent_span_id !== null) expect(trace.spans.has(span.parent_span_id)).toBe(true);
    }
    const turnRow = trace.turns.get(turnId)!;
    expect(turnRow.coverage).toEqual({ model_calls: "measured", tools: "measured", sandbox: "attempts" });
  });

  it("measures model calls and tool execution from Pi fields (trace.measured)", () => {
    const [first, second] = spansOfKind(trace, "model_call");
    for (const call of [first!, second!]) {
      expect(call.precision).toBe("measured");
      expect(Math.abs((call.end_ms! - call.start_ms) - Number(call.attrs.harness_duration_ms))).toBeLessThanOrEqual(1);
    }
    expect(first!.start_ms).toBe(1792097242512);
    expect(first!.end_ms).toBe(1792097243440);
    expect(first!.ttft_ms).toBe(1792097243000 - 1792097242512);
    expect(first!.attrs.record_start_ms).toBe(Date.parse("2026-10-15T20:47:22.514Z"));
    const [exec] = spansOfKind(trace, "tool_exec");
    expect(exec!.precision).toBe("measured");
    expect(exec!.end_ms! - exec!.start_ms).toBe(Number(exec!.attrs.harness_duration_ms));
  });

  it("keeps the execution order by measured time (trace.order) and links events (trace.event_links)", () => {
    const [sandbox] = spansOfKind(trace, "sandbox");
    const [call1, call2] = spansOfKind(trace, "model_call");
    const [exec] = spansOfKind(trace, "tool_exec");
    const [tool] = spansOfKind(trace, "tool_call");
    const [turn] = spansOfKind(trace, "turn");
    expect(sandbox!.end_ms!).toBeLessThanOrEqual(call1!.start_ms);
    expect(call1!.end_ms!).toBeLessThanOrEqual(exec!.start_ms);
    expect(exec!.end_ms!).toBeLessThanOrEqual(call2!.start_ms);
    expect(call2!.end_ms!).toBeLessThanOrEqual(turn!.end_ms!);
    expect(tool!.start_ms).toBe(call1!.end_ms);
    expect(tool!.end_ms).toBe(exec!.end_ms);
    expect(exec!.parent_span_id).toBe(tool!.span_id);
    expect(call1!.primary_event_id).toBe("sevt-i2havp34duc1fap1");
    expect(call1!.event_ids).toEqual(["sevt-i2havp34duc1fap1", "sevt__thhBfnqX2JWdXVmxf1LX"]);
    expect(tool!.primary_event_id).toBe("chatcmpl-tool-ab6ba647636a85b4");
    expect(tool!.event_ids.at(-1)).toBe("sevt_oCcwJWaHAOdEyGrVYkzSQ");
  });

  it("copies the model fields (trace.model_fields)", () => {
    const [call1, call2] = spansOfKind(trace, "model_call");
    expect(call1).toMatchObject({ model: "Qwen/Qwen3.6-35B-A3B", finish_reason: "toolUse", usage: { input: 2825, output: 139, cache_read: 0, cache_write: 0 } });
    expect(call2!.finish_reason).toBe("stop");
    expect(call1!.attrs.provider_response_id).toBe("chatcmpl-900a1bea9c88f225");
  });

  it("gives the same span ids when the same frames are projected again", () => {
    const again = runProjectorInputs(fixture.inputs, projectorOptionsFor(fixture));
    expect([...again.spans.keys()].sort()).toEqual([...trace.spans.keys()].sort());
  });
});

describe("trace projector on driver start failures", () => {
  const fixture = loadTraceFixture("start-failure-frames.json");

  it("three failed attempts give an error turn, three sandboxes, two pauses and one error node", () => {
    const trace = runProjectorInputs(fixture.inputs, projectorOptionsFor(fixture));
    const [turn] = spansOfKind(trace, "turn");
    expect(turn!.status).toBe("error");
    const sandboxes = spansOfKind(trace, "sandbox");
    expect(sandboxes).toHaveLength(3);
    for (const sandbox of sandboxes) {
      expect(sandbox.status).toBe("error");
      expect(sandbox.error?.message).toContain("verify-trace-missing-1");
      expect(sandbox.sources).toEqual(["runner"]);
    }
    expect(sandboxes[0]!.event_ids).toEqual(["sevt_fixtureStartFailErr01"]);
    const pauses = spansOfKind(trace, "retry_wait");
    expect(pauses).toHaveLength(2);
    expect(pauses.map((pause) => [pause.start_ms, pause.end_ms, pause.status])).toEqual([
      [1792200001502, 1792200003503, "ok"],
      [1792200005003, 1792200009004, "ok"],
    ]);
    const events = spansOfKind(trace, "event");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "error", status: "error", primary_event_id: "sevt_fixtureStartFailErr03" });
    expect(events[0]!.error?.retry_status).toBe("exhausted");
    for (const span of trace.spans.values()) {
      if (span.kind !== "turn") expect(trace.spans.has(span.parent_span_id!)).toBe(true);
    }
  });

  it("a cancel during the pause cancels the pause and interrupts the turn despite end_turn", () => {
    const head = fixture.inputs.slice(0, 5);
    const at = 1792200002000;
    const inputs: TraceProjectorInput[] = [
      ...head,
      { kind: "start_cancelled", atMs: at, reason: "user_interrupt" },
      { kind: "frame", frame: { type: "session.status_idle", id: "sevt_fixtureCancelIdle", stop_reason: { type: "end_turn" }, processed_at: new Date(at + 1).toISOString() } },
      { kind: "execution_settled", atMs: at + 5, outcome: "cancelled", reason: "user_interrupt" },
    ];
    const trace = runProjectorInputs(inputs, projectorOptionsFor(fixture));
    const [pause] = spansOfKind(trace, "retry_wait");
    expect(pause).toMatchObject({ status: "cancelled", end_ms: at });
    const [turn] = spansOfKind(trace, "turn");
    expect(turn).toMatchObject({ status: "interrupted", end_ms: at + 1 });
  });
});

describe("trace projector on recorded failures", () => {
  it("an interrupted turn closes its model call and the turn as interrupted", () => {
    const fixture = loadTraceFixture("interrupted-turn-frames.json");
    const trace = runProjectorInputs(fixture.inputs, projectorOptionsFor(fixture));
    const [call] = spansOfKind(trace, "model_call");
    expect(call).toMatchObject({ status: "interrupted", finish_reason: "aborted", precision: "by_events" });
    const [turn] = spansOfKind(trace, "turn");
    expect(turn!.status).toBe("interrupted");
  });

  it("a runner failure after a good start gives an error node and an error turn", () => {
    const fixture = loadTraceFixture("runner-failure-frames.json");
    const trace = runProjectorInputs(fixture.inputs, projectorOptionsFor(fixture));
    const [turn] = spansOfKind(trace, "turn");
    expect(turn!.status).toBe("error");
    const [sandbox] = spansOfKind(trace, "sandbox");
    expect(sandbox!.status).toBe("ok");
    const [error] = spansOfKind(trace, "event");
    expect(error!.error?.message).toContain("No model card matched");
    expect(error!.parent_span_id).toBe(turn!.span_id);
  });

  it("a failed tool marks the tool call as error and the turn ok with has_error", () => {
    const fixture = loadTraceFixture<TraceTurnFixture>("tool-error-frames.json");
    const trace = runProjectorInputs(fixture.inputs, projectorOptionsFor(fixture));
    const tools = spansOfKind(trace, "tool_call");
    expect(tools.map((tool) => [tool.name, tool.status])).toEqual([
      ["write", "ok"],
      ["bash", "error"],
      ["bash", "ok"],
    ]);
    expect(spansOfKind(trace, "model_call")).toHaveLength(4);
    const [turn] = spansOfKind(trace, "turn");
    expect(turn).toMatchObject({ status: "ok" });
    expect(turn!.attrs.has_error).toBe(true);
    expect(trace.turns.get(fixture.execution!.id)!.coverage).toEqual({ model_calls: "by_events", tools: "by_events", sandbox: "attempts" });
  });
});
