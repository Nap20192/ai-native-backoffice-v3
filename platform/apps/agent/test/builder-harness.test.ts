import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@open-managed-agents/shared";
import { buildTools, DEFAULT_TOOLS, getEnabledBuiltinTools, getToolPermission, disposeTools } from "../src/harness/tools";
import { emitHarnessToolUseFromCall } from "../src/harness/tool-events";

const disabled = { type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] };
const config = (tools: unknown[]): AgentConfig => ({ tools } as AgentConfig);
// A server without a toolset asks, so an executed MCP call needs an allowing
// toolset. The confirmed-call copy (allowAllLegacyHarnessTools) adds the same one.
const allowPlatform = { type: "mcp_toolset", mcp_server_name: "platform", default_config: { permission_policy: { type: "always_allow" } }, configs: [] };

describe("enabled builtins", () => {
  it("preserves defaults and first non-custom entry semantics", () => {
    expect([...getEnabledBuiltinTools([])]).toEqual(DEFAULT_TOOLS);
    expect([...getEnabledBuiltinTools([{ type: "mcp_toolset" }] as any)]).toEqual(DEFAULT_TOOLS);
    expect([...getEnabledBuiltinTools([disabled] as any)]).toEqual([]);
    expect([...getEnabledBuiltinTools([{ type: "agent_toolset_20260401", default_config: { enabled: false } }] as any)]).toEqual(DEFAULT_TOOLS);
    expect([...getEnabledBuiltinTools([{ type: "custom" }, disabled] as any)]).toEqual([]);
    expect([...getEnabledBuiltinTools([{ ...disabled, configs: [{ name: "browser", enabled: true }] }] as any)]).toEqual(["browser"]);
    expect([...getEnabledBuiltinTools([{ type: "mcp_toolset" }, disabled] as any)]).toEqual(DEFAULT_TOOLS);
    expect([...getEnabledBuiltinTools([{ ...disabled, configs: [{ name: "read", enabled: true }, { name: "unknown", enabled: true }] }] as any)]).toEqual(["read"]);
  });
  it("includes separately configured search providers", async () => {
    for (const type of ["web_search_ddg", "web_search_20250305", "web_search_tavily"]) {
      const agent = config([disabled, { type }]);
      expect([...getEnabledBuiltinTools(agent.tools)]).toEqual(["web_search"]);
    }
    const agent = config([disabled, { type: "web_search_ddg" }]);
    expect(Object.keys(await buildTools(agent, {} as any))).toEqual(["web_search"]);
  });
});

describe("MCP asks by default (plan cma-wave-1, 3.1)", () => {
  const iiko = { type: "url", name: "iiko", url: "https://iiko.test/mcp" };
  const withIiko = (tools: unknown[]) => ({ ...config(tools), mcp_servers: [iiko] } as AgentConfig);

  it("asks for a tool of a server that has no mcp_toolset", () => {
    expect(getToolPermission(withIiko([disabled]), "mcp__iiko__write_act")).toBe("always_ask");
  });

  it("asks when the mcp_toolset sets no policy, and keeps an explicit one", () => {
    const bare = { type: "mcp_toolset", mcp_server_name: "iiko" };
    expect(getToolPermission(withIiko([bare]), "mcp__iiko__write_act")).toBe("always_ask");
    const explicit = withIiko([{
      ...bare,
      default_config: { permission_policy: { type: "always_allow" } },
      configs: [{ name: "write_act", permission_policy: { type: "always_ask" } }],
    }]);
    expect(getToolPermission(explicit, "mcp__iiko__read_report")).toBe("always_allow");
    expect(getToolPermission(explicit, "mcp__iiko__write_act")).toBe("always_ask");
    expect(getToolPermission(config([]), "bash")).toBe("always_allow");
  });

  it("builds write_act of a server without a toolset as a pending call", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const mcp = await import("@open-managed-agents/mcp");
    vi.spyOn(mcp, "connectHttpMcpClient").mockResolvedValue({
      listTools: async () => [{ name: "write_act", inputSchema: { type: "object" } }],
      callTool, close: vi.fn(),
    });
    const tools = await buildTools(withIiko([disabled]), {} as any, { mcpBinding: { fetch: vi.fn() }, tenantId: "tenant", sessionId: "session" } as any);
    try {
      expect(tools.mcp__iiko__write_act).toBeDefined();
      expect(tools.mcp__iiko__write_act.execute).toBeUndefined();
      expect(callTool).not.toHaveBeenCalled();
    } finally {
      await disposeTools(tools);
      vi.restoreAllMocks();
    }
  });
});

