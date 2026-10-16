// Agent trace through HTTP (docs/plans/agent-trace.md, TW1): a real Node
// control plane runs a Pi turn on a local sandbox. Only the model is fake:
// the Pi faux provider answers with a bash call, then with text. The trace
// comes from GET /v1/oma/sessions/:id/trace and is checked against section 6.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TraceSpan } from "../src/lib/trace/types.js";
import {
  TRACE_MODEL,
  createPiSession,
  createTraceRoot,
  removeTraceRoot,
  runTurn,
  slowAnswer,
  startTracePlane,
  useFauxPiModel,
  waitFor,
  type TracePlane,
} from "./_helpers/trace-node-plane.js";

const BASH_ID = "toolu_trace_bash";
const TOLERANCE_MS = 2;

/** Subscribes to the official live stream; `untilIdle` reads it until the turn goes idle. */
async function openLiveStream(node: TracePlane, sessionId: string) {
  const response = await node.api(`/v1/sessions/${sessionId}/events/stream`);
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  return {
    async untilIdle(): Promise<Array<Record<string, unknown> & { type: string }>> {
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes("session.status_idle")) break;
      }
      await reader.cancel().catch(() => undefined);
      return text.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice("data:".length)) as Record<string, unknown> & { type: string });
    },
  };
}

const faux = useFauxPiModel();
let root = "";
let plane: TracePlane | undefined;

beforeAll(async () => {
  root = await createTraceRoot();
  plane = await startTracePlane(root);
}, 60_000);

afterAll(async () => {
  await plane?.stop();
  if (root !== "") await removeTraceRoot(root);
});

