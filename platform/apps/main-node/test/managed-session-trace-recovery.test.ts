// Agent trace after a failure (docs/plans/agent-trace.md, 1.4, 3.3 and TW1):
// a lost lease and a new attempt of the same turn, and a store that refuses
// two batches in the middle of a turn.

import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { DefaultNodeManagedSessionRuntimeDriver } from "../src/lib/node-managed-session-runtime.js";
import { spanIdFor, turnSpanIdFor } from "../src/lib/trace/ids.js";
import { createTraceObserver } from "../src/lib/trace/observer.js";
import { createTraceRecorder } from "../src/lib/trace/recorder.js";
import { createTraceStore } from "../src/lib/trace/store.js";
import {
  createPiSession,
  createTraceRoot,
  removeTraceRoot,
  runTurn,
  slowAnswer,
  startTracePlane,
  useFauxPiModel,
  waitFor,
} from "./_helpers/trace-node-plane.js";

const faux = useFauxPiModel();

const T0 = Date.parse("2026-10-16T08:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const scope = { workspaceId: "workspace_01", sessionId: "session_01" };

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    openma: { harness: "pi" },
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-10-16T07:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: "Node session",
  updatedAt: "2026-10-16T07:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-10-16T07:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-10-16T07:00:00.000Z",
};

const input = {
  id: "event_input_01",
  type: "user.message" as const,
  content: [{ type: "text" as const, text: "Run" }],
  processedAt: at(T0 - 100),
};

function fence(attemptId: string, generation: number): SessionExecutionFence {
  return {
    executionId: input.id,
    ...scope,
    attemptId,
    ownerId: `node_${generation}`,
    generation,
    expiresAt: at(T0 + 60_000),
  };
}

/** Fails every batch that inserts trace spans while `left` is above zero, after the first one passed. */
function refuseTraceInserts(inner: SqlClient, state: { left: number; failed: number }): SqlClient {
  const inserts = new WeakSet<object>();
  let armed = false;
  return {
    prepare(query) {
      const statement = inner.prepare(query);
      if (!query.includes("INSERT INTO trace_spans")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...params: unknown[]) => {
        const bound = bind(...params);
        inserts.add(bound);
        return bound;
      };
      inserts.add(statement);
      return statement;
    },
    async batch(statements) {
      if (statements.some((statement) => inserts.has(statement))) {
        if (armed && state.left > 0) {
          state.left -= 1;
          state.failed += 1;
          throw new Error("trace store is down");
        }
        armed = true;
      }
      return inner.batch(statements);
    },
    exec: (query) => inner.exec(query),
  };
}

