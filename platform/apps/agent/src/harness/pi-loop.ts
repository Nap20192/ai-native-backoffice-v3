import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type ToolResultMessage,
  type Usage,
  type JsonObject,
  isContextOverflow,
  isRecoverableLength,
} from "@earendil-works/pi-ai";
import type { ModelMessage } from "ai";
import type { ContentBlock, SessionEvent } from "@open-managed-agents/shared";
import {
  classifyExternalError,
  generateEventId,
  ModelError,
  SessionLimitError,
} from "@open-managed-agents/shared";
import { eventsToMessagesAsync } from "../runtime/history";
import type { HarnessContext, HarnessInterface } from "./interface";
import {
  estimatePiRequestTokens,
  PI_CONTEXT_OUTPUT_RESERVE_TOKENS,
  resolvePiCompactionPolicy,
  type PiCompactionPolicy,
  type PiCompactionResult,
} from "./pi-compaction";
import { readHarnessAgentModelSettings } from "./agent-model-settings";
import {
  resolveCompactionSummaryInstructions,
  resolveCompactionTriggerInputTokens,
} from "./compaction-config";
import { emitHarnessToolUseFromCall, isMcpTool } from "./tool-events";
import { withPiRuntimeRequestOptions } from "./pi-provider";
import { createPiToolAssembly } from "./assembly/adapters/pi";
import { capHistoryText, toolsToPi, valueToPiContent } from "./pi-loop-tools";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface LiveMessageState {
  spanId: string | null;
  firstTokenSeen: boolean;
  textIds: Map<number, string>;
  thinkingIds: Map<number, string>;
  toolIds: Map<number, string>;
  /** Tool calls with an open span.tool_execution_start frame (agent trace, plan 2.2). */
  executingTools: Set<string>;
}

interface PiRunOutcome {
  /** The run streamed text or a tool call. Thinking alone does not count. */
  producedOutput: boolean;
  providerFailure?: AssistantMessage;
  /** Stop reason of the last assistant message of the run. */
  stopReason?: AssistantMessage["stopReason"];
}

export interface PiHarnessOptions {
  /** Replace the required default policy; the compaction capability remains active. */
  compaction?: PiCompactionPolicy;
  /** Pause before each retry of a model request the network dropped. Tests pass zeros. */
  transientRetryDelaysMs?: readonly number[];
}

export const MODEL_REQUEST_RETRY_WARNING_SOURCE = "oma.model_request_retry";
const DEFAULT_TRANSIENT_RETRY_DELAYS_MS = [2_000, 5_000] as const;

/**
 * A request the connection or the gateway dropped: undici's "terminated" when
 * the peer closes a streaming body, resets, timeouts and 502/503/504 from a
 * proxy. A provider refusal or a bad request is not transient.
 */
const TRANSIENT_PROVIDER_FAILURE =
  /\bterminated\b|other side closed|socket hang up|fetch failed|network error|connection error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_|\b50[234]\b|bad gateway|service unavailable|gateway time-?out/i;

/**
 * Pi-backed implementation of the OpenMA Harness Port.
 *
 * Pi owns provider auth, request/response protocols, streaming and the tool
 * loop. This class is intentionally only a boundary translator: canonical
 * OpenMA history in, canonical OpenMA events out.
 */
export class PiHarness implements HarnessInterface {
  constructor(private readonly options: PiHarnessOptions = {}) {}

