import type { ModelMessage, LanguageModel } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import type { FileResolver } from "../runtime/history";
import type { PiModelRuntime } from "./pi-provider";

// SandboxPort + ProcessHandle live in @open-managed-agents/sandbox so
// non-CF runtimes (apps/main-node, future deployments) can implement the
// same shape without depending on apps/agent's CF-only modules. Imported
// for local use AND re-exported so existing imports keep working unchanged.
import type {
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxPort,
  ProcessHandle,
} from "@open-managed-agents/sandbox";
export type {
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxPort,
  SandboxExecutor,
  ProcessHandle,
} from "@open-managed-agents/sandbox";
export type { FileResolver, ResolvedFile } from "../runtime/history";

export type HarnessDisposeReason = "replace" | "shutdown" | "destroy";

export interface HarnessPendingInterruptContext {
  agent: AgentConfig;
  session_id: string;
  tenant_id: string;
  pendingActions: SessionEvent[];
}

export interface HarnessInterface {
  /** Main agent loop. Required. Drives generateText and emits events. */
  run(ctx: HarnessContext): Promise<void>;

  /** Interrupt work retained by an execution host after run() paused for a
   * client callback. Return only request IDs whose native turn has ended. */
  interruptPending?(ctx: HarnessPendingInterruptContext): Promise<string[]>;

  /** Release harness-owned processes. Session hosts call this before the
   * underlying Sandbox is destroyed. */
  dispose?(reason?: HarnessDisposeReason): Promise<void>;

  /**
   * Called once per session, after sandbox warmup, before the first user
   * message is processed. Typical behavior: inject
   * <system-reminder> user.message events for each skill / memory_prompt /
   * appendable_prompt the agent opted into. Override to substitute a custom
   * RAG layer, or to opt out of platform reminders entirely (no-op).
   *
   * Anything written here lands in the events stream BEFORE the first user
   * message — it becomes part of the cached prefix for every subsequent turn.
   */
  onSessionInit?(ctx: HarnessContext, runtime: HarnessRuntime): Promise<void>;

  /**
   * Decide whether to trigger compaction for this turn. Default behavior:
   * estimate tokens via deriveModelContext + heuristic, fire when > 75% of
   * the model's context window. Override for cooldown / business rules /
   * never-compact / always-compact.
   *
   * `ctx.contextWindowTokens` is the resolved model's window (best-effort —
   * may be a default if the model card doesn't expose it).
   */
  shouldCompact?(events: SessionEvent[], ctx: { contextWindowTokens: number }): boolean;

  /**
   * Execute compaction. Implementation MUST persist its product as a
   * agent.thread_context_compacted event with `summary: ContentBlock[]`
   * filled in (via runtime.broadcast). Default: send the FULL conversation
   * (same model + system + tools as main agent's last call) to the model
   * with a "summarize the above" user message appended — Anthropic's prompt
   * cache then reads the prefix instead of recomputing it.
   */
  compact?(
    events: SessionEvent[],
    runtime: HarnessRuntime,
    ctx: {
      model: LanguageModel;
      systemPrompt: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: Record<string, any>;
      providerOptions?: SharedV3ProviderOptions;
    },
  ): Promise<void>;

  /**
   * Project events → ModelMessage[] for the next generateText call. Default:
   * eventsToMessagesAsync — strict bijection inverse of writes, with
   * agent.thread_context_compacted boundary handling and async file_id
   * resolution. Override for sliding-window / RAG / hierarchical / no-compact
   * strategies.
   *
   * Output MUST be byte-deterministic for any input — Anthropic's prompt
   * cache invalidates on any prefix byte drift.
   *
   * Sync-or-async: the union return type lets a sync override keep its
   * shape. Callers always `await` the result so either form works.
   */
  deriveModelContext?(
    events: SessionEvent[],
    opts?: { fileFetcher?: FileResolver },
  ): ModelMessage[] | Promise<ModelMessage[]>;
}

