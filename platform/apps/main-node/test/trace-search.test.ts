import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { spanIdFor } from "../src/lib/trace/ids";
import { buildTraceRoutes } from "../src/lib/trace/routes";
import { loadTraceFixture, type TraceMultiTurnFixture } from "./_helpers/trace-harness-conformance";
import { createHistoryDb, insertSession, loadTurnInputsAsHistory } from "./_helpers/trace-history-db";

const WS = "ws_search";

/** Subagent session, nothing recorded live: every turn is not_built until search builds it. */
async function setup(options: { searchBudgetMs?: number; now?: () => number } = {}) {
  const sql = await createHistoryDb();
  const fixture = loadTraceFixture<TraceMultiTurnFixture>("subagent-frames.json");
  await insertSession(sql, WS, fixture.scope.sessionId, { harness: "pi" });
  for (const turn of fixture.turns) await loadTurnInputsAsHistory(sql, WS, fixture.scope.sessionId, turn.executionId, turn.inputs);
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", WS); await next(); });
  app.route("/v1/oma/sessions", buildTraceRoutes({ sql, dialect: "sqlite", ...options }) as never);
  const root = `/v1/oma/sessions/${fixture.scope.sessionId}/trace/search`;
  const search = async (query: string) => {
    const response = await app.request(`${root}?${query}`);
    return { status: response.status, body: await response.json() as { matches: Array<{ span_id: string; turn_id: string; kind: string; name: string }>; next: string | null; remaining_turns: number } };
  };
  return { fixture, search };
}

describe("GET /v1/oma/sessions/:id/trace/search", () => {
  it("builds unbuilt turns and finds nodes by tool, model, span id, event id and error text", async () => {
    const { fixture, search } = await setup();
    const byTool = await search("q=create_subagent");
    expect(byTool.status).toBe(200);
    expect(byTool.body.remaining_turns).toBe(0);
    expect(byTool.body.matches.map((match) => [match.kind, match.name])).toEqual([["tool_call", "create_subagent"], ["tool_call", "create_subagent"]]);
    expect(byTool.body.matches[0]!.turn_id).toBe(fixture.turns[0]!.executionId);
    const byError = await search("q=PROVIDER%20REQUEST");
    expect(byError.body.matches.map((match) => match.kind)).toEqual(expect.arrayContaining(["model_call", "event"]));
    const subagentNode = spanIdFor(fixture.scope.sessionId, "events", "subagent", `${fixture.threads!.A}:${fixture.turns[1]!.executionId}`);
    expect((await search(`q=${subagentNode}`)).body.matches.map((match) => match.span_id)).toEqual([subagentNode]);
    expect((await search("q=sevt_fixtureSubResWait01")).body.matches.map((match) => match.kind)).toEqual(["tool_call"]);
    expect((await search("q=fixture-model")).body.matches.length).toBeGreaterThan(10);
    expect((await search("q=100%25_off")).body.matches).toEqual([]);
  });

  it("reports the turns it could not build within the budget", async () => {
    const { search } = await setup({ searchBudgetMs: 0 });
    const first = await search("q=researcher");
    expect(first.body.remaining_turns).toBe(3);
    expect(first.body.matches).toEqual([]);
  });

  it("search builds turns newest first and still links confirmations to the calls of earlier turns", async () => {
    const sql = await createHistoryDb();
    const fixture = loadTraceFixture<TraceMultiTurnFixture>("confirmation-frames.json");
    const sessionId = fixture.scope.sessionId;
    await insertSession(sql, WS, sessionId, { harness: "pi" });
    for (const turn of fixture.turns) await loadTurnInputsAsHistory(sql, WS, sessionId, turn.executionId, turn.inputs);
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", WS); await next(); });
    app.route("/v1/oma/sessions", buildTraceRoutes({ sql, dialect: "sqlite" }) as never);
    const root = `/v1/oma/sessions/${sessionId}/trace`;
    const found = await (await app.request(`${root}/search?q=bash`)).json() as { remaining_turns: number };
    expect(found.remaining_turns).toBe(0);
    const spansOf = async (turnId: string) =>
      (await (await app.request(`${root}?turn_id=${turnId}`)).json() as { spans: Array<{ span_id: string; status: string }> }).spans;
    const status = new Map([...await spansOf(fixture.turns[0]!.executionId), ...await spansOf(fixture.turns[2]!.executionId)]
      .map((span) => [span.span_id, span.status]));
    const node = (kind: "tool_call" | "tool_wait" | "tool_exec", toolUseId: string) => status.get(spanIdFor(sessionId, "events", kind, toolUseId));
    expect([node("tool_call", "toolu_fixtureConfirmBash1"), node("tool_wait", "toolu_fixtureConfirmBash1"), node("tool_exec", "toolu_fixtureConfirmBash1")]).toEqual(["ok", "ok", "ok"]);
    expect([node("tool_call", "toolu_fixtureConfirmBash3"), node("tool_wait", "toolu_fixtureConfirmBash3")]).toEqual(["denied", "denied"]);
  });

  it("rejects an empty query and pages long results", async () => {
    const { search } = await setup();
    expect((await search("q=")).status).toBe(400);
    const page = await search("q=fixture-model&limit=2");
    expect(page.body.matches).toHaveLength(2);
    expect(page.body.next).not.toBeNull();
    const next = await search(`q=fixture-model&limit=2&after=${page.body.next}`);
    expect(next.body.matches[0]!.span_id).not.toBe(page.body.matches[0]!.span_id);
  });
});
