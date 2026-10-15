import { describe, expect, it } from "vitest";
import * as s from "./session-stats";

const base = 1_800_000_000_000;
const e = (type: string, id: string, ms = 0, fields: Record<string, unknown> = {}): s.SessionEvent =>
  ({ type, id, processed_at: new Date(base + ms).toISOString(), ...fields });
const usage = { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };

describe("event data", () => {
  it("reads timestamp fallbacks without sorting or mutating input", () => {
    expect(s.eventTimeMs(e("x", "a"))).toBe(base);
    expect(s.eventTimeMs({ type: "x", processed_at: "invalid", processed_at_ms: base })).toBe(base);
    expect(s.eventTimeMs({ type: "x", ts: base / 1000 })).toBe(base);
    expect(s.eventTimeMs({ type: "x", ts: base })).toBe(base);
    expect(s.eventTimeMs({ type: "x", ts: "invalid" })).toBeNull();
    const events = [e("x", "late", 10), e("x", "early", 0, { session_thread_id: "child" })];
    expect(s.eventsOfThread(events, s.PRIMARY_THREAD_ID)).toEqual([events[0]]);
    expect(s.eventThreadId(events[1])).toBe("child");
    expect(s.addUsage(s.ZERO_USAGE, { input: 20, output: 10, cacheRead: 3, cacheWrite: 2 })).toEqual({ input: 20, output: 10, cacheRead: 3, cacheWrite: 2 });
    expect(s.totalInput({ input: 20, output: 10, cacheRead: 3, cacheWrite: 2 })).toBe(25);
  });

  it("pairs requests by id across threads and keeps orphan starts and ends", () => {
    const events = [e("span.model_request_start", "a"), e("span.model_request_start", "b", 10),
      e("span.model_request_end", "c", 3600, { model_request_start_id: "a", model_usage: usage }),
      e("span.model_request_end", "d", 4000, { model_request_start_id: "absent", is_error: true })];
    const requests = s.collectModelRequests(events);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({ id: "a", startEventId: "a", endEventId: "c", durationMs: 3600, usage: { input: 20, output: 10, cacheRead: 3, cacheWrite: 2 } });
    expect(requests[1]).toMatchObject({ endEventId: null, durationMs: null });
    expect(requests[2]).toMatchObject({ id: "d", startEventId: null, isError: true });
  });

  it("frames model requests and leaves user and status events outside", () => {
    const events = [e("user.message", "u"), e("span.model_request_start", "s"), e("agent.thinking", "t"),
      e("span.model_request_end", "end"), e("agent.tool_use", "call"), e("session.status_idle", "idle"), e("agent.message", "m")];
    expect(s.groupEventsByRequest(events)).toEqual([
      { kind: "single", event: events[0] }, { kind: "request", id: "s", events: events.slice(1, 5) },
      { kind: "single", event: events[5] }, { kind: "single", event: events[6] },
    ]);
    expect(s.filterEvents(events, { mode: "all" })).toEqual(events);
    expect(s.filterEvents(events, { mode: "types", types: new Set(["agent.thinking"]) })).toEqual([events[2]]);
    expect(s.filterEvents(events, { mode: "transcript" }).map(x => x.id)).toEqual(["u", "t", "call", "m"]);
    expect(s.eventTypesPresent([events[2], events[0], events[2]])).toEqual(["agent.thinking", "user.message"]);
    expect(["agent", "user", "span", "session", "system", "other"].map(x => s.eventFamily(`${x}.x`))).toEqual(["agent", "user", "span", "session", "system", "other"]);
  });

  it("formats every supported preview and canonical JSON", () => {
    const events = [e("span.model_request_start", "start"), e("span.model_request_end", "end", 3600, { model_request_start_id: "start", model_usage: { input_tokens: 4, output_tokens: 139, cache_read_input_tokens: 20900 } }), e("agent.tool_use", "use", 1, { name: "edit", input: { file_path: "/x" } })];
    const index = s.buildEventIndex(events);
    expect(s.eventPreview(events[1], index)).toBe("3,6 с 4 вх. 139 вых. 20,9 тыс. кэш");
    for (const type of ["user.message", "agent.message"]) expect(s.eventPreview(e(type, "x", 0, { content: [{ type: "text", text: "first\nsecond" }] }), index)).toBe("first");
    expect(s.eventPreview(events[2], index)).toBe("edit /x");
    expect(s.eventPreview(e("agent.tool_result", "r", 0, { tool_use_id: "use", content: [{ type: "text", text: "File updated" }] }), index)).toBe("edit File updated");
    for (const suffix of ["start", "ongoing"]) expect(s.eventPreview(e(`span.outcome_evaluation_${suffix}`, "o", 0, { iteration: 1 }), index)).toBe("Итерация 2");
    expect(s.eventPreview(e("span.outcome_evaluation_end", "o", 0, { iteration: 1, result: "needs_revision" }), index)).toBe("нужна доработка, итерация 2");
    expect(s.eventPreview(e("session.thread_status_idle", "th", 0, { agent: { name: "Researcher" } }), index)).toBe("Researcher");
    expect(s.eventPreview(e("session.error", "err", 0, { error: { message: "boom" } }), index)).toBe("boom");
    expect(s.eventPreview(e("user.define_outcome", "o", 0, { description: "Report" }), index)).toBe("Report");
    expect(s.eventPreview(e("session.updated", "z"), index)).toBe("");
    const keys = { bash: "command", read: "file_path", write: "path", edit: "file_path", glob: "pattern", grep: "pattern", web_fetch: "url", web_search: "query" };
    for (const [name, key] of Object.entries(keys)) expect(s.toolInputPreview(name, { [key]: "value", extra: "ignored" })).toBe("value");
    expect(s.toolInputPreview("other", { n: 1 })).toBe('{"n":1}');
    expect(s.eventJson({ type: "x", ts: 1, processed_at: "date", z: { b: 1, a: [{ z: 2, a: 1 }] } })).toBe(JSON.stringify({ processed_at: "date", type: "x", z: { a: [{ a: 1, z: 2 }], b: 1 } }, null, 2));
  });
});