describe("agent trace over HTTP", () => {
  it("records a Pi turn with measured model calls and a bash call, then deletes it with the session", async () => {
    const node = plane!;
    faux.setResponses([
      slowAnswer(() => fauxAssistantMessage(
        fauxToolCall("bash", { command: "sleep 0.25; echo trace-bash-ok" }, { id: BASH_ID }),
        { stopReason: "toolUse" },
      ), 150),
      slowAnswer(() => fauxAssistantMessage("Done."), 60),
    ]);
    const { sessionId } = await createPiSession(node);
    const live = await openLiveStream(node, sessionId);
    const events = await runTurn(node, sessionId, [
      { type: "user.message", content: [{ type: "text", text: "Run the command" }] },
    ]);
    const liveEvents = await live.untilIdle();
    const trace = await waitFor("a settled trace", async () => {
      const current = await node.trace(sessionId);
      return !current.collecting && current.turns[0]?.state === "complete" ? current : null;
    });

    // The public list and the live stream keep their contract: no execution
    // frames, no Pi timing, no stream error.
    expect(liveEvents.map((event) => event.type)).toContain("span.model_request_start");
    expect(liveEvents.filter((event) => event.type === "error")).toEqual([]);
    for (const event of [...events, ...liveEvents]) {
      expect(event.type.startsWith("span.tool_execution_"), event.type).toBe(false);
      if (!event.type.startsWith("span.model_request_")) continue;
      for (const key of ["at_ms", "atMs", "started_at_ms", "startedAtMs", "duration_ms", "durationMs"]) {
        expect(event, `${event.type} ${key}`).not.toHaveProperty(key);
      }
    }
    const userMessage = events.find((event) => event.type === "user.message")!;
    const modelStarts = events.filter((event) => event.type === "span.model_request_start");
    const modelEnds = events.filter((event) => event.type === "span.model_request_end");
    const toolUse = events.find((event) => event.type === "agent.tool_use")!;
    const toolResult = events.find((event) => event.type === "agent.tool_result")!;
    expect(modelStarts).toHaveLength(2);
    expect(toolUse).toMatchObject({ id: BASH_ID, name: "bash" });

    // trace.api_shape
    expect(trace.trace_id).toMatch(/^[0-9a-f]{32}$/u);
    expect(trace.session_id).toBe(sessionId);
    expect(trace.spans_next).toBeNull();
    const spans = trace.spans;
    const byId = new Map(spans.map((span) => [span.span_id, span]));
    for (const span of spans) {
      expect(span.span_id).toMatch(/^[0-9a-f]{16}$/u);
      if (span.kind === "turn") expect(span.parent_span_id).toBeNull();
      else expect(byId.has(span.parent_span_id ?? ""), `${span.kind} ${span.name} has a parent`).toBe(true);
    }
    expect(trace.turns).toHaveLength(1);
    const summary = trace.turns[0]!;
    expect(summary).toMatchObject({
      state: "complete",
      partial: false,
      lost: [],
      coverage: { model_calls: "measured", tools: "measured", sandbox: "phases" },
    });
    expect(summary.version).toBeGreaterThan(0);

    // trace.turn_tree
    const turn = summary.turn;
    expect(turn).toMatchObject({ kind: "turn", turn_id: userMessage.id, status: "ok", harness: "pi" });
    expect(byId.get(turn.span_id)).toBeDefined();
    const children = (kind: TraceSpan["kind"], parent: TraceSpan) =>
      spans.filter((span) => span.kind === kind && span.parent_span_id === parent.span_id)
        .sort((a, b) => a.start_ms - b.start_ms);
    const sandboxes = children("sandbox", turn);
    const calls = children("model_call", turn);
    const tools = children("tool_call", turn);
    expect(sandboxes.length).toBeGreaterThanOrEqual(1);
    expect(sandboxes.every((span) => span.status === "ok")).toBe(true);
    expect(children("sandbox_phase", sandboxes.at(-1)!).map((span) => span.name)).toContain("acquire");
    expect(calls).toHaveLength(2);
    expect(tools).toHaveLength(1);
    const bash = tools[0]!;
    expect(bash).toMatchObject({ name: "bash", status: "ok", tool: { name: "bash", call_id: BASH_ID } });
    const execs = children("tool_exec", bash);
    expect(execs).toHaveLength(1);
    const exec = execs[0]!;

    // trace.measured
    for (const span of [...calls, exec]) {
      expect(span.precision).toBe("measured");
      expect(span.end_ms).not.toBeNull();
      expect(Math.abs(Number(span.attrs.harness_duration_ms) - (span.end_ms! - span.start_ms))).toBeLessThanOrEqual(1);
    }
    expect(exec.end_ms! - exec.start_ms).toBeGreaterThanOrEqual(250);
    expect(calls[0]!.end_ms! - calls[0]!.start_ms).toBeGreaterThanOrEqual(150);

    // trace.order: execution order by measurements, write order by events
    const sandbox = sandboxes.at(-1)!;
    expect(sandbox.end_ms!).toBeLessThanOrEqual(calls[0]!.start_ms + TOLERANCE_MS);
    expect(calls[0]!.end_ms!).toBeLessThanOrEqual(exec.start_ms + TOLERANCE_MS);
    expect(exec.end_ms!).toBeLessThanOrEqual(calls[1]!.start_ms + TOLERANCE_MS);
    expect(calls[1]!.end_ms!).toBeLessThanOrEqual(turn.end_ms! + TOLERANCE_MS);
    expect(turn.start_ms).toBeGreaterThanOrEqual(Date.parse(userMessage.processed_at));
    expect(turn.start_ms).toBeLessThanOrEqual(Date.parse(userMessage.processed_at) + 2_000);
    const position = new Map(events.map((event, index) => [event.id, index]));
    for (const span of [...calls, bash]) {
      const indexes = span.event_ids.map((id) => position.get(id)).filter((index) => index !== undefined);
      expect(indexes).toEqual([...indexes].sort((a, b) => a! - b!));
    }

    // trace.event_links
    expect(calls.map((span) => span.primary_event_id)).toEqual(modelStarts.map((event) => event.id));
    expect(bash.primary_event_id).toBe(toolUse.id);
    expect(bash.event_ids.at(-1)).toBe(toolResult.id);

    // trace.model_fields (Pi reports its own stop reasons)
    calls.forEach((call, index) => {
      const usage = modelEnds[index]!.model_usage as Record<string, number>;
      expect(call.model).toBe(TRACE_MODEL);
      expect(call.usage).toEqual({
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_read: usage.cache_read_input_tokens,
        cache_write: usage.cache_creation_input_tokens,
      });
    });
    expect(calls.map((span) => span.finish_reason)).toEqual(["toolUse", "stop"]);

    // The subtree page of the turn returns the same rows.
    const subtree = await node.turn(sessionId, turn.turn_id!);
    expect(subtree.page_next).toBeNull();
    expect(subtree.spans.map((span) => span.span_id).sort()).toEqual(spans.map((span) => span.span_id).sort());

    // Deleting the session deletes its trace rows (plan 3.1).
    const deleted = await node.api(`/v1/sessions/${sessionId}`, { method: "DELETE" });
    expect(deleted.status, await deleted.clone().text()).toBeLessThan(300);
    await waitFor("the trace rows to go", async () => {
      const spanRows = await node.sql.prepare("SELECT COUNT(*) AS count FROM trace_spans WHERE session_id = ?")
        .bind(sessionId).first<{ count: number }>();
      const turnRows = await node.sql.prepare("SELECT COUNT(*) AS count FROM trace_turns WHERE session_id = ?")
        .bind(sessionId).first<{ count: number }>();
      return Number(spanRows?.count) === 0 && Number(turnRows?.count) === 0 ? true : null;
    }, 10_000);
  }, 90_000);
});