  async run(ctx: HarnessContext): Promise<void> {
    if (!ctx.pi) {
      throw new ModelError("Pi harness requires a tenant-scoped Pi model runtime");
    }

    const signal = ctx.runtime.abortSignal;
    // A Session at its limit sends nothing, the compaction summary included.
    if (await sessionLimitReached(ctx)) throw sessionLimitError();
    await this.compactIfInsufficientOutputRoom(ctx);
    const proactivelyCompacted = await this.compactBeforeTurn(ctx);
    if (signal?.aborted) return;
    let outcome = await this.runAgentOnce(ctx);
    // Tool output produced after the proactive compaction can overflow the
    // context again, so that compaction does not rule out the retry.
    if (
      !signal?.aborted
      && (!proactivelyCompacted || outcome.producedOutput)
      && shouldRetryPiTurnAfterCompaction(outcome, ctx.pi.model)
    ) {
      if (await sessionLimitReached(ctx)) throw sessionLimitError();
      const recovered = await this.compactBeforeTurn(ctx, true);
      if (recovered && !signal?.aborted) outcome = await this.runAgentOnce(ctx);
    }
    outcome = await this.retryTransientProviderFailures(ctx, outcome);
    if (signal?.aborted) return;
    // The request the limit stopped never left: the turn ends here, and the
    // runner reads the error as budget_reached, not as a model failure.
    if (ctx.runtime.limitReached) throw sessionLimitError();

    if (outcome.providerFailure) {
      const failure = outcome.providerFailure;
      const detail = failure.errorMessage?.trim();
      const message = detail && detail.length > 0
        ? detail
        : `Pi provider request failed (stop_reason=${failure.stopReason})`;
      const external = classifyExternalError(new Error(message));
      throw external instanceof Error ? external : new ModelError(message);
    }
    if (!outcome.producedOutput) {
      // Same contract as the removed ai-sdk loop: a turn without text or a
      // tool call is a deterministic model failure, not a context problem.
      throw new ModelError(
        `silent_stop: model returned finish_reason=${outcome.stopReason ?? "stop"} with empty text and no tool calls`,
      );
    }
  }

  /**
   * Retry a model request the network dropped. The tool calls and results of
   * the turn before it are in the stored history, and the failed request ran
   * no tool, so a new run continues from where the turn stopped.
   */
  private async retryTransientProviderFailures(ctx: HarnessContext, first: PiRunOutcome): Promise<PiRunOutcome> {
    const delays = this.options.transientRetryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS;
    const signal = ctx.runtime.abortSignal;
    let outcome = first;
    for (let attempt = 1; attempt <= delays.length; attempt++) {
      const failure = outcome.providerFailure;
      if (!failure || !isTransientProviderFailure(failure, ctx.pi!.model)) return outcome;
      if (signal?.aborted || ctx.runtime.limitReached) return outcome;
      ctx.runtime.broadcast({
        type: "session.warning",
        source: MODEL_REQUEST_RETRY_WARNING_SOURCE,
        message: `Model request failed (${failure.errorMessage?.trim().slice(0, 200) || "network error"}); retry ${attempt} of ${delays.length}`,
        details: { attempt, of: delays.length },
      } as SessionEvent);
      await waitUnlessAborted(delays[attempt - 1], signal);
      if (signal?.aborted) return outcome;
      if (await sessionLimitReached(ctx)) throw sessionLimitError();
      outcome = await this.runAgentOnce(ctx);
    }
    return outcome;
  }

