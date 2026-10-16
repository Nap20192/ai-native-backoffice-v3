// Trace store contract shared by the SQLite and Postgres tests.
import { expect } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { spanIdFor, turnSpanIdFor } from "../../src/lib/trace/ids";
import { createTraceProjector } from "../../src/lib/trace/projector";
import { createTraceStore, type TraceStore } from "../../src/lib/trace/store";
import type { TraceProjectorInput, TraceSpanWrite } from "../../src/lib/trace/types";
import { loadTraceFixture, type TraceMultiTurnFixture } from "./trace-harness-conformance";

export async function runTraceStoreContract(open: () => Promise<{ sql: SqlClient; dialect: "sqlite" | "postgres"; close?: () => Promise<void> }>): Promise<void> {
  const { sql, dialect, close } = await open();
  try {
    await storeContract(sql, dialect);
  } finally {
    await close?.();
  }
}

async function project(store: TraceStore, scope: { workspaceId: string; sessionId: string }, inputs: readonly TraceProjectorInput[], harness: string | null = "pi") {
  const projector = createTraceProjector({ sessionId: scope.sessionId, harness });
  const results = [];
  for (const input of inputs) {
    const ops = projector.push(input);
    if (ops.length === 0) continue;
    results.push(await store.apply(scope, { turnId: projector.turnId()!, attemptId: projector.attemptId(), ops }));
  }
  return { projector, results };
}

export async function count(sql: SqlClient, table: string): Promise<number> {
  const row = await sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number | string }>();
  return Number(row?.n ?? 0);
}

