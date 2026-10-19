import { describe, expect, it } from "vitest";
import { allRouteRules, DRAFT_SET, defaultPolicy, routeAllowlist, TOOL_TABLE } from "../src/lib/platform-mcp/tool-table";

const FORBIDDEN: [string, string][] = [
  ["GET", "/v1/oma/model_cards/mc_1/key"],
  ["POST", "/v1/tunnels/tun_1/reveal_token"],
  ["POST", "/v1/vaults/vlt_1/credentials"],
  ["POST", "/v1/vaults/vlt_1/credentials/cred_1"],
  ["POST", "/v1/oma/model_cards"],
  // Harness cards and the harness catalog are gone (D41).
  ["GET", "/v1/oma/harnesses"],
  ["GET", "/v1/oma/harness_cards"],
  ["GET", "/v1/oma/harness_cards/hc_1"],
  ["POST", "/v1/oma/harness_cards"],
  ["POST", "/v1/oma/harness_cards/hc_1"],
  ["POST", "/v1/oma/harness_cards/hc_1/archive"],
  ["DELETE", "/v1/oma/harness_cards/hc_1"],
  ["GET", "/v1/oma/dependencies/harness_card/hc_1"],
  ["GET", "/v1/oma/api_keys"],
  ["POST", "/v1/oma/api_keys"],
  // The route went away with the oma CLI on 2026-10-19; the entry stays as a guard.
  ["GET", "/v1/oma/me/cli-tokens"],
  ["POST", "/v1/oma/tenants/ws_1/members"],
  ["GET", "/v1/oma/tenants"],
  ["GET", "/v1/oma/platform-mcp/settings"],
  ["POST", "/v1/oma/platform-mcp/settings"],
  ["POST", "/v1/oma/sessions/sesn_1/exec"],
  // get_trajectory reads the trace now (cleanup.md 3.4): the legacy route and
  // the trace search and download stay closed.
  ["GET", "/v1/oma/sessions/sesn_1/trajectory"],
  ["GET", "/v1/oma/sessions/sesn_1/trace/search"],
  ["GET", "/v1/oma/sessions/sesn_1/trace/otlp.json"],
  ["GET", "/metrics"],
  ["GET", "/v1/oma/internal/x"],
  ["POST", "/v1/oma/mcp-proxy/sesn_1/platform"],
  ["GET", "/v1/environments/env_1/work"],
  ["POST", "/v1/oma/platform-mcp/preview"],
  ["POST", "/v1/oma/platform-mcp/confirm"],
  ["POST", "/v1/oma/platform-mcp"],
  // vaults, credentials, keys and members stay with the human (crud.md 3.3)
  ["DELETE", "/v1/vaults/vlt_1"],
  ["POST", "/v1/vaults/vlt_1/archive"],
  ["POST", "/v1/vaults/vlt_1/unarchive"],
  ["DELETE", "/v1/vaults/vlt_1/credentials/cred_1"],
  ["POST", "/v1/vaults/vlt_1/credentials/cred_1/archive"],
  ["GET", "/v1/oma/dependencies/vault/vlt_1"],
  ["DELETE", "/v1/oma/api_keys/key_1"],
  ["DELETE", "/v1/oma/tenants/ws_1/members/user_1"],
  // out of this plan
  ["POST", "/v1/sessions/sesn_1/resources/res_1"],
  ["POST", "/v1/sessions/sesn_1/threads/thr_1/archive"],
  ["DELETE", "/v1/deployments/depl_1"],
  ["POST", "/v1/vaults/vlt_1/credentials/cred_1/unarchive"],
  ["DELETE", "/v1/oma/agents/agent_1"],
  ["POST", "/v1/oma/evals/runs"],
  ["POST", "/v1/oma/skill-sources/install"],
];