  private async runAgentOnce(ctx: HarnessContext): Promise<PiRunOutcome> {
    const messages = dropTrailingAssistantPiMessages(
      await replayHistoryToPi(ctx, ctx.runtime.history.getEvents()),
    );
    if (messages.length === 0) {
      throw new ModelError("Pi harness cannot continue without a user message");
    }
    const state: LiveMessageState = {
      spanId: null,
      firstTokenSeen: false,
      textIds: new Map(),
      thinkingIds: new Map(),
      toolIds: new Map(),
      executingTools: new Set(),
    };
    let providerFailure: AssistantMessage | undefined;
    let producedOutput = false;
    let stopReason: AssistantMessage["stopReason"] | undefined;

    const signal = ctx.runtime.abortSignal;
    if (signal?.aborted) return { producedOutput };

    const toolAssembly = createPiToolAssembly(ctx);
    // Hints open the request. A hint stamped after the replayed history would
    // make Pi drop the usage of the last replayed assistant message.
    const firstTimestamp = messages[0]!.timestamp;
    const bootstrapMessages = toolAssembly.bootstrapTurnMessages.map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: Math.min(message.timestamp, firstTimestamp),
    }));
    const agent = new Agent({
      initialState: {
        systemPrompt: toolAssembly.systemPrompt,
        model: ctx.pi!.model,
        messages: [...bootstrapMessages, ...messages],
        tools: toolAssembly.initialTools,
        // The tenant runtime maps effort to the model's supported Pi level.
        thinkingLevel: ctx.pi!.thinkingLevel,
      },
      sessionId: ctx.session_id,
      // The limit check runs before each request (plan multiagent, 3.Б). Pi
      // turns a throw here into an error reply and loses its type, so the
      // flag on the runtime carries the stop. The request span opens only
      // for a request that goes out.
      streamFn: async (model, context, options) => {
        try {
          await ctx.runtime.beforeModelRequest?.();
        } finally {
          if (!ctx.runtime.limitReached) broadcastModelRequestStart(ctx, state);
        }
        if (ctx.runtime.limitReached) throw sessionLimitError();
        return ctx.pi!.models.streamSimple(
          model,
          context,
          withPiRuntimeRequestOptions(ctx.pi!, options, context),
        );
      },
      toolExecution: "parallel",
    });
    toolAssembly.attach(agent);

    const unsubscribe = agent.subscribe(async (event) => {
      const result = await translatePiEvent(event, ctx, state);
      producedOutput ||= result.producedOutput;
      if (result.providerFailure) providerFailure = result.providerFailure;
      if (event.type === "message_end" && event.message.role === "assistant") {
        stopReason = event.message.stopReason;
      }
    });

    const abort = () => agent.abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const run = async () => {
        // agent.abort() does nothing until continue() starts a run, so an
        // abort that came earlier (e.g. inside keepAliveWhile) stops here.
        if (signal?.aborted) return;
        await agent.continue();
      };
      if (ctx.runtime.keepAliveWhile) await ctx.runtime.keepAliveWhile(run);
      else await run();
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
      await closeLiveStreams(ctx, state, signal?.aborted ? "aborted" : "completed");
    }

    return {
      producedOutput,
      ...(providerFailure ? { providerFailure } : {}),
      ...(stopReason ? { stopReason } : {}),
    };
  }

  private async compactIfInsufficientOutputRoom(ctx: HarnessContext): Promise<void> {
    if (!ctx.pi || ctx.pi.model.contextWindow <= 0) return;
    const messages = await replayHistoryToPi(ctx, ctx.runtime.history.getEvents());
    const remaining = ctx.pi.model.contextWindow
      - estimatePiRequestTokens(messages, ctx.systemPrompt, toolsToPi(ctx));
    if (remaining < PI_CONTEXT_OUTPUT_RESERVE_TOKENS) {
      await this.compactBeforeTurn(ctx, true);
    }
  }

  private async compactBeforeTurn(ctx: HarnessContext, force: boolean = false): Promise<boolean> {
    if (ctx.runtime.abortSignal?.aborted) return false;
    const metadata = (ctx.agent.metadata ?? {}) as Record<string, unknown>;
    const summaryInstructions = resolveCompactionSummaryInstructions(ctx.agent);
    const policy = this.options.compaction === undefined
      ? resolvePiCompactionPolicy(metadata, summaryInstructions)
      : this.options.compaction;
    if (!ctx.pi) return false;

    const events = ctx.runtime.history.getEvents();
    const messages = await replayHistoryToPi(ctx, events);
    const piTools = toolsToPi(ctx);
    const compactionCtx = {
      messages,
      model: ctx.pi.model,
      systemPrompt: ctx.systemPrompt,
      tools: piTools,
      compactionTriggerInputTokens: resolveCompactionTriggerInputTokens(
        ctx.pi.model,
        ctx.agent,
        metadata,
      ),
    };
    if (!force && !policy.shouldCompact(events, compactionCtx)) return false;

    try {
      const result = await policy.compact(events, {
        ...compactionCtx,
        models: ctx.pi.models,
        runtime: ctx.runtime,
        sessionId: ctx.session_id,
        abortSignal: ctx.runtime.abortSignal,
        requestOptions: withPiRuntimeRequestOptions(ctx.pi, {
          ...(ctx.pi.thinkingLevel !== undefined && ctx.pi.thinkingLevel !== "off"
            ? { reasoning: ctx.pi.thinkingLevel }
            : {}),
        }, {
          systemPrompt: compactionCtx.systemPrompt,
          messages: compactionCtx.messages,
          tools: compactionCtx.tools,
        }),
      });
      // A policy that ignores the signal may return a summary cut by the
      // abort. The boundary replaces older history for good, so skip it.
      if (ctx.runtime.abortSignal?.aborted) return false;
      const compacted = this.persistCompaction(result, ctx);
      // §6 post-compaction re-assembly runs when `createPiToolAssembly` builds the
      // next turn (skill/tool retention + `oma.context_reassembled` marker).
      return compacted;
    } catch (error) {
      // Context compaction is a best-effort optimization. The canonical
      // history remains untouched when a policy/model fails, so the main
      // turn can still run and a later turn can retry.
      console.warn(`[pi-compact] ${policy.name} failed: ${(error as Error).message}`);
      return false;
    }
  }

  private persistCompaction(
    result: PiCompactionResult | null,
    ctx: HarnessContext,
  ): boolean {
    if (!result) return false;
    const hasContent = result.summary.some(
      (block) => (block.type === "text" && block.text.trim().length > 0)
        || block.type === "image"
        || block.type === "document",
    );
    if (!hasContent) return false;
    ctx.runtime.broadcast({
      type: "agent.thread_context_compacted",
      original_message_count: result.original_message_count,
      compacted_message_count: result.compacted_message_count,
      summary: result.summary,
      trigger: "auto",
      pre_tokens: result.pre_tokens,
    });
    return true;
  }
}

