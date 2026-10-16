import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildSessionEventRoutes } from "@open-managed-agents/managed-agents-api";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { SessionEvent } from "@open-managed-agents/shared";
import { ManagedNodeHarnessRuntime } from "../src/lib/node-managed-harness-runtime";

describe("кадры Pi в публичном потоке", () => {
  it("сохраняет события модели и результат, скрывает замеры в истории и SSE", async () => {
    const output: unknown[] = [];
    let nextId = 0;
    const runtime = new ManagedNodeHarnessRuntime({
      initialEvents: [],
      events: [],
      sandbox: {} as SandboxExecutor,
      output: async (frame) => { output.push(frame); },
      clock: { now: () => new Date("2026-10-16T00:00:00.000Z") },
      ids: { nextEventId: () => `event-${++nextId}` },
    });
    const frames = [
      { id: "model-start", type: "span.model_request_start", model: "test-model", at_ms: 100 },
      { type: "span.model_first_token", model_request_start_id: "model-start", at_ms: 120 },
      {
        type: "span.model_request_end",
        model_request_start_id: "model-start",
        started_at_ms: 100,
        duration_ms: 40,
        at_ms: 140,
        model_usage: { input_tokens: 10, output_tokens: 2 },
        is_error: false,
      },
      { type: "span.tool_execution_start", tool_use_id: "tool-1", name: "echo", at_ms: 140 },
      { type: "span.tool_execution_end", tool_use_id: "tool-1", at_ms: 160, duration_ms: 20, is_error: false },
      {
        type: "agent.tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: "готово" }],
        is_error: false,
      },
    ];
    for (const frame of frames) runtime.broadcast(frame as SessionEvent);
    await runtime.drain();
    expect(output).toHaveLength(frames.length);
    expect(output).toEqual(frames.map((frame) => expect.objectContaining(frame)));

    const history = runtime.getApplicationHistoryEvents();
    expect(history.map((event) => event.type)).toEqual([
      "span.model_request_start",
      "span.model_request_end",
      "agent.tool_result",
    ]);
    const app = new Hono();
    app.route("/v1/sessions", buildSessionEventRoutes({
      sendSessionEvents: async () => ({ type: "accepted" }),
      listSessionEvents: async () => ({ type: "page", page: { events: history, nextCursor: null } }),
      streamSessionEvents: async () => ({
        type: "stream",
        events: (async function* () { yield* history; })(),
      }),
    }));
    const headers = { "anthropic-beta": "managed-agents-2026-04-01" };
    const response = await app.request("/v1/sessions/session-1/events", { headers });
    expect(response.status).toBe(200);
    const page = await response.json() as { data: Array<Record<string, unknown>> };
    expect(page.data.map((event) => event.type)).toEqual(history.map((event) => event.type));
    expect(page.data[0]).toEqual({
      id: "model-start",
      type: "span.model_request_start",
      processed_at: expect.any(String),
    });
    expect(page.data[1]).toEqual({
      id: expect.any(String),
      type: "span.model_request_end",
      model_request_start_id: "model-start",
      model_usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      is_error: false,
      processed_at: expect.any(String),
    });
    expect(page.data[2]).toEqual({
      id: expect.any(String),
      type: "agent.tool_result",
      tool_use_id: "tool-1",
      content: [{ type: "text", text: "готово" }],
      is_error: false,
      processed_at: expect.any(String),
    });

    const stream = await app.request("/v1/sessions/session-1/events/stream", { headers });
    expect(stream.status).toBe(200);
    const body = await stream.text();
    expect(body).toContain("span.model_request_start");
    expect(body).toContain("span.model_request_end");
    expect(body).toContain("agent.tool_result");
    for (const hidden of ["span.tool_execution_", "span.model_first_token", "at_ms", "started_at_ms", "duration_ms"]) {
      expect(body).not.toContain(hidden);
    }
  });
});
