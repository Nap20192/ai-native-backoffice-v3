import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { decodeCursor } from "../src/lib/trace/cursor";
import { traceIdFor, turnSpanIdFor } from "../src/lib/trace/ids";
import { createTraceObserver } from "../src/lib/trace/observer";
import { createTraceRecorder } from "../src/lib/trace/recorder";
import { buildTraceRoutes } from "../src/lib/trace/routes";
import { createTraceStore } from "../src/lib/trace/store";
import type { TraceProjectorInput, TraceScope } from "../src/lib/trace/types";
import { loadTraceFixture, type TraceMultiTurnFixture } from "./_helpers/trace-harness-conformance";
import { createHistoryDb, insertExecution, insertSession, loadFixtureHistory, loadTurnInputsAsHistory } from "./_helpers/trace-history-db";

const WS = "ws_routes";

async function drive(observer: ReturnType<typeof createTraceObserver>, scope: TraceScope, inputs: readonly TraceProjectorInput[]) {
  for (const input of inputs) {
    if (input.kind === "execution_started") {
      observer.executionStarted({ ...scope, events: input.events, atMs: input.atMs, harness: "pi", ...(input.fence !== undefined && { fence: { ...scope, executionId: input.fence.executionId ?? "", attemptId: input.fence.attemptId, ownerId: "node:test", generation: input.fence.generation ?? 1, expiresAt: "" } }) });
    } else if (input.kind === "start_attempt") observer.startAttempt({ ...scope, attempt: input.attempt, atMs: input.atMs });
    else if (input.kind === "start_attempt_settled") observer.startAttemptSettled({ ...scope, attempt: input.attempt, atMs: input.atMs, outcome: input.outcome });
    else if (input.kind === "frame") observer.frame(scope, input.frame);
    else if (input.kind === "execution_settled") await observer.executionSettled({ ...scope, atMs: input.atMs, outcome: input.outcome === "process_lost" ? "failed" : input.outcome });
  }
}

function appFor(routes: Hono<never>) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", c.req.header("x-workspace") ?? WS); await next(); });
  app.route("/v1/oma/sessions", routes as never);
  return app;
}

/** Confirmation session: turns 1..3 recorded live, turn 4 only in history. */
async function confirmationSession(options: { dialect?: "sqlite" | "mysql"; now?: () => number } = {}) {
  const sql = await createHistoryDb();
  const fixture = loadTraceFixture<TraceMultiTurnFixture>("confirmation-frames.json");
  const scope = { workspaceId: WS, sessionId: fixture.scope.sessionId };
  await insertSession(sql, WS, scope.sessionId, { harness: "pi" });
  for (const turn of fixture.turns) await loadTurnInputsAsHistory(sql, WS, scope.sessionId, turn.executionId, turn.inputs);
  if ((options.dialect ?? "sqlite") === "sqlite") {
    const observer = createTraceObserver({ recorder: createTraceRecorder({ store: createTraceStore({ sql, dialect: "sqlite" }) }) });
    for (const turn of fixture.turns.slice(0, 3)) await drive(observer, scope, turn.inputs);
  }
  const now = options.now ?? (() => 1792300000000);
  const routes = buildTraceRoutes({ sql, dialect: options.dialect ?? "sqlite", now });
  return { sql, fixture, scope, app: appFor(routes as never), root: `/v1/oma/sessions/${scope.sessionId}/trace` };
}

async function tables(sql: SqlClient): Promise<string[]> {
  const rows = await sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'trace_%' ORDER BY name").all<{ name: string }>();
  return (rows.results ?? []).map((row) => row.name);
}