async function translatePiEvent(
  event: AgentEvent,
  ctx: HarnessContext,
  state: LiveMessageState,
): Promise<{ producedOutput: boolean; providerFailure?: AssistantMessage }> {
  const runtime = ctx.runtime;
  const modelId = ctx.pi!.model.id;
  let producedOutput = false;

  if (event.type === "turn_start") {
    // `streamFn` opens the span once the request passed the limit check.
    state.spanId = generateEventId();
    state.firstTokenSeen = false;
    return { producedOutput };
  }

  if (event.type === "message_update" && event.message.role === "assistant") {
    const update = event.assistantMessageEvent;
    if (update.type !== "start" && update.type !== "done" && update.type !== "error") {
      markFirstToken(runtime, state, modelId);
    }
    switch (update.type) {
      case "text_start": {
        const id = generateEventId();
        state.textIds.set(update.contentIndex, id);
        await runtime.broadcastStreamStart(id);
        break;
      }
      case "text_delta": {
        const id = await ensureTextStream(runtime, state, update.contentIndex);
        await runtime.broadcastChunk(id, update.delta);
        break;
      }
      case "thinking_start": {
        const id = generateEventId();
        state.thinkingIds.set(update.contentIndex, id);
        await runtime.broadcastThinkingStart(id);
        break;
      }
      case "thinking_delta": {
        const id = await ensureThinkingStream(runtime, state, update.contentIndex);
        await runtime.broadcastThinkingChunk(id, update.delta);
        break;
      }
      case "toolcall_start": {
        const block = update.partial.content[update.contentIndex];
        const id = block?.type === "toolCall" ? block.id : generateEventId();
        const name = block?.type === "toolCall" ? block.name : undefined;
        state.toolIds.set(update.contentIndex, id);
        await runtime.broadcastToolInputStart(id, name);
        break;
      }
      case "toolcall_delta": {
        const id = await ensureToolStream(runtime, state, update.contentIndex);
        await runtime.broadcastToolInputChunk(id, update.delta);
        break;
      }
      case "toolcall_end": {
        const prior = state.toolIds.get(update.contentIndex);
        if (prior && prior !== update.toolCall.id) {
          await runtime.broadcastToolInputEnd(prior, "aborted");
          await runtime.broadcastToolInputStart(update.toolCall.id, update.toolCall.name);
        } else if (!prior) {
          await runtime.broadcastToolInputStart(update.toolCall.id, update.toolCall.name);
        }
        state.toolIds.set(update.contentIndex, update.toolCall.id);
        break;
      }
    }
    return { producedOutput };
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    // The error reply Pi made of the limit stop: no request went out, so it
    // gets no span, no usage and no empty answer in the history.
    if (runtime.limitReached) {
      await closeLiveStreams(ctx, state, "aborted");
      return { producedOutput };
    }
    const message = event.message;
    const contextWindow = ctx.pi!.model.contextWindow;
    const desiredMaxOutput = ctx.pi!.model.maxTokens || PI_CONTEXT_OUTPUT_RESERVE_TOKENS;
    const overflowRecovery = isPiCompactionRecoverableAssistantEnd(
      message,
      contextWindow,
      desiredMaxOutput,
    ) && !message.content.some((block) => block.type === "toolCall");

    if (overflowRecovery) {
      const modelRequestStartId = state.spanId;
      await closeLiveStreams(ctx, state, "aborted");
      const usage = message.usage;
      runtime.broadcast({
        type: "span.model_request_end",
        model: modelId,
        model_request_start_id: modelRequestStartId ?? undefined,
        provider_response_id: message.responseId,
        model_usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_input_tokens: usage.cacheRead,
          cache_creation_input_tokens: usage.cacheWrite,
        },
        finish_reason: message.stopReason,
        final_text_length: 0,
        is_error: message.stopReason === "error",
        ...(message.errorMessage ? { error_message: message.errorMessage.slice(0, 500) } : {}),
        ...piModelTiming(message),
      } as SessionEvent);
      await runtime.reportUsage?.(usage.input, usage.output);
      return { producedOutput: false, providerFailure: message };
    }

    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
      if (block.type === "thinking") {
        const id = state.thinkingIds.get(index) ?? generateEventId();
        if (state.thinkingIds.has(index)) {
          await runtime.broadcastThinkingEnd(id, "completed");
        }
        runtime.broadcast({
          type: "agent.thinking",
          thinking_id: id,
          text: block.thinking,
          ...(block.thinkingSignature
            ? { providerOptions: { pi: { thinkingSignature: block.thinkingSignature } } }
            : {}),
        });
      } else if (block.type === "text") {
        const id = state.textIds.get(index) ?? generateEventId();
        if (state.textIds.has(index)) {
          await runtime.broadcastStreamEnd(id, "completed");
        }
        runtime.broadcast({
          type: "agent.message",
          message_id: id,
          content: [{ type: "text", text: block.text.replace(/\s+$/, "") }],
        });
        producedOutput ||= block.text.trim().length > 0;
      } else if (block.type === "toolCall") {
        const streamId = state.toolIds.get(index);
        if (streamId) await runtime.broadcastToolInputEnd(streamId, "completed");
        emitHarnessToolUseFromCall(
          runtime,
          ctx.tools as Record<string, unknown>,
          block.id,
          block.name,
          block.arguments as Record<string, unknown>,
        );
        producedOutput = true;
      }
    }

    const usage = message.usage;
    runtime.broadcast({
      type: "span.model_request_end",
      model: modelId,
      model_request_start_id: state.spanId ?? undefined,
      provider_response_id: message.responseId,
      model_usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: usage.cacheWrite,
      },
      finish_reason: message.stopReason,
      final_text_length: message.content
        .filter((block) => block.type === "text")
        .reduce((sum, block) => sum + block.text.length, 0),
      is_error: message.stopReason === "error",
      ...(message.errorMessage ? { error_message: message.errorMessage.slice(0, 500) } : {}),
      ...piModelTiming(message),
    } as SessionEvent);
    await runtime.reportUsage?.(usage.input, usage.output);
    clearMessageState(state);
    return {
      producedOutput,
      ...(message.stopReason === "error"
        ? { providerFailure: message }
        : {}),
    };
  }

  if (event.type === "tool_execution_start") {
    // A tool without execute waits for OpenMA confirmation: Pi still calls the
    // wrapper, but nothing runs, so it gets no execution frames.
    if (!awaitsConfirmation(ctx, event.toolName)) {
      state.executingTools.add(event.toolCallId);
      runtime.broadcast({
        type: "span.tool_execution_start",
        tool_use_id: event.toolCallId,
        name: event.toolName,
        at_ms: Date.now(),
      } as unknown as SessionEvent);
    }
    return { producedOutput };
  }

  if (event.type === "tool_execution_end") {
    if (state.executingTools.delete(event.toolCallId)) {
      runtime.broadcast({
        type: "span.tool_execution_end",
        tool_use_id: event.toolCallId,
        at_ms: Date.now(),
        ...(typeof event.durationMs === "number" ? { duration_ms: event.durationMs } : {}),
        is_error: event.isError,
      } as unknown as SessionEvent);
    }
    const details = event.result?.details as { openmaPendingConfirmation?: boolean } | undefined;
    if (!details?.openmaPendingConfirmation) {
      const content = piContentToWire(event.result?.content ?? []);
      if (isMcpTool(event.toolName)) {
        runtime.broadcast({
          type: "agent.mcp_tool_result",
          mcp_tool_use_id: event.toolCallId,
          content,
          ...(event.isError && { is_error: true }),
        } as SessionEvent);
      } else {
        runtime.broadcast({
          type: "agent.tool_result",
          tool_use_id: event.toolCallId,
          content,
          is_error: event.isError,
        } as SessionEvent);
      }
    }
  }

  return { producedOutput };
}

