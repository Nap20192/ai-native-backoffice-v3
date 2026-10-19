import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { ModelError, SessionLimitError, type SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import type { PiCompactionPolicy } from "../src/harness/pi-compaction";
import { PiSummaryCompactionPolicy } from "../src/harness/pi-compaction";
import { PiHarness } from "../src/harness/pi-loop";
import { createPiModelRuntime } from "../src/harness/pi-provider";
import { buildTools } from "../src/harness/tools";
import { TOOL_ASSEMBLY_WARNING_SOURCE } from "../src/harness/assembly/loaded-tools-state";
import { SKILL_ASSEMBLY_WARNING_SOURCE } from "../src/harness/assembly/loaded-skills-state";
import { CONTEXT_REASSEMBLED_WARNING_SOURCE } from "../src/harness/assembly/context-reassembled-state";

function makeContext(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);

  const events: SessionEvent[] = [
    { type: "user.message", content: [{ type: "text", text: "echo hello" }] },
  ];
  const streamCalls = {
    messageStarts: [] as string[],
    messageChunks: [] as Array<[string, string]>,
    messageEnds: [] as string[],
    thinkingStarts: [] as string[],
    thinkingEnds: [] as string[],
    toolStarts: [] as string[],
    toolEnds: [] as string[],
  };

  const runtime = {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox: {},
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: vi.fn(async (id: string) => void streamCalls.messageStarts.push(id)),
    broadcastChunk: vi.fn(async (id: string, delta: string) => void streamCalls.messageChunks.push([id, delta])),
    broadcastStreamEnd: vi.fn(async (id: string) => void streamCalls.messageEnds.push(id)),
    broadcastThinkingStart: vi.fn(async (id: string) => void streamCalls.thinkingStarts.push(id)),
    broadcastThinkingChunk: vi.fn(async () => undefined),
    broadcastThinkingEnd: vi.fn(async (id: string) => void streamCalls.thinkingEnds.push(id)),
    broadcastToolInputStart: vi.fn(async (id: string) => void streamCalls.toolStarts.push(id)),
    broadcastToolInputChunk: vi.fn(async () => undefined),
    broadcastToolInputEnd: vi.fn(async (id: string) => void streamCalls.toolEnds.push(id)),
    reportUsage: vi.fn(async () => undefined),
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;

  const echo = vi.fn(async ({ value }: { value: string }) => ({ echoed: value }));
  const ctx = {
    agent: { id: "agent-test", model: faux.getModel().id },
    userMessage: events[0],
    session_id: "session-test",
    tools: {
      echo: {
        description: "Echo a value",
        inputSchema: z.object({ value: z.string() }),
        execute: echo,
      },
    },
    model: {} as HarnessContext["model"],
    pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
    systemPrompt: "You are concise.",
    env: { ANTHROPIC_API_KEY: "unused" },
    runtime,
  } as unknown as HarnessContext;

  return { ctx, events, streamCalls, echo, faux };
}

describe("PiHarness", () => {
  describe("кадры трейса", () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    function capturePiEvents(): AgentEvent[] {
      const events: AgentEvent[] = [];
      const subscribe = Agent.prototype.subscribe;
      vi.spyOn(Agent.prototype, "subscribe").mockImplementation(function (listener) {
        return subscribe.call(this, (event) => {
          events.push(event);
          return listener(event);
        });
      });
      return events;
    }

    it.each(["stop", "error", "length"] as const)(
      "передаёт время Pi при завершении модели с %s",
      async (stopReason) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        const now = 1_800_000_000_000;
        vi.setSystemTime(now);
        const rawEvents = capturePiEvents();
        const message = fauxAssistantMessage(stopReason === "length" ? "" : "ответ", {
          stopReason,
          timestamp: now - 200,
          ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
        });
        message.durationMs = 137;
        const { ctx, events } = makeContext([message]);
        const run = new PiHarness({ compaction: {
          name: "disabled",
          shouldCompact: () => false,
          compact: async () => null,
        } }).run(ctx);
        if (stopReason === "stop") await run;
        else await expect(run).rejects.toThrow();

        const rawEnd = rawEvents.find((event) => event.type === "message_end"
          && event.message.role === "assistant");
        expect(rawEnd).toBeDefined();
        const assistant = rawEnd!.type === "message_end" ? rawEnd!.message : undefined;
        expect(events.find((event) => event.type === "span.model_request_start")).toMatchObject({ at_ms: now });
        if (stopReason === "stop") {
          expect(events.find((event) => event.type === "span.model_first_token")).toMatchObject({ at_ms: now });
        }
        expect(events.find((event) => event.type === "span.model_request_end")).toMatchObject({
          started_at_ms: assistant!.timestamp,
          duration_ms: (assistant as typeof message).durationMs,
          at_ms: now,
        });
      },
    );

    it("измеряет параллельные инструменты и передаёт ошибку до результата", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = 1_800_000_000_000;
      vi.setSystemTime(now);
      const rawEvents = capturePiEvents();
      const { ctx, events, echo } = makeContext([
        fauxAssistantMessage([
          fauxToolCall("echo", { value: "первый" }, { id: "tool-1" }),
          fauxToolCall("echo", { value: "второй" }, { id: "tool-2" }),
          fauxToolCall("mcp_docs_read", { value: "третий" }, { id: "tool-3" }),
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("готово"),
      ]);
      let entered = 0;
      let release!: () => void;
      const bothStarted = new Promise<void>((resolve) => { release = resolve; });
      echo.mockImplementation(async ({ value }) => {
        entered += 1;
        if (entered === 3) release();
        await bothStarted;
        vi.setSystemTime(now + 100);
        if (value === "второй") throw new Error("ошибка инструмента");
        return { echoed: value };
      });
      ctx.tools.mcp_docs_read = ctx.tools.echo;

      await new PiHarness().run(ctx);

      const frames = events as unknown as Array<Record<string, unknown>>;
      const starts = frames.filter((event) => event.type === "span.tool_execution_start");
      const ends = frames.filter((event) => event.type === "span.tool_execution_end");
      expect(starts).toHaveLength(3);
      expect(ends).toHaveLength(3);
      expect(Math.max(...starts.map((event) => frames.indexOf(event))))
        .toBeLessThan(Math.min(...ends.map((event) => frames.indexOf(event))));
      for (const [index, id] of ["tool-1", "tool-2", "tool-3"].entries()) {
        const start = starts.find((event) => event.tool_use_id === id)!;
        const end = ends.find((event) => event.tool_use_id === id)!;
        const piEnd = rawEvents.find((event) => event.type === "tool_execution_end" && event.toolCallId === id);
        expect(piEnd?.type).toBe("tool_execution_end");
        expect(start).toMatchObject({ name: index === 2 ? "mcp_docs_read" : "echo", at_ms: now });
        expect(end).toMatchObject({
          at_ms: now + 100,
          duration_ms: piEnd!.type === "tool_execution_end" ? piEnd!.durationMs : undefined,
          is_error: index === 1,
        });
        expect(end.duration_ms).toEqual(expect.any(Number));
        const result = frames.find((event) => (event.type === "agent.tool_result" || event.type === "agent.mcp_tool_result")
          && (event.tool_use_id === id || event.mcp_tool_use_id === id))!;
        expect(frames.indexOf(start)).toBeLessThan(frames.indexOf(end));
        expect(frames.indexOf(end)).toBeLessThan(frames.indexOf(result));
        expect(result).not.toHaveProperty("duration_ms");
      }
    });
  });

  it("keeps thinking off by default even when the model supports reasoning", async () => {
    const { ctx, faux } = makeContext([]);
    ctx.pi!.model = { ...ctx.pi!.model, reasoning: true };
    let reasoning: unknown = "not-called";
    faux.setResponses([
      (_context, options) => {
        reasoning = options?.reasoning;
        return fauxAssistantMessage("thinking stayed off");
      },
    ]);

    await new PiHarness().run(ctx);

    // Pi encodes the portable "off" level by omitting provider reasoning.
    expect(reasoning).toBeUndefined();
  });

  it("projects an explicit Managed Agents effort into Pi's thinking level", async () => {
    const { ctx, faux } = makeContext([]);
    ctx.pi!.model = { ...ctx.pi!.model, reasoning: true };
    ctx.agent.model = { id: ctx.pi!.model.id, effort: "high" };
    // Runtime construction owns normalization; the harness uses its result.
    ctx.pi!.thinkingLevel = createPiModelRuntime({
      model: ctx.agent.model.id,
      apiKey: "local-test-key",
      provider: "ant-compatible",
      baseURL: "https://model.example.test",
      piConfig: { reasoning: ctx.pi!.model.reasoning },
      thinkingLevel: ctx.agent.model.effort,
    }).thinkingLevel;
    let reasoning: unknown;
    faux.setResponses([
      (_context, options) => {
        reasoning = options?.reasoning;
        return fauxAssistantMessage("explicit effort applied");
      },
    ]);

    await new PiHarness().run(ctx);

    expect(reasoning).toBe("high");
  });

  it("runs an injected compaction policy and persists its canonical boundary before the turn", async () => {
    const { ctx, events, faux } = makeContext([fauxAssistantMessage("after compact")]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "older question" }] },
      { type: "agent.message", message_id: "older-answer", content: [{ type: "text", text: "older answer" }] },
      { type: "user.message", content: [{ type: "text", text: "follow-up" }] },
      { type: "agent.message", message_id: "follow-up-answer", content: [{ type: "text", text: "follow-up answer" }] },
    );

    const policy: PiCompactionPolicy = {
      name: "test-policy",
      shouldCompact: vi.fn(() => true),
      compact: vi.fn(async () => ({
        summary: [{ type: "text", text: "custom compacted summary" }],
        pre_tokens: 123,
        original_message_count: 5,
        compacted_message_count: 1,
      })),
    };
    let requestText = "";
    faux.setResponses([
      (context) => {
        requestText = JSON.stringify(context.messages);
        return fauxAssistantMessage("after compact");
      },
    ]);

    await new PiHarness({ compaction: policy }).run(ctx);

    expect(policy.shouldCompact).toHaveBeenCalledOnce();
    expect(policy.compact).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.thread_context_compacted",
      summary: [{ type: "text", text: "custom compacted summary" }],
      trigger: "auto",
      pre_tokens: 123,
    }));
    expect(requestText).toContain("<conversation-summary>");
    expect(requestText).toContain("custom compacted summary");
  });

  it("re-assembles loaded skills after compaction before the main Pi turn", async () => {
    const { ctx, events, faux } = makeContext([fauxAssistantMessage("after reassembly")]);
    ctx.skillMounts = [{
      skillId: "skill_compact",
      name: "Compact Skill",
      description: "demo",
      mountRoot: "/workspace/.openma/skills/skill_compact/latest/",
      body: "RETAINED_SKILL_BODY",
      source: "custom",
    }];
    events.unshift(
      {
        type: "session.warning",
        source: SKILL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded skill",
        details: { loadedSkillIds: ["skill_compact"] },
      },
      { type: "user.message", content: [{ type: "text", text: "older" }] },
      { type: "agent.message", message_id: "older", content: [{ type: "text", text: "older reply" }] },
    );

    const policy: PiCompactionPolicy = {
      name: "test-policy",
      shouldCompact: vi.fn(() => true),
      compact: vi.fn(async () => ({
        summary: [{ type: "text", text: "compacted summary" }],
        pre_tokens: 50,
        original_message_count: 4,
        compacted_message_count: 1,
      })),
    };

    faux.setResponses([fauxAssistantMessage("after reassembly")]);

    const assemblyProbe = vi.fn();
    const piAdapter = await import("../src/harness/assembly/adapters/pi");
    const createAssembly = piAdapter.createPiToolAssembly;
    const assemblySpy = vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
      const assembly = createAssembly(harnessCtx);
      assemblyProbe(assembly.systemPrompt);
      return assembly;
    });

    try {
      await new PiHarness({ compaction: policy }).run(ctx);
    } finally {
      assemblySpy.mockRestore();
    }

    expect(events).toContainEqual(expect.objectContaining({
      type: "session.warning",
      source: CONTEXT_REASSEMBLED_WARNING_SOURCE,
    }));
    const turnSystemPrompt = assemblyProbe.mock.calls[0]?.[0] as string;
    expect(turnSystemPrompt).toContain("RETAINED_SKILL_BODY");
    expect(turnSystemPrompt).toContain("<post-compaction-loaded-skills>");
  });

  it("uses Pi itself for the built-in summary and keeps compaction best-effort", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "a".repeat(200) }] },
      { type: "agent.message", message_id: "a1", content: [{ type: "text", text: "b".repeat(200) }] },
      { type: "user.message", content: [{ type: "text", text: "c".repeat(200) }] },
      { type: "agent.message", message_id: "a2", content: [{ type: "text", text: "d".repeat(200) }] },
    );
    ctx.agent.metadata = { compaction_trigger_fraction: 0.01 };
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 20_000 };

    let summaryTools: unknown;
    let summaryReasoning: unknown;
    let finalRequestText = "";
    faux.setResponses([
      (context, options) => {
        summaryTools = context.tools;
        summaryReasoning = options?.reasoning;
        return fauxAssistantMessage("built-in Pi summary");
      },
      (context) => {
        finalRequestText = JSON.stringify(context.messages);
        return fauxAssistantMessage("done after summary");
      },
    ]);

    await new PiHarness().run(ctx);

    expect(summaryTools ?? []).toEqual([]);
    expect(summaryReasoning).toBeUndefined();
    expect(finalRequestText).toContain("<conversation-summary>");
    expect(finalRequestText).toContain("built-in Pi summary");
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "done after summary" }],
    }));
  });

  it("continues the turn when a compaction policy fails", async () => {
    const { ctx, events } = makeContext([fauxAssistantMessage("still answered")]);
    const policy: PiCompactionPolicy = {
      name: "broken-policy",
      shouldCompact: () => true,
      compact: async () => {
        throw new Error("summarizer unavailable");
      },
    };

    await new PiHarness({ compaction: policy }).run(ctx);

    expect(events.some((event) => event.type === "agent.thread_context_compacted")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "still answered" }],
    }));
  });

  it("preserves fast speed and custom request options through a real Pi compaction request", async () => {
    const { ctx, events } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "first question" }] },
      { type: "agent.message", message_id: "first", content: [{ type: "text", text: "first answer" }] },
      { type: "user.message", content: [{ type: "text", text: "second question" }] },
      { type: "agent.message", message_id: "second", content: [{ type: "text", text: "second answer" }] },
    );
    ctx.pi = createPiModelRuntime({
      model: "claude-opus-5",
      provider: "ant-compatible",
      apiKey: "local-pi-compaction-key",
      baseURL: "https://tenant-model.example.test",
      speed: "fast",
    });
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      const text = requests.length === 1 ? "COMPACTION_DONE" : "TURN_DONE";
      const responseEvents = [
        { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", content: [], model: "claude-opus-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      return new Response(responseEvents.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const summary = new PiSummaryCompactionPolicy();
    const policy: PiCompactionPolicy = {
      name: "custom-summary-transport",
      shouldCompact: () => true,
      compact: (history, input) => {
        const inherited = input.requestOptions;
        return summary.compact(history, {
          ...input,
          requestOptions: {
            ...inherited,
            fetch: (request, init) => {
              const forwarded = new Request(request, init);
              forwarded.headers.set("x-compaction-transport", "custom");
              return (inherited?.fetch ?? globalThis.fetch)(forwarded);
            },
            onPayload: async (payload, model) => {
              const projected = (await inherited?.onPayload?.(payload, model)) ?? payload;
              if (typeof projected !== "object" || projected === null) throw new Error("Expected a model request");
              return { ...projected, metadata: { user_id: "custom-compaction-payload" } };
            },
          },
        });
      },
    };

    try {
      await new PiHarness({ compaction: policy }).run(ctx);

      expect(requests).toHaveLength(2);
      const [compaction, turn] = await Promise.all(requests.map(request => request.json()));
      expect(compaction).toMatchObject({ speed: "fast", metadata: { user_id: "custom-compaction-payload" }, max_tokens: 2_000 });
      expect(turn).toMatchObject({ speed: "fast" });
      expect(requests[0]!.headers.get("x-compaction-transport")).toBe("custom");
      for (const request of requests) {
        expect(new URL(request.url).pathname).toBe("/v1/messages");
        expect(request.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
      }
      expect(JSON.stringify(turn.messages)).toContain("COMPACTION_DONE");
      expect(events).toContainEqual(expect.objectContaining({ type: "agent.message", content: [{ type: "text", text: "TURN_DONE" }] }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("network failures of a model request", () => {
    // 2026-10-19: the LLM gateway closed one streaming request after 89 s with
    // undici's "terminated". The other 83 requests of those sessions took at
    // most 17 s, so a retry would have passed, but the whole turn died.
    const noCompaction = { name: "disabled", shouldCompact: () => false, compact: async () => null };
    const harness = () => new PiHarness({ compaction: noCompaction, transientRetryDelaysMs: [0, 0] });

    it("retries a request the connection dropped and finishes the turn", async () => {
      const { ctx, events, faux } = makeContext([
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "terminated" }),
        fauxAssistantMessage("ответ после повтора"),
      ]);

      await harness().run(ctx);

      expect(faux.state.callCount).toBe(2);
      expect(events).toContainEqual(expect.objectContaining({
        type: "agent.message",
        content: [{ type: "text", text: "ответ после повтора" }],
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: "session.warning",
        source: "oma.model_request_retry",
        details: expect.objectContaining({ attempt: 1, of: 2 }),
      }));
    });

    it("keeps the earlier tool work of the turn and retries only the failed request", async () => {
      const { ctx, events, faux, echo } = makeContext([
        fauxAssistantMessage([fauxToolCall("echo", { value: "раз" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "other side closed" }),
        fauxAssistantMessage("готово"),
      ]);

      await harness().run(ctx);

      expect(echo).toHaveBeenCalledTimes(1);
      expect(faux.state.callCount).toBe(3);
      expect(events).toContainEqual(expect.objectContaining({
        type: "agent.message",
        content: [{ type: "text", text: "готово" }],
      }));
    });

    it("gives up after two retries with the provider's own error", async () => {
      const { ctx, faux } = makeContext([
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "terminated" }),
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "terminated" }),
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "terminated" }),
      ]);

      await expect(harness().run(ctx)).rejects.toThrow("terminated");
      expect(faux.state.callCount).toBe(3);
    });

    it("does not retry a provider error that is not a network failure", async () => {
      const { ctx, events, faux } = makeContext([
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider failed" }),
        fauxAssistantMessage("не должно дойти"),
      ]);

      await expect(harness().run(ctx)).rejects.toThrow("provider failed");
      expect(faux.state.callCount).toBe(1);
      expect(events.some((event) => event.type === "session.warning" && event.source === "oma.model_request_retry")).toBe(false);
    });
  });

  it("does one forced compact-and-retry when Pi classifies a context overflow", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "old question 1" }] },
      { type: "agent.message", message_id: "old-answer-1", content: [{ type: "text", text: "old answer 1" }] },
      { type: "user.message", content: [{ type: "text", text: "old question 2" }] },
      { type: "agent.message", message_id: "old-answer-2", content: [{ type: "text", text: "old answer 2" }] },
    );
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 12000 tokens > 10000 maximum",
      }),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "prompt is too long: 12000 tokens > 10000 maximum",
      }),
      fauxAssistantMessage("overflow recovery summary"),
      fauxAssistantMessage("recovered answer"),
    ]);

    await new PiHarness().run(ctx);

    expect(faux.state.callCount).toBe(4);
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "recovered answer" }],
    }));
  });

  it("does one forced compact-and-retry on length-stop overflow with no deliverable output", async () => {
    const { ctx, events, faux } = makeContext([]);
    events.unshift(
      { type: "user.message", content: [{ type: "text", text: "old question 1" }] },
      { type: "agent.message", message_id: "old-answer-1", content: [{ type: "text", text: "old answer 1" }] },
      { type: "user.message", content: [{ type: "text", text: "old question 2" }] },
      { type: "agent.message", message_id: "old-answer-2", content: [{ type: "text", text: "old answer 2" }] },
    );
    const contextWindow = 8_192;
    ctx.pi!.model = { ...ctx.pi!.model, contextWindow };
    const lengthOverflow = fauxAssistantMessage([fauxThinking("partial plan")], {
      stopReason: "length",
      usage: {
        input: contextWindow,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: contextWindow,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    faux.setResponses([
      lengthOverflow,
      lengthOverflow,
      fauxAssistantMessage("length recovery summary"),
      fauxAssistantMessage("recovered after length"),
    ]);

    await new PiHarness().run(ctx);

    expect(faux.state.callCount).toBe(4);
    expect(events.some((event) => event.type === "agent.thinking")).toBe(false);
    expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.message",
      content: [{ type: "text", text: "recovered after length" }],
    }));
  });

  it("drives Pi's tool loop and emits canonical OpenMA events", async () => {
    const first = fauxAssistantMessage(
      [
        fauxThinking("I should call echo"),
        fauxToolCall("echo", { value: "hello" }, { id: "tool-echo" }),
      ],
      { stopReason: "toolUse", responseId: "response-1" },
    );
    const second = fauxAssistantMessage("done", { responseId: "response-2" });
    const { ctx, events, streamCalls, echo } = makeContext([first, second]);

    await new PiHarness().run(ctx);

    expect(echo).toHaveBeenCalled();
    expect(echo.mock.calls[0]?.[0]).toEqual({ value: "hello" });
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "span.model_request_start",
        "agent.thinking",
        "agent.custom_tool_use",
        "agent.tool_result",
        "agent.message",
        "span.model_request_end",
      ]),
    );
    expect(events.filter((event) => event.type === "span.model_request_start")).toHaveLength(2);
    expect(events.find((event) => event.type === "agent.custom_tool_use")).toMatchObject({
      id: "tool-echo",
      name: "echo",
      input: { value: "hello" },
    });
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({
      tool_use_id: "tool-echo",
      content: [{ type: "text", text: '{"echoed":"hello"}' }],
    });
    expect(events.find((event) => event.type === "agent.message")).toMatchObject({
      content: [{ type: "text", text: "done" }],
    });
    expect(streamCalls.messageStarts).toEqual(streamCalls.messageEnds);
    expect(streamCalls.thinkingStarts).toEqual(streamCalls.thinkingEnds);
    expect(streamCalls.toolStarts).toEqual(streamCalls.toolEnds);
  });

  it("projects canonical history back into Pi on the next turn", async () => {
    const { ctx, events, faux } = makeContext([
      fauxAssistantMessage("first answer"),
    ]);
    await new PiHarness().run(ctx);
    events.push({
      type: "user.message",
      content: [{ type: "text", text: "second question" }],
    });

    let roles: string[] = [];
    faux.setResponses([
      (context) => {
        roles = context.messages.map((message) => message.role);
        return fauxAssistantMessage("second answer");
      },
    ]);
    await new PiHarness().run(ctx);

    expect(roles.filter((role) => role !== "system")).toEqual(["user", "assistant", "user"]);
    expect(
      events.filter((event) => event.type === "agent.message"),
    ).toHaveLength(2);
  });

  it("uses the runtime thinking level for every Pi agent turn", async () => {
    const { ctx } = makeContext([fauxAssistantMessage("careful answer")]);
    const streamSimple = vi.spyOn(ctx.pi!.models, "streamSimple");
    Reflect.set(ctx.pi!, "thinkingLevel", "high");

    await new PiHarness().run(ctx);

    expect(streamSimple).toHaveBeenCalledWith(
      ctx.pi!.model,
      expect.any(Object),
      expect.objectContaining({ reasoning: "high" }),
    );
  });

  describe("tool_search assembly", () => {
    const MCP_TOOL = "mcp__github__create_issue";

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function makeToolSearchContext(
      responses: ReturnType<typeof fauxAssistantMessage>[],
      toolSearchMode: "on" | "off" | "auto",
      mcpDescription = "Create a GitHub issue",
    ) {
      const base = makeContext(responses);
      base.ctx.agent = {
        id: "agent-test",
        model: base.ctx.pi!.model.id,
        metadata: { tool_search: toolSearchMode },
      };
      base.ctx.tools = {
        read: {
          description: "Read a file",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        },
        [MCP_TOOL]: {
          description: mcpDescription,
          inputSchema: z.object({ title: z.string() }),
          execute: async () => ({ created: true }),
        },
      };
      return base;
    }

    it("keeps all MCP tools visible when tool_search is off", async () => {
      const { ctx, faux } = makeToolSearchContext([fauxAssistantMessage("ok")], "off");
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(1);
      expect(assemblyProbe).toHaveBeenCalled();
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain(MCP_TOOL);
      expect(assemblyProbe.mock.calls[0]?.[0]).not.toContain("tool_search");
    });

    it("defers MCP tools and exposes tool_search when mode is on", async () => {
      const { ctx, faux } = makeToolSearchContext([fauxAssistantMessage("ok")], "on");
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(1);
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain("tool_search");
      expect(assemblyProbe.mock.calls[0]?.[0]).not.toContain(MCP_TOOL);
    });

    it("loads deferred tools for the next model turn after tool_search", async () => {
      const { ctx, faux, events } = makeToolSearchContext(
        [
          fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: `select:${MCP_TOOL}` }, { id: "tool-search-1" })],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("loaded"),
        ],
        "on",
      );

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(2);
      expect(events).toContainEqual(expect.objectContaining({
        type: "session.warning",
        source: TOOL_ASSEMBLY_WARNING_SOURCE,
        details: { loadedToolNames: [MCP_TOOL] },
      }));
    });

    it("keeps MCP tools visible in auto mode when defs are below the threshold", async () => {
      const { ctx, faux } = makeToolSearchContext([fauxAssistantMessage("ok")], "auto");
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(1);
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain(MCP_TOOL);
      expect(assemblyProbe.mock.calls[0]?.[0]).not.toContain("tool_search");
    });

    it("defers MCP tools in auto mode when defs exceed the threshold", async () => {
      const { ctx, faux } = makeToolSearchContext(
        [fauxAssistantMessage("ok")],
        "auto",
        "x".repeat(8_000),
      );
      ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });

      await new PiHarness().run(ctx);
      expect(faux.state.callCount).toBe(1);
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain("tool_search");
      expect(assemblyProbe.mock.calls[0]?.[0]).not.toContain(MCP_TOOL);
    });

    it("resumes loaded tools from prior session events on a new harness run", async () => {
      const { ctx, events, faux } = makeToolSearchContext(
        [
          fauxAssistantMessage(
            [fauxToolCall("tool_search", { query: `select:${MCP_TOOL}` }, { id: "tool-search-resume" })],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("first run done"),
        ],
        "on",
      );

      await new PiHarness().run(ctx);
      events.push({
        type: "user.message",
        content: [{ type: "text", text: "second turn" }],
      });
      const assemblyProbe = vi.fn();
      const piAdapter = await import("../src/harness/assembly/adapters/pi");
      const createAssembly = piAdapter.createPiToolAssembly;
      vi.spyOn(piAdapter, "createPiToolAssembly").mockImplementation((harnessCtx) => {
        const assembly = createAssembly(harnessCtx);
        assemblyProbe(assembly.initialTools.map((tool) => tool.name));
        return assembly;
      });
      faux.setResponses([fauxAssistantMessage("resumed")]);

      await new PiHarness().run(ctx);
      expect(assemblyProbe.mock.calls[0]?.[0]).toContain(MCP_TOOL);
    });
  });

  it("pauses non-executable tools for OpenMA confirmation", async () => {
    const call = fauxAssistantMessage(
      fauxToolCall("echo", { value: "confirm me" }, { id: "tool-confirm" }),
      { stopReason: "toolUse" },
    );
    const { ctx, events } = makeContext([call]);
    delete (ctx.tools.echo as { execute?: unknown }).execute;

    await new PiHarness().run(ctx);

    expect(ctx.runtime.pendingConfirmations).toEqual(["tool-confirm"]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.custom_tool_use",
      id: "tool-confirm",
    }));
    expect(events.some((event) => event.type === "agent.tool_result")).toBe(false);
    expect(events.filter((event) => event.type.startsWith("span.tool_execution_"))).toEqual([]);
  });

  // docs/plans/harness-fixes.md, пункт 12.
  it("сохраняет обе правки одного файла из одного шага", async () => {
    const { ctx, events } = makeContext([
      fauxAssistantMessage([
        fauxToolCall("edit", { file_path: "/workspace/a.ts", old_string: "a = 1", new_string: "a = 10" }, { id: "edit-1" }),
        fauxToolCall("edit", { file_path: "/workspace/a.ts", old_string: "b = 2", new_string: "b = 20" }, { id: "edit-2" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("готово"),
    ]);
    let text = "a = 1\nb = 2\n";
    const vmCall = () => new Promise((resolve) => setTimeout(resolve, 1));
    const sandbox = {
      async readFile() {
        await vmCall();
        return text;
      },
      async writeFile(_path: string, content: string) {
        await vmCall();
        text = content;
        return "ok";
      },
    };
    const tools = await buildTools(
      { id: "agent-test", name: "a", model: "m", system: "", tools: [{ type: "agent_toolset_20260401" }] } as never,
      sandbox as never,
    );
    ctx.tools = { edit: tools.edit };

    await new PiHarness().run(ctx);

    expect(text).toBe("a = 10\nb = 20\n");
    const results = events.filter((event) => event.type === "agent.tool_result");
    expect(results.map((event) => (event as { content?: unknown }).content)).toEqual([
      [{ type: "text", text: "ok" }],
      [{ type: "text", text: "ok" }],
    ]);
  });

  // docs/plans/harness-fixes.md, пункты 1, 2 и 5.
  describe("переполнение, отмена и пустой ответ", () => {
    function olderTurns(): SessionEvent[] {
      return [
        { type: "user.message", content: [{ type: "text", text: "старый вопрос 1" }] },
        { type: "agent.message", message_id: "old-1", content: [{ type: "text", text: "старый ответ 1" }] },
        { type: "user.message", content: [{ type: "text", text: "старый вопрос 2" }] },
        { type: "agent.message", message_id: "old-2", content: [{ type: "text", text: "старый ответ 2" }] },
      ];
    }

    const overflow = () => fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "prompt is too long: 140000 tokens > 128000 maximum",
    });

    function messageIndex(events: SessionEvent[], text: string): number {
      return events.findIndex((event) => event.type === "agent.message"
        && JSON.stringify(event.content).includes(text));
    }

    function attachAbort(ctx: HarnessContext): AbortController {
      const controller = new AbortController();
      Reflect.set(ctx.runtime, "abortSignal", controller.signal);
      return controller;
    }

    it("сжимает историю и повторяет ход, если контекст переполнился после вызова инструмента", async () => {
      const { ctx, events, faux, echo } = makeContext([]);
      events.unshift(...olderTurns());
      let summaryRequest = "";
      let retryRequest = "";
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("echo", { value: "hello" }, { id: "tool-before-overflow" }),
          { stopReason: "toolUse" },
        ),
        overflow(),
        (context) => {
          summaryRequest = JSON.stringify(context.messages);
          return fauxAssistantMessage("сводка после инструмента");
        },
        (context) => {
          retryRequest = JSON.stringify(context.messages);
          return fauxAssistantMessage("ответ после сжатия");
        },
      ]);

      await new PiHarness().run(ctx);

      expect(echo).toHaveBeenCalledOnce();
      expect(faux.state.callCount).toBe(4);
      const compacted = events.findIndex((event) => event.type === "agent.thread_context_compacted");
      const toolResult = events.findIndex((event) => event.type === "agent.tool_result");
      expect(compacted).toBeGreaterThan(toolResult);
      expect(compacted).toBeLessThan(messageIndex(events, "ответ после сжатия"));
      expect(summaryRequest).toContain("echoed");
      expect(retryRequest).toContain("<conversation-summary>");
      expect(retryRequest).toContain("сводка после инструмента");
      expect(retryRequest).toContain("tool-before-overflow");
    });

    it("повторяет ход после переполнения и тогда, когда ход начался со сжатия", async () => {
      const { ctx, events, faux } = makeContext([]);
      events.unshift(...olderTurns());
      // Окно меньше max_tokens модели: порог сжатия 0, сжатие идёт перед каждым ходом.
      ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
      faux.setResponses([
        fauxAssistantMessage("первая сводка"),
        fauxAssistantMessage(
          fauxToolCall("echo", { value: "hello" }, { id: "tool-after-compaction" }),
          { stopReason: "toolUse" },
        ),
        overflow(),
        fauxAssistantMessage("вторая сводка"),
        fauxAssistantMessage("ответ после второго сжатия"),
      ]);

      await new PiHarness().run(ctx);

      expect(faux.state.callCount).toBe(5);
      expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(2);
      expect(messageIndex(events, "ответ после второго сжатия")).toBeGreaterThan(-1);
    });

    it("отмена до хода не запускает ни сжатие, ни модель", async () => {
      const { ctx, events, faux } = makeContext([fauxAssistantMessage("ответ после отмены")]);
      const policy: PiCompactionPolicy = {
        name: "test-policy",
        shouldCompact: () => true,
        compact: vi.fn(async () => null),
      };
      attachAbort(ctx).abort();

      await new PiHarness({ compaction: policy }).run(ctx);

      expect(faux.state.callCount).toBe(0);
      expect(policy.compact).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === "span.model_request_start")).toBe(false);
    });

    it("отмена во время сжатия останавливает ход", async () => {
      const { ctx, events, faux } = makeContext([fauxAssistantMessage("ответ после отмены")]);
      const controller = attachAbort(ctx);
      const policy: PiCompactionPolicy = {
        name: "test-policy",
        shouldCompact: () => true,
        compact: async () => {
          controller.abort();
          return null;
        },
      };

      await new PiHarness({ compaction: policy }).run(ctx);

      expect(faux.state.callCount).toBe(0);
      expect(events.some((event) => event.type === "span.model_request_start")).toBe(false);
      expect(messageIndex(events, "ответ после отмены")).toBe(-1);
    });

    it("отмена после подписки на сигнал и до запуска агента останавливает ход", async () => {
      const { ctx, events, faux } = makeContext([fauxAssistantMessage("ответ после отмены")]);
      const controller = attachAbort(ctx);
      Reflect.set(ctx.runtime, "keepAliveWhile", async (run: () => Promise<void>) => {
        controller.abort();
        await run();
      });

      await new PiHarness({ compaction: {
        name: "disabled",
        shouldCompact: () => false,
        compact: async () => null,
      } }).run(ctx);

      expect(faux.state.callCount).toBe(0);
      expect(messageIndex(events, "ответ после отмены")).toBe(-1);
    });

    // Граница сжатия навсегда заменяет историю до себя, поэтому оборванная сводка
    // не записывается. Ход идёт по полной истории, сжатие повторит следующий ход.
    it.each(["length", "aborted"] as const)(
      "не записывает сводку, оборванную по %s, и отвечает по полной истории",
      async (stopReason) => {
        const { ctx, events, faux } = makeContext([]);
        events.unshift(...olderTurns());
        // Окно меньше max_tokens модели: порог сжатия 0, сжатие идёт перед ходом.
        ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
        let turnRequest = "";
        faux.setResponses([
          fauxAssistantMessage("оборванная сводка", { stopReason }),
          (context) => {
            turnRequest = JSON.stringify(context.messages);
            return fauxAssistantMessage("ответ по полной истории");
          },
        ]);
        const warnings: string[] = [];
        const warn = vi.spyOn(console, "warn")
          .mockImplementation((message: unknown) => void warnings.push(String(message)));

        try {
          await new PiHarness().run(ctx);
        } finally {
          warn.mockRestore();
        }

        expect(faux.state.callCount).toBe(2);
        expect(events).toContainEqual(expect.objectContaining({
          type: "span.compaction_summarize_end",
          finish_reason: stopReason,
        }));
        expect(events.some((event) => event.type === "agent.thread_context_compacted")).toBe(false);
        expect(warnings).toContainEqual(expect.stringContaining(`stop_reason=${stopReason}`));
        expect(turnRequest).not.toContain("оборванная сводка");
        expect(turnRequest).toContain("старый вопрос 1");
        expect(messageIndex(events, "ответ по полной истории")).toBeGreaterThan(-1);
      },
    );

    it("не записывает часть сводки, если ход отменили во время запроса сводки", async () => {
      const { ctx, events, faux } = makeContext([fauxAssistantMessage("ответ после отмены")]);
      events.unshift(...olderTurns());
      ctx.pi!.model = { ...ctx.pi!.model, contextWindow: 10_000 };
      const controller = attachAbort(ctx);
      // Так отвечает Pi, когда отмена приходит посреди потока: текст до отмены и aborted.
      const completeSimple = vi.spyOn(ctx.pi!.models, "completeSimple").mockImplementation(async () => {
        controller.abort();
        return fauxAssistantMessage("начало сводки", {
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        });
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      try {
        await new PiHarness().run(ctx);
      } finally {
        warn.mockRestore();
      }

      expect(completeSimple).toHaveBeenCalledOnce();
      expect(events.some((event) => event.type === "agent.thread_context_compacted")).toBe(false);
      expect(faux.state.callCount).toBe(0);
      expect(messageIndex(events, "ответ после отмены")).toBe(-1);
    });

    it("не записывает сводку своей политики, если ход отменили во время сжатия", async () => {
      const { ctx, events, faux } = makeContext([fauxAssistantMessage("ответ после отмены")]);
      const controller = attachAbort(ctx);
      // Своя политика может не слушать сигнал и вернуть сводку, оборванную отменой.
      const policy: PiCompactionPolicy = {
        name: "test-policy",
        shouldCompact: () => true,
        compact: async () => {
          controller.abort();
          return {
            summary: [{ type: "text", text: "частичная сводка" }],
            pre_tokens: 10,
            original_message_count: 4,
            compacted_message_count: 1,
          };
        },
      };

      await new PiHarness({ compaction: policy }).run(ctx);

      expect(events.some((event) => event.type === "agent.thread_context_compacted")).toBe(false);
      expect(faux.state.callCount).toBe(0);
    });

    it.each([
      ["одни мысли", () => fauxAssistantMessage([fauxThinking("думаю, но не отвечаю")])],
      ["пустой ответ", () => fauxAssistantMessage([])],
    ])("%s со stop бросает silent_stop без сжатия", async (_name, reply) => {
      const { ctx, events, faux } = makeContext([]);
      events.unshift(...olderTurns());
      faux.setResponses([
        reply(),
        fauxAssistantMessage("сводка пустого ответа"),
        fauxAssistantMessage("ответ после сводки"),
      ]);

      const run = new PiHarness().run(ctx);

      await expect(run).rejects.toBeInstanceOf(ModelError);
      await expect(run).rejects.toThrow(/^silent_stop: model returned finish_reason=stop/);
      expect(faux.state.callCount).toBe(1);
      expect(events.some((event) => event.type === "agent.thread_context_compacted")).toBe(false);
    });
  });

  // Размер контекста берётся из расхода последнего ответа (span.model_request_end),
  // а не из числа знаков истории. У faux-модели окно 128 000 и max_tokens 16 384,
  // порог сжатия 128 000 - 16 384 - 4 096 = 107 520 токенов.
  describe("расход последнего ответа и русский текст", () => {
    const MCP_TOOL = "mcp__github__create_issue";
    const noCompaction: PiCompactionPolicy = {
      name: "disabled",
      shouldCompact: () => false,
      compact: async () => null,
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function olderTurns(): SessionEvent[] {
      return [
        { type: "user.message", content: [{ type: "text", text: "старый вопрос 1" }] },
        { type: "agent.message", message_id: "old-1", content: [{ type: "text", text: "старый ответ 1" }] },
        { type: "user.message", content: [{ type: "text", text: "старый вопрос 2" }] },
        { type: "agent.message", message_id: "old-2", content: [{ type: "text", text: "старый ответ 2" }] },
      ];
    }

    function requestEnd(inputTokens: number, overrides: Record<string, unknown> = {}): SessionEvent {
      return {
        type: "span.model_request_end",
        model: "faux",
        model_usage: {
          input_tokens: inputTokens,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        finish_reason: "stop",
        is_error: false,
        ...overrides,
      } as SessionEvent;
    }

    function captureRequest(faux: ReturnType<typeof makeContext>["faux"]) {
      const request = { maxTokens: undefined as number | undefined, firstUserMessage: "" };
      faux.setResponses([
        (context, options) => {
          request.maxTokens = options?.maxTokens;
          request.firstUserMessage = JSON.stringify(context.messages.find((message) => message.role === "user"));
          return fauxAssistantMessage("ответ");
        },
      ]);
      return request;
    }

    it("сжимает историю, когда расход последнего ответа дошёл до порога", async () => {
      const { ctx, events, faux } = makeContext([]);
      // Текст истории занимает пару десятков токенов. Её размер виден только из span.
      events.unshift(...olderTurns(), requestEnd(110_000));
      faux.setResponses([
        fauxAssistantMessage("сводка по расходу"),
        fauxAssistantMessage("ответ после сжатия"),
      ]);

      await new PiHarness().run(ctx);

      expect(faux.state.callCount).toBe(2);
      expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    });

    it.each(["off", "on"] as const)(
      "отдаёт Pi расход последнего ответа, tool_search %s",
      async (toolSearch) => {
        const { ctx, events, faux } = makeContext([]);
        if (toolSearch === "on") {
          ctx.agent = { ...ctx.agent, metadata: { tool_search: "on" } };
          ctx.tools = {
            ...ctx.tools,
            [MCP_TOOL]: {
              description: "Create a GitHub issue",
              inputSchema: z.object({ title: z.string() }),
              execute: async () => ({ created: true }),
            },
          };
        }
        // Часы идут вперёд на каждом вызове. Подсказка tool_search собирается позже
        // истории, но не должна выглядеть новее последнего ответа.
        let clock = 1_800_000_000_000;
        vi.spyOn(Date, "now").mockImplementation(() => (clock += 1_000));
        events.unshift(...olderTurns(), requestEnd(120_000));
        const request = captureRequest(faux);

        await new PiHarness({ compaction: noCompaction }).run(ctx);

        // Подсказка tool_search открывает запрос до сообщений истории.
        if (toolSearch === "on") expect(request.firstUserMessage).toContain(MCP_TOOL);
        // Pi оставляет на ответ остаток окна: 128 000 - 120 500 - 4 096.
        expect(request.maxTokens).toBeLessThanOrEqual(128_000 - 120_500 - 4_096);
      },
    );

    it.each([
      ["до границы сжатия", (): SessionEvent[] => [
        ...olderTurns(),
        requestEnd(120_000),
        {
          type: "agent.thread_context_compacted",
          summary: [{ type: "text", text: "сводка старых ходов" }],
          original_message_count: 4,
          compacted_message_count: 1,
          trigger: "auto",
          pre_tokens: 120_500,
        } as SessionEvent,
      ]],
      ["прерванного запроса", (): SessionEvent[] => [
        ...olderTurns(),
        requestEnd(120_000, { finish_reason: "aborted" }),
      ]],
      ["запроса с ошибкой", (): SessionEvent[] => [
        ...olderTurns(),
        requestEnd(120_000, { finish_reason: "error", is_error: true }),
      ]],
      ["запроса без своего ответа", (): SessionEvent[] => [
        ...olderTurns(),
        { type: "user.message", content: [{ type: "text", text: "ещё вопрос" }] },
        requestEnd(120_000, { finish_reason: "length" }),
      ]],
      ["запроса, после которого есть ответ без span", (): SessionEvent[] => [
        ...olderTurns(),
        requestEnd(120_000),
        { type: "agent.message", message_id: "late", content: [{ type: "text", text: "ответ без span" }] },
      ]],
    ])("не берёт расход %s", async (_name, history) => {
      const { ctx, events, faux } = makeContext([]);
      events.unshift(...history());
      const request = captureRequest(faux);

      await new PiHarness({ compaction: noCompaction }).run(ctx);

      expect(request.maxTokens).toBe(ctx.pi!.model.maxTokens);
    });

    it("сжимает русскую историю, которую оценка по 3,5 знака на токен недосчитывает", async () => {
      const { ctx, events, faux } = makeContext([]);
      const paragraph = "Сотрудник выходит на работу в понедельник. До этого отдел кадров готовит договор, "
        + "пропуск и рабочее место, а руководитель пишет план на первую неделю. В первый день новичок "
        + "получает ноутбук, учётные записи и список людей, к которым можно прийти с вопросом. ";
      const text = paragraph.repeat(90);
      events.unshift(
        { type: "user.message", content: [{ type: "text", text }] },
        { type: "agent.message", message_id: "ru-1", content: [{ type: "text", text }] },
        { type: "user.message", content: [{ type: "text", text }] },
        { type: "agent.message", message_id: "ru-2", content: [{ type: "text", text }] },
      );
      // Qwen 3.6 тратил токен примерно на 3,1 знака русского ответа (сессии 2026-10-16).
      // Порог стоит на этом счёте с запасом, токен на 3 знака. Pi по 3,5 знака видит меньше.
      const qwenTokens = Math.ceil(text.length * 4 / 3);
      ctx.agent = {
        ...ctx.agent,
        context_management: { edits: [{ type: "compact", trigger: { type: "input_tokens", value: qwenTokens } }] },
      } as HarnessContext["agent"];
      faux.setResponses([
        fauxAssistantMessage("сводка русской истории"),
        fauxAssistantMessage("ответ после сжатия"),
      ]);

      await new PiHarness().run(ctx);

      expect(faux.state.callCount).toBe(2);
      expect(events.filter((event) => event.type === "agent.thread_context_compacted")).toHaveLength(1);
    });
  });
});