describe("GET /v1/oma/sessions/:id/trace", () => {
  it("answers 401 without a workspace and 404 for an unknown session", async () => {
    const { sql } = await confirmationSession();
    const routes = buildTraceRoutes({ sql, dialect: "sqlite" });
    expect((await routes.request("/session_x/trace")).status).toBe(401);
    const app = appFor(routes as never);
    expect((await app.request("/v1/oma/sessions/session_missing/trace")).status).toBe(404);
    expect((await app.request("/v1/oma/sessions/session_fixtureConfirm00001/trace", { headers: { "x-workspace": "ws_other" } })).status).toBe(404);
  });

  it("returns turn summaries and the subtrees of the last two turns (trace.api_shape)", async () => {
    const { app, root, fixture, scope } = await confirmationSession();
    const response = await app.request(root);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown> & { turns: Array<Record<string, unknown> & { turn: { span_id: string; turn_id: string } }>; spans: Array<{ span_id: string; parent_span_id: string | null; turn_id: string; kind: string }> };
    expect(body.trace_id).toBe(traceIdFor(scope.sessionId));
    expect(body.trace_id).toMatch(/^[0-9a-f]{32}$/u);
    expect(body.session_id).toBe(scope.sessionId);
    expect(body.turns_before).toBeNull();
    expect(body.spans_next).toBeNull();
    expect(body.collecting).toBe(false);
    expect(typeof body.cursor).toBe("string");
    expect(body.turns.map((turn) => [turn.turn.turn_id, turn.state])).toEqual([
      [fixture.turns[0]!.executionId, "complete"],
      [fixture.turns[1]!.executionId, "complete"],
      [fixture.turns[2]!.executionId, "complete"],
      [fixture.turns[3]!.executionId, "repaired"],
    ]);
    for (const turn of body.turns) {
      expect(turn).toHaveProperty("coverage");
      expect(turn).toHaveProperty("version");
      expect(turn.turn.span_id).toBe(turnSpanIdFor(scope.sessionId, turn.turn.turn_id));
    }
    expect(body.turns[3]).toMatchObject({ partial: true, lost: ["sandbox_phases", "harness_timing", "ttft", "tool_exec"] });
    const ids = new Set(body.spans.map((span) => span.span_id));
    expect(new Set(body.spans.map((span) => span.turn_id))).toEqual(new Set([fixture.turns[2]!.executionId, fixture.turns[3]!.executionId]));
    for (const span of body.spans) {
      expect(span.span_id).toMatch(/^[0-9a-f]{16}$/u);
      if (span.kind === "turn") expect(span.parent_span_id).toBeNull();
      else expect(ids.has(span.parent_span_id!)).toBe(true);
    }
  });

  it("pages one turn, older summaries and the change feed", async () => {
    const { app, root, fixture, sql, scope } = await confirmationSession();
    const page = await (await app.request(`${root}?turn_id=${fixture.turns[0]!.executionId}`)).json() as { spans: Array<{ kind: string; status: string }>; page_next: string | null; turn: { state: string } };
    expect(page.page_next).toBeNull();
    expect(page.turn.state).toBe("complete");
    expect(page.spans.map((span) => span.kind)).toEqual(expect.arrayContaining(["turn", "sandbox", "model_call", "tool_call", "tool_wait", "tool_exec"]));
    expect((await app.request(`${root}?turn_id=sevt_unknown`)).status).toBe(404);
    expect((await app.request(`${root}?after=not-a-cursor`)).status).toBe(400);

    for (let index = 0; index < 500; index += 1) {
      await insertExecution(sql, WS, scope.sessionId, { id: `sevt_old_${String(index).padStart(4, "0")}`, admitted_at_ms: 1792100000000 + index, events: [], state: "completed", attempt_id: null, claimed_at_ms: null, lease_expires_at_ms: null, settled_at_ms: 1792100000000 + index + 1 });
    }
    const first = await (await app.request(root)).json() as { turns: Array<{ turn: { turn_id: string }; state: string }>; turns_before: string | null };
    expect(first.turns).toHaveLength(500);
    expect(first.turns.at(-1)!.turn.turn_id).toBe(fixture.turns[3]!.executionId);
    expect(first.turns_before).not.toBeNull();
    const older = await (await app.request(`${root}?turns_before=${first.turns_before}`)).json() as { turns: Array<{ turn: { turn_id: string }; state: string; span_count: number | null }>; turns_before: string | null };
    expect(older.turns.map((turn) => turn.turn.turn_id)).toEqual(["sevt_old_0000", "sevt_old_0001", "sevt_old_0002", "sevt_old_0003"]);
    expect(older.turns[0]).toMatchObject({ state: "not_built", span_count: null });
    expect(older.turns_before).toBeNull();

    const changes = await (await app.request(`${root}?after=${encodeURIComponent((await (await app.request(root)).json() as { cursor: string }).cursor)}`)).json() as { spans: unknown[]; turns: unknown[]; more: boolean; cursor: string };
    expect(changes.more).toBe(false);
    expect(decodeCursor(changes.cursor).u).toBeLessThanOrEqual(1792300000000 - 2000);
  });

  it("the change feed rebuilds a turn whose process died after the overview, so polling ends with it closed", async () => {
    const sql = await createHistoryDb();
    const fixture = loadTraceFixture("interrupted-turn-frames.json");
    const scope = { workspaceId: WS, sessionId: fixture.scope.sessionId };
    const leaseEnd = 1792108976229;
    await loadFixtureHistory(sql, WS, fixture, { state: "running", settled_at_ms: null, lease_expires_at_ms: leaseEnd, failure: null });
    let clock = 1792108950000;
    const store = createTraceStore({ sql, dialect: "sqlite", now: () => clock });
    // The live write stops after the model request start: the final records never come.
    const recorder = createTraceRecorder({ store });
    const observer = createTraceObserver({ recorder });
    const cut = fixture.inputs.findIndex((input) => input.kind === "frame" && (input.frame as { type?: string }).type === "span.model_request_start");
    await drive(observer, scope, fixture.inputs.slice(0, cut + 1));
    await recorder.flush(scope);
    const app = appFor(buildTraceRoutes({ sql, dialect: "sqlite", store, now: () => clock }) as never);
    const root = `/v1/oma/sessions/${scope.sessionId}/trace`;

    const overview = await (await app.request(root)).json() as { cursor: string; collecting: boolean; turns: Array<{ state: string }> };
    expect(overview.collecting).toBe(true);
    expect(overview.turns.map((turn) => turn.state)).toEqual(["open"]);

    // The lease ran out long ago, past the grace of an open turn.
    clock = leaseEnd + 60_000;
    const changes = await (await app.request(`${root}?after=${encodeURIComponent(overview.cursor)}`)).json() as {
      collecting: boolean;
      turns: Array<{ state: string; turn: { turn_id: string } }>;
      spans: Array<{ kind: string; status: string }>;
    };
    expect(changes.turns.map((turn) => [turn.turn.turn_id, turn.state])).toEqual([[fixture.execution!.id, "repaired"]]);
    expect(changes.spans.filter((span) => span.status === "running")).toEqual([]);
    expect(changes.collecting).toBe(false);
  });

  it("downloads the trace as one OTLP JSON request", async () => {
    const { app, root, scope } = await confirmationSession();
    const response = await app.request(`${root}/otlp.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toContain(`trace-${scope.sessionId}.json`);
    const body = await response.json() as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; name: string }> }> }> };
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.length).toBeGreaterThan(10);
    expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([traceIdFor(scope.sessionId)]));
    expect(spans.some((span) => span.name === "execute_tool bash")).toBe(true);
  });

  it("builds the trace from events in memory on MySQL, without trace tables", async () => {
    const { app, root, sql, fixture } = await confirmationSession({ dialect: "mysql" });
    const body = await (await app.request(root)).json() as { turns: Array<{ state: string }>; spans: Array<{ kind: string; precision: string; status: string }> };
    expect(await tables(sql)).toEqual([]);
    expect(body.turns.map((turn) => turn.state)).toEqual(["repaired", "repaired", "repaired", "repaired"]);
    expect(body.spans.filter((span) => span.kind === "model_call").every((span) => span.precision === "by_events")).toBe(true);
    const turn = await (await app.request(`${root}?turn_id=${fixture.turns[0]!.executionId}`)).json() as { spans: Array<{ kind: string; status: string }> };
    expect(turn.spans.find((span) => span.kind === "tool_call")!.status).toBe("ok");
    expect(turn.spans.find((span) => span.kind === "tool_wait")!.status).toBe("ok");
  });

  it("on MySQL rebuilds only new turns and keeps versions growing", async () => {
    const { app, root, sql, scope, fixture } = await confirmationSession({ dialect: "mysql", now: () => 1792300000000 });
    const first = await (await app.request(`${root}?turn_id=${fixture.turns[0]!.executionId}`)).json() as { spans: Array<{ span_id: string; version: number }> };
    const t = 1792200500000;
    const iso = (ms: number) => new Date(ms).toISOString();
    await loadTurnInputsAsHistory(sql, WS, scope.sessionId, "sevt_fixtureConfirmUser005", [
      { kind: "execution_started", atMs: t + 1, events: [{ type: "user.message", id: "sevt_fixtureConfirmUser005", content: [], processedAt: iso(t) }], fence: { executionId: "sevt_fixtureConfirmUser005", attemptId: "attempt_fixtureConfirm005", generation: 1 } },
      { kind: "frame", frame: { type: "session.status_running", id: "sevt_fixtureConfirmRun005", processed_at: iso(t + 10) } },
      { kind: "frame", frame: { type: "span.model_request_start", id: "sevt-fixture-confirm-m5", model: "fixture-model", processed_at: iso(t + 20) } },
      { kind: "frame", frame: { type: "span.model_request_end", id: "sevt_fixtureConfirmEnd005", model_request_start_id: "sevt-fixture-confirm-m5", finish_reason: "stop", processed_at: iso(t + 300) } },
      { kind: "frame", frame: { type: "session.status_idle", id: "sevt_fixtureConfirmIdle05", stop_reason: { type: "end_turn" }, processed_at: iso(t + 310) } },
      { kind: "execution_settled", atMs: t + 320, outcome: "completed" },
    ]);
    const body = await (await app.request(root)).json() as { turns: Array<{ turn: { turn_id: string }; state: string }> };
    expect(body.turns.map((turn) => turn.state)).toEqual(["repaired", "repaired", "repaired", "repaired", "repaired"]);
    const again = await (await app.request(`${root}?turn_id=${fixture.turns[0]!.executionId}`)).json() as { spans: Array<{ span_id: string; version: number }> };
    expect(again.spans.map((span) => [span.span_id, span.version])).toEqual(first.spans.map((span) => [span.span_id, span.version]));
  });

  it("answers for the recorded Pi turn with the contract fixture pi-turn-trace.json", async () => {
    const sql = await createHistoryDb();
    const fixture = loadTraceFixture("pi-turn-frames.json");
    await loadFixtureHistory(sql, WS, fixture);
    const scope = { workspaceId: WS, sessionId: fixture.scope.sessionId };
    let clock = 1792097299600;
    const store = createTraceStore({ sql, dialect: "sqlite", now: () => clock++ });
    const observer = createTraceObserver({ recorder: createTraceRecorder({ store }) });
    await drive(observer, scope, fixture.inputs);
    const app = appFor(buildTraceRoutes({ sql, dialect: "sqlite", store, now: () => 1792097400000 }) as never);
    const body = await (await app.request(`/v1/oma/sessions/${scope.sessionId}/trace`)).json();
    await expect(`${JSON.stringify(body, null, 2)}\n`).toMatchFileSnapshot("./_fixtures/trace/pi-turn-trace.json");
  });
});
