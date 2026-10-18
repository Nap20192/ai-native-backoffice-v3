import type { SessionEventView } from "@open-managed-agents/domain/sessions";
import type {
  SendableSessionEvent,
  SendSessionEventsCommand,
  SendSessionEventsResult,
  SentSessionEvent,
  ListSessionEventsQuery,
  ListSessionEventsResult,
  StreamSessionEventsQuery,
  StreamSessionEventsResult,
  SessionEventsApplicationPort,
} from "../ports/session-events";
import type { SessionEventLogStore } from "@open-managed-agents/session-event-store";
import type { SessionSourcePort } from "./session-source";
import type { SessionEventStreamPort } from "./stream";
import type { SessionEventDispatchPort } from "../session-execution/events";
import type {
  SessionExecutionContextSourcePort,
} from "@open-managed-agents/session-runtime-contract/context";
import { PRIMARY_SESSION_THREAD_ID } from "@open-managed-agents/session-runtime-contract/coordination";
import type { SessionLimitsPort } from "../sessions/limits-source";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

import { sessionInputIdentityPrefix } from "@openma/common/protocol/managed";
export { sessionInputIdentityPrefix };

function inputPayload(event: SentSessionEvent): string {
  const { id: _id, processedAt: _time, ...body } = event;
  if ("outcomeId" in body) delete (body as {outcomeId?: string}).outcomeId;
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)])) : value;
  return JSON.stringify(normalize(body));
}

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

interface EventCursor {
  order: "asc" | "desc";
  processedAt: string;
  eventId: string;
}

function encodeEventCursor(
  event: { id: string; processedAt?: string | null },
  order: EventCursor["order"],
): string | null {
  if (event.processedAt == null) return null;
  return `session-events.${order}.${encodeCursorPart(event.processedAt)}.${encodeCursorPart(event.id)}`;
}

function decodeEventCursor(value: string): EventCursor | null {
  const [scope, order, processedAt, eventId, extra] = value.split(".");
  if (
    scope !== "session-events" ||
    (order !== "asc" && order !== "desc") ||
    processedAt === undefined ||
    eventId === undefined ||
    extra !== undefined
  ) return null;
  const decodedProcessedAt = decodeCursorPart(processedAt);
  const decodedEventId = decodeCursorPart(eventId);
  if (
    decodedProcessedAt === null ||
    decodedEventId === null ||
    decodedEventId.length === 0 ||
    Number.isNaN(Date.parse(decodedProcessedAt)) ||
    new Date(decodedProcessedAt).toISOString() !== decodedProcessedAt
  ) return null;
  return { order, processedAt: decodedProcessedAt, eventId: decodedEventId };
}

export interface SessionEventsApplicationServiceDependencies {
  workspaceId: string;
  store: SessionEventLogStore;
  sessions: SessionSourcePort;
  execution: SessionExecutionContextSourcePort;
  stream: SessionEventStreamPort;
  dispatch: SessionEventDispatchPort;
  clock: { now(): Date };
  ids: { nextEventId(): string; nextOutcomeId(): string };
  /**
   * At its limit a Session takes no new work, only answers to calls and
   * interrupts (docs/plans/multiagent.md, 3.Б). Without it nothing is refused.
   */
  limits?: Pick<SessionLimitsPort, "standing">;
}

/** Events that start new work. At the limit they get 400, as in CMA. */
const NEW_WORK_TYPES: ReadonlySet<SendableSessionEvent["type"]> = new Set([
  "user.message",
  "user.define_outcome",
]);

function limitReachedMessage(sessionId: string): string {
  return `Session ${sessionId} stopped at its limit: it accepts only user.tool_confirmation, ` +
    "user.tool_result, user.custom_tool_result and user.interrupt. " +
    `Raise _oma.limits with POST /v1/sessions/${sessionId} to go on.`;
}

function toSentEvent(
  event: SendableSessionEvent,
  id: string,
  processedAt: string,
  nextOutcomeId: () => string,
): SentSessionEvent {
  switch (event.type) {
    case "user.message":
      return { ...event, id, processedAt };
    case "user.interrupt":
      return { ...event, id, processedAt };
    case "user.tool_confirmation":
      return { ...event, id, processedAt };
    case "user.custom_tool_result":
      return { ...event, id, processedAt };
    case "user.define_outcome":
      return {
        ...event,
        id,
        maxIterations: event.maxIterations ?? null,
        outcomeId: nextOutcomeId(),
        processedAt,
      };
    case "user.tool_result":
      return { ...event, id, processedAt };
    case "system.message":
      return { ...event, id, processedAt };
  }
}

type CallAnswer = Extract<
  SendableSessionEvent,
  { type: "user.tool_confirmation" | "user.custom_tool_result" }
>;

