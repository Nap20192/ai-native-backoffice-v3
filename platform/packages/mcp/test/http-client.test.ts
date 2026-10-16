import { expect, it } from "vitest";
import { connectHttpMcpClient } from "../src/http-client";

it("sends call metadata through the HTTP transport", async () => {
  const calls: Record<string, any>[] = [];
  const client = await connectHttpMcpClient({
    url: "https://mcp.test/rpc",
    clientInfo: { name: "test", version: "1" },
    versionNegotiation: "legacy",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json() as Record<string, any>;
      calls.push(body);
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
        : { content: [{ type: "text", text: "ok" }] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  try {
    await client.callTool({ name: "create_session", arguments: { title: "test" }, _meta: { "oma/tool_use_id": "call-1", other: 42 } });
    expect(calls.find(call => call.method === "tools/call")?.params).toMatchObject({
      name: "create_session", arguments: { title: "test" },
      _meta: { "oma/tool_use_id": "call-1", other: 42 },
    });
  } finally {
    await client.close();
  }
});
