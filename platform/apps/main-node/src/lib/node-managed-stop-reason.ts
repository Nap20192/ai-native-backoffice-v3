import type { SessionEvent } from "@open-managed-agents/shared";
import type { SessionEventView, SessionStopReason } from "@open-managed-agents/managed-agents-application";
import { encodeRuntimeHistoryEvent } from "@open-managed-agents/managed-agents-adapters-runtime";

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

/** Calls that wait for a person in application events of any thread. A
 * result in one thread answers a call in another: sessions written before
 * plan multiagent 3.1 slice 3 hold the answer to a subagent's call in the
 * primary thread. */
export function waitingCalls(events: readonly SessionEventView[]): string[] {
  return pendingConfirmations(events.map((event) => encodeRuntimeHistoryEvent(event) as SessionEvent));
}

/**
 * Resolve wire history to the Node runner's internal stop reason.
 * `subagentThreads` holds the events of the subagent threads that are not
 * archived: a call there that waits for a person holds the session too
 * (plan multiagent, 3.1). A result in one thread answers a call in another,
 * as in `waitingCalls`. `limitReached` says the turn stopped at the Session
 * limit (plan multiagent, 3.Б): a waiting call still wins over it, as in CMA.
 */
export function nodeManagedStopReason(
  events: readonly SessionEvent[],
  failed = false,
  subagentThreads: readonly SessionEventView[] = [],
  limitReached = false,
): SessionStopReason {
  if (failed) return { type: "retries_exhausted" };
  const pending = pendingConfirmations([
    ...events,
    ...subagentThreads.map((event) => encodeRuntimeHistoryEvent(event) as SessionEvent),
  ]);
  if (pending.length > 0) return { type: "requires_action", eventIds: pending };
  return limitReached ? { type: "budget_reached" } : { type: "end_turn" };
}