export interface HarnessRuntime {
  history: HistoryStore;
  sandbox: SandboxPort;
  /**
   * Append an event to history AND broadcast to WS subscribers. The single
   * write path for harness-emitted events (model output, system_reminder,
   * compaction marker, custom marker, etc.).
   */
  broadcast: (event: SessionEvent) => void;
  /**
   * Mark the start of an in-flight LLM stream and broadcast a lifecycle
   * event to subscribers. The runtime persists the stream state to the
   * `streams` table (separate from the events log) so a deploy mid-
   * stream can be detected and the partial finalized. Lifecycle events
   * are NOT persisted to the events log — the eventual `agent.message`
   * with the same `id` is the canonical record. Idempotent on duplicate
   * start with the same id (e.g. harness retry minted a fresh id).
   */
  broadcastStreamStart: (messageId: string) => Promise<void>;
  /**
   * Append a token delta to an in-flight stream's buffer and broadcast
   * an `agent.message_chunk` event with the same message_id. Chunks are
   * buffered for restart recovery; they are NOT persisted to the events
   * log (would pollute history — the final agent.message is the source
   * of truth).
   */
  broadcastChunk: (messageId: string, delta: string) => Promise<void>;
  /**
   * Mark a stream as finished and broadcast an end lifecycle event.
   * `completed` = LLM finished cleanly; `aborted` = explicit abort or
   * harness retry minting a new id. The recovery scan uses `interrupted`
   * for streams left dangling by a runtime restart — callers shouldn't
   * pass that themselves.
   */
  broadcastStreamEnd: (
    messageId: string,
    status: "completed" | "aborted",
    errorText?: string,
  ) => Promise<void>;
  /**
   * Live thinking-block streaming. Broadcast-only — the eventual
   * `agent.thinking` event with the same `thinking_id` is the
   * persisted record. If the runtime dies mid-thinking, the
   * agent.thinking never lands and the harness retries the step (no
   * recovery work needed because nothing was committed).
   */
  broadcastThinkingStart: (thinkingId: string) => Promise<void>;
  broadcastThinkingChunk: (thinkingId: string, delta: string) => Promise<void>;
  broadcastThinkingEnd: (
    thinkingId: string,
    status: "completed" | "aborted",
  ) => Promise<void>;
  /**
   * Live tool-input streaming. `toolUseId` matches the eventual
   * `agent.tool_use` / `agent.mcp_tool_use` / `agent.custom_tool_use`
   * id. Broadcast-only — the canonical tool_use event lands once the
   * model commits the call, and recovery handles missing tool_results
   * via the existing scan (see recovery.ts).
   */
  broadcastToolInputStart: (toolUseId: string, toolName?: string) => Promise<void>;
  broadcastToolInputChunk: (toolUseId: string, delta: string) => Promise<void>;
  broadcastToolInputEnd: (
    toolUseId: string,
    status: "completed" | "aborted",
  ) => Promise<void>;
  reportUsage?: (input_tokens: number, output_tokens: number) => Promise<void>;
  /**
   * Checks the Session limit before a model request
   * (docs/plans/multiagent.md, 3.Б). At the limit it sets `limitReached`.
   * The harness then sends no request, writes no span for it and throws
   * `SessionLimitError`. A throw inside Pi's `streamFn` alone would lose its
   * type and come back as a retried model error, hence the flag.
   */
  beforeModelRequest?: () => Promise<void>;
  /** Set by `beforeModelRequest` once the Session spent its limit. */
  limitReached?: boolean;
  pendingConfirmations?: string[];
  /** Release a completed runner callback from the existing pending-action
   * state after the execution host acknowledges its response. */
  consumePendingConfirmation?: (requestId: string) => void;
  abortSignal?: AbortSignal;
  /**
   * Wrap a long async operation (e.g. model fetch + stream consumption) so
   * the underlying Durable Object stays alive — refcounted keepAlive that
   * actually prevents CF eviction during the await. Without this the
   * 30s alarm-driven keepAlive heartbeat is the only thing reminding CF
   * the DO is busy, which is too coarse: CF can evict between heartbeats
   * if no request handler is on the stack and no fetch is pending in a
   * way the runtime credits.
   *
   * Implementation: SessionDO injects `(fn) => this.keepAliveWhile(fn)`
   * (cf-agents Agent.keepAliveWhile). Always returns whatever fn returns.
   */
  keepAliveWhile?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface HarnessContext {
  agent: AgentConfig;
  userMessage: UserMessageEvent;
  /**
   * The OMA session id this turn belongs to. The session host populates
   * this on every harness.run call.
   */
  session_id?: string;
  /**
   * The OMA tenant id this session belongs to. The session host populates
   * this from its tenant state.
   */
  tenant_id?: string;

  /** Platform-prepared tools: built from agent config, ready to pass to generateText. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;

  /** AI SDK projection of the platform-prepared Pi model runtime. */
  model: LanguageModel;

  /**
   * Tenant-scoped Pi provider/model runtime. PiHarness drives the turn with
   * it; `model` above is the AI SDK projection of the same runtime.
   * Optional because not every caller builds it (tests, sub-agents).
   */
  pi?: PiModelRuntime;

  /**
   * Platform-augmented system prompt: agent.system + platform guidance
   * (authenticatedCommandGuidance + loopStopGuidance).
   * Skill/memory/appendable_prompt content is NOT here — that's injected as
   * <system-reminder> user.message events via onSessionInit (default behavior).
   * Use this directly to inherit platform defaults; ignore and use
   * `rawSystemPrompt` if you want to take full control.
   */
  systemPrompt: string;

  /**
   * Just `agent.system` verbatim, no platform additions. Use this when
   * substituting a custom system prompt build path. Optional during the
   * transition; SessionDO will populate it once task #9 lands.
   */
  rawSystemPrompt?: string;

  /**
   * Platform-resolved reminders the default `onSessionInit` will inject as
   * `<system-reminder>` user.message events on first session run. Sources:
   * skill metadata, memory_store prompts, opted-in appendable_prompts.
   *
   * Custom harnesses can ignore this and inject differently — or skip
   * platform reminders entirely by overriding onSessionInit with a no-op.
   * Each reminder lands as ONE event, persisted in the events stream
   * before any user message, so it sits in the cached prefix forever.
   */
  platformReminders?: Array<{ source: string; text: string }>;

  /**
   * Resolved skill mounts for assembly-layer exposure (Pi / default harness).
   * When set, SKILL.md bodies are not inlined into `systemPrompt` by default.
   */
  skillMounts?: Array<{
    skillId: string;
    name: string;
    description: string;
    mountRoot: string;
    body?: string;
    source?: "builtin" | "custom";
  }>;

  /**
   * Resolve a `file_id` (Anthropic Managed Agents ImageBlock/DocumentBlock
   * `source.type === "file"`) into inline bytes + media type + filename for
   * the next derive cycle. SessionDO populates this with a
   * `services.files.get` + R2 fetch composition scoped to the session's
   * tenant; sub-agents and tests may leave it undefined, in which case the
   * sync projection runs and file_id sources collapse to placeholder text.
   *
   * Idempotent failure: returning `null` is the contract for "couldn't
   * resolve" (missing, deleted, permission denied, R2 fetch error) — the
   * derive layer emits a placeholder block so the turn keeps running.
   */
  fileFetcher?: FileResolver;

  env: {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_MODEL?: string;
    TAVILY_API_KEY?: string;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
    CONFIG_KV?: KVNamespace;
    memoryStoreIds?: string[];
    environmentConfig?: { networking?: { type: string; allowed_hosts?: string[] } };
    /** Register a background task for completion notification (CC-style task_notification). */
    watchBackgroundTask?: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => void;
  };
  runtime: HarnessRuntime;
}

export interface HistoryStore {
  getMessages(): ModelMessage[];
  append(event: SessionEvent): void;
  getEvents(afterSeq?: number): SessionEvent[];
}