async function sessionLimitReached(ctx: HarnessContext): Promise<boolean> {
  await ctx.runtime.beforeModelRequest?.();
  return ctx.runtime.limitReached === true;
}

function sessionLimitError(): SessionLimitError {
  return new SessionLimitError("Session limit reached: no further model request is sent");
}

function broadcastModelRequestStart(ctx: HarnessContext, state: LiveMessageState): void {
  state.spanId ??= generateEventId();
  ctx.runtime.broadcast({
    type: "span.model_request_start",
    id: state.spanId,
    model: ctx.pi!.model.id,
    at_ms: Date.now(),
  } as SessionEvent);
}

function markFirstToken(
  runtime: HarnessContext["runtime"],
  state: LiveMessageState,
  model: string,
): void {
  if (state.firstTokenSeen || !state.spanId) return;
  state.firstTokenSeen = true;
  runtime.broadcast({
    type: "span.model_first_token",
    model,
    model_request_start_id: state.spanId,
    at_ms: Date.now(),
  } as SessionEvent);
}

/**
 * Pi's own clock for the agent trace (docs/plans/agent-trace.md, 2.2): event
 * stamps follow write order, not execution. `timestamp` is the request start,
 * `durationMs` comes from a monotonic clock. The public stream drops these
 * fields; only the trace observer reads them.
 */