describe("предел сессии (план multiagent 3.Б, срез 2)", () => {
  /** Предел как у сервера: проверка перед запросом видит расход прошлых
   * запросов. Здесь предел исчерпан после `requests` ответов модели. */
  function limitAfter(ctx: HarnessContext, requests: number): HarnessRuntime {
    const runtime = ctx.runtime;
    let answered = 0;
    runtime.reportUsage = vi.fn(async () => { answered += 1; });
    runtime.beforeModelRequest = vi.fn(async () => {
      if (answered >= requests) runtime.limitReached = true;
    });
    return runtime;
  }

  it("не шлёт запрос модели после предела и не пишет спан ошибки", async () => {
    const { ctx, events, echo, faux } = makeContext([
      fauxAssistantMessage(fauxToolCall("echo", { value: "hello" }, { id: "tool-echo" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("этот ответ модель не должна дать"),
    ]);
    limitAfter(ctx, 1);

    const failure = await new PiHarness().run(ctx).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(SessionLimitError);
    expect(failure).not.toBeInstanceOf(ModelError);
    expect(faux.state.callCount).toBe(1);
    expect(echo).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === "agent.tool_result")).toMatchObject({ tool_use_id: "tool-echo" });
    expect(events.filter((event) => event.type === "span.model_request_start")).toHaveLength(1);
    const ends = events.filter((event) => event.type === "span.model_request_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ is_error: false });
    // Неотправленный запрос не оставляет пустого ответа в истории.
    expect(events.filter((event) => event.type === "agent.message")).toEqual([]);
    expect(ctx.runtime.reportUsage).toHaveBeenCalledTimes(1);
  });

  it("на пределе до хода не зовёт ни сжатие, ни модель", async () => {
    const { ctx, events, faux } = makeContext([fauxAssistantMessage("этот ответ модель не должна дать")]);
    const policy: PiCompactionPolicy = {
      name: "test-policy",
      shouldCompact: () => true,
      compact: vi.fn(async () => null),
    };
    limitAfter(ctx, 0);

    await expect(new PiHarness({ compaction: policy }).run(ctx)).rejects.toBeInstanceOf(SessionLimitError);

    expect(faux.state.callCount).toBe(0);
    expect(policy.compact).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type.startsWith("span."))).toEqual([]);
  });
});
