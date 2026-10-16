import { createHash } from "node:crypto";
import type { TraceSpanKind } from "./types.js";

/** Id spaces of plan section 1.3. OTel spans get their own space in wave 3. */
export type TraceIdSpace = "events" | "runner" | "otel";

/** First 16 bytes of sha256(session id) in hex: one trace per session. */
export function traceIdFor(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

/** First 8 bytes of sha256 over session, space, kind and key in hex. */
export function spanIdFor(
  sessionId: string,
  space: TraceIdSpace,
  kind: TraceSpanKind,
  key: string,
): string {
  return createHash("sha256")
    .update(`${sessionId}\u0000${space}\u0000${kind}\u0000${key}`)
    .digest("hex")
    .slice(0, 16);
}

/** Top-level turn span: keyed by the execution id (the first accepted event). */
export function turnSpanIdFor(sessionId: string, turnId: string): string {
  return spanIdFor(sessionId, "events", "turn", turnId);
}

/** `TRACEPARENT` for the agent process of a turn. */
export function traceparentFor(sessionId: string, turnId: string): string {
  return `00-${traceIdFor(sessionId)}-${turnSpanIdFor(sessionId, turnId)}-01`;
}
