import { describe, expect, it } from "vitest";
import { allRouteRules, DRAFT_SET, defaultPolicy, routeAllowlist, TOOL_TABLE } from "../src/lib/platform-mcp/tool-table";

const FORBIDDEN: [string, string][] = [
  ["GET", "/v1/oma/model_cards/mc_1/key"],
  ["POST", "/v1/tunnels/tun_1/reveal_token"],
  ["POST", "/v1/vaults/vlt_1/credentials"],
  ["POST", "/v1/vaults/vlt_1/credentials/cred_1"],
  ["POST", "/v1/oma/model_cards"],
  ["POST", "/v1/oma/harness_cards"],
  ["GET", "/v1/oma/api_keys"],
  ["POST", "/v1/oma/api_keys"],
  ["GET", "/v1/oma/me/cli-tokens"],
  ["POST", "/v1/oma/tenants/ws_1/members"],
  ["GET", "/v1/oma/tenants"],
  ["GET", "/v1/oma/platform-mcp/settings"],
  ["POST", "/v1/oma/platform-mcp/settings"],
  ["POST", "/v1/oma/sessions/sesn_1/exec"],
  ["GET", "/metrics"],
  ["GET", "/v1/oma/internal/x"],
  ["POST", "/v1/oma/mcp-proxy/sesn_1/platform"],
  ["GET", "/v1/environments/env_1/work"],
  ["POST", "/v1/oma/platform-mcp/preview"],
  ["POST", "/v1/oma/platform-mcp/confirm"],
  ["POST", "/v1/oma/platform-mcp"],
  // second version
  ["POST", "/v1/sessions/sesn_1"],
  ["POST", "/v1/sessions/sesn_1/resources"],
  ["POST", "/v1/sessions/sesn_1/resources/res_1"],
  ["POST", "/v1/sessions/sesn_1/archive"],
  ["DELETE", "/v1/sessions/sesn_1"],
  ["POST", "/v1/deployments/depl_1/run"],
  ["POST", "/v1/deployments/depl_1/pause"],
  ["POST", "/v1/deployments/depl_1/unpause"],
  ["POST", "/v1/deployments/depl_1/archive"],
  ["POST", "/v1/agents/agent_1/archive"],
  ["POST", "/v1/environments/env_1/archive"],
  ["DELETE", "/v1/environments/env_1"],
  ["POST", "/v1/memory_stores/ms_1/archive"],
  ["DELETE", "/v1/memory_stores/ms_1/memories/mem_1"],
  ["DELETE", "/v1/skills/skill_1"],
  ["DELETE", "/v1/files/file_1"],
  ["DELETE", "/v1/oma/harness_cards/hc_1"],
  ["POST", "/v1/oma/evals/runs"],
  ["POST", "/v1/oma/skill-sources/install"],
];

