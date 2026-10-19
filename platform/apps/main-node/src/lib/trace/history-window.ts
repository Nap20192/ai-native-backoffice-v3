import type { SqlClient } from "@open-managed-agents/sql-client";
import { encodeRuntimeHistoryEvent } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { SessionEventView } from "@open-managed-agents/managed-agents-application";
import type { TraceExecutionRow } from "./executions-reader.js";
import type { TraceScope } from "./types.js";

/**
 * Reads the recorded events of one turn from managed_session_events by the
 * (workspace_id, session_id, processed_at, id) index. An event belongs to the
 * turn when its source_position.execution_id is the execution id. Accepted
 * events come from the execution row and are left out here.
 */
export type TraceHistoryFrame = Record<string, unknown> & { type: string; id: string };

export interface TraceHistoryWindow {
  read(scope: TraceScope, execution: TraceExecutionRow): Promise<TraceHistoryFrame[]>;
  /** Execution that produced or accepted an event. */
  executionOfEvent(scope: TraceScope, eventId: string): Promise<string | null>;
}

export interface TraceSessionInfo {
  harness: string | null;
  agentName: string | null;
  archived: boolean;
}

export interface TraceSessionInfoReader {
  read(scope: TraceScope): Promise<TraceSessionInfo | null>;
}

const PAGE = 500;
/** Strictly increasing stamps may run past settled_at in a dense stream. */
const STAMP_SLACK_MS = 60_000;

interface RawEvent {
  id: string;
  type: string;
  document: string | Record<string, unknown>;
  processed_at: number | string;
}

function parseDocument(document: RawEvent["document"]): Record<string, unknown> | null {
  if (typeof document !== "string") return document;
  try {
    const value = JSON.parse(document) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function executionIdOf(document: Record<string, unknown>): string | undefined {
  const position = document.source_position ?? document.sourcePosition;
  if (position === null || typeof position !== "object") return undefined;
  const id = (position as Record<string, unknown>).execution_id ?? (position as Record<string, unknown>).executionId;
  return typeof id === "string" ? id : undefined;
}

/** History documents are camelCase views. The projector reads the snake_case runtime shape. */
export function decodeHistoryDocument(raw: RawEvent): TraceHistoryFrame | null {
  const document = parseDocument(raw.document);
  if (document === null) return null;
  const { source_position: _position, sourcePosition: _camel, ...view } = document;
  const frame = encodeRuntimeHistoryEvent(view as unknown as SessionEventView) as Record<string, unknown>;
  return {
    ...frame,
    id: typeof frame.id === "string" ? frame.id : raw.id,
    type: typeof frame.type === "string" ? frame.type : raw.type,
    processed_at: typeof frame.processed_at === "string" ? frame.processed_at : new Date(Number(raw.processed_at)).toISOString(),
  };
}

export function createHistoryWindow(sql: SqlClient): TraceHistoryWindow {
  return {
    async read(scope, execution) {
      const accepted = new Set(execution.events
        .map((event) => event !== null && typeof event === "object" ? (event as { id?: unknown }).id : undefined)
        .filter((id): id is string => typeof id === "string"));
      const from = execution.admitted_at_ms;
      const until = execution.settled_at_ms === null ? Number.MAX_SAFE_INTEGER : execution.settled_at_ms + STAMP_SLACK_MS;
      const frames: TraceHistoryFrame[] = [];
      let cursor = { at: from - 1, id: "" };
      for (;;) {
        const rows = await sql.prepare(
          `SELECT id, type, document, processed_at FROM managed_session_events
           WHERE workspace_id = ? AND session_id = ? AND processed_at <= ?
             AND (processed_at > ? OR (processed_at = ? AND id > ?))
           ORDER BY processed_at, id LIMIT ?`,
        ).bind(scope.workspaceId, scope.sessionId, until, cursor.at, cursor.at, cursor.id, PAGE).all<RawEvent>();
        const page = rows.results ?? [];
        for (const raw of page) {
          if (accepted.has(raw.id)) continue;
          const document = parseDocument(raw.document);
          if (document === null || executionIdOf(document) !== execution.id) continue;
          const frame = decodeHistoryDocument(raw);
          if (frame !== null) frames.push(frame);
        }
        if (page.length < PAGE) break;
        const last = page[page.length - 1]!;
        cursor = { at: Number(last.processed_at), id: last.id };
      }
      return frames;
    },

    async executionOfEvent(scope, eventId) {
      const raw = await sql.prepare(
        `SELECT id, type, document, processed_at FROM managed_session_events
         WHERE workspace_id = ? AND session_id = ? AND id = ?`,
      ).bind(scope.workspaceId, scope.sessionId, eventId).first<RawEvent>();
      if (raw === null) return null;
      const document = parseDocument(raw.document);
      if (document === null) return null;
      // An accepted event starts its own execution: its id is the execution id.
      return executionIdOf(document) ?? (raw.type.startsWith("user.") ? raw.id : null);
    },
  };
}

export function createSessionInfoReader(sql: SqlClient): TraceSessionInfoReader {
  return {
    async read(scope) {
      const raw = await sql.prepare(
        "SELECT document, archived_at FROM managed_sessions WHERE workspace_id = ? AND id = ?",
      ).bind(scope.workspaceId, scope.sessionId).first<{ document: string | Record<string, unknown>; archived_at: number | string | null }>();
      if (raw === null) return null;
      const document = parseDocument(raw.document) ?? {};
      const agent = document.agent !== null && typeof document.agent === "object" ? document.agent as Record<string, unknown> : {};
      const openma = agent.openma !== null && typeof agent.openma === "object" ? agent.openma as Record<string, unknown> : {};
      return {
        harness: typeof openma.harness === "string" ? openma.harness : null,
        agentName: typeof agent.name === "string" ? agent.name : null,
        archived: raw.archived_at !== null,
      };
    },
  };
}
