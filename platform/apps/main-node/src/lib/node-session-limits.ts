// Session limits (docs/plans/multiagent.md, 3.Б).
//
// One row per Session holds the work counted against its limits: the input
// and output tokens of every model request of every thread (main thread,
// subagents, advisor, outcome grader) and the turns of subagent threads.
// The runtime projection adds to the row in the batch of the events it
// writes, so the count follows the canonical log under the same revision
// and execution fence. A Session older than the counter has no row: the
// first write or read fills it from the log. A running execution asks the
// row before a model request and before a subagent turn (slice 2).
//
// The row also holds the limits a Session was given or raised to; NULL
// means the server default (slice 3). A raise above the work counted lets
// a turn that stopped on budget_reached go on: a continuation execution in
// the primary lane runs the turn from the log, without a new message.

import type { SqlRuntimeProjectionEffect } from "@open-managed-agents/managed-agents-adapters-sql";
import { environmentExecutionAuthority } from "@open-managed-agents/managed-agents-adapters-runtime";
import type {
  RaiseSessionLimitsResult,
  ReadSessionLimits,
  SentSessionEvent,
  SessionEventView,
  SessionLimitsPort,
  SessionLimitStanding,
  SessionLimitsView,
  SessionStopReason,
  SetSessionLimits,
} from "@open-managed-agents/managed-agents-application";
import type { SessionExecutionContextSourcePort } from "@open-managed-agents/session-runtime-contract/context";
import {
  PRIMARY_SESSION_THREAD_ID,
  type SessionExecutionStorePort,
} from "@open-managed-agents/session-runtime-contract/coordination";
import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import type { SqlClient, SqlStatement } from "@open-managed-agents/sql-client";

/** The advisor thread spends tokens of the Session but is not a subagent turn. */
export const ADVISOR_AGENT_NAME = "anthropic.advisor";

const PRIMARY_THREAD = PRIMARY_SESSION_THREAD_ID;

/** The events that add work, for the query that fills a missing row. */
const COUNTED_EVENT_TYPES = [
  "span.model_request_end",
  "span.outcome_evaluation_end",
  "session.thread_status_running",
] as const;

export interface SessionLimitDefaults {
  maxTokens: number;
  maxChildTurns: number;
}

export interface SessionLimitWork {
  tokens: number;
  childTurns: number;
}

function tokens(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The work events add to the limits of their Session. Tokens are input and
 * output of a model request, cache tokens are not counted. A turn of a
 * subagent thread starts with `session.thread_status_running`.
 */
export function sessionLimitWork(events: readonly SessionEventView[]): SessionLimitWork {
  let total = 0;
  let childTurns = 0;
  for (const event of events) {
    if (event.type === "span.model_request_end") {
      total += tokens(event.modelUsage?.inputTokens) + tokens(event.modelUsage?.outputTokens);
    } else if (event.type === "span.outcome_evaluation_end") {
      total += tokens(event.usage?.inputTokens) + tokens(event.usage?.outputTokens);
    } else if (
      event.type === "session.thread_status_running" &&
      event.sessionThreadId !== PRIMARY_THREAD &&
      event.agentName !== ADVISOR_AGENT_NAME
    ) {
      childTurns += 1;
    }
  }
  return { tokens: total, childTurns };
}

/** The token limit stops model requests of every thread. */
export function tokenLimitReached(limits: SessionLimitsView): boolean {
  return limits.usedTokens >= limits.maxTokens;
}

/**
 * The turn limit stops the start of a subagent turn. Model requests do not
 * look at it: the last allowed turn has to be able to run, and a refused
 * start stops the Session through `SessionLimitGate.modelRequest`.
 */
export function childTurnLimitReached(limits: SessionLimitsView): boolean {
  return limits.usedChildTurns >= limits.maxChildTurns;
}

/** Pi throws `SessionLimitError` from `@open-managed-agents/shared` at the limit. */
export function isSessionLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "SessionLimitError";
}

