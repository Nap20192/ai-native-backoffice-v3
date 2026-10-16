import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { toOtlpTraceExport, genaiSpanName, type OtlpKeyValue } from "../src/lib/trace/genai";
import { traceIdFor } from "../src/lib/trace/ids";
import { createTraceProjector } from "../src/lib/trace/projector";
import { createTraceStore } from "../src/lib/trace/store";
import type { TraceSpan } from "../src/lib/trace/types";
import { loadTraceFixture } from "./_helpers/trace-harness-conformance";

const attr = (attrs: OtlpKeyValue[], key: string) => attrs.find((item) => item.key === key)?.value;

async function piSpans(): Promise<{ sessionId: string; spans: TraceSpan[] }> {
  const fixture = loadTraceFixture("pi-turn-frames.json");
  const sql = await createBetterSqlite3SqlClient(":memory:");
  const store = createTraceStore({ sql, dialect: "sqlite" });
  const scope = { workspaceId: "ws", sessionId: fixture.scope.sessionId };
  const projector = createTraceProjector({ sessionId: scope.sessionId, harness: "pi" });
  for (const input of fixture.inputs) {
    const ops = projector.push(input.kind === "execution_started" ? { ...input, agentName: "documents" } : input);
    if (ops.length > 0) await store.apply(scope, { turnId: projector.turnId()!, attemptId: projector.attemptId(), ops });
  }
  return { sessionId: scope.sessionId, spans: await store.readSessionSpans(scope, null, 100) };
}

describe("gen_ai mapping of the trace export (plan 1.5)", () => {
  it("names spans by the gen_ai operation", async () => {
    const { spans } = await piSpans();
    const names = spans.map((span) => genaiSpanName(span));
    expect(names).toEqual(expect.arrayContaining([
      "invoke_agent documents",
      "chat Qwen/Qwen3.6-35B-A3B",
      "execute_tool bash",
      "oma.sandbox",
      "oma.tool_exec",
    ]));
  });

  it("exports one ExportTraceServiceRequest with the session trace id and Anthropic input totals", async () => {
    const { sessionId, spans } = await piSpans();
    const cached = spans.map((span) => span.kind === "model_call" && span.finish_reason === "toolUse"
      ? { ...span, usage: { input: 100, output: 7, cache_read: 900, cache_write: 50 } }
      : span);
    const request = toOtlpTraceExport(sessionId, cached);
    expect(request.resourceSpans).toHaveLength(1);
    const otlpSpans = request.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(otlpSpans).toHaveLength(spans.length);
    for (const span of otlpSpans) {
      expect(span.traceId).toBe(traceIdFor(sessionId));
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/u);
      expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
    }
    const chat = otlpSpans.find((span) => span.name === "chat Qwen/Qwen3.6-35B-A3B" && attr(span.attributes, "gen_ai.response.finish_reasons") !== undefined && attr(span.attributes, "gen_ai.usage.output_tokens")?.intValue === "7")!;
    expect(attr(chat.attributes, "gen_ai.operation.name")).toEqual({ stringValue: "chat" });
    expect(attr(chat.attributes, "gen_ai.request.model")).toEqual({ stringValue: "Qwen/Qwen3.6-35B-A3B" });
    expect(attr(chat.attributes, "gen_ai.usage.input_tokens")).toEqual({ intValue: "1050" });
    expect(attr(chat.attributes, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "900" });
    expect(attr(chat.attributes, "gen_ai.usage.cache_creation.input_tokens")).toEqual({ intValue: "50" });
    expect(attr(chat.attributes, "gen_ai.response.id")).toEqual({ stringValue: "chatcmpl-900a1bea9c88f225" });
    expect(attr(chat.attributes, "gen_ai.response.finish_reasons")).toEqual({ arrayValue: { values: [{ stringValue: "toolUse" }] } });
    expect(chat.kind).toBe(3);
    const turn = otlpSpans.find((span) => span.name === "invoke_agent documents")!;
    expect(turn.parentSpanId).toBe("");
    expect(attr(turn.attributes, "gen_ai.conversation.id")).toEqual({ stringValue: sessionId });
    expect(attr(turn.attributes, "oma.kind")).toEqual({ stringValue: "turn" });
    const tool = otlpSpans.find((span) => span.name === "execute_tool bash")!;
    expect(attr(tool.attributes, "gen_ai.tool.call.id")).toEqual({ stringValue: "chatcmpl-tool-ab6ba647636a85b4" });
    expect(attr(tool.attributes, "gen_ai.tool.type")).toEqual({ stringValue: "function" });
    const sandbox = otlpSpans.find((span) => span.name === "oma.sandbox")!;
    expect(sandbox.attributes.every((item) => item.key.startsWith("oma."))).toBe(true);
  });

  it("marks errors with status ERROR and error.type", async () => {
    const { sessionId, spans } = await piSpans();
    const failed = spans.map((span) => span.kind === "tool_call" ? { ...span, status: "error" as const, error: { type: "tool_error", message: "exit 127" } } : span);
    const tool = toOtlpTraceExport(sessionId, failed).resourceSpans[0]!.scopeSpans[0]!.spans.find((span) => span.name === "execute_tool bash")!;
    expect(tool.status).toEqual({ code: 2, message: "exit 127" });
    expect(attr(tool.attributes, "error.type")).toEqual({ stringValue: "tool_error" });
  });
});