function piModelTiming(message: AssistantMessage): {
  started_at_ms: number;
  duration_ms?: number;
  at_ms: number;
} {
  return {
    started_at_ms: message.timestamp,
    ...(typeof message.durationMs === "number" ? { duration_ms: message.durationMs } : {}),
    at_ms: Date.now(),
  };
}

function awaitsConfirmation(ctx: HarnessContext, toolName: string): boolean {
  const tools = ctx.tools as Record<string, { execute?: unknown } | undefined>;
  if (!Object.hasOwn(tools, toolName)) return false;
  return typeof tools[toolName]?.execute !== "function";
}

async function ensureTextStream(
  runtime: HarnessContext["runtime"],
  state: LiveMessageState,
  index: number,
): Promise<string> {
  let id = state.textIds.get(index);
  if (!id) {
    id = generateEventId();
    state.textIds.set(index, id);
    await runtime.broadcastStreamStart(id);
  }
  return id;
}

async function ensureThinkingStream(
  runtime: HarnessContext["runtime"],
  state: LiveMessageState,
  index: number,
): Promise<string> {
  let id = state.thinkingIds.get(index);
  if (!id) {
    id = generateEventId();
    state.thinkingIds.set(index, id);
    await runtime.broadcastThinkingStart(id);
  }
  return id;
}

async function ensureToolStream(
  runtime: HarnessContext["runtime"],
  state: LiveMessageState,
  index: number,
): Promise<string> {
  let id = state.toolIds.get(index);
  if (!id) {
    id = generateEventId();
    state.toolIds.set(index, id);
    await runtime.broadcastToolInputStart(id);
  }
  return id;
}

async function closeLiveStreams(
  ctx: HarnessContext,
  state: LiveMessageState,
  status: "completed" | "aborted",
): Promise<void> {
  for (const id of state.textIds.values()) {
    await ctx.runtime.broadcastStreamEnd(id, status);
  }
  for (const id of state.thinkingIds.values()) {
    await ctx.runtime.broadcastThinkingEnd(id, status);
  }
  for (const id of state.toolIds.values()) {
    await ctx.runtime.broadcastToolInputEnd(id, status);
  }
  clearMessageState(state);
}

function clearMessageState(state: LiveMessageState): void {
  state.spanId = null;
  state.firstTokenSeen = false;
  state.textIds.clear();
  state.thinkingIds.clear();
  state.toolIds.clear();
}

function piContentToWire(content: Array<TextContent | ImageContent>): ContentBlock[] {
  return content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : {
          type: "image",
          source: { type: "base64", media_type: block.mimeType, data: block.data },
        },
  );
}

/** Stored history → Pi messages, with the provider usage of the last request. */
async function replayHistoryToPi(ctx: HarnessContext, events: SessionEvent[]): Promise<Message[]> {
  const modelMessages = await eventsToMessagesAsync(events, ctx.fileFetcher);
  return withLastAssistantUsage(
    modelMessagesToPi(modelMessages, ctx.pi!.model, ctx.pi!.toolImages),
    lastReplayedAssistantUsage(events),
  );
}

function withLastAssistantUsage(messages: Message[], usage: Usage | undefined): Message[] {
  if (!usage) return messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const copy = messages.slice();
    copy[index] = { ...message, usage };
    return copy;
  }
  return messages;
}