describe("tools", () => {
  it("reads enabled builtins, defaults, MCP and custom configuration", () => {
    const catalog = s.toolCatalogFromAgent([{ type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: "always_allow" }, configs: [{ name: "bash", enabled: true, permission_policy: "always_ask" }, { name: "read", enabled: false }] }, { type: "mcp_toolset", mcp_server_name: "server", configs: [{ name: "lookup", enabled: true, permission_policy: "always_ask" }] }, { type: "custom", name: "custom" }]);
    expect(catalog).toHaveLength(9);
    expect(catalog.find(x => x.name === "bash")?.permission).toBe("ask");
    expect(catalog.find(x => x.name === "read")).toBeUndefined();
    expect(catalog.find(x => x.name === "lookup")).toMatchObject({ kind: "mcp", mcpServerName: "server", permission: "ask" });
    expect(s.toolCatalogFromAgent(undefined)).toEqual([]);
  });

  it.each([
    ["agent.tool_use", "agent.tool_result", "tool_use_id", "builtin"],
    ["agent.mcp_tool_use", "agent.mcp_tool_result", "mcp_tool_use_id", "mcp"],
    ["agent.custom_tool_use", "user.custom_tool_result", "custom_tool_use_id", "custom"],
  ])("pairs %s with its result and confirmation", (use, result, field, kind) => {
    const calls = s.collectToolCalls([e("span.model_request_start", "req"), e(use, "u", 10, { name: "bash" }), e("user.tool_confirmation", "c", 110, { tool_use_id: "u", result: "allow" }), e(result, "r", 410, { [field]: "u", content: "done" })]);
    expect(calls[0]).toMatchObject({ kind, useEventId: "u", resultEventId: "r", confirmationEventId: "c", status: "completed", durationMs: 400, waitingMs: 100, output: "done", requestId: "req" });
  });

  it("distinguishes denied, interrupted, running and failed within each thread", () => {
    const calls = s.collectToolCalls([e("agent.tool_use", "d", 0, { name: "bash" }), e("user.tool_confirmation", "deny", 100, { tool_use_id: "d", result: "deny" }),
      e("agent.tool_use", "i", 200, { name: "bash" }), e("agent.tool_use", "live", 210, { name: "bash", session_thread_id: "child" }), e("user.interrupt", "stop", 300),
      e("agent.tool_use", "f", 400, { name: "bash" }), e("agent.tool_result", "err", 450, { tool_use_id: "f", is_error: true })]);
    expect(calls.map(x => x.status)).toEqual(["denied", "interrupted", "running", "failed"]);
    expect(calls[0].durationMs).toBeNull();
    expect(s.computeToolStats(calls, []).summary.time).toEqual({ totalMs: 250, executingMs: 150, waitingMs: 100 });
  });

  it("matches the reference table, median, zero rows and summary", () => {
    const events: s.SessionEvent[] = [];
    for (const [name, count, failed, duration] of [["bash", 6, false, 384], ["web_search", 5, true, 119], ["edit", 4, false, 1100], ["write", 1, false, 366], ["web_fetch", 1, true, 1000]] as const) {
      for (let i = 0; i < count; i++) events.push(e("agent.tool_use", `${name}${i}`, 0, { name }), e("agent.tool_result", `${name}${i}r`, duration, { tool_use_id: `${name}${i}`, is_error: failed }));
    }
    const catalog = s.toolCatalogFromAgent([{ type: "agent_toolset_20260401" }]);
    const { rows, summary } = s.computeToolStats(s.collectToolCalls(events), catalog);
    expect(summary).toMatchObject({ toolCount: 8, usedCount: 5, callCount: 17, counts: { failed: 6, completed: 11 } });
    expect(rows[0]).toMatchObject({ name: "bash", calls: 6, failed: 0, p50Ms: 384 });
    expect(rows[1]).toMatchObject({ name: "web_search", failed: 5, failedRatio: 1 });
    expect(rows.find(x => x.name === "read")).toMatchObject({ calls: 0, p50Ms: null, failedRatio: null });
    const even = s.collectToolCalls([e("agent.tool_use", "a", 0, { name: "x" }), e("agent.tool_result", "ar", 100, { tool_use_id: "a" }), e("agent.tool_use", "b", 0, { name: "x" }), e("agent.tool_result", "br", 300, { tool_use_id: "b" })]);
    expect(s.computeToolStats(even, []).rows[0].p50Ms).toBe(200);
  });

  it("includes confirmed waiting time while a tool is still running", () => {
    const calls = s.collectToolCalls([e("agent.tool_use", "a", 0, { name: "bash" }), e("user.tool_confirmation", "allow", 500, { tool_use_id: "a", result: "allow" })]);
    expect(s.computeToolStats(calls, []).summary.time).toEqual({ totalMs: 500, executingMs: 0, waitingMs: 500 });
  });
});

