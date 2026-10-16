import { describe, expect, it } from "vitest";
import { createStrictlyIncreasingEventStamp } from "../src/lib/node-managed-harness-runtime";
import type { TraceProjectorInput } from "../src/lib/trace/types";
import { runProjectorInputs, spansOfKind } from "./_helpers/trace-harness-conformance";

describe("trace timing on a dense frame stream", () => {
  it("takes durations from at_ms and duration_ms, not from shifted processed_at stamps", () => {
    const t0 = 1792300000000;
    // The runtime stamps every frame strictly after the previous one. Fifty
    // frames written within one real millisecond move the stamps 50 ms ahead.
    const stamp = createStrictlyIncreasingEventStamp({ now: () => new Date(t0) });
    const frame = (type: string, id: string, rest: Record<string, unknown> = {}) =>
      ({ kind: "frame", frame: { type, id, ...rest, processed_at: stamp() } }) as TraceProjectorInput;
    const inputs: TraceProjectorInput[] = [
      { kind: "execution_started", atMs: t0, events: [{ type: "user.message", id: "sevt_dense_user", content: [], processedAt: new Date(t0).toISOString() }] },
      { kind: "start_attempt", attempt: 1, atMs: t0 },
      { kind: "start_attempt_settled", attempt: 1, atMs: t0, outcome: "ok" },
      frame("session.status_running", "sevt_dense_running"),
      frame("span.model_request_start", "sevt_dense_m1", { model: "m", at_ms: t0 }),
    ];
    for (let index = 0; index < 50; index += 1) {
      inputs.push(frame("agent.message", `sevt_dense_msg_${index}`, { content: [] }));
    }
    inputs.push(frame("agent.tool_use", "toolu_dense_1", { name: "bash", input: {} }));
    inputs.push(frame("span.model_request_end", "sevt_dense_m1_end", {
      model: "m", model_request_start_id: "sevt_dense_m1", started_at_ms: t0, duration_ms: 1, at_ms: t0 + 1,
      model_usage: { input_tokens: 1, output_tokens: 1 }, finish_reason: "toolUse", is_error: false,
    }));
    inputs.push(frame("span.tool_execution_start", "sevt_dense_exec_start", { tool_use_id: "toolu_dense_1", name: "bash", at_ms: t0 + 1 }));
    inputs.push(frame("span.tool_execution_end", "sevt_dense_exec_end", { tool_use_id: "toolu_dense_1", at_ms: t0 + 1, duration_ms: 0, is_error: false }));
    inputs.push(frame("agent.tool_result", "sevt_dense_result", { tool_use_id: "toolu_dense_1", content: [], is_error: false }));
    inputs.push(frame("session.status_idle", "sevt_dense_idle", { stop_reason: { type: "end_turn" } }));
    inputs.push({ kind: "execution_settled", atMs: t0 + 2, outcome: "completed" });

    const trace = runProjectorInputs(inputs, { sessionId: "session_dense", harness: "pi" });
    const [call] = spansOfKind(trace, "model_call");
    expect(call).toMatchObject({ precision: "measured", start_ms: t0, end_ms: t0 + 1 });
    const recorded = Number(call!.attrs.record_end_ms) - Number(call!.attrs.record_start_ms);
    expect(recorded).toBeGreaterThanOrEqual(50);
    expect(call!.end_ms! - call!.start_ms).not.toBe(recorded);
    const [exec] = spansOfKind(trace, "tool_exec");
    expect(exec).toMatchObject({ precision: "measured", start_ms: t0 + 1, end_ms: t0 + 1 });
    const [tool] = spansOfKind(trace, "tool_call");
    expect(tool).toMatchObject({ precision: "measured", start_ms: t0 + 1, end_ms: t0 + 1 });
    const [turn] = spansOfKind(trace, "turn");
    expect(turn!.end_ms! - turn!.start_ms).toBeGreaterThanOrEqual(50);
  });

  it("falls back to processed_at with precision by_events when Pi sends no timing", () => {
    const t0 = 1792300100000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const trace = runProjectorInputs([
      { kind: "execution_started", atMs: t0, events: [{ type: "user.message", id: "sevt_plain_user", content: [], processedAt: iso(t0) }] },
      { kind: "frame", frame: { type: "span.model_request_start", id: "sevt_plain_m1", model: "m", processed_at: iso(t0 + 10) } },
      { kind: "frame", frame: { type: "span.model_first_token", model_request_start_id: "sevt_plain_m1", processed_at: iso(t0 + 40) } },
      { kind: "frame", frame: { type: "span.model_request_end", id: "sevt_plain_m1_end", model_request_start_id: "sevt_plain_m1", finish_reason: "stop", processed_at: iso(t0 + 300) } },
      { kind: "frame", frame: { type: "session.status_idle", id: "sevt_plain_idle", stop_reason: { type: "end_turn" }, processed_at: iso(t0 + 310) } },
    ], { sessionId: "session_plain", harness: "ai-sdk" });
    const [call] = spansOfKind(trace, "model_call");
    expect(call).toMatchObject({ precision: "by_events", start_ms: t0 + 10, end_ms: t0 + 300, ttft_ms: 30, status: "ok" });
  });
});