it("marks pending MCP calls for confirmation and keeps server metadata", () => {
  const broadcast = vi.fn();
  for (const execute of [undefined, vi.fn()]) {
    emitHarnessToolUseFromCall({ broadcast } as any, {
      mcp__platform__send_message: { execute, metadata: { serverName: "platform", toolName: "send_message" } },
    }, "call-1", "mcp__platform__send_message", { text: "hello" });
    const event = broadcast.mock.calls.at(-1)![0];
    expect(event).toMatchObject({ type: "agent.mcp_tool_use", id: "call-1", mcp_server_name: "platform" });
    expect(event.evaluated_permission).toBe(execute ? undefined : "ask");
  }
});

it("passes the execution toolCallId to MCP, including confirmed calls", async () => {
  const callTool = vi.fn(async () => ({ content: [] }));
  const mcp = await import("@open-managed-agents/mcp");
  vi.spyOn(mcp, "connectHttpMcpClient").mockResolvedValue({
    listTools: async () => [{ name: "create_session", inputSchema: { type: "object" } }],
    callTool, close: vi.fn(),
  });
  const agent = { ...config([disabled, allowPlatform]), mcp_servers: [{ type: "url", name: "platform", url: "https://mcp.test" }] } as AgentConfig;
  const tools = await buildTools(agent, {} as any, { mcpBinding: { fetch: vi.fn() }, tenantId: "tenant", sessionId: "session" } as any);
  try {
    const signal = new AbortController().signal;
    await tools.mcp__platform__create_session.execute!({ title: "test" }, { toolCallId: "confirmed-1", messages: [], abortSignal: signal });
    expect(callTool).toHaveBeenCalledWith({ name: "create_session", arguments: { title: "test" }, _meta: { "oma/tool_use_id": "confirmed-1" } }, expect.objectContaining({ signal }));
  } finally {
    await disposeTools(tools);
    vi.restoreAllMocks();
  }
});

it("turns an MCP result with isError into a tool error, so the model and the event see the refusal", async () => {
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "Объект не найден. Проверь id через list" }], isError: true }));
  const mcp = await import("@open-managed-agents/mcp");
  vi.spyOn(mcp, "connectHttpMcpClient").mockResolvedValue({
    listTools: async () => [{ name: "get", inputSchema: { type: "object" } }],
    callTool, close: vi.fn(),
  });
  const agent = { ...config([disabled, allowPlatform]), mcp_servers: [{ type: "url", name: "platform", url: "https://mcp.test" }] } as AgentConfig;
  const tools = await buildTools(agent, {} as any, { mcpBinding: { fetch: vi.fn() }, tenantId: "tenant", sessionId: "session" } as any);
  try {
    const run = tools.mcp__platform__get.execute!({ kind: "agent", id: "x" }, { toolCallId: "call-2", messages: [], abortSignal: new AbortController().signal });
    await expect(run).rejects.toThrow("Объект не найден. Проверь id через list");
  } finally {
    await disposeTools(tools);
    vi.restoreAllMocks();
  }
});

it("reports a refused MCP server as a session.warning with a source, as the event contract wants", async () => {
  const mcp = await import("@open-managed-agents/mcp");
  vi.spyOn(mcp, "connectHttpMcpClient").mockRejectedValue(new Error("the server denied access (HTTP 403)"));
  const broadcastEvent = vi.fn();
  const agent = { ...config([disabled]), mcp_servers: [{ type: "url", name: "platform", url: "https://mcp.test" }] } as AgentConfig;
  const tools = await buildTools(agent, {} as any, { mcpBinding: { fetch: vi.fn() }, tenantId: "tenant", sessionId: "session", broadcastEvent } as any);
  try {
    expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "session.warning",
      source: "mcp_setup",
      message: expect.stringContaining('MCP setup failed for "platform"'),
    }));
  } finally {
    await disposeTools(tools);
    vi.restoreAllMocks();
  }
});