describe("totals, costs and transcript", () => {
  it("sums all requests, separates evaluations and closes active intervals", () => {
    const events = [e("session.status_running", "s"), e("session.status_running", "dup", 10), e("span.model_request_end", "a", 50, { model_usage: usage }), e("session.status_idle", "idle", 100),
      e("session.status_running", "s2", 200), e("span.model_request_end", "b", 250, { model_usage: usage, is_error: true }), e("span.outcome_evaluation_end", "ev", 300, { usage })];
    expect(s.computeSessionTotals(events, { nowMs: base + 400 })).toMatchObject({ activeMs: 300, requestCount: 2, erroredRequestCount: 1, usage: { input: 40, output: 20, cacheRead: 6, cacheWrite: 4 }, evaluationUsage: { input: 20, output: 10, cacheRead: 3, cacheWrite: 2 }, firstEventMs: base, lastEventMs: base + 300 });
    expect(s.computeSessionTotals([]).activeMs).toBe(0);
    const thread = events.map(x => ({ ...x, type: x.type.replace("session.status_", "session.thread_status_"), session_thread_id: "child" }));
    expect(s.computeThreadStats(thread, "child", base + 400)).toMatchObject({ activeMs: 300, contextTokens: 35, contextSeries: [{ atMs: base + 50, tokens: 35 }, { atMs: base + 250, tokens: 35 }] });
  });

  it("validates prices and budget and builds cumulative costs", () => {
    const price = s.priceFromModelCard({ pi_config: { cost: { input: 3, output: 15 } } });
    expect(price).toEqual({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
    expect(s.priceFromModelCard({ pi_config: { cost: { input: -1, output: 2 } } })).toBeNull();
    expect(s.priceFromModelCard(null)).toBeNull();
    expect(s.usageCostMicros({ input: 20, output: 10, cacheRead: 0, cacheWrite: 0 }, price!)).toBe(210);
    expect(s.budgetCents({ max_list_cost: { amount: "500", currency: "USD" } })).toBe(500);
    expect(s.budgetCents({ max_list_cost: { amount: "-5" } })).toBeNull();
    const requests = s.collectModelRequests([e("span.model_request_end", "a"), e("span.model_request_end", "b", 1)]);
    expect(s.buildCostSeries(requests, () => 210)).toEqual([{ atMs: base, eventId: "a", stepMicros: 210, cumulativeMicros: 210 }, { atMs: base + 1, eventId: "b", stepMicros: 210, cumulativeMicros: 420 }]);
    expect(s.buildCostSeries(requests, () => null)).toBeNull();
  });

  it("builds user, request, outcome, grading, gap, warning and error blocks and maps every event", () => {
    const events = [e("session.status_running", "status"), e("user.message", "u", 0, { content: "Hello", status: "pending", wakeup: true }),
      e("span.model_request_start", "req", 100), e("agent.thinking", "think", 2000), e("agent.message", "msg", 2100, { content: "Hi" }), e("agent.tool_use", "tool", 2200, { name: "read" }), e("agent.tool_result", "result", 2300, { tool_use_id: "tool" }), e("span.model_request_end", "end", 2400, { model_request_start_id: "req" }),
      e("user.define_outcome", "out", 2500, { outcome_id: "o", description: "Report", rubric: { type: "text", content: "Clear" }, max_iterations: 3 }),
      e("span.outcome_evaluation_start", "es", 2600, { outcome_id: "o", iteration: 0 }), e("span.outcome_evaluation_end", "ee", 2700, { outcome_id: "o", iteration: 0, result: "needs_revision", explanation: "Fix", usage }),
      e("span.outcome_evaluation_end", "ee2", 2800, { outcome_id: "o", iteration: 1, result: "satisfied" }), e("session.error", "err", 2_000_000, { error: { type: "bad", message: "boom", retry_status: "retrying" } }), e("session.warning", "warn", 2_000_001, { source: "agent", message: "Careful" })];
    const blocks = s.buildTranscriptBlocks(events, { previousEventMs: base - 2_000_000 });
    expect(blocks.map(x => x.kind)).toEqual(["gap", "user", "request", "outcome_defined", "grading", "grading", "gap", "error", "warning"]);
    expect(blocks[1]).toMatchObject({ status: "pending", wakeup: true, text: "Hello" });
    expect(blocks[2]).toMatchObject({ id: "req", thoughtMs: 1900, thinking: true, items: [{ kind: "text", text: "Hi" }, { kind: "tool", call: { useEventId: "tool" } }] });
    expect(blocks[4]).toMatchObject({ index: 0, count: 2, evaluation: { startEventId: "es", iteration: 0 } });
    expect(blocks[5]).toMatchObject({ index: 1, count: 2 });
    const map = s.blockIdByEventId(blocks, events);
    expect(map.size).toBe(events.length);
    expect(map.get("result")).toBe("req");
    expect(map.get("status")).toBe("u");
    expect(s.collectOutcomes(events)[0]).toMatchObject({ outcomeId: "o", evaluations: [{ endEventId: "ee" }, { endEventId: "ee2" }] });
  });

  it("keeps accounting events in their request and does not render status cards", () => {
    const events = [e("span.model_request_start", "start"), e("agent.message", "message", 1, { content: "Hi" }), e("session.usage", "usage", 2), e("user.message", "next", 3, { content: "Next" })];
    const blocks = s.buildTranscriptBlocks(events);
    expect(s.blockIdByEventId(blocks, events).get("usage")).toBe("start");
    expect(blocks.map(b => b.kind)).toEqual(["request", "user"]);
    expect(s.buildTranscriptBlocks([e("session.status_running", "status")])).toEqual([]);
  });
});