async function storeContract(sql: SqlClient, dialect: "sqlite" | "postgres"): Promise<void> {
  let clock = 1792400000000;
  const store = createTraceStore({ sql, dialect, now: () => clock });
  await store.ensureSchema();
  await store.ensureSchema();
  expect(await count(sql, "trace_spans")).toBe(0);
  expect(await count(sql, "trace_turns")).toBe(0);

  // Live write of a recorded Pi turn, then the same frames again.
  const pi = loadTraceFixture("pi-turn-frames.json");
  const scope = { workspaceId: "ws_store", sessionId: pi.scope.sessionId };
  await project(store, scope, pi.inputs);
  const rows = await count(sql, "trace_spans");
  expect(rows).toBe(6);
  const firstRead = await store.readSpansByIds(scope, [turnSpanIdFor(scope.sessionId, pi.execution!.id)]);
  expect(firstRead[0]).toMatchObject({ kind: "turn", status: "ok", sources: ["events"], deleted: false });
  clock += 1000;
  await project(store, scope, pi.inputs);
  expect(await count(sql, "trace_spans")).toBe(rows);
  const [again] = await store.readSpansByIds(scope, [firstRead[0]!.span_id]);
  expect(again!.version).toBeGreaterThan(firstRead[0]!.version);
  expect(again!.updated_at).toBe(clock);
  const [turnRow] = await store.readTurns(scope);
  expect(turnRow).toMatchObject({ turn_id: pi.execution!.id, state: "open", span_count: 6, error_count: 0, waiting_count: 0, attempt_id: pi.execution!.attempt_id });
  expect(turnRow!.coverage).toEqual({ model_calls: "measured", tools: "measured", sandbox: "attempts" });

  // A by-events copy of a closed measured span keeps the measurement.
  const model = (await store.readTurnSpans(scope, [pi.execution!.id], null, 100)).find((span) => span.kind === "model_call")!;
  const byEvents: TraceSpanWrite = { ...stripStore(model), precision: "by_events", start_ms: model.start_ms + 2, end_ms: model.end_ms! + 9, attrs: {} };
  await store.apply(scope, { turnId: pi.execution!.id, attemptId: pi.execution!.attempt_id as string, ops: [{ op: "upsert", span: byEvents }] });
  const [kept] = await store.readSpansByIds(scope, [model.span_id]);
  expect(kept).toMatchObject({ precision: "measured", start_ms: model.start_ms, end_ms: model.end_ms, status: "ok" });
  expect(kept!.attrs.harness_duration_ms).toBe(model.attrs.harness_duration_ms);

  // An open measured span closed by events keeps its start and takes the end.
  const openSpan: TraceSpanWrite = { ...stripStore(model), span_id: "00000000000000aa", precision: "measured", start_ms: 100, end_ms: null, status: "running", attrs: {} };
  await store.apply(scope, { turnId: pi.execution!.id, attemptId: pi.execution!.attempt_id as string, ops: [{ op: "upsert", span: openSpan }] });
  await store.apply(scope, { turnId: pi.execution!.id, attemptId: pi.execution!.attempt_id as string, ops: [{ op: "upsert", span: { ...openSpan, precision: "by_events", start_ms: 150, end_ms: 400, status: "interrupted", attrs: { end_reason: "process_lost" } } }] });
  const [closed] = await store.readSpansByIds(scope, ["00000000000000aa"]);
  expect(closed).toMatchObject({ precision: "measured", start_ms: 100, end_ms: 400, status: "interrupted" });
  expect(closed!.attrs.end_reason).toBe("process_lost");
  // A closed span is not reopened, a non-waiting span does not go back to waiting.
  await store.apply(scope, { turnId: pi.execution!.id, attemptId: pi.execution!.attempt_id as string, ops: [{ op: "upsert", span: { ...openSpan, end_ms: null, status: "waiting" } }] });
  expect((await store.readSpansByIds(scope, ["00000000000000aa"]))[0]).toMatchObject({ status: "interrupted", end_ms: 400 });

  // Confirmation across turns: patches by status, inherit from the parent turn, missing rows reported.
  const confirm = loadTraceFixture<TraceMultiTurnFixture>("confirmation-frames.json");
  const cscope = { workspaceId: "ws_store", sessionId: confirm.scope.sessionId };
  await project(store, cscope, confirm.turns[0]!.inputs);
  const turns1 = await store.readTurns(cscope);
  expect(turns1[0]).toMatchObject({ waiting_count: 2 });
  await project(store, cscope, confirm.turns[1]!.inputs);
  const call = spanIdFor(cscope.sessionId, "events", "tool_call", "toolu_fixtureConfirmBash1");
  const exec = spanIdFor(cscope.sessionId, "events", "tool_exec", "toolu_fixtureConfirmBash1");
  const [callRow, execRow] = await store.readSpansByIds(cscope, [call, exec]);
  expect(callRow).toMatchObject({ status: "ok", turn_id: confirm.turns[0]!.executionId, event_ids: ["toolu_fixtureConfirmBash1", "sevt_fixtureConfirmRes001"] });
  expect(execRow).toMatchObject({ status: "ok", turn_id: confirm.turns[0]!.executionId, thread_id: "sthr_primary" });
  const summaries = await store.readTurns(cscope);
  expect(summaries.find((row) => row.turn_id === confirm.turns[0]!.executionId)).toMatchObject({ waiting_count: 0 });
  const missing = await store.apply(cscope, {
    turnId: confirm.turns[1]!.executionId,
    attemptId: "attempt_fixtureConfirm002",
    ops: [{ op: "patch", span_id: "ffffffffffffffff", key_event_id: "toolu_unknown", expect: ["waiting"], set: { status: "ok" } }],
  });
  expect(missing.missing).toEqual([{ span_id: "ffffffffffffffff", key_event_id: "toolu_unknown" }]);
  const closedPatch = await store.apply(cscope, {
    turnId: confirm.turns[1]!.executionId,
    attemptId: "attempt_fixtureConfirm002",
    ops: [{ op: "patch", span_id: call, key_event_id: "toolu_fixtureConfirmBash1", expect: ["waiting"], set: { status: "cancelled" } }],
  });
  expect(closedPatch.missing).toEqual([]);
  expect((await store.readSpansByIds(cscope, [call]))[0]!.status).toBe("ok");

  // Session stop cancels waiting nodes of earlier turns.
  await project(store, cscope, confirm.turns[2]!.inputs);
  const cancelled = await store.cancelWaiting(cscope, 1792200399000);
  expect(cancelled).toBe(2);
  const bash3 = spanIdFor(cscope.sessionId, "events", "tool_call", "toolu_fixtureConfirmBash3");
  expect((await store.readSpansByIds(cscope, [bash3]))[0]).toMatchObject({ status: "cancelled", end_ms: 1792200399000 });

  // Attempt fence: a new attempt takes the turn and closes what the old one left open.
  const fscope = { workspaceId: "ws_store", sessionId: "session_fence" };
  const startedA: TraceProjectorInput = { kind: "execution_started", atMs: 1000, events: [{ type: "user.message", id: "sevt_fence_user", processedAt: new Date(999).toISOString() }], fence: { executionId: "sevt_fence_user", attemptId: "attempt_A", generation: 1 } };
  const projectorA = createTraceProjector({ sessionId: fscope.sessionId, harness: "pi" });
  const applyA = (input: TraceProjectorInput) => store.apply(fscope, { turnId: "sevt_fence_user", attemptId: "attempt_A", ops: projectorA.push(input) });
  await applyA(startedA);
  await applyA({ kind: "start_attempt", attempt: 1, atMs: 1001 });
  await applyA({ kind: "start_attempt_settled", attempt: 1, atMs: 1002, outcome: "ok" });
  await applyA({ kind: "frame", frame: { type: "span.model_request_start", id: "sevt_fence_m1", model: "m", processed_at: new Date(1010).toISOString() } });
  const projectorB = createTraceProjector({ sessionId: fscope.sessionId, harness: "pi" });
  await store.apply(fscope, { turnId: "sevt_fence_user", attemptId: "attempt_B", ops: projectorB.push({ ...startedA, atMs: 5000, fence: { executionId: "sevt_fence_user", attemptId: "attempt_B", generation: 2 } }) });
  const modelA = spanIdFor(fscope.sessionId, "events", "model_call", "sevt_fence_m1");
  const [interrupted] = await store.readSpansByIds(fscope, [modelA]);
  expect(interrupted).toMatchObject({ status: "interrupted", end_ms: 5000 });
  expect(interrupted!.attrs.end_reason).toBe("owner_changed");
  expect((await store.readSpansByIds(fscope, [turnSpanIdFor(fscope.sessionId, "sevt_fence_user")]))[0]).toMatchObject({ status: "running", end_ms: null, attempt_id: "attempt_B" });
  const stale = await applyA({ kind: "frame", frame: { type: "span.model_request_end", id: "sevt_fence_m1_end", model_request_start_id: "sevt_fence_m1", finish_reason: "stop", processed_at: new Date(6000).toISOString() } });
  expect(stale.fenced).toBe(true);
  expect((await store.readSpansByIds(fscope, [modelA]))[0]).toMatchObject({ status: "interrupted", end_ms: 5000 });
  const staleTurn = await applyA({ kind: "frame", frame: { type: "session.status_idle", id: "sevt_fence_idle", stop_reason: { type: "end_turn" }, processed_at: new Date(6100).toISOString() } });
  expect(staleTurn.fenced).toBe(true);
  const [fenceTurn] = await store.readTurns(fscope);
  expect(fenceTurn).toMatchObject({ attempt_id: "attempt_B", end_ms: null, state: "open" });
  expect(await store.finalizeTurn(fscope, { turnId: "sevt_fence_user", attemptId: "attempt_A", state: "complete", historyCursor: "x", lost: [] })).toBe(false);

  // Finalize: complete only without lost frames, repaired always.
  await store.markFramesLost(fscope, "sevt_fence_user", "attempt_B");
  expect(await store.finalizeTurn(fscope, { turnId: "sevt_fence_user", attemptId: "attempt_B", state: "complete", historyCursor: "sevt_fence_idle", lost: [] })).toBe(false);
  expect(await store.finalizeTurn(fscope, { turnId: "sevt_fence_user", attemptId: "attempt_B", state: "repaired", historyCursor: "sevt_fence_idle", lost: ["tool_exec"] })).toBe(true);
  expect((await store.readTurns(fscope))[0]).toMatchObject({ state: "repaired", frames_lost: true, lost: ["tool_exec"], history_cursor: "sevt_fence_idle" });

  // Subagent continuation: the store links the previous node of the thread.
  const sub = loadTraceFixture<TraceMultiTurnFixture>("subagent-frames.json");
  const sscope = { workspaceId: "ws_store", sessionId: sub.scope.sessionId };
  for (const turn of sub.turns) await project(store, sscope, turn.inputs);
  const nodeOf = (turnId: string) => spanIdFor(sscope.sessionId, "events", "subagent", `${sub.threads!.A}:${turnId}`);
  const [second, third] = await store.readSpansByIds(sscope, [nodeOf(sub.turns[1]!.executionId), nodeOf(sub.turns[2]!.executionId)]);
  expect(second!.attrs.continued_from).toBe(nodeOf(sub.turns[0]!.executionId));
  expect(third!.attrs.continued_from).toBe(nodeOf(sub.turns[1]!.executionId));

  // Deleted rows stay readable in the change feed.
  await store.markDeleted(sscope, nodeOf(sub.turns[2]!.executionId));
  const changes = await store.readChanges(sscope, null, 5000);
  expect(changes.find((span) => span.span_id === nodeOf(sub.turns[2]!.executionId))).toMatchObject({ deleted: true });
  expect((await store.readTurnSpans(sscope, [sub.turns[2]!.executionId], null, 1000)).some((span) => span.span_id === nodeOf(sub.turns[2]!.executionId))).toBe(false);

  // Deleting a session removes its spans and turns.
  await store.deleteSession(sscope);
  expect(await store.readTurns(sscope)).toEqual([]);
  expect(await store.readChanges(sscope, null, 10)).toEqual([]);
  void dialect;
}

function stripStore(span: { version: number; deleted: boolean; updated_at: number } & TraceSpanWrite): TraceSpanWrite {
  const { version: _v, deleted: _d, updated_at: _u, ...rest } = span;
  return rest;
}

