// Wiring of the platform MCP server in main-node (builder-agent.md, BS3):
// PLATFORM_MCP_URL in the config, the adapter of the BX2 helpers to the
// ports of BS1, the API shape of the known-secret sources and the runner
// rule for calls that still wait for a confirmation.

import { describe, expect, it } from "vitest";
import { loadNodeConfig, NodeConfigError } from "../src/config";
import { createPlatformMcpLibs, apiShape, contractSchemas } from "../src/lib/platform-mcp/node-wiring";
import { secretValuesOf } from "../src/lib/platform-mcp/known-secrets";
import { pendingConfirmations } from "../src/lib/node-managed-stop-reason";

const base = { NODE_ENV: "test", AUTH_DISABLED: "1" };

describe("PLATFORM_MCP_URL", () => {
  it("defaults to the public address of the server", () => {
    expect(loadNodeConfig({ ...base, PUBLIC_BASE_URL: "https://oma.example/" }).platformMcp.url).toBe("https://oma.example/v1/oma/platform-mcp");
    expect(loadNodeConfig(base).platformMcp.url).toBe("http://localhost:8787/v1/oma/platform-mcp");
  });

  it("takes an explicit value with the endpoint path", () => {
    expect(loadNodeConfig({ ...base, PLATFORM_MCP_URL: "http://127.0.0.1:8788/v1/oma/platform-mcp" }).platformMcp.url)
      .toBe("http://127.0.0.1:8788/v1/oma/platform-mcp");
  });

  it("refuses another path or a broken address", () => {
    expect(() => loadNodeConfig({ ...base, PLATFORM_MCP_URL: "http://127.0.0.1:8788/mcp" })).toThrow(NodeConfigError);
    expect(() => loadNodeConfig({ ...base, PLATFORM_MCP_URL: "not a url" })).toThrow(NodeConfigError);
  });
});

describe("helpers of BX2 behind the ports of BS1", () => {
  const libs = createPlatformMcpLibs([
    { name: "platform-reference.md", content: "# Окружение\n\nОкружение задаёт сеть и пакеты песочницы.\n" },
  ]);

  it("scan masks known values and key patterns and counts them", () => {
    const result = libs.scan("ключ sk-abcdefghijklmnop и пароль hunter2", ["hunter2"]);
    expect(result.text).not.toContain("hunter2");
    expect(result.text).not.toContain("sk-abcdefghijklmnop");
    expect(result.count).toBe(2);
  });

  it("hasKeyPattern finds well-known keys only", () => {
    expect(libs.hasKeyPattern("token ghp_abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(libs.hasKeyPattern("обычный промпт агента")).toBe(false);
  });

  it("yamlDiff compares two YAML texts, an empty before is all new", () => {
    expect(libs.yamlDiff("", "name: a\n")).toContain("+name: a");
    const diff = libs.yamlDiff("name: a\nmodel: m\n", "name: b\nmodel: m\n");
    expect(diff).toContain("-name: a");
    expect(diff).toContain("+name: b");
    expect(diff).not.toContain("-model: m");
    expect(libs.yamlDiff("name: a\n", "name: a\n")).toBe("");
  });

  it("checkSkill reads SKILL.md with its folder name", () => {
    const good = libs.checkSkill([{ path: "e2e-skill/SKILL.md", content: "---\nname: e2e-skill\ndescription: Делает отчёт. Use when asked for a report.\n---\n\nТело\n" }]);
    expect(good).toEqual({ ok: true, errors: [] });
    expect(libs.checkSkill([{ path: "notes.md", content: "x" }]).ok).toBe(false);
    expect(libs.checkSkill([{ path: "other/SKILL.md", content: "---\nname: e2e-skill\ndescription: x\n---\n" }]).ok).toBe(false);
  });

  it("searchDocs finds a section by a word of its text", () => {
    expect(libs.searchDocs("пакеты", 5)).toEqual([
      { document: "platform-reference.md", heading: "Окружение", text: "Окружение задаёт сеть и пакеты песочницы." },
    ]);
  });

  it("redactUrl and canonicalJson come from BX2", () => {
    expect(libs.redactUrl("https://u:p@mcp.example/x?k=v")).toEqual({ url: "https://mcp.example/x", secrets: expect.arrayContaining(["u", "p", "v"]) });
    expect(libs.canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("API shape of the known-secret sources", () => {
  it("turns stored camelCase documents into the snake_case paths of secret-fields.ts", () => {
    const agent = apiShape({
      mcpServers: [{ name: "x", url: "https://u:pw@mcp.example/?token=qtok", env: { API_KEY: "envkey", PLAIN: "plain" } }],
      openma: { acp: { agent: { env: { GITHUB_TOKEN: "acptok" } } } },
    });
    expect(secretValuesOf("agent", agent)).toEqual(expect.arrayContaining(["envkey", "acptok", "pw", "qtok"]));
    expect(secretValuesOf("agent", agent)).not.toContain("plain");
    const credential = apiShape({
      auth: { type: "mcp_oauth", accessToken: "acc", refresh: { refreshToken: "ref", tokenEndpointAuth: { clientSecret: "cs" } }, mcpServerUrl: "https://mcp.example" },
    });
    expect(secretValuesOf("credential", credential)).toEqual(expect.arrayContaining(["acc", "ref", "cs"]));
  });
});

describe("contract schemas for the tools", () => {
  it("validate the create and update bodies of every kind the tools check", () => {
    for (const kind of ["agent", "environment", "deployment", "memory", "memory_store"] as const) {
      expect(contractSchemas[kind]?.create, kind).toBeDefined();
      expect(contractSchemas[kind]?.update, kind).toBeDefined();
    }
    expect(contractSchemas.session?.create).toBeDefined();
    expect(contractSchemas.agent!.create!.safeParse({ name: "a", model: "m" }).success).toBe(true);
    expect(contractSchemas.agent!.create!.safeParse({ model: "m" }).success).toBe(false);
  });
});

describe("pendingConfirmations", () => {
  const ask = (id: string) => ({ type: "agent.mcp_tool_use", id, name: "mcp__platform__x", input: {}, evaluated_permission: "ask" });
  it("lists calls with ask and no result, so the runner does not resume the model", () => {
    expect(pendingConfirmations([ask("a"), ask("b"), { type: "agent.mcp_tool_result", mcp_tool_use_id: "a", content: [] }] as never)).toEqual(["b"]);
    expect(pendingConfirmations([ask("a"), { type: "agent.mcp_tool_result", mcp_tool_use_id: "a", content: [] }] as never)).toEqual([]);
  });
});