describe("platform MCP tool table", () => {
  it("has 36 tools: 10 reads, 1 draft and 25 writes", () => {
    const groups = [...TOOL_TABLE.values()].map((tool) => tool.group);
    expect(TOOL_TABLE.size).toBe(36);
    expect(groups.filter((group) => group === "read")).toHaveLength(10);
    expect(groups.filter((group) => group === "draft")).toHaveLength(1);
    expect(groups.filter((group) => group === "write" || group === "batch")).toHaveLength(25);
  });

  it("allows exactly the 11 read and draft tools without asking", () => {
    const allow = [...TOOL_TABLE.values()].filter((tool) => defaultPolicy(tool) === "always_allow").map((tool) => tool.name);
    expect(allow.sort()).toEqual(
      ["help", "search_docs", "search_config", "list", "get", "read_content", "get_session_events", "get_trajectory", "request_secret", "get_dependencies", "preview_change"].sort(),
    );
    for (const name of DRAFT_SET) expect(TOOL_TABLE.has(name)).toBe(true);
  });

  it("tells the model that SKILL.md needs frontmatter with name and description", () => {
    // 2026-10-19: the assistant wrote a skill without frontmatter, the preview
    // refused it as invalid and the card could only be denied. The rule lived
    // only in help and the docs, which the model had not read.
    for (const name of ["create_skill", "create_skill_version"]) {
      const description = TOOL_TABLE.get(name)!.description;
      expect(description, name).toMatch(/frontmatter/);
      expect(description, name).toMatch(/name/);
      expect(description, name).toMatch(/description/);
    }
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
    const existing = ["update_agent", "restore_agent_version", "update_environment", "create_skill_version", "update_memory_store", "update_deployment", "update_model_card", "send_message", "write_memory"];
    for (const name of existing) expect(TOOL_TABLE.get(name)?.precondition, name).not.toBe("new_object");
    expect(TOOL_TABLE.has("update_harness_card")).toBe(false);
    expect(TOOL_TABLE.get("update_agent")?.precondition).toBe("version_in_body");
    expect(TOOL_TABLE.get("write_memory")?.precondition).toBe("content_sha256_or_new_path");
    expect(TOOL_TABLE.get("send_message")?.precondition).toBe("if_match");
  });

  it("keeps every forbidden route out of the allowlist", () => {
    for (const [method, path] of FORBIDDEN) expect(routeAllowlist.match(method, path), `${method} ${path}`).toBeNull();
    expect(routeAllowlist.match("GET", "/v1/oma/sessions/sesn_1/trace")?.pattern).toBe("/v1/oma/sessions/:id/trace");
    expect(allRouteRules().every((rule) => ["GET", "POST", "DELETE"].includes(rule.method))).toBe(true);
    expect(allRouteRules().some((rule) => rule.pattern.includes("vault") && rule.method !== "GET")).toBe(false);
  });

  it("checks the body or the headers of the writes", () => {
    const checks = Object.fromEntries(allRouteRules().filter((rule) => rule.bodyCheck).map((rule) => [`${rule.method} ${rule.pattern}`, rule.bodyCheck]));
    const ifMatch = [
      "POST /v1/agents/:id/archive",
      "DELETE /v1/agents/:id",
      "POST /v1/environments/:id/archive",
      "DELETE /v1/environments/:id",
      "POST /v1/sessions/:id/archive",
      "DELETE /v1/sessions/:id",
      "POST /v1/deployments/:id/archive",
      "DELETE /v1/skills/:id",
      "DELETE /v1/skills/:id/versions/:version",
      "POST /v1/memory_stores/:id/archive",
      "DELETE /v1/memory_stores/:id",
      "POST /v1/oma/model_cards/:id/archive",
      "DELETE /v1/oma/model_cards/:id",
    ];
    expect(checks).toEqual({
      "POST /v1/deployments": "deployment_paused",
      "POST /v1/oma/model_cards/:id": "model_card_safe",
      "POST /v1/sessions": "session_create",
      "POST /v1/sessions/:id/events": "session_event",
      "POST /v1/sessions/:id": "session_update",
      "POST /v1/sessions/:id/resources": "session_resource",
      ...Object.fromEntries(ifMatch.map((key) => [key, "if_match_required"])),
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

    pass("POST", "/v1/sessions/sesn_1", { title: "Разбор", metadata: { team: "a", old: null } });
    deny("POST", "/v1/sessions/sesn_1", { title: "x", agent: { tools: [] } });
    deny("POST", "/v1/sessions/sesn_1", { vault_ids: ["v"] });
    deny("POST", "/v1/sessions/sesn_1", { budget: null });
    deny("POST", "/v1/sessions/sesn_1", { metadata: { oma_assistant_session: "x" } });
    pass("POST", "/v1/sessions/sesn_1/resources", { type: "file", file_id: "file_1" });
    pass("POST", "/v1/sessions/sesn_1/resources", { type: "memory_store", memory_store_id: "ms_1" });
    deny("POST", "/v1/sessions/sesn_1/resources", { type: "github_repository", url: "u", authorization_token: "t" });
    deny("POST", "/v1/sessions/sesn_1/resources", { type: "file", file_id: "f", authorization_token: "t" });
    for (const [method, path] of [["DELETE", "/v1/agents/agent_1"], ["POST", "/v1/environments/env_1/archive"], ["DELETE", "/v1/oma/model_cards/mc_1"]]) {
      deny(method, path, null);
      pass(method, path, null, { issuer: "handler", headers: withIfMatch });
    }
    pass("DELETE", "/v1/files/file_1", null);
    pass("POST", "/v1/agents/agent_1/unarchive", {});
  });
});