describe("agent trace recovery", () => {
  it("closes what a lost attempt left open when the next attempt takes the turn", async () => {
    let now = T0;
    const store = createTraceStore({ sql: await createBetterSqlite3SqlClient(":memory:"), dialect: "sqlite" });
    const observer = createTraceObserver({ recorder: createTraceRecorder({ store, flushMs: 5 }) });
    let emit: ((frame: unknown) => Promise<void>) | undefined;
    let accepts = 0;
    let loseLease: (() => void) | undefined;
    const driver = new DefaultNodeManagedSessionRuntimeDriver({
      engine: {
        start: async (_start, output) => { emit = output; },
        stop: async () => {},
        accept: async () => {
          accepts += 1;
          if (accepts === 1) {
            await emit!({ id: "event_running_1", type: "session.status_running", processed_at: at(T0 + 10) });
            await emit!({ id: "event_model_1", type: "span.model_request_start", model: "m", at_ms: T0 + 20, processed_at: at(T0 + 20) });
            await new Promise<void>((_resolve, reject) => {
              loseLease = () => reject(Object.assign(new Error("lease_lost"), { name: "AbortError" }));
            });
            return;
          }
          const base = now;
          await emit!({ id: "event_running_2", type: "session.status_running", processed_at: at(base + 1) });
          await emit!({ id: "event_model_2", type: "span.model_request_start", model: "m", at_ms: base + 2, processed_at: at(base + 2) });
          await emit!({
            id: "event_model_2_end",
            type: "span.model_request_end",
            model_request_start_id: "event_model_2",
            model_usage: { input_tokens: 3, output_tokens: 2 },
            finish_reason: "stop",
            is_error: false,
            started_at_ms: base + 2,
            duration_ms: 40,
            at_ms: base + 42,
            processed_at: at(base + 43),
          });
          await emit!({ id: "event_message_2", type: "agent.message", content: [{ type: "text", text: "done" }], processed_at: at(base + 44) });
          await emit!({ id: "event_idle_2", type: "session.status_idle", stop_reason: { type: "end_turn" }, processed_at: at(base + 50) });
        },
        archiveThread: async () => {},
      },
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({ recordSessionRuntimeEvents: async () => ({ type: "recorded", session }) }),
      clock: { now: () => new Date(now) },
      observer,
    });

    const first = driver.accept({ ...scope, session, environment, events: [input], executionFence: fence("attempt_01", 1) });
    const lostCall = spanIdFor(scope.sessionId, "events", "model_call", "event_model_1");
    await waitFor("the first model call row", async () =>
      (await store.readSpansByIds(scope, [lostCall])).length === 1 ? true : null);
    driver.cancel({ ...scope, reason: "lease_lost" });
    loseLease!();
    await expect(first).rejects.toThrow("lease_lost");
    // The lost attempt leaves the turn to the next owner.
    expect(await store.readTurn(scope, input.id)).toMatchObject({ state: "open", attempt_id: "attempt_01" });

    now = T0 + 5_000;
    await driver.accept({ ...scope, session, environment, events: [input], executionFence: fence("attempt_02", 2) });

    expect((await store.readSpansByIds(scope, [lostCall]))[0]).toMatchObject({
      status: "interrupted",
      attempt_id: "attempt_01",
      end_ms: T0 + 5_000,
      attrs: expect.objectContaining({ end_reason: "owner_changed" }),
    });
    expect(await store.readTurn(scope, input.id)).toMatchObject({ state: "complete", attempt_id: "attempt_02", frames_lost: false });
    const spans = await store.readTurnSpans(scope, [input.id], null, 100);
    expect(spans.filter((span) => span.status === "running")).toEqual([]);
    expect(spans.find((span) => span.span_id === turnSpanIdFor(scope.sessionId, input.id))).toMatchObject({
      status: "ok",
      attempt_id: "attempt_02",
    });
    expect(spans.filter((span) => span.kind === "sandbox").map((span) => span.attempt_id).sort())
      .toEqual(["attempt_01", "attempt_02"]);
    expect(spans.filter((span) => span.kind === "model_call").map((span) => [span.attempt_id, span.status]).sort())
      .toEqual([["attempt_01", "interrupted"], ["attempt_02", "ok"]]);
  });

  it("repairs a turn from history when the store refused two batches in the middle of it", async () => {
    const refused = { left: 8, failed: 0 };
    const root = await createTraceRoot();
    const node = await startTracePlane(root, { wrapSql: (sql) => refuseTraceInserts(sql, refused) });
    try {
      faux.setResponses([
        slowAnswer(() => fauxAssistantMessage(
          fauxToolCall("bash", { command: "sleep 0.3; echo repaired" }, { id: "toolu_repair_bash" }),
          { stopReason: "toolUse" },
        ), 400),
        slowAnswer(() => fauxAssistantMessage("Done."), 100),
      ]);
      const { sessionId } = await createPiSession(node);
      const events = await runTurn(node, sessionId, [
        { type: "user.message", content: [{ type: "text", text: "Run the command" }] },
      ]);
      // Each refused batch is tried four times (plan 2.1: retries after 250, 500 and 1000 ms).
      await waitFor("two refused batches", async () => refused.failed >= 8 ? true : null, 20_000);
      const userMessage = events.find((event) => event.type === "user.message")!;
      const page = await waitFor("the repaired turn", async () => {
        const current = await node.turn(sessionId, userMessage.id);
        return current.turn.state === "repaired" ? current : null;
      }, 20_000);

      expect(refused.failed).toBe(8);
      expect(page.turn).toMatchObject({ state: "repaired", partial: true });
      expect(page.turn.lost.length).toBeGreaterThan(0);
      expect(page.turn.turn).toMatchObject({ status: "ok", turn_id: userMessage.id });
      expect(page.spans.filter((span) => span.status === "running")).toEqual([]);
      expect(page.spans.filter((span) => span.kind === "model_call")).toHaveLength(2);
      expect(page.spans.filter((span) => span.kind === "tool_call").map((span) => span.tool?.call_id))
        .toEqual(["toolu_repair_bash"]);
      const row = await node.sql.prepare("SELECT frames_lost FROM trace_turns WHERE session_id = ?")
        .bind(sessionId).first<{ frames_lost: number }>();
      expect(Number(row?.frames_lost)).toBe(1);
    } finally {
      await node.stop();
      await removeTraceRoot(root);
    }
  }, 90_000);
});
