import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { connectHttpMcpClient } from "../../../packages/mcp/src/http-client";
import type { McpClientPort } from "../../../packages/mcp/src/port";
import { buildPlatformMcpRoutes, type PlatformMcpVariables } from "../src/lib/platform-mcp/routes";
import { createFakePlatform, WS, OWNER, ASSISTANT_SESSION } from "./helpers/platform-mcp-fake";

function mount(fake: ReturnType<typeof createFakePlatform>) {
  const app = new Hono<PlatformMcpVariables>();
  app.use("/v1/oma/platform-mcp/*", async (c, next) => {
    if (c.req.header("authorization") === "Bearer endpoint-token") {
      c.set("platform_mcp_actor", { workspaceId: WS, userId: OWNER, sessionId: ASSISTANT_SESSION });
    }
    await next();
  });
  app.route("/v1/oma/platform-mcp", buildPlatformMcpRoutes(fake.deps));
  return app;
}

let client: McpClientPort | null = null;
afterEach(async () => {
  await client?.close();
  client = null;
});

describe("platform MCP handler", () => {
  it("serves initialize, tools/list and tools/call to the real MCP client", async () => {
    const fake = createFakePlatform();
    fake.setupAssistant();
    fake.addAgent({ id: "agent_pr", name: "Сводка PR", system: "Пиши кратко" });
    const app = mount(fake);
    client = await connectHttpMcpClient({
      url: "http://node.internal/v1/oma/platform-mcp",
      clientInfo: { name: "test", version: "1" },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch,
      requestInit: { headers: { authorization: "Bearer endpoint-token" } },
    });
    const tools = await client.listTools();
    expect(tools).toHaveLength(28);
    expect(tools.find((tool) => tool.name === "get")?.inputSchema).toMatchObject({ type: "object" });
    const result = await client.callTool({ name: "get", arguments: { kind: "agent", id: "agent_pr" } });
    expect(result.isError).toBe(false);
    const text = (result.content as unknown as { text: string }[])[0].text;
    expect(JSON.parse(text)).toMatchObject({ kind: "agent", revision: "1", object: { name: "Сводка PR", system: "Пиши кратко" } });
    const missing = await client.callTool({ name: "get", arguments: { kind: "agent", id: "agent_none" } });
    expect(missing.isError).toBe(true);
    const bad = await client.callTool({ name: "get", arguments: { kind: "agent" } });
    expect(bad.isError).toBe(true);
    expect((bad.content as unknown as { text: string }[])[0].text).toContain("id");
  });

  it("answers 403 without the endpoint token and 405 to GET and DELETE", async () => {
    const fake = createFakePlatform();
    const app = mount(fake);
    const post = await app.request("/v1/oma/platform-mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect(post.status).toBe(403);
    expect((await app.request("/v1/oma/platform-mcp", { method: "GET" })).status).toBe(405);
    expect((await app.request("/v1/oma/platform-mcp", { method: "DELETE" })).status).toBe(405);
    const headers = { authorization: "Bearer endpoint-token", "content-type": "application/json" };
    const ping = await app.request("/v1/oma/platform-mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect((await ping.json()) as any).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const unknown = await app.request("/v1/oma/platform-mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" }) });
    expect(((await unknown.json()) as any).error.code).toBe(-32601);
    const note = await app.request("/v1/oma/platform-mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(note.status).toBe(202);
    expect(note.headers.get("mcp-session-id")).toBeNull();
    const parse = await app.request("/v1/oma/platform-mcp", { method: "POST", headers, body: "{" });
    expect(parse.status).toBe(400);
  });

  it("refuses every tool while the assistant is off but still lists tools", async () => {
    const fake = createFakePlatform();
    fake.setupAssistant();
    fake.setEnabled(false);
    const app = mount(fake);
    const headers = { authorization: "Bearer endpoint-token", "content-type": "application/json" };
    const list = await app.request("/v1/oma/platform-mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(((await list.json()) as any).result.tools).toHaveLength(28);
    const before = fake.calls.length;
    const call = await fake.call("list", { kind: "agents" });
    expect(call.isError).toBe(true);
    expect(call.text).toContain("Ассистент выключен");
    expect(fake.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([`GET /v1/sessions/${ASSISTANT_SESSION}`]);
    expect(fake.actionRows.at(-1)).toMatchObject({ tool: "list", result: "refused_disabled" });
    for (const tool of ((await (await app.request("/v1/oma/platform-mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) })).json()) as any).result.tools) {
      const start = fake.calls.length;
      const result = await fake.call(tool.name, {});
      expect(result.text, tool.name).toBe("Ассистент выключен в этом пространстве. Скажи пользователю, что включить его может владелец или администратор");
      expect(fake.calls.slice(start).every((c) => c.method === "GET" && c.path === `/v1/sessions/${ASSISTANT_SESSION}`), tool.name).toBe(true);
      expect(fake.actionRows.at(-1), tool.name).toMatchObject({ tool: tool.name, result: "refused_disabled" });
    }
    fake.setEnabled(true);
    expect((await fake.call("list", { kind: "agents" })).isError).toBeFalsy();
  });
});
