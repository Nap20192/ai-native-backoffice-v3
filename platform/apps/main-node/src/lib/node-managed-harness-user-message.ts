import type { UserMessageEvent } from "@open-managed-agents/shared";

type AcceptedEvent = { type: string; content?: unknown; description?: unknown };

/** The turn's prompt for `ctx.userMessage`. Text blocks of every
 * `user.message` in the accepted batch are carried over in order; a turn
 * that only defines an outcome gets the outcome description. Non-text blocks
 * (images, documents) are not carried: the legacy event's block shapes
 * differ from the managed domain's. Pi reads the turn from the history, so a
 * batch without text (tool confirmations or tool results) gives an empty
 * message and still runs. */
export function latestAcceptedUserMessage(
  events: readonly AcceptedEvent[],
): UserMessageEvent {
  const content = events
    .filter((event) => event.type === "user.message")
    .flatMap((event) => (Array.isArray(event.content) ? event.content : []))
    .flatMap((block: { type?: unknown; text?: unknown }) =>
      block.type === "text" && typeof block.text === "string"
        ? [{ type: "text" as const, text: block.text }]
        : []
    );
  if (content.length === 0) {
    const outcome = events.findLast((event) => event.type === "user.define_outcome");
    if (typeof outcome?.description === "string" && outcome.description.trim()) {
      content.push({ type: "text", text: outcome.description });
    }
  }
  return { type: "user.message", content };
}

/** The `ctx.userMessage` of a turn. */
export function harnessUserMessage(events: readonly AcceptedEvent[]): UserMessageEvent {
  return latestAcceptedUserMessage(events);
}