/** What a running execution asks before work that counts (slice 2). */
export interface SessionLimitGate {
  /** True when no thread of the Session may send another model request. */
  modelRequest(): Promise<boolean>;
  /** True when no subagent turn may start. */
  childTurn(): Promise<boolean>;
}

/** The turn that stopped at the limit, named by its `session.status_idle`. */
export interface SessionLimitContinuation extends ReadSessionLimits {
  stopId: string;
}

const CONTINUATION_PREFIX = "slimit_continue_";

/**
 * The input of a continuation execution. It is never written to the log:
 * the turn goes on from the log as it is. The id names the stop, so a second
 * raise before the turn runs admits nothing new.
 */
export function sessionLimitContinuationEvent(stopId: string, at: string): SentSessionEvent {
  return {
    id: `${CONTINUATION_PREFIX}${stopId}`,
    type: "system.message",
    processedAt: at,
    content: [{ type: "text", text: "The Session limit was raised: the turn that stopped at it goes on." }],
  };
}

/** True for the input of a continuation execution. */
export function isSessionLimitContinuation(events: readonly { id: string; type: string }[]): boolean {
  return events.length > 0 &&
    events.every((event) => event.type === "system.message" && event.id.startsWith(CONTINUATION_PREFIX));
}

/** The stop reason of the last turn of the Session in its log, or null. */
export function lastSessionStop(events: readonly SessionEventView[]): SessionStopReason | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "session.status_idle") return event.stopReason;
  }
  return null;
}

/**
 * Admits the continuation of a stopped turn in the primary lane. Only for a
 * live Session that runs on this server: a self-hosted worker reads the log
 * itself and gets no continuation.
 */
export function sessionLimitContinuations(deps: {
  context: SessionExecutionContextSourcePort;
  coordinator: Pick<SessionExecutionStorePort, "admit">;
  poll(): Promise<void>;
  now(): Date;
}): (input: SessionLimitContinuation) => Promise<void> {
  return async (input) => {
    const context = await deps.context.find(input);
    if (context === null || context.session.archivedAt !== null) return;
    if (environmentExecutionAuthority(context.environment) !== "session_execution") return;
    const at = deps.now().toISOString();
    const event = sessionLimitContinuationEvent(input.stopId, at);
    // `replayed` and `conflict` both mean the continuation is already there.
    await deps.coordinator.admit({
      execution: {
        id: event.id,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        laneId: PRIMARY_THREAD,
        admittedAt: at,
        events: [event],
      },
    });
    await deps.poll();
  };
}

interface LimitRow {
  used_tokens: number | string;
  used_child_turns: number | string;
  max_tokens: number | string | null;
  max_child_turns: number | string | null;
}

const LIMIT_COLUMNS = "used_tokens, used_child_turns, max_tokens, max_child_turns";

export class NodeSessionLimits implements SessionLimitsPort, SqlRuntimeProjectionEffect {
  private readonly nowMs: () => number;