/** Event types of the call that each answer may refer to. */
const answeredCallTypes: Record<CallAnswer["type"], readonly string[]> = {
  "user.tool_confirmation": ["agent.tool_use", "agent.mcp_tool_use"],
  "user.custom_tool_result": ["agent.custom_tool_use"],
};

function isCallAnswer(event: SendableSessionEvent): event is CallAnswer {
  return event.type === "user.tool_confirmation" ||
    event.type === "user.custom_tool_result";
}

function answeredCallId(event: CallAnswer): string {
  return event.type === "user.tool_confirmation"
    ? event.toolUseId
    : event.customToolUseId;
}

function callThreadId(call: SessionEventView): string {
  return ("sessionThreadId" in call ? call.sessionThreadId : null) ??
    PRIMARY_SESSION_THREAD_ID;
}

function applyAcceptedEvents(
  current: import("../domain/session").Session,
  events: SentSessionEvent[],
): import("../domain/session").Session {
  const next = structuredClone(current);
  for (const event of events) {
    if (
      event.type === "user.define_outcome" &&
      !next.outcomeEvaluations.some(
        (evaluation) => evaluation.outcomeId === event.outcomeId,
      )
    ) {
      next.outcomeEvaluations.push({
        type: "outcome_evaluation",
        completedAt: null,
        description: event.description,
        explanation: null,
        iteration: 0,
        outcomeId: event.outcomeId,
        result: "pending",
      });
    }
    if (event.processedAt != null && event.processedAt > next.updatedAt) {
      next.updatedAt = event.processedAt;
    }
  }
  return next;
}

