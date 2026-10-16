// Tool set of an assistant session (builder-agent.md 3.2, 6.1 "состав сессии").

import { describe, expect, it } from "vitest";
import type { Session } from "@open-managed-agents/managed-agents-application";
import {
  SESSION_TOOLS_MESSAGE,
  checkAssistantToolSet,
  createSessionToolCheck,
} from "../src/lib/platform-mcp/session-tool-check";

const PLATFORM_URL = "http://127.0.0.1:8787/v1/oma/platform-mcp";

function templateSession(): Session {
  return {
    id: "sesn_assistant",
    agent: {
      id: "agent_builder",
      description: null,
      mcpServers: [{ name: "platform", type: "url", url: PLATFORM_URL }],
      model: { id: "qwen3.6-35b" },
      multiagent: null,
      name: "Помощник",
      skills: [],
      system: "Ты помощник",
      tools: [
        { type: "agent_toolset_20260401", configs: [], defaultConfig: { enabled: false, permissionPolicy: { type: "always_allow" } } },
        {
          type: "mcp_toolset",
          mcpServerName: "platform",
          configs: [{ name: "list", enabled: true, permissionPolicy: { type: "always_allow" } }],
          defaultConfig: { enabled: true, permissionPolicy: { type: "always_ask" } },
        },
      ],
      version: 4,
    },
    archivedAt: null,
    budget: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    environmentId: "env_builder",
    metadata: {},
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status: "idle",
    title: null,
    updatedAt: "2026-10-16T10:00:00.000Z",
    usage: {},
    vaultIds: [],
  };
}

type Mutate = (session: any) => void;

const [toolset, mcpToolset] = templateSession().agent.tools;

const broken: [string, Mutate][] = [
  ["tools is empty", (s) => (s.agent.tools = [])],
  ["tools has only mcp_toolset", (s) => (s.agent.tools = [mcpToolset])],
  ["mcp_toolset comes first", (s) => (s.agent.tools = [mcpToolset, toolset])],
  ["agent_toolset without default_config.enabled false", (s) => (s.agent.tools[0] = { ...toolset, defaultConfig: { enabled: true, permissionPolicy: { type: "always_allow" } } })],
  ["read is enabled", (s) => (s.agent.tools[0] = { ...toolset, configs: [{ name: "read", enabled: true, permissionPolicy: { type: "always_allow" } }] })],
  ["web_search_ddg entry", (s) => s.agent.tools.push({ type: "web_search_ddg" })],
  ["custom tool", (s) => s.agent.tools.push({ type: "custom", name: "x", description: "x", inputSchema: { type: "object" } })],
  ["callable agents", (s) => (s.agent.multiagent = { type: "coordinator", agents: [{ type: "agent", id: "agent_2", version: 1 }] })],
  ["enable_general_subagent", (s) => (s.agent.openma = { enableGeneralSubagent: true })],
  ["second MCP server", (s) => s.agent.mcpServers.push({ name: "linear", type: "url", url: "https://mcp.linear.app" })],
  ["the platform server at another URL", (s) => (s.agent.mcpServers[0].url = "https://evil.test/v1/oma/platform-mcp")],
  ["a stdio platform server", (s) => (s.agent.mcpServers[0] = { name: "platform", type: "stdio", command: "sh" })],
  ["the toolset names another server", (s) => (s.agent.tools[1] = { ...mcpToolset, mcpServerName: "linear" })],
  ["a skill", (s) => s.agent.skills.push({ type: "custom", skillId: "skill_1", version: "1" })],
  ["a memory_store resource", (s) => s.resources.push({ id: "res_1", type: "memory_store", memoryStoreId: "ms_1", access: "read_write", instructions: null, createdAt: "", updatedAt: "" })],
  ["a file resource", (s) => s.resources.push({ id: "res_2", type: "file", fileId: "file_1", mountPath: "/mnt/f", createdAt: "", updatedAt: "" })],
  ["vault_ids", (s) => (s.vaultIds = ["vlt_1"])],
  ["an ACP agent", (s) => (s.agent.openma = { acp: { agent: { command: "claude-code-acp" } } })],
  ["an archived session", (s) => (s.archivedAt = "2026-10-16T11:00:00.000Z")],
];

describe("checkAssistantToolSet", () => {
  it("passes the template tool set", () => {
    expect(checkAssistantToolSet(templateSession(), PLATFORM_URL)).toEqual({ ok: true });
  });

  it("ignores a trailing slash in the platform URL", () => {
    const session = templateSession();
    (session.agent.mcpServers[0] as { url: string }).url = `${PLATFORM_URL}/`;
    expect(checkAssistantToolSet(session, PLATFORM_URL)).toEqual({ ok: true });
  });

  it.each(broken)("refuses when %s", (_name, mutate) => {
    const session = templateSession();
    mutate(session);
    expect(checkAssistantToolSet(session, PLATFORM_URL)).toEqual({ ok: false, message: SESSION_TOOLS_MESSAGE });
  });
});

describe("createSessionToolCheck", () => {
  it("reads the session on every check, so a later edit of tools drops the platform", async () => {
    let session: Session | null = templateSession();
    const check = createSessionToolCheck({ platformMcpUrl: PLATFORM_URL, loadSession: async () => session });
    expect(await check.check("ws_1", "sesn_assistant")).toEqual({ ok: true });
    session = templateSession();
    session.agent.tools[0] = { type: "agent_toolset_20260401", configs: [], defaultConfig: { enabled: true, permissionPolicy: { type: "always_allow" } } };
    expect(await check.check("ws_1", "sesn_assistant")).toEqual({ ok: false, message: SESSION_TOOLS_MESSAGE });
    session = null;
    expect((await check.check("ws_1", "sesn_assistant")).ok).toBe(false);
  });
});