  constructor(
    private readonly deps: {
      sql: SqlClient;
      dialect: "sqlite" | "postgres";
      defaults: SessionLimitDefaults;
      nowMs?: () => number;
      /** Queues the stopped turn after a raise. Without it a raise only
       * changes the limits. */
      continueTurn?: (input: SessionLimitContinuation) => Promise<void>;
    },
  ) {
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  async ensureSchema(): Promise<void> {
    await this.deps.sql.exec(`CREATE TABLE IF NOT EXISTS oma_session_limits (
      workspace_id VARCHAR(191) NOT NULL, session_id VARCHAR(191) NOT NULL,
      used_tokens BIGINT NOT NULL DEFAULT 0, used_child_turns BIGINT NOT NULL DEFAULT 0,
      max_tokens BIGINT, max_child_turns BIGINT,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, session_id)
    )`);
    // A table from slice 1 has no limit columns. SQLite has no
    // ADD COLUMN IF NOT EXISTS, so the catalog is asked first.
    for (const column of ["max_tokens", "max_child_turns"]) {
      if (this.deps.dialect === "postgres") {
        await this.deps.sql.exec(`ALTER TABLE oma_session_limits ADD COLUMN IF NOT EXISTS ${column} BIGINT`);
        continue;
      }
      const present = await this.deps.sql
        .prepare("SELECT 1 AS present FROM pragma_table_info('oma_session_limits') WHERE name = ?")
        .bind(column)
        .first();
      if (!present) await this.deps.sql.exec(`ALTER TABLE oma_session_limits ADD COLUMN ${column} BIGINT`);
    }
  }

  async read(input: ReadSessionLimits): Promise<SessionLimitsView> {
    return this.view(await this.row(input) ?? await this.fill(input));
  }

  async standing(input: ReadSessionLimits): Promise<SessionLimitStanding> {
    const stop = await this.lastStop(input);
    if (stop?.stopReason.type !== "budget_reached" && stop?.stopReason.type !== "requires_action") {
      return { type: "within_limits" };
    }
    const limits = await this.read(input);
    return tokenLimitReached(limits) || childTurnLimitReached(limits)
      ? { type: "at_limit", limits }
      : { type: "within_limits" };
  }

  async set(input: SetSessionLimits): Promise<void> {
    await this.deps.sql
      .prepare(
        `INSERT INTO oma_session_limits
           (workspace_id, session_id, used_tokens, used_child_turns, max_tokens, max_child_turns, updated_at)
         VALUES (?, ?, 0, 0, ?, ?, ?)
         ON CONFLICT (workspace_id, session_id) DO UPDATE
           SET max_tokens = excluded.max_tokens, max_child_turns = excluded.max_child_turns,
               updated_at = excluded.updated_at`,
      )
      .bind(
        input.workspaceId, input.sessionId,
        input.limits.maxTokens ?? null, input.limits.maxChildTurns ?? null, this.nowMs(),
      )
      .run();
  }

  /** One UPDATE whose condition holds the check, so a concurrent request
   * cannot slip between the check and the write. */
  async raise(input: SetSessionLimits): Promise<RaiseSessionLimitsResult> {
    const scope = { workspaceId: input.workspaceId, sessionId: input.sessionId };
    if (await this.row(scope) === null) await this.fill(scope);
    const changes: [column: string, used: string, value: number][] = [];
    if (input.limits.maxTokens !== undefined) changes.push(["max_tokens", "used_tokens", input.limits.maxTokens]);
    if (input.limits.maxChildTurns !== undefined) {
      changes.push(["max_child_turns", "used_child_turns", input.limits.maxChildTurns]);
    }
    if (changes.length === 0) return { type: "raised", limits: await this.read(scope) };
    const result = await this.deps.sql
      .prepare(
        `UPDATE oma_session_limits
            SET ${changes.map(([column]) => `${column} = ?`).join(", ")}, updated_at = ?
          WHERE workspace_id = ? AND session_id = ?
            AND ${changes.map(([, used]) => `${used} < ?`).join(" AND ")}`,
      )
      .bind(
        ...changes.map(([, , value]) => value), this.nowMs(),
        input.workspaceId, input.sessionId,
        ...changes.map(([, , value]) => value),
      )
      .run();
    const limits = await this.read(scope);
    return result.meta.changes > 0 ? { type: "raised", limits } : { type: "not_above_used", limits };
  }

  async resume(input: ReadSessionLimits): Promise<void> {
    if (this.deps.continueTurn === undefined) return;
    const stop = await this.lastStop(input);
    if (stop?.stopReason.type !== "budget_reached") return;
    // Model requests look only at the tokens (see childTurnLimitReached).
    if (tokenLimitReached(await this.read(input))) return;
    await this.deps.continueTurn({ ...input, stopId: stop.id });
  }

  /** One UPDATE in the batch of the projected events, under its guard. */
  async statements(input: Parameters<SqlRuntimeProjectionEffect["statements"]>[0]): Promise<SqlStatement[]> {
    const added = sessionLimitWork(input.events);
    if (added.tokens === 0 && added.childTurns === 0) return [];
    const scope = { workspaceId: input.workspaceId, sessionId: input.sessionId };
    // The row exists before any counted event is written: a missing row is
    // filled from the log without the events of this batch.
    if (await this.row(scope) === null) await this.fill(scope);
    return [
      this.deps.sql.prepare(
        `UPDATE oma_session_limits
            SET used_tokens = used_tokens + ?, used_child_turns = used_child_turns + ?, updated_at = ?
          WHERE workspace_id = ? AND session_id = ? AND ${input.guard.sql}`,
      ).bind(
        added.tokens, added.childTurns, this.nowMs(),
        input.workspaceId, input.sessionId, ...input.guard.bindings,
      ),
    ];
  }

  async deleteSession(input: ReadSessionLimits): Promise<void> {
    await this.deps.sql
      .prepare("DELETE FROM oma_session_limits WHERE workspace_id = ? AND session_id = ?")
      .bind(input.workspaceId, input.sessionId)
      .run();
  }

  private view(row: LimitRow): SessionLimitsView {
    return {
      maxTokens: row.max_tokens === null ? this.deps.defaults.maxTokens : Number(row.max_tokens),
      maxChildTurns: row.max_child_turns === null ? this.deps.defaults.maxChildTurns : Number(row.max_child_turns),
      usedTokens: Number(row.used_tokens),
      usedChildTurns: Number(row.used_child_turns),
    };
  }

  private row(input: ReadSessionLimits): Promise<LimitRow | null> {
    return this.deps.sql
      .prepare(`SELECT ${LIMIT_COLUMNS} FROM oma_session_limits WHERE workspace_id = ? AND session_id = ?`)
      .bind(input.workspaceId, input.sessionId)
      .first<LimitRow>();
  }

  /** The last `session.status_idle` of the Session: how its last turn ended. */
  private async lastStop(input: ReadSessionLimits): Promise<{ id: string; stopReason: SessionStopReason } | null> {
    const row = await this.deps.sql
      .prepare(
        `SELECT document FROM managed_session_events
          WHERE workspace_id = ? AND session_id = ? AND type = ?
          ORDER BY processed_at DESC, id DESC LIMIT 1`,
      )
      .bind(input.workspaceId, input.sessionId, "session.status_idle")
      .first<{ document: string }>();
    if (row === null) return null;
    const { event } = decodeSessionEventDocument(row.document);
    return event.type === "session.status_idle" ? { id: event.id, stopReason: event.stopReason } : null;
  }

  /**
   * Sums the log of every thread into a new row with the default limits.
   * Another writer may insert the row first, then its row stands: every
   * counted event after it adds itself in its own batch.
   */
  private async fill(input: ReadSessionLimits): Promise<LimitRow> {
    const rows = await this.deps.sql
      .prepare(
        `SELECT thread_id, document FROM managed_session_events
          WHERE workspace_id = ? AND session_id = ? AND type IN (?, ?, ?)`,
      )
      .bind(input.workspaceId, input.sessionId, ...COUNTED_EVENT_TYPES)
      .all<{ thread_id: string | null; document: string }>();
    const events = (rows.results ?? []).map((row) => {
      const { event } = decodeSessionEventDocument(row.document);
      const threadId = "sessionThreadId" in event ? event.sessionThreadId : undefined;
      return row.thread_id !== null && (threadId === undefined || threadId === null)
        ? ({ ...event, sessionThreadId: row.thread_id } as SessionEventView)
        : event;
    });
    const work = sessionLimitWork(events);
    await this.deps.sql
      .prepare(
        `INSERT INTO oma_session_limits (workspace_id, session_id, used_tokens, used_child_turns, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, session_id) DO NOTHING`,
      )
      .bind(input.workspaceId, input.sessionId, work.tokens, work.childTurns, this.nowMs())
      .run();
    return await this.row(input) ?? {
      used_tokens: work.tokens, used_child_turns: work.childTurns, max_tokens: null, max_child_turns: null,
    };
  }
}
