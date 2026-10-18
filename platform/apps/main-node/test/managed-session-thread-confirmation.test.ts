// Confirmation of a call in a subagent thread (docs/plans/multiagent.md, 3.1,
// slice 1). The API takes `session_thread_id` on user.tool_confirmation and
// user.custom_tool_result, checks it against the thread of the call and takes
// the thread from the call when the field is absent. Until step 3 gives
// threads their own lanes, both events execute in the primary lane.

import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { encodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import type { SessionEventView } from "@open-managed-agents/managed-agents-application";
import {
  createPiSession,
  createTraceRoot,
  removeTraceRoot,
  startTracePlane,
  useFauxPiModel,
  waitFor,
  type TracePlane,
  type WireEvent,
} from "./_helpers/trace-node-plane.js";

const faux = useFauxPiModel();
const CHILD = "sthr_child";

async function workspaceOf(node: TracePlane, sessionId: string): Promise<string> {
  const row = await node.sql
    .prepare("SELECT workspace_id FROM managed_sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ workspace_id: string }>();
  return row!.workspace_id;
}

/** A call the model made earlier, written straight into the canonical log. */
async function seedCall(node: TracePlane, workspaceId: string, sessionId: string, event: SessionEventView): Promise<void> {
  const threadId = "sessionThreadId" in event ? event.sessionThreadId ?? null : null;
  await node.sql
    .prepare(
      `INSERT INTO managed_session_events
        (workspace_id, session_id, thread_id, id, type, document, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      workspaceId,
      sessionId,
      threadId,
      event.id,
      event.type,
      encodeSessionEventDocument(event, { revision: 1, index: 0 }),
      Date.parse(event.processedAt!),
    )
    .run();
}

function bashCall(id: string, sessionThreadId: string | undefined): SessionEventView {
  return {
    id,
    type: "agent.tool_use",
    name: "bash",
    input: { command: `echo ${id}` },
    evaluatedPermission: "ask",
    processedAt: new Date().toISOString(),
    ...(sessionThreadId !== undefined && { sessionThreadId }),
  };
}

async function send(node: TracePlane, sessionId: string, events: unknown[]): Promise<Response> {
  return node.api(`/v1/sessions/${sessionId}/events`, { body: { events } });
}

async function expectRejected(response: Response, message: string): Promise<void> {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    type: "error",
    error: { type: "invalid_request_error", message: expect.stringContaining(message) },
  });
}

describe("confirmation of a call in a subagent thread", () => {
  it("takes the thread of the call, refuses another thread and runs in the primary lane", async () => {
    const root = await createTraceRoot();
    const node = await startTracePlane(root);
    try {
      const { sessionId } = await createPiSession(node, { bashPolicy: "always_ask" });
      const workspaceId = await workspaceOf(node, sessionId);
      await seedCall(node, workspaceId, sessionId, bashCall("toolu_main", undefined));
      await seedCall(node, workspaceId, sessionId, bashCall("toolu_child", CHILD));
      await seedCall(node, workspaceId, sessionId, bashCall("toolu_child_later", CHILD));
      await seedCall(node, workspaceId, sessionId, {
        id: "toolu_child_custom",
        type: "agent.custom_tool_use",
        name: "lookup",
        input: {},
        processedAt: new Date().toISOString(),
        sessionThreadId: CHILD,
      });

      faux.setResponses([fauxAssistantMessage("All calls answered.")]);
      const accepted = await send(node, sessionId, [
        { type: "user.tool_confirmation", tool_use_id: "toolu_main", result: "allow", session_thread_id: "sthr_primary" },
        { type: "user.tool_confirmation", tool_use_id: "toolu_child", result: "allow", session_thread_id: CHILD },
        { type: "user.tool_confirmation", tool_use_id: "toolu_child_later", result: "allow" },
      ]);
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      const sent = (await accepted.json() as { data: WireEvent[] }).data;
      expect(sent.map((event) => [event.tool_use_id, event.session_thread_id])).toEqual([
        ["toolu_main", "sthr_primary"],
        ["toolu_child", CHILD],
        // Without the field the server takes the thread from the call.
        ["toolu_child_later", CHILD],
      ]);

      const lane = await node.sql
        .prepare("SELECT lane_id FROM managed_session_executions WHERE workspace_id = ? AND id = ?")
        .bind(workspaceId, sent[0]!.id)
        .first<{ lane_id: string }>();
      expect(lane).toEqual({ lane_id: "sthr_primary" });
      const otherLanes = await node.sql
        .prepare("SELECT lane_id FROM managed_session_executions WHERE workspace_id = ? AND session_id = ? AND lane_id <> 'sthr_primary'")
        .bind(workspaceId, sessionId)
        .all<{ lane_id: string }>();
      expect(otherLanes.results).toEqual([]);
      await waitFor("the confirmed turn", async () =>
        (await node.events(sessionId)).some((event) => event.type === "session.status_idle") ? true : null);

      const before = (await node.events(sessionId)).length;
      await expectRejected(await send(node, sessionId, [
        { type: "user.tool_confirmation", tool_use_id: "toolu_child", result: "deny", session_thread_id: "sthr_other" },
      ]), `belongs to session thread ${CHILD}`);
      await expectRejected(await send(node, sessionId, [
        { type: "user.tool_confirmation", tool_use_id: "toolu_main", result: "deny", session_thread_id: CHILD },
      ]), "belongs to session thread sthr_primary");
      await expectRejected(await send(node, sessionId, [
        { type: "user.custom_tool_result", custom_tool_use_id: "toolu_child_custom", session_thread_id: "sthr_other", content: [{ type: "text", text: "found" }] },
      ]), `belongs to session thread ${CHILD}`);
      await expectRejected(await send(node, sessionId, [
        { type: "user.tool_confirmation", tool_use_id: "toolu_missing", result: "allow", session_thread_id: CHILD },
      ]), "toolu_missing was not found");
      // A refused batch writes nothing.
      expect(await node.events(sessionId)).toHaveLength(before);
    } finally {
      await node.stop();
      await removeTraceRoot(root);
    }
  });
});
