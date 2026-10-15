import type { UserMessageEvent } from "@open-managed-agents/shared";

type AcceptedEvent = { type: string; content?: unknown; description?: unknown };

/** The turn's prompt for harnesses that read `ctx.userMessage` (acp-sandbox
 * sends its text to the ACP agent). Text blocks of every `user.message` in the
 * accepted batch are carried over in order; a turn that only defines an
 * outcome gets the outcome description. Non-text blocks (images, documents)
 * are not carried: the legacy event's block shapes differ from the managed
 * domain's, and acp-sandbox sends text only. */
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

/** Harnesses whose agent takes only the turn's prompt text, not the history. */
const PROMPT_ONLY_HARNESSES: ReadonlySet<string> = new Set(["acp-sandbox"]);

/** `latestAcceptedUserMessage`, refusing a prompt-only harness turn that has
 * no text (a batch of tool confirmations or tool results) with an error that
 * says why, instead of the harness's "empty turn". */
export function harnessUserMessage(
  events: readonly AcceptedEvent[],
  harness: string | undefined,
): UserMessageEvent {
  const message = latestAcceptedUserMessage(events);
  const hasText = message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
  if (!hasText && harness !== undefined && PROMPT_ONLY_HARNESSES.has(harness)) {
    const types = [...new Set(events.map((event) => event.type))].join(", ") || "none";
    throw new Error(
      `${harness}: this turn has no user message text (accepted events: ${types}); ` +
      "the ACP agent takes only a text prompt, send a user.message",
    );
  }
  return message;
}