describe("platform MCP tool table", () => {
  it("has 28 tools: 9 reads, 1 draft and 18 writes", () => {
    const groups = [...TOOL_TABLE.values()].map((tool) => tool.group);
    expect(TOOL_TABLE.size).toBe(28);
    expect(groups.filter((group) => group === "read")).toHaveLength(9);
    expect(groups.filter((group) => group === "draft")).toHaveLength(1);
    expect(groups.filter((group) => group === "write" || group === "batch")).toHaveLength(18);
  });

  it("allows exactly the 10 read and draft tools without asking", () => {
    const allow = [...TOOL_TABLE.values()].filter((tool) => defaultPolicy(tool) === "always_allow").map((tool) => tool.name);
    expect(allow.sort()).toEqual(
      ["help", "search_docs", "search_config", "list", "get", "read_content", "get_session_events", "get_trajectory", "request_secret", "preview_change"].sort(),
    );
    for (const name of DRAFT_SET) expect(TOOL_TABLE.has(name)).toBe(true);
  });

  it("gives every write a precondition, an operation and routes", () => {
    for (const tool of TOOL_TABLE.values()) {
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      if (tool.group === "write") {
        expect(tool.op, tool.name).toBeDefined();
        expect(tool.precondition, tool.name).not.toBeNull();
        expect(tool.routes.length, tool.name).toBeGreaterThan(0);
      }
    }
    const existing = ["update_agent", "restore_agent_version", "update_environment", "create_skill_version", "update_memory_store", "update_deployment", "update_model_card", "update_harness_card", "send_message", "write_memory"];
    for (const name of existing) expect(TOOL_TABLE.get(name)?.precondition, name).not.toBe("new_object");
    expect(TOOL_TABLE.get("update_agent")?.precondition).toBe("version_in_body");
    expect(TOOL_TABLE.get("write_memory")?.precondition).toBe("content_sha256_or_new_path");
    expect(TOOL_TABLE.get("send_message")?.precondition).toBe("if_match");
  });

  it("keeps every forbidden and second-version route out of the allowlist", () => {
    for (const [method, path] of FORBIDDEN) expect(routeAllowlist.match(method, path), `${method} ${path}`).toBeNull();
    expect(allRouteRules().every((rule) => rule.method === "GET" || rule.method === "POST")).toBe(true);
  });

  it("checks the body of five routes", () => {
    const checks = Object.fromEntries(allRouteRules().filter((rule) => rule.bodyCheck).map((rule) => [`${rule.method} ${rule.pattern}`, rule.bodyCheck]));
    expect(checks).toEqual({
      "POST /v1/deployments": "deployment_paused",
      "POST /v1/oma/model_cards/:id": "model_card_safe",
      "POST /v1/oma/harness_cards/:id": "harness_card_safe",
      "POST /v1/sessions": "session_create",
      "POST /v1/sessions/:id/events": "session_event",
    });
  });

  it("refuses bodies against the checks", () => {
    const headers = new Headers();
    const withIfMatch = new Headers({ "if-match": '"3"' });
    const handler = { issuer: "handler" as const, headers };
    const rule = (method: string, path: string) => routeAllowlist.match(method, path)!;
    const deny = (method: string, path: string, body: unknown, context = handler) =>
      expect(routeAllowlist.checkBody(rule(method, path), body, context).ok, JSON.stringify(body)).toBe(false);
    const pass = (method: string, path: string, body: unknown, context = handler) =>
      expect(routeAllowlist.checkBody(rule(method, path), body, context).ok, JSON.stringify(body)).toBe(true);

    deny("POST", "/v1/deployments", { name: "x" });
    pass("POST", "/v1/deployments", { name: "x", _oma: { paused: true } });
    deny("POST", "/v1/oma/model_cards/mc_1", { base_url: "https://evil.example.com" });
    deny("POST", "/v1/oma/model_cards/mc_1", { api_key: "k" });
    pass("POST", "/v1/oma/model_cards/mc_1", { model: "qwen" });
    deny("POST", "/v1/oma/harness_cards/hc_1", { command: "rm" });
    pass("POST", "/v1/oma/harness_cards/hc_1", { name: "n", install: { npm: [] } });

    const session = { agent: { type: "agent", id: "a", version: 2 }, environment_id: "e", metadata: { oma_created_via: "assistant" } };
    pass("POST", "/v1/sessions", session);
    deny("POST", "/v1/sessions", { ...session, initial_events: [] });
    deny("POST", "/v1/sessions", { ...session, budget: {} });
    deny("POST", "/v1/sessions", { ...session, vault_ids: ["v"] });
    deny("POST", "/v1/sessions", { ...session, resources: [{ type: "github_repository", url: "u", authorization_token: "t" }] });
    deny("POST", "/v1/sessions", { ...session, agent: { type: "agent_with_overrides", id: "a", version: 2 } });
    deny("POST", "/v1/sessions", { ...session, agent: { type: "agent", id: "a" } });
    deny("POST", "/v1/sessions", { ...session, metadata: { other: "x" } });

    const events = "/v1/sessions/sesn_1/events";
    const message = { type: "user.message", content: [{ type: "text", text: "Привет" }] };
    pass("POST", events, { events: [message] }, { issuer: "handler", headers: withIfMatch });
    deny("POST", events, { events: [message] });
    deny("POST", events, { events: [message, message] }, { issuer: "handler", headers: withIfMatch });
    for (const event of [
      { type: "user.interrupt" },
      { type: "user.define_outcome", description: "d", rubric: { type: "text", content: "r" } },
      { type: "system.message", content: [{ type: "text", text: "x" }] },
      { type: "user.message", content: [{ type: "image", source: { type: "url", url: "u" } }] },
      { type: "user.tool_confirmation", result: "allow", tool_use_id: "t1" },
    ]) {
      deny("POST", events, { events: [event] }, { issuer: "handler", headers: withIfMatch });
    }
    const confirm = { type: "user.tool_confirmation", result: "allow", tool_use_id: "t1" };
    pass("POST", events, { events: [confirm] }, { issuer: "confirm", headers, toolUseId: "t1" } as never);
    deny("POST", events, { events: [confirm] }, { issuer: "confirm", headers, toolUseId: "t2" } as never);
    deny("POST", events, { events: [message] }, { issuer: "confirm", headers: withIfMatch, toolUseId: "t1" } as never);
    deny("GET", "/v1/agents", null, { issuer: "confirm", headers } as never);
  });
});
