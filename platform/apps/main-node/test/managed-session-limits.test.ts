// Session limits (docs/plans/multiagent.md, 3.Б). Slice 1: one row per
// Session counts the tokens of every model request of every thread and the
// turns of subagent threads. A Session without the row gets it filled from
// its log. GET /v1/sessions/:id shows the row as `_oma.limits`. Slice 2: Pi
// asks the row before each request and the turn stops on budget_reached.
// Slice 3: at the limit new work gets 400 and answers to calls go on; a
// raise above the work counted continues the stopped turn.
//
// A real Node control plane runs Pi on a local sandbox, only the model is
// the Pi faux provider. The wait goes through SQL, not GET .../events: that
// list still answers 500 after a `call_agent_*` call (slice 1.2 report).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  decodeSessionEventDocument,
  encodeSessionEventDocument,
} from "@open-managed-agents/session-runtime-contract/history";
import type { SessionEventView } from "@open-managed-agents/managed-agents-application";
import {
  TRACE_MODEL,
  createPiSession,
  createTraceRoot,
  removeTraceRoot,
  runTurn as runPiTurn,
  startTracePlane,
  useFauxPiModel,
  waitFor,
  type TracePlane,
  type WireEvent,
} from "./_helpers/trace-node-plane.js";

interface Limits {
  max_tokens: number;
  max_child_turns: number;
  used_tokens: number;
  used_child_turns: number;
}

const faux = useFauxPiModel();
let root = "";
let plane: TracePlane | undefined;

beforeAll(async () => {
  root = await createTraceRoot();
  plane = await startTracePlane(root);
}, 60_000);

afterAll(async () => {
  await plane?.stop();
  if (root !== "") await removeTraceRoot(root);
});

/** A coordinator with one subagent in its roster, and an idle session. */
async function createCoordinatorSession(node: TracePlane): Promise<{ sessionId: string; workspaceId: string; checkerId: string }> {
  const environment = await node.post("/v1/environments", {
    name: "limits",
    config: { type: "cloud", networking: { type: "unrestricted" }, packages: { type: "packages" } },
  });
  const checker = await node.post("/v1/agents", {
    name: "Checker",
    model: TRACE_MODEL,
    system: "Check what you are asked and answer in one line.",
    tools: [{ type: "agent_toolset_20260401" }],
    _oma: { harness: "pi" },
  });
  const coordinator = await node.post("/v1/agents", {
    name: "Coordinator",
    model: TRACE_MODEL,
    system: "Delegate checks to the checker.",
    tools: [{ type: "agent_toolset_20260401" }],
    multiagent: { type: "coordinator", agents: [{ type: "agent", id: checker.id, version: checker.version }] },
    _oma: { harness: "pi" },
  });
  const session = await node.post("/v1/sessions", {
    agent: { type: "agent", id: coordinator.id, version: coordinator.version },
    environment_id: environment.id,
    title: "limits",
  });
  const row = await node.sql
    .prepare("SELECT workspace_id FROM managed_sessions WHERE id = ?")
    .bind(session.id)
    .first<{ workspace_id: string }>();
  return { sessionId: session.id as string, workspaceId: row!.workspace_id, checkerId: checker.id as string };
}

