// A tool the ACP agent reports as failed (Claude Code: denied permission,
// a command error) must reach the session as an error result. Without
// is_error the console shows the denied tool with a green "Готово" badge.

import { describe, expect, it } from "vitest";

import type { HarnessRuntime } from "@open-managed-agents/agent/harness/interface";
import { AcpTranslator } from "../../agent/src/harness/acp-translate";

function capture(): { runtime: HarnessRuntime; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const noop = async () => {};
  const runtime = {
    history: { getEvents: () => [] },
    sandbox: {},
    broadcast: (event: Record<string, unknown>) => { events.push(event); },
    broadcastStreamStart: noop,
    broadcastChunk: noop,
    broadcastStreamEnd: noop,
    broadcastThinkingStart: noop,
    broadcastThinkingChunk: noop,
    broadcastThinkingEnd: noop,
    reportUsage: noop,
  } as unknown as HarnessRuntime;
  return { runtime, events };
}

const update = (value: Record<string, unknown>) => ({
  type: "session.event",
  event: { sessionId: "acp-1", update: value },
});

describe("AcpTranslator tool results", () => {
  it("marks a failed tool call as an error result", async () => {
    const { runtime, events } = capture();
    const translator = new AcpTranslator(runtime);
    await translator.consume(update({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_bash",
      title: "touch /mnt/session/outputs/x.txt",
      rawInput: { command: "touch /mnt/session/outputs/x.txt" },
    }));
    await translator.consume(update({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_bash",
      status: "failed",
    }));
    expect(events.filter((event) => event.type === "agent.tool_result")).toEqual([{
      type: "agent.tool_result",
      tool_use_id: "toolu_bash",
      content: "(status: failed)",
      is_error: true,
    }]);
  });

  it("keeps a completed tool call a plain result", async () => {
    const { runtime, events } = capture();
    const translator = new AcpTranslator(runtime);
    await translator.consume(update({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_read",
      title: "Read verify.txt",
      rawInput: { file_path: "/mnt/session/outputs/verify.txt" },
    }));
    await translator.consume(update({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_read",
      status: "completed",
      rawOutput: "1\tVERIFY_OK\n",
    }));
    expect(events.filter((event) => event.type === "agent.tool_result")).toEqual([{
      type: "agent.tool_result",
      tool_use_id: "toolu_read",
      content: "1\tVERIFY_OK\n",
    }]);
  });
});
