// Tool confirmation in the agent trace (docs/plans/agent-trace.md, 1.4 and TW1):
// turn 1 leaves bash waiting, main-node restarts on the same database, turn 2
// allows the call and patches the nodes of turn 1. A later turn denies.

import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { spanIdFor } from "../src/lib/trace/ids.js";
import type { TraceSpan } from "../src/lib/trace/types.js";
import {
  createPiSession,
  createTraceRoot,
  removeTraceRoot,
  runTurn,
  slowAnswer,
  startTracePlane,
  useFauxPiModel,
  waitFor,
  type TracePlane,
  type WireEvent,
} from "./_helpers/trace-node-plane.js";

const faux = useFauxPiModel();

const byKind = (spans: TraceSpan[], kind: TraceSpan["kind"]) => spans.filter((span) => span.kind === kind);
const idOf = (events: WireEvent[], type: string) => events.filter((event) => event.type === type).at(-1)!.id;

async function settledTurn(node: TracePlane, sessionId: string, turnId: string) {
  return waitFor(`turn ${turnId} to settle`, async () => {
    const page = await node.turn(sessionId, turnId);
    return page.turn.state === "complete" && !page.collecting ? page : null;
  });
}

describe("agent trace with tool confirmation", () => {
  it("keeps a waiting call across a restart, then allow and deny settle it", async () => {
    const root = await createTraceRoot();
    let node = await startTracePlane(root);
    try {
      faux.setResponses([
        slowAnswer(() => fauxAssistantMessage(
          fauxToolCall("bash", { command: "echo allowed" }, { id: "toolu_allow" }),
          { stopReason: "toolUse" },
        ), 30),
      ]);
      const { sessionId } = await createPiSession(node, { bashPolicy: "always_ask" });
      const turn1 = idOf(await runTurn(node, sessionId, [
        { type: "user.message", content: [{ type: "text", text: "Run it" }] },
      ]), "user.message");
      const waiting = await settledTurn(node, sessionId, turn1);
      const callSpan = spanIdFor(sessionId, "events", "tool_call", "toolu_allow");
      expect(waiting.turn.turn.status).toBe("ok");
      expect(byKind(waiting.spans, "tool_call")).toEqual([expect.objectContaining({ span_id: callSpan, status: "waiting" })]);
      expect(byKind(waiting.spans, "tool_wait")).toEqual([expect.objectContaining({ status: "waiting", end_ms: null })]);
      expect(byKind(waiting.spans, "tool_exec")).toEqual([]);

      // A new main-node on the same database: no state of turn 1 is left in memory.
      await node.stop();
      node = await startTracePlane(root);
      faux.setResponses([slowAnswer(() => fauxAssistantMessage("Ran it."), 30)]);
      const allowed = await runTurn(node, sessionId, [
        { type: "user.tool_confirmation", tool_use_id: "toolu_allow", result: "allow" },
      ]);
      const turn2 = idOf(allowed, "user.tool_confirmation");
      const confirmation = allowed.find((event) => event.id === turn2)!;
      const second = await settledTurn(node, sessionId, turn2);
      expect(byKind(second.spans, "event")).toContainEqual(expect.objectContaining({
        name: "confirmation",
        status: "ok",
        attrs: expect.objectContaining({ link_span_id: callSpan, result: "allow" }),
      }));
      const first = await settledTurn(node, sessionId, turn1);
      expect(byKind(first.spans, "tool_call")).toEqual([expect.objectContaining({ span_id: callSpan, status: "ok" })]);
      expect(byKind(first.spans, "tool_wait")).toEqual([expect.objectContaining({
        status: "ok",
        end_ms: Date.parse(confirmation.processed_at),
      })]);
      expect(byKind(first.spans, "tool_exec")).toEqual([expect.objectContaining({
        status: "ok",
        turn_id: turn1,
        parent_span_id: callSpan,
        attrs: expect.objectContaining({ executed_in_turn: turn2 }),
      })]);
      expect(byKind(second.spans, "tool_call")).toEqual([]);

      faux.setResponses([
        slowAnswer(() => fauxAssistantMessage(
          fauxToolCall("bash", { command: "echo denied" }, { id: "toolu_deny" }),
          { stopReason: "toolUse" },
        ), 30),
        slowAnswer(() => fauxAssistantMessage("Not run."), 30),
      ]);
      const turn3 = idOf(await runTurn(node, sessionId, [
        { type: "user.message", content: [{ type: "text", text: "Run another" }] },
      ]), "user.message");
      await settledTurn(node, sessionId, turn3);
      const turn4 = idOf(await runTurn(node, sessionId, [
        { type: "user.tool_confirmation", tool_use_id: "toolu_deny", result: "deny", deny_message: "Not now" },
      ]), "user.tool_confirmation");
      await settledTurn(node, sessionId, turn4);
      const third = await settledTurn(node, sessionId, turn3);
      expect(byKind(third.spans, "tool_call")).toEqual([expect.objectContaining({
        span_id: spanIdFor(sessionId, "events", "tool_call", "toolu_deny"),
        status: "denied",
      })]);
      expect(byKind(third.spans, "tool_wait")).toEqual([expect.objectContaining({ status: "denied" })]);
      expect(byKind(third.spans, "tool_exec")).toEqual([]);
    } finally {
      await node.stop();
      await removeTraceRoot(root);
    }
  }, 120_000);
});