/**
 * Provider usage of the request that wrote the last replayed assistant
 * message. Replayed messages otherwise carry zero usage, and Pi then estimates
 * the whole history by characters. The usage counts only when that request saw
 * the current view of history and finished cleanly:
 * - it ran after the last compaction boundary, which replaces older history;
 * - it did not stop on an error or an abort;
 * - its own output is the latest assistant content, with nothing after it.
 */
function lastReplayedAssistantUsage(events: SessionEvent[]): Usage | undefined {
  let end = -1;
  for (let index = events.length - 1; index >= 0 && end < 0; index--) {
    const kind = replayedEventKind(events[index]!);
    if (kind === "request_end") end = index;
    else if (kind === "assistant" || kind === "boundary") return undefined;
  }
  if (end < 0) return undefined;
  const span = events[end] as Extract<SessionEvent, { type: "span.model_request_end" }>;
  if (span.is_error || span.finish_reason === "error" || span.finish_reason === "aborted") {
    return undefined;
  }
  let ownOutput = false;
  for (let index = end - 1; index >= 0; index--) {
    const kind = replayedEventKind(events[index]!);
    if (kind === "ignored") continue;
    ownOutput = kind === "assistant";
    break;
  }
  if (!ownOutput) return undefined;
  const reported = span.model_usage;
  const input = reported?.input_tokens ?? 0;
  const output = reported?.output_tokens ?? 0;
  const cacheRead = reported?.cache_read_input_tokens ?? 0;
  const cacheWrite = reported?.cache_creation_input_tokens ?? 0;
  const totalTokens = input + output + cacheRead + cacheWrite;
  if (!(totalTokens > 0)) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: { ...EMPTY_USAGE.cost },
  };
}

/** How `eventsToMessages` treats an event, as far as usage lookup needs it. */
function replayedEventKind(
  event: SessionEvent,
): "assistant" | "other_message" | "boundary" | "request_end" | "ignored" {
  if ((event as { cancelled_at_ms?: number }).cancelled_at_ms != null) return "ignored";
  switch (event.type) {
    case "agent.message":
    case "agent.tool_use":
    case "agent.mcp_tool_use":
    case "agent.custom_tool_use":
      return "assistant";
    case "agent.thinking":
      return event.text != null ? "assistant" : "ignored";
    case "user.message":
    case "agent.tool_result":
    case "agent.mcp_tool_result":
      return "other_message";
    case "agent.thread_context_compacted":
      return event.summary?.some(
        (block) => (block.type === "text" && block.text.trim().length > 0)
          || block.type === "image"
          || block.type === "document",
      )
        ? "boundary"
        : "ignored";
    case "span.model_request_end":
      return "request_end";
    default:
      return "ignored";
  }
}

function modelMessagesToPi(
  messages: ModelMessage[],
  model: Model<Api>,
  toolImages = false,
): Message[] {
  const now = Date.now();
  return messages.flatMap((message, index): Message[] => {
    const timestamp = now + index;
    if (message.role === "user") {
      const content = typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part): Array<TextContent | ImageContent> => {
            if (part.type === "text") return [{ type: "text", text: part.text }];
            if (part.type === "image") {
              const image = part.image;
              if (image instanceof Uint8Array) {
                return [{
                  type: "image",
                  data: bytesToBase64(image),
                  mimeType: part.mediaType ?? "application/octet-stream",
                }];
              }
              if (typeof image === "string") {
                return [{ type: "image", data: image, mimeType: part.mediaType ?? "image/png" }];
              }
            }
            return [{ type: "text", text: `[${part.type} attachment]` }];
          });
      return [{ role: "user", content, timestamp }];
    }
    if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      if (typeof message.content === "string") {
        content.push({ type: "text", text: message.content });
      } else {
        for (const part of message.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "reasoning") {
            const options = part.providerOptions as Record<string, unknown> | undefined;
            const thinkingSignature = extractThinkingSignature(options);
            content.push({
              type: "thinking",
              thinking: part.text,
              ...(thinkingSignature ? { thinkingSignature } : {}),
            });
          } else if (part.type === "tool-call") {
            content.push({
              type: "toolCall",
              id: part.toolCallId,
              name: part.toolName,
              arguments: (part.input ?? {}) as JsonObject,
            });
          }
        }
      }
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp,
      };
      return [assistant];
    }
    if (message.role === "tool") {
      return message.content.flatMap((part): ToolResultMessage[] =>
        part.type === "tool-result"
          ? [{
              role: "toolResult",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              content: toolOutputToPi(part.output, toolImages),
              isError: false,
              timestamp,
            }]
          : [],
      );
    }
    return [];
  });
}