export class SessionEventsApplicationService
  implements SessionEventsApplicationPort
{
  constructor(
    private readonly dependencies: SessionEventsApplicationServiceDependencies,
  ) {}

  async sendSessionEvents(
    command: SendSessionEventsCommand,
  ): Promise<SendSessionEventsResult> {
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1)) {
      return { type: "invalid_request", message: "Expected Session revision must be a positive integer" };
    }
    if (command.idempotencyKey !== undefined && (command.idempotencyKey.length === 0 || command.events.length === 0)) {
      return { type: "invalid_request", message: "Idempotent input requires a nonempty key and event batch" };
    }
    const prefix = command.idempotencyKey === undefined ? null : await sessionInputIdentityPrefix(this.dependencies.workspaceId, command.sessionId, command.idempotencyKey);
    const processedAt = this.dependencies.clock.now().toISOString();
    let events: SentSessionEvent[] | undefined;
    let limitChecked = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const execution = await this.dependencies.execution.find({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
      });
      if (execution === null) return { type: "not_found" };
      if (events === undefined) {
        // After the Session lookup: a missing Session answers 404 first.
        const threaded = await this.withCallThreads(command.sessionId, command.events);
        if (threaded.type === "invalid_request") return threaded;
        events = threaded.events.map((event, index) =>
          toSentEvent(
            event,
            prefix === null ? this.dependencies.ids.nextEventId() : `${prefix}${index}`,
            processedAt,
            () => this.dependencies.ids.nextOutcomeId(),
          ),
        );
      }
      if (prefix !== null) {
        // Check complete event IDs, including the next batch position so a
        // shorter retry cannot silently accept a previously longer batch.
        const eventIds = [...events.map(event => event.id), `${prefix}${events.length}`];
        const previous: SessionEventView[] = [];
        // Keep bound parameters below D1's limit even for large input batches.
        for (let offset = 0; offset < eventIds.length; offset += 64) {
          const ids = eventIds.slice(offset, offset + 64);
          previous.push(...await this.dependencies.store.list({
            workspaceId: this.dependencies.workspaceId, sessionId: command.sessionId,
            eventIds: ids, limit: ids.length, order: "asc",
          }));
        }
        if (previous.length > 0) {
          const byId = new Map(previous.map(event => [event.id, event]));
          if (previous.length !== events.length || events.some(event => !byId.has(event.id) || inputPayload(byId.get(event.id)! as SentSessionEvent) !== inputPayload(event))) {
            return { type: "idempotency_conflict", message: "Idempotency key was already used with different input" };
          }
          return { type: "accepted", events: events.map(event => byId.get(event.id)! as SentSessionEvent) };
        }
      }
      if (command.expectedRevision !== undefined && command.expectedRevision !== execution.revision) {
        return { type: "version_conflict", message: "Session changed after input validation; retrieve the session before retrying" };
      }
      // After the replay check: a retry of a batch accepted before the limit
      // gets its first answer again.
      if (
        !limitChecked &&
        this.dependencies.limits !== undefined &&
        events.some((event) => NEW_WORK_TYPES.has(event.type))
      ) {
        const standing = await this.dependencies.limits.standing({
          workspaceId: this.dependencies.workspaceId,
          sessionId: command.sessionId,
        });
        if (standing.type === "at_limit") {
          return { type: "invalid_request", message: limitReachedMessage(command.sessionId) };
        }
        limitChecked = true;
      }
      const appended = await this.dependencies.store.append({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        expectedRevision: execution.revision,
        events,
        nextSession: applyAcceptedEvents(execution.session, events),
      });
      if (appended.type === "not_found") return { type: "not_found" };
      if (appended.type === "revision_conflict") continue;
      await this.dependencies.dispatch.sessionEventsAccepted({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        session: appended.session,
        environment: execution.environment,
        events: appended.events,
      });
      return { type: "accepted", events: appended.events };
    }
    throw new Error("Session changed concurrently while accepting events");
  }

  /**
   * Checks the thread named by each call answer against the thread of its
   * call and takes the call's thread when the answer names none, as CMA does
   * (docs/plans/multiagent.md, 3.1). An answer that names a thread must refer
   * to a call of this Session. An answer without a thread to an unknown call
   * passes unchanged: the runner reports it.
   */
  private async withCallThreads(
    sessionId: string,
    events: SendableSessionEvent[],
  ): Promise<
    | { type: "threaded"; events: SendableSessionEvent[] }
    | { type: "invalid_request"; message: string }
  > {
    const callIds = [...new Set(events.filter(isCallAnswer).map(answeredCallId))];
    if (callIds.length === 0) return { type: "threaded", events };
    const calls = new Map<string, SessionEventView>();
    // Keep bound parameters below D1's limit, as the idempotency check does.
    for (let offset = 0; offset < callIds.length; offset += 64) {
      const ids = callIds.slice(offset, offset + 64);
      for (const call of await this.dependencies.store.list({
        workspaceId: this.dependencies.workspaceId,
        sessionId,
        eventIds: ids,
        types: [...new Set(Object.values(answeredCallTypes).flat())],
        limit: ids.length,
        order: "asc",
      })) {
        calls.set(call.id, call);
      }
    }
    const threaded: SendableSessionEvent[] = [];
    for (const [index, event] of events.entries()) {
      if (!isCallAnswer(event)) {
        threaded.push(event);
        continue;
      }
      const callId = answeredCallId(event);
      const found = calls.get(callId);
      const call = found !== undefined && answeredCallTypes[event.type].includes(found.type)
        ? found
        : undefined;
      if (event.sessionThreadId != null) {
        if (call === undefined) {
          return {
            type: "invalid_request",
            message: `events.${index}: call ${callId} was not found in Session ${sessionId}`,
          };
        }
        const threadId = callThreadId(call);
        if (threadId !== event.sessionThreadId) {
          return {
            type: "invalid_request",
            message: `events.${index}: call ${callId} belongs to session thread ${threadId}, not ${event.sessionThreadId}`,
          };
        }
        threaded.push(event);
        continue;
      }
      const threadId = call === undefined ? PRIMARY_SESSION_THREAD_ID : callThreadId(call);
      threaded.push(
        threadId === PRIMARY_SESSION_THREAD_ID
          ? event
          : { ...event, sessionThreadId: threadId },
      );
    }
    return { type: "threaded", events: threaded };
  }

  async listSessionEvents(
    query: ListSessionEventsQuery,
  ): Promise<ListSessionEventsResult> {
    const session = await this.dependencies.sessions.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    if (session === null) return { type: "not_found" };
    const order = query.order ?? "asc";
    const cursor =
      query.cursor === undefined ? undefined : decodeEventCursor(query.cursor);
    if (cursor === null || (cursor !== undefined && cursor.order !== order)) {
      return {
        type: "invalid_request",
        message: "Invalid session events page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
      limit: pageSize + 1,
      order,
      ...(query.createdAfter !== undefined && {
        createdAfter: query.createdAfter,
      }),
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdBefore !== undefined && {
        createdBefore: query.createdBefore,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(query.types !== undefined && { types: query.types }),
      ...(cursor !== undefined && {
        position: {
          processedAt: cursor.processedAt,
          eventId: cursor.eventId,
        },
      }),
    });
    const hasMore = records.length > pageSize;
    const events = hasMore ? records.slice(0, pageSize) : records;
    const last = events[events.length - 1];
    return {
      type: "page",
      page: {
        events,
        nextCursor:
          hasMore && last !== undefined ? encodeEventCursor(last, order) : null,
      },
    };
  }

  async streamSessionEvents(
    query: StreamSessionEventsQuery,
  ): Promise<StreamSessionEventsResult> {
    const session = await this.dependencies.sessions.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    if (session === null) return { type: "not_found" };
    return {
      type: "stream",
      events: this.dependencies.stream.subscribe({
        workspaceId: this.dependencies.workspaceId,
        sessionId: query.sessionId,
        session,
        ...(query.deltaEventTypes !== undefined && {
          deltaEventTypes: query.deltaEventTypes,
        }),
      }),
    };
  }
}