/** Writes events straight into the canonical log, as an older server did. */
async function seed(node: TracePlane, workspaceId: string, sessionId: string, events: SessionEventView[]): Promise<void> {
  for (const [index, event] of events.entries()) {
    const threadId = "sessionThreadId" in event ? event.sessionThreadId ?? null : null;
    await node.sql
      .prepare(
        `INSERT INTO managed_session_events
          (workspace_id, session_id, thread_id, id, type, document, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(workspaceId, sessionId, threadId, event.id, event.type,
        encodeSessionEventDocument(event, { revision: 1, index }), Date.parse(event.processedAt!))
      .run();
  }
}

const usage = (inputTokens: number, outputTokens: number) => ({
  cacheCreationInputTokens: 0, cacheReadInputTokens: 0, inputTokens, outputTokens,
});

/**
 * Work of an earlier server: a request of the main thread, a subagent turn
 * with its request, an advisor request and an outcome grader. 1 672 tokens
 * and one subagent turn: the advisor thread is not a subagent turn.
 */
function earlierWork(): SessionEventView[] {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, 0, ms)).toISOString();
  return [
    { id: "sevt_old_main_end", type: "span.model_request_end", isError: false, modelRequestStartId: "sevt_old_main_start", modelUsage: usage(1000, 200), processedAt: at(1) },
    { id: "sevt_old_child_running", type: "session.thread_status_running", agentName: "Checker", sessionThreadId: "sthr_old_child", processedAt: at(2) },
    { id: "sevt_old_child_end", type: "span.model_request_end", isError: false, modelRequestStartId: "sevt_old_child_start", modelUsage: usage(300, 40), sessionThreadId: "sthr_old_child", processedAt: at(3) },
    { id: "sevt_old_advisor_running", type: "session.thread_status_running", agentName: "anthropic.advisor", sessionThreadId: "sthr_old_advisor", processedAt: at(4) },
    { id: "sevt_old_advisor_end", type: "span.model_request_end", isError: false, modelRequestStartId: "sevt_old_advisor_start", modelUsage: usage(50, 5), sessionThreadId: "sthr_old_advisor", processedAt: at(5) },
    { id: "sevt_old_grader_end", type: "span.outcome_evaluation_end", explanation: "ok", iteration: 0, outcomeEvaluationStartId: "sevt_old_grader_start", outcomeId: "outc_old", result: "satisfied", usage: usage(70, 7), processedAt: at(6) },
  ];
}
const EARLIER_TOKENS = 1200 + 340 + 55 + 77;
const EARLIER_CHILD_TURNS = 1;

async function limitsOf(node: TracePlane, sessionId: string): Promise<Limits> {
  const response = await node.api(`/v1/sessions/${sessionId}`);
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json() as { _oma?: { limits?: Limits } };
  expect(body._oma?.limits, "GET /v1/sessions/:id carries _oma.limits").toBeDefined();
  return body._oma!.limits!;
}

/** Every logged event of the session, all threads, read from SQL. */
async function loggedEvents(node: TracePlane, workspaceId: string, sessionId: string): Promise<SessionEventView[]> {
  const rows = await node.sql
    .prepare("SELECT document FROM managed_session_events WHERE workspace_id = ? AND session_id = ? ORDER BY processed_at, id")
    .bind(workspaceId, sessionId)
    .all<{ document: string }>();
  return (rows.results ?? []).map((row) => decodeSessionEventDocument(row.document).event as SessionEventView);
}

function tokensIn(events: SessionEventView[]): number {
  let total = 0;
  for (const event of events) {
    if (event.type === "span.model_request_end") total += event.modelUsage.inputTokens + event.modelUsage.outputTokens;
    if (event.type === "span.outcome_evaluation_end") total += event.usage.inputTokens + event.usage.outputTokens;
  }
  return total;
}

async function runTurn(node: TracePlane, workspaceId: string, sessionId: string, text: string): Promise<void> {
  const idle = async () => (await node.sql
    .prepare("SELECT COUNT(*) AS n FROM managed_session_events WHERE workspace_id = ? AND session_id = ? AND type = 'session.status_idle'")
    .bind(workspaceId, sessionId)
    .first<{ n: number }>())!.n;
  const before = Number(await idle());
  await node.post(`/v1/sessions/${sessionId}/events`, {
    events: [{ type: "user.message", content: [{ type: "text", text }] }],
  });
  await waitFor("the idle turn", async () => Number(await idle()) > before ? true : null);
}

describe("session limits count the work of every thread (plan multiagent 3.Б, slice 1)", () => {
  it("two turns, a subagent turn and the earlier log add up in one row", async () => {
    const node = plane!;
    const { sessionId, workspaceId, checkerId } = await createCoordinatorSession(node);
    await seed(node, workspaceId, sessionId, earlierWork());

    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(`call_agent_${checkerId.replace(/[^a-zA-Z0-9_]/g, "_")}`, { message: "Check the invoice" }, { id: "toolu_limits_delegate" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("The invoice is fine."),
      fauxAssistantMessage("The checker says the invoice is fine."),
    ]);
    await runTurn(node, workspaceId, sessionId, "Check the invoice");

    const afterFirst = await loggedEvents(node, workspaceId, sessionId);
    const childThreads = new Set(afterFirst.flatMap((event) =>
      event.type === "session.thread_status_running" && event.sessionThreadId !== "sthr_old_child" && event.sessionThreadId !== "sthr_old_advisor"
        ? [event.sessionThreadId] : []));
    expect(childThreads.size, "the checker ran in its own thread").toBe(1);
    const [childThread] = [...childThreads];
    const childRequests = afterFirst.filter((event) => event.type === "span.model_request_end" && event.sessionThreadId === childThread);
    expect(childRequests.length, "the checker asked the model").toBeGreaterThan(0);
    expect(tokensIn(childRequests)).toBeGreaterThan(0);

    const first = await limitsOf(node, sessionId);
    expect(first).toMatchObject({
      used_tokens: tokensIn(afterFirst),
      used_child_turns: EARLIER_CHILD_TURNS + 1,
    });
    expect(first.used_tokens).toBeGreaterThan(EARLIER_TOKENS);

    faux.setResponses([fauxAssistantMessage("Nothing else to check.")]);
    await runTurn(node, workspaceId, sessionId, "Anything else?");
    const afterSecond = await loggedEvents(node, workspaceId, sessionId);
    const second = await limitsOf(node, sessionId);
    expect(second).toMatchObject({
      used_tokens: tokensIn(afterSecond),
      used_child_turns: EARLIER_CHILD_TURNS + 1,
    });
    expect(second.used_tokens).toBeGreaterThan(first.used_tokens);
    expect(second.max_tokens).toBeGreaterThan(second.used_tokens);
    expect(second.max_child_turns).toBeGreaterThan(second.used_child_turns);

    const rows = await node.sql
      .prepare("SELECT COUNT(*) AS n FROM oma_session_limits WHERE workspace_id = ? AND session_id = ?")
      .bind(workspaceId, sessionId)
      .first<{ n: number }>();
    expect(Number(rows!.n)).toBe(1);
  }, 60_000);

  it("a Session that has not run since the counter came reads its row from the log", async () => {
    const node = plane!;
    const { sessionId, workspaceId } = await createCoordinatorSession(node);
    await seed(node, workspaceId, sessionId, earlierWork());

    expect(await limitsOf(node, sessionId)).toEqual({
      max_tokens: 1_000_000,
      max_child_turns: 20,
      used_tokens: EARLIER_TOKENS,
      used_child_turns: EARLIER_CHILD_TURNS,
    });

    // Delete takes the row along.
    const deleted = await node.api(`/v1/sessions/${sessionId}`, { method: "DELETE" });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    const rows = await node.sql
      .prepare("SELECT COUNT(*) AS n FROM oma_session_limits WHERE workspace_id = ? AND session_id = ?")
      .bind(workspaceId, sessionId)
      .first<{ n: number }>();
    expect(Number(rows!.n)).toBe(0);
  }, 60_000);
});

describe("a turn stops at the limit between requests (plan multiagent 3.Б, slice 2)", () => {
  it("Pi sends no request over the limit, and the session goes idle on budget_reached", async () => {
    const node = plane!;
    const { sessionId } = await createPiSession(node, { bashPolicy: "always_allow" });
    const row = await node.sql
      .prepare("SELECT workspace_id FROM managed_sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ workspace_id: string }>();
    // An earlier server spent one token less than the default limit of 1 000 000.
    await seed(node, row!.workspace_id, sessionId, [{
      id: "sevt_old_spent_end", type: "span.model_request_end", isError: false,
      modelRequestStartId: "sevt_old_spent_start", modelUsage: usage(999_000, 999),
      processedAt: "2026-10-01T12:00:00.000Z",
    }]);
    const message = (text: string) => [{ type: "user.message", content: [{ type: "text", text }] }];
    const fresh = (before: WireEvent[], after: WireEvent[]) => after.slice(before.length);
    const callsBefore = faux.state.callCount;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo LIMIT_OK" }, { id: "toolu_limit_bash" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("This answer must never be requested."),
    ]);

    const first = await runPiTurn(node, sessionId, message("Run echo"));

    expect(faux.state.callCount - callsBefore, "one request went out, the second stopped").toBe(1);
    const turn = first.filter((event) => event.id !== "sevt_old_spent_end");
    expect(turn.filter((event) => event.type === "agent.tool_result")).toHaveLength(1);
    expect(turn.filter((event) => event.type === "span.model_request_end")).toHaveLength(1);
    expect(turn.filter((event) => event.type === "span.model_request_start")).toHaveLength(1);
    expect(turn.filter((event) => event.type === "session.error" || event.type === "session.status_rescheduled")).toEqual([]);
    expect(turn.filter((event) => event.type === "agent.message")).toEqual([]);
    expect(first.at(-2)).toMatchObject({ type: "session.usage" });
    expect(first.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "budget_reached" } });
    expect((await limitsOf(node, sessionId)).used_tokens).toBeGreaterThanOrEqual(1_000_000);

    // A message at the limit is refused (slice 3): nothing reaches the log.
    faux.setResponses([fauxAssistantMessage("This answer must never be requested.")]);
    const refused = await node.api(`/v1/sessions/${sessionId}/events`, { body: { events: message("Anything else?") } });
    expect(refused.status, await refused.clone().text()).toBe(400);
    expect(faux.state.callCount - callsBefore).toBe(1);
    expect(await node.events(sessionId)).toHaveLength(first.length);
  }, 60_000);
});

interface CreatedSession {
  sessionId: string;
  workspaceId: string;
}

/** A Pi agent with bash on the given policy, and a session with its own limits. */
async function createLimitedSession(
  node: TracePlane,
  options: { bashPolicy: "always_allow" | "always_ask"; limits: Partial<Pick<Limits, "max_tokens" | "max_child_turns">> },
): Promise<CreatedSession> {
  const environment = await node.post("/v1/environments", {
    name: "limits",
    config: { type: "cloud", networking: { type: "unrestricted" }, packages: { type: "packages" } },
  });
  const agent = await node.post("/v1/agents", {
    name: "Limited agent",
    model: TRACE_MODEL,
    system: "Use bash when asked.",
    tools: [{
      type: "agent_toolset_20260401",
      configs: [{ name: "bash", permission_policy: { type: options.bashPolicy } }],
    }],
    _oma: { harness: "pi" },
  });
  const session = await node.post("/v1/sessions", {
    agent: { type: "agent", id: agent.id, version: agent.version },
    environment_id: environment.id,
    title: "limits",
    _oma: { limits: options.limits },
  });
  const row = await node.sql
    .prepare("SELECT workspace_id FROM managed_sessions WHERE id = ?")
    .bind(session.id)
    .first<{ workspace_id: string }>();
  return { sessionId: session.id as string, workspaceId: row!.workspace_id };
}

async function executionsOf(node: TracePlane, sessionId: string): Promise<{ id: string; state: string }[]> {
  const rows = await node.sql
    .prepare("SELECT id, state FROM managed_session_executions WHERE session_id = ? ORDER BY admitted_at_ms, id")
    .bind(sessionId)
    .all<{ id: string; state: string }>();
  return rows.results ?? [];
}

describe("events at the limit and the raise (plan multiagent 3.Б, slice 3)", () => {
  const message = (text: string) => ({ type: "user.message", content: [{ type: "text", text }] });
  const outcome = {
    type: "user.define_outcome",
    description: "The echo ran",
    rubric: { type: "text", content: "The output shows the echo." },
  };
  const idles = (events: WireEvent[]) => events.filter((event) => event.type === "session.status_idle").length;

  it("a waiting call goes on at the limit, new work waits for a raise, and the raise continues the turn", async () => {
    const node = plane!;
    const { sessionId } = await createLimitedSession(node, { bashPolicy: "always_ask", limits: { max_tokens: 1 } });
    expect(await limitsOf(node, sessionId)).toEqual({
      max_tokens: 1, max_child_turns: 20, used_tokens: 0, used_child_turns: 0,
    });
    const callsBefore = faux.state.callCount;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo RAISE_OK" }, { id: "toolu_raise_bash" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Done after the raise."),
    ]);

    // The first request goes out under the limit and asks for a confirmation.
    const first = await runPiTurn(node, sessionId, [message("Run echo")]);
    expect(faux.state.callCount - callsBefore).toBe(1);
    expect(first.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "requires_action" } });
    expect((await limitsOf(node, sessionId)).used_tokens).toBeGreaterThan(1);

    // New work is refused at the limit and leaves nothing in the log.
    for (const event of [message("Anything else?"), outcome]) {
      const refused = await node.api(`/v1/sessions/${sessionId}/events`, { body: { events: [event] } });
      const text = await refused.text();
      expect(refused.status, text).toBe(400);
      expect(text).toContain("user.tool_confirmation");
      expect(text).toContain("_oma.limits");
    }
    expect(await node.events(sessionId)).toHaveLength(first.length);

    // The confirmation is accepted: the call runs, the next request stops at the limit.
    const confirmed = await runPiTurn(node, sessionId, [
      { type: "user.tool_confirmation", tool_use_id: "toolu_raise_bash", result: "allow" },
    ]);
    expect(faux.state.callCount - callsBefore).toBe(1);
    const afterConfirmation = confirmed.slice(first.length);
    expect(afterConfirmation.filter((event) => event.type === "agent.tool_result")).toHaveLength(1);
    expect(afterConfirmation.filter((event) => event.type === "session.error")).toEqual([]);
    expect(confirmed.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "budget_reached" } });

    // A limit not above the work counted is refused and changes nothing.
    const used = (await limitsOf(node, sessionId)).used_tokens;
    const executionsBefore = await executionsOf(node, sessionId);
    const low = await node.api(`/v1/sessions/${sessionId}`, { body: { _oma: { limits: { max_tokens: used } } } });
    expect(low.status, await low.clone().text()).toBe(400);
    expect(await low.text()).toContain(String(used));
    expect((await limitsOf(node, sessionId)).max_tokens).toBe(1);
    expect(await executionsOf(node, sessionId)).toEqual(executionsBefore);

    // The raise continues the stopped turn without a new message. Two raises
    // at once queue one continuation.
    const raisedTo = used + 1_000_000;
    const raise = () => node.api(`/v1/sessions/${sessionId}`, { body: { _oma: { limits: { max_tokens: raisedTo } } } });
    for (const raised of await Promise.all([raise(), raise()])) {
      expect(raised.status, await raised.clone().text()).toBe(200);
      expect((await raised.json() as { _oma?: { limits?: Limits } })._oma?.limits)
        .toMatchObject({ max_tokens: raisedTo, max_child_turns: 20 });
    }
    const resumed = await waitFor("the continued turn", async () => {
      const events = await node.events(sessionId);
      return idles(events) > idles(confirmed) ? events : null;
    });
    expect(faux.state.callCount - callsBefore, "the stopped request went out once").toBe(2);
    const continued = resumed.slice(confirmed.length);
    expect(continued.map((event) => event.type)).not.toContain("user.message");
    expect(continued.filter((event) => event.type === "agent.message")).toHaveLength(1);
    expect(resumed.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
    expect((await executionsOf(node, sessionId)).length - executionsBefore.length, "one continuation").toBe(1);

    // A raise on a session that ended its turn starts nothing.
    const executionsAfter = await executionsOf(node, sessionId);
    const idle = await node.api(`/v1/sessions/${sessionId}`, { body: { _oma: { limits: { max_tokens: raisedTo * 2 } } } });
    expect(idle.status, await idle.clone().text()).toBe(200);
    expect(await executionsOf(node, sessionId)).toHaveLength(executionsAfter.length);
    expect((await limitsOf(node, sessionId)).max_tokens).toBe(raisedTo * 2);
  }, 60_000);

  it("a turn that went over the limit with its last request still ends; the next message stops before any request", async () => {
    const node = plane!;
    const { sessionId } = await createLimitedSession(node, { bashPolicy: "always_allow", limits: { max_tokens: 1 } });
    const callsBefore = faux.state.callCount;
    faux.setResponses([
      fauxAssistantMessage("Hello."),
      fauxAssistantMessage("This answer must never be requested."),
    ]);

    // The only request goes out under the limit and goes over it, as in CMA.
    const first = await runPiTurn(node, sessionId, [message("Hi")]);
    expect(faux.state.callCount - callsBefore).toBe(1);
    expect(first.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
    expect((await limitsOf(node, sessionId)).used_tokens).toBeGreaterThan(1);

    // The turn ended normally, so the message is taken: the limit stops the
    // turn before its request and the session shows budget_reached.
    const second = await runPiTurn(node, sessionId, [message("Hello again")]);
    expect(faux.state.callCount - callsBefore).toBe(1);
    expect(second.slice(first.length).map((event) => event.type)).toEqual([
      "user.message", "session.status_running", "session.usage", "session.status_idle",
    ]);
    expect(second.at(-1)).toMatchObject({ stop_reason: { type: "budget_reached" } });
    const refused = await node.api(`/v1/sessions/${sessionId}/events`, { body: { events: [message("Again")] } });
    expect(refused.status, await refused.clone().text()).toBe(400);
  }, 60_000);
});