/**
 * Stored tool output → Pi content for the next model request. Text passes
 * capHistoryText: sessions saved before the size limits held base64 files and
 * huge outputs that no longer fit the context window.
 */
function toolOutputToPi(output: unknown, images: boolean): Array<TextContent | ImageContent> {
  if (typeof output === "string") return [{ type: "text", text: capHistoryText(output) }];
  if (!output || typeof output !== "object") return valueToPiContent(output);
  const value = output as { type?: string; value?: unknown };
  if (value.type === "text") return [{ type: "text", text: capHistoryText(String(value.value ?? "")) }];
  if (value.type === "json") return valueToPiContent(value.value);
  if (value.type === "content" && Array.isArray(value.value)) {
    return value.value.flatMap((part): Array<TextContent | ImageContent> => {
      if (!part || typeof part !== "object") return valueToPiContent(part);
      const item = part as Record<string, unknown>;
      if (item.type === "text") return [{ type: "text", text: capHistoryText(String(item.text ?? "")) }];
      if (item.type === "image-data") {
        return valueToPiContent(
          {
            type: "image",
            source: { type: "base64", media_type: String(item.mediaType ?? "image/png"), data: String(item.data ?? "") },
          },
          { images },
        );
      }
      return valueToPiContent(item);
    });
  }
  return valueToPiContent(output);
}

function extractThinkingSignature(options: Record<string, unknown> | undefined): string | undefined {
  if (!options) return undefined;
  const pi = options.pi as { thinkingSignature?: unknown } | undefined;
  if (typeof pi?.thinkingSignature === "string") return pi.thinkingSignature;
  const anthropic = options.anthropic as { signature?: unknown; redactedData?: unknown } | undefined;
  if (typeof anthropic?.signature === "string") return anthropic.signature;
  if (typeof anthropic?.redactedData === "string") return anthropic.redactedData;
  return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function dropTrailingAssistantPiMessages(messages: Message[]): Message[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role === "assistant") end--;
  return end === messages.length ? messages : messages.slice(0, end);
}

function isPiLengthStopWithNoDeliverableOutput(message: AssistantMessage): boolean {
  const hasText = message.content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
  const hasTools = message.content.some((block) => block.type === "toolCall");
  return !hasText && !hasTools;
}

function isPiCompactionRecoverableAssistantEnd(
  message: AssistantMessage,
  contextWindow?: number,
  desiredMaxOutput?: number,
): boolean {
  if (message.stopReason === "error" && contextWindow && isContextOverflow(message, contextWindow)) {
    return true;
  }
  if (message.stopReason !== "length") return false;
  if (contextWindow && isContextOverflow(message, contextWindow)) return true;
  if (isPiLengthStopWithNoDeliverableOutput(message)) return true;
  return desiredMaxOutput !== undefined && isRecoverableLength(message, desiredMaxOutput);
}

function isTransientProviderFailure(message: AssistantMessage, model: Model<Api>): boolean {
  if (message.stopReason !== "error") return false;
  if (isContextOverflow(message, model.contextWindow)) return false;
  return TRANSIENT_PROVIDER_FAILURE.test(message.errorMessage ?? "");
}

function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Retry only a context failure. Earlier text or tool calls of the turn do not
 * block it: they are in the stored history, and the retry continues from the
 * compacted view of it. A clean stop without output is a silent stop.
 */
function shouldRetryPiTurnAfterCompaction(
  outcome: PiRunOutcome,
  model: Model<Api>,
): boolean {
  const failure = outcome.providerFailure;
  if (!failure) return false;
  if (failure.stopReason === "error" && isContextOverflow(failure, model.contextWindow)) {
    return true;
  }
  if (failure.stopReason === "length") {
    const desiredMax = model.maxTokens || PI_CONTEXT_OUTPUT_RESERVE_TOKENS;
    return isContextOverflow(failure, model.contextWindow)
      || isRecoverableLength(failure, desiredMax)
      || isPiLengthStopWithNoDeliverableOutput(failure);
  }
  return false;
}
