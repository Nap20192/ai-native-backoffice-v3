import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import { nodeManagedStopReason } from "../src/lib/node-managed-stop-reason";

const ask = (id: string, type = "agent.mcp_tool_use") => ({ type, id, name: "write", input: {}, evaluated_permission: "ask", mcp_server_name: "platform" }) as SessionEvent;

describe("nodeManagedStopReason", () => {
  it("returns end_turn without pending confirmations", () => {
    expect(nodeManagedStopReason([])).toEqual({ type: "end_turn" });
    expect(nodeManagedStopReason([{ ...ask("allowed"), evaluated_permission: "allow" } as SessionEvent])).toEqual({ type: "end_turn" });
  });
  it("returns all pending MCP and builtin ids in order without duplicates", () => {
    expect(nodeManagedStopReason([ask("a"), ask("b", "agent.tool_use"), ask("a")])).toEqual({ type: "requires_action", eventIds: ["a", "b"] });
  });
  it("excludes calls with results, including failed or refused calls", () => {
    expect(nodeManagedStopReason([
      ask("mcp"), ask("builtin", "agent.tool_use"), ask("pending"),
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "mcp", content: "denied", is_error: true },
      { type: "agent.tool_result", tool_use_id: "builtin", content: "ok" },
    ])).toMatchObject({ type: "requires_action", eventIds: ["pending"] });
  });
  it("does not resolve calls from a different tool family", () => {
    expect(nodeManagedStopReason([ask("same"), { type: "agent.tool_result", tool_use_id: "same", content: "ok" }])).toMatchObject({ eventIds: ["same"] });
  });
  it("keeps failure precedence over pending calls", () => {
    expect(nodeManagedStopReason([ask("a")], true)).toEqual({ type: "retries_exhausted" });
  });
});
