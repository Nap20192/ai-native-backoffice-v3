import type { SessionEvent } from "@open-managed-agents/shared";
import type { SessionStopReason } from "@open-managed-agents/managed-agents-application";

/** Ids of tool calls that wait for a user confirmation: `ask` and no result yet. */
export function pendingConfirmations(events: readonly SessionEvent[]): string[] {
  const builtinResults = new Set<string>();
  const mcpResults = new Set<string>();
  for (const event of events) {
    if (event.type === "agent.tool_result") builtinResults.add(event.tool_use_id);
    if (event.type === "agent.mcp_tool_result") mcpResults.add(event.mcp_tool_use_id);
  }

  const pending = new Set<string>();
  for (const event of events) {
    const permission = (event as { evaluated_permission?: string }).evaluated_permission;
    if (
      (event.type === "agent.tool_use" || event.type === "agent.mcp_tool_use")
      && permission === "ask"
      && event.id
      && !(event.type === "agent.mcp_tool_use" ? mcpResults : builtinResults).has(event.id)
    ) {
      pending.add(event.id);
    }
  }
  return [...pending];
}

/** Resolve wire history to the Node runner's internal stop reason. */
export function nodeManagedStopReason(
  events: readonly SessionEvent[],
  failed = false,
): SessionStopReason {
  if (failed) return { type: "retries_exhausted" };
  const pending = pendingConfirmations(events);
  return pending.length
    ? { type: "requires_action", eventIds: pending }
    : { type: "end_turn" };
}
