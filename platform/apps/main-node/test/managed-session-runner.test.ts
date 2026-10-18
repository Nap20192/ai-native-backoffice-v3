import { describe, expect, it, vi } from "vitest";
import { withReportedArtifactPublication } from "../src/openai-artifact-publication";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { SessionLimitError, type SessionEvent } from "@open-managed-agents/shared";
import type {
  Environment,
  Session,
  SessionEventView,
  ToolResultContentBlock,
} from "@open-managed-agents/managed-agents-application";
import type {
  NodeManagedSessionRunner,
  NodeManagedSessionRunnerAcceptInput,
} from "../src/lib/node-managed-session-runtime.js";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { MemorySessionThreadStore } from "../../../packages/session-thread-store-memory/src/index";
import {
  DefaultNodeManagedSessionRunner,
  type DefaultNodeManagedSessionRunnerDependencies,
} from "../src/lib/node-managed-session-runner.js";
import type { ManagedNodeSubagentControl } from "../src/lib/node-managed-subagents.js";
import type { ManagedNodeHarnessRuntime } from "../src/lib/node-managed-harness-runtime.js";
import { sessionLimitContinuationEvent } from "../src/lib/node-session-limits.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-25T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

interface RunnerConstructor {
  new (dependencies: {
    buildSandbox(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      signal?: AbortSignal;
    }): Promise<SandboxExecutor>;
    prepareSandbox?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
      signal?: AbortSignal;
    }): Promise<void>;
    synchronizeSandbox?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
      executionFence: NonNullable<NodeManagedSessionRunnerAcceptInput["executionFence"]>;
    }): Promise<void>;
    afterExecution?(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
      runtimeGeneration: string;
      executionFence: NonNullable<NodeManagedSessionRunnerAcceptInput["executionFence"]>;
    }): Promise<void>;
    buildModel(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
    }): Promise<unknown>;
    buildTools(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      sandbox: SandboxExecutor;
    }): Promise<unknown>;
    disposeTools?(tools: unknown): Promise<void>;
    buildHarness(): { run(context: unknown): Promise<void> };
    buildHarnessContext(input: {
      workspaceId: string;
      session: Session;
      environment: Environment;
      acceptedEvents: NodeManagedSessionRunnerAcceptInput["events"];
      sandbox: SandboxExecutor;
      runtime: {
        broadcast(event: SessionEvent): void;
      };
      model: unknown;
      tools: unknown;
    }): Promise<unknown>;
    confirmedTools: {
      execute(input: {
        workspaceId: string;
        session: Session;
        environment: Environment;
        sandbox: SandboxExecutor;
        confirmation: Extract<
          NodeManagedSessionRunnerAcceptInput["events"][number],
          { type: "user.tool_confirmation" }
        >;
        toolUse: Extract<
          SessionEventView,
          { type: "agent.tool_use" | "agent.mcp_tool_use" }
        >;
        abortSignal: AbortSignal;
      }): Promise<{
        content?: ToolResultContentBlock[];
        isError?: boolean | null;
      }>;
    };
    outcomes: {
      evaluate(input: {
        workspaceId: string;
        session: Session;
        environment: Environment;
        outcome: Extract<
          NodeManagedSessionRunnerAcceptInput["events"][number],
          { type: "user.define_outcome" }
        >;
        historyEvents: SessionEventView[];
        iteration: number;
        abortSignal: AbortSignal;
      }): Promise<{
        result: "satisfied" | "needs_revision" | "failed";
        explanation: string;
        usage: {
          cacheCreationInputTokens: number;
          cacheReadInputTokens: number;
          inputTokens: number;
          outputTokens: number;
        };
      }>;
    };
    clock: { now(): Date };
    ids: { nextEventId(): string };
    runtimeGenerations?: { next(): string };
  }): NodeManagedSessionRunner & { connectedSandbox(input: { workspaceId: string; sessionId: string }): SandboxExecutor | null };
}

describe("DefaultNodeManagedSessionRunner", () => {
  it("prepares Session inputs after sandbox creation and before it becomes executable", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const order: string[] = [];
    const sandbox = {
      destroy: vi.fn(async () => { order.push("destroy"); }),
    } as unknown as SandboxExecutor;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => {
        order.push("build");
        return sandbox;
      },
      prepareSandbox: async (input) => {
        expect(input).toMatchObject({
          workspaceId: "workspace_01",
          session,
          environment,
          sandbox,
        });
        order.push("prepare");
      },
      buildModel: async () => {
        order.push("model");
        return {};
      },
      buildTools: async () => {
        order.push("tools");
        return {};
      },
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_inputs" },
    });

    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBeNull();
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    expect(order).toEqual(["build", "prepare"]);
    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBe(sandbox);
    expect(runner.connectedSandbox({ workspaceId: "workspace_other", sessionId: session.id })).toBeNull();
    await runner.stop({ workspaceId: "workspace_01", sessionId: session.id });
    expect(runner.connectedSandbox({ workspaceId: "workspace_01", sessionId: session.id })).toBeNull();
  });

  it("destroys a new sandbox when Session input preparation fails", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const destroy = vi.fn(async () => undefined);
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({ destroy } as unknown as SandboxExecutor),
      prepareSandbox: async () => { throw new Error("input staging failed"); },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_inputs" },
    });

    await expect(runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    })).rejects.toThrow("input staging failed");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("replaces a prepared sandbox when the Session resource snapshot changes", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const destroyed: number[] = [];
    const preparedResourceCounts: number[] = [];
    let generation = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => {
        generation += 1;
        const current = generation;
        return {
          destroy: async () => { destroyed.push(current); },
        } as SandboxExecutor;
      },
      prepareSandbox: async ({ session }) => {
        preparedResourceCounts.push(session.resources.length);
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => "event_resource_refresh" },
    });
    const changedSession: Session = {
      ...session,
      resources: [{
        id: "sesrsc_file_01",
        type: "file",
        createdAt: "2026-08-26T03:00:00.000Z",
        fileId: "file_01",
        mountPath: "/mnt/session/uploads/file_01",
        updatedAt: "2026-08-26T03:00:00.000Z",
      }],
    };

    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session: changedSession,
      environment,
      initialEvents: [],
    });

    expect(preparedResourceCounts).toEqual([0, 1]);
    expect(destroyed).toEqual([1]);
  });

  it("runs a user message between official lifecycle events", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath).catch(
      () => ({}),
    ) as { DefaultNodeManagedSessionRunner?: RunnerConstructor };
    const Runner = runnerModule.DefaultNodeManagedSessionRunner ?? class {
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      async accept(): Promise<void> {}
      async archiveThread(): Promise<void> {}
    } as RunnerConstructor;
    const sandbox = {} as SandboxExecutor;
    const contexts: unknown[] = [];
    const lifecycle: string[] = [];
    const builtTools = { bash: { type: "tool" } };
    let nextId = 0;
    const runner = new Runner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({ type: "model" }),
      buildTools: async () => builtTools,
      disposeTools: async (tools) => {
        expect(tools).toBe(builtTools);
        lifecycle.push("dispose");
      },
      synchronizeSandbox: async (input) => {
        expect(input).toMatchObject({
          workspaceId: "workspace_01",
          session,
          environment,
          sandbox,
          runtimeGeneration: "runtime_generation_01",
          executionFence: {
            executionId: "event_user_01",
            attemptId: "attempt_01",
            ownerId: "worker_01",
            generation: 1,
          },
        });
        lifecycle.push("synchronize");
      },
      afterExecution: withReportedArtifactPublication(async input => {
        expect(input.executionFence.executionId).toBe("event_user_01");
        expect(lifecycle.at(-1)).toBe("idle");
        lifecycle.push("afterExecution");
        throw new Error("Output copy failed after completion");
      }, (error, input) => {
        expect(error).toMatchObject({ message: "Output copy failed after completion" });
        expect(input.session.id).toBe(session.id);
        lifecycle.push("publicationReported");
      }),
      buildHarness: () => ({
        run: async (context) => {
          lifecycle.push("run");
          const runtime = (context as {
            runtime: { broadcast(event: SessionEvent): void };
          }).runtime;
          runtime.broadcast({
            type: "agent.message",
            content: [{ type: "text", text: "Hello" }],
          } as SessionEvent);
        },
      }),
      buildHarnessContext: async (input) => {
        contexts.push(input);
        return input;
      },
      clock: { now: () => new Date("2026-08-26T02:00:00.000Z") },
      ids: { nextEventId: () => `event_runtime_0${++nextId}` },
      runtimeGenerations: { next: () => "runtime_generation_01" },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_01",
      type: "user.message",
      content: [{ type: "text", text: "Continue" }],
      processedAt: "2026-08-26T01:00:00.000Z",
    };
    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [event],
      historyEvents: [event],
      executionFence: {
        workspaceId: "workspace_01",
        sessionId: session.id,
        executionId: "event_user_01",
        attemptId: "attempt_01",
        ownerId: "worker_01",
        generation: 1,
        expiresAt: "2026-08-26T02:01:00.000Z",
      },
      output: async (frame) => {
        output.push(frame);
        if ((frame as { type?: string }).type === "session.status_idle") {
          lifecycle.push("idle");
        }
      },
    });

    expect(contexts).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_01",
        session,
        environment,
        acceptedEvents: [event],
        sandbox,
        model: { type: "model" },
        tools: { bash: { type: "tool" } },
        runtime: expect.any(Object),
      }),
    ]);
    expect(output).toEqual([
      {
        id: "event_runtime_01",
        type: "session.status_running",
        processed_at: "2026-08-26T02:00:00.000Z",
      },
      {
        id: "event_runtime_02",
        type: "agent.message",
        content: [{ type: "text", text: "Hello" }],
        processed_at: "2026-08-26T02:00:00.001Z",
      },
      {
        id: "event_runtime_03",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T02:00:00.002Z",
      },
    ]);
    expect(lifecycle).toEqual(["run", "dispose", "synchronize", "idle", "afterExecution", "publicationReported"]);
  });

  async function failingHarnessTurn(run: (context: { runtime: { broadcast(event: unknown): void } }) => Promise<void>) {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let nextId = 0;
    let runs = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({}) as SandboxExecutor,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async (context) => { runs += 1; await run(context as never); } }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:00:00.000Z") },
      ids: { nextEventId: () => `event_error_0${++nextId}` },
      harnessRetry: { attempts: 3, delayMs: () => 0 },
    } as never);
    await runner.start({ workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [] });
    const output: Array<Record<string, unknown>> = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_02", type: "user.message",
      content: [{ type: "text", text: "Retry" }], processedAt: "2026-08-26T02:30:00.000Z",
    };
    const result = await runner.accept({
      workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [],
      events: [event], historyEvents: [event],
      output: async (frame) => { output.push(frame as Record<string, unknown>); },
    }).then(() => undefined, (error: unknown) => error);
    const summary = output.map((frame) => frame.type === "session.error"
      ? `error:${(frame.error as { retry_status: string }).retry_status}`
      : frame.type === "session.status_idle"
        ? `idle:${(frame.stop_reason as { type: string }).type}`
        : String(frame.type));
    return { result, runs, summary };
  }

  it("reports a failed turn as exhausted without retry once the agent produced side effects", async () => {
    const { result, runs, summary } = await failingHarnessTurn(async ({ runtime }) => {
      runtime.broadcast({ type: "agent.tool_use", id: "tool_01", name: "bash", input: { command: "touch x" } });
      throw new Error("model unavailable");
    });
    expect((result as Error).message).toBe("model unavailable");
    expect(runs).toBe(1);
    expect(summary).toEqual(["session.status_running", "agent.tool_use", "error:exhausted", "idle:retries_exhausted"]);
  });

  it("retries a harness failure in place while the turn has no agent side effects", async () => {
    let failures = 2;
    const { result, runs, summary } = await failingHarnessTurn(async () => {
      if (failures-- > 0) throw new Error("No output generated. Check the stream for errors.");
    });
    expect(result).toBeUndefined();
    expect(runs).toBe(3);
    expect(summary).toEqual([
      "session.status_running",
      "error:retrying", "session.status_rescheduled",
      "error:retrying", "session.status_rescheduled",
      "idle:end_turn",
    ]);
  });

  it("reports exhausted after the side-effect-free retries run out", async () => {
    const { result, runs, summary } = await failingHarnessTurn(async () => { throw new Error("model unavailable"); });
    expect((result as Error).message).toBe("model unavailable");
    expect(runs).toBe(3);
    expect(summary).toEqual([
      "session.status_running",
      "error:retrying", "session.status_rescheduled",
      "error:retrying", "session.status_rescheduled",
      "error:exhausted", "idle:retries_exhausted",
    ]);
  });

  it("reports a failed fenced final collection as exhausted and goes idle", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      synchronizeSandbox: async () => { throw new Error("final collect failed"); },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:15:00.000Z") },
      ids: { nextEventId: () => `event_collect_failure_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_collect_failure",
      type: "user.message",
      content: [{ type: "text", text: "Collect" }],
      processedAt: "2026-08-26T03:14:00.000Z",
    };

    await expect(runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [event],
      historyEvents: [event],
      executionFence: {
        executionId: "execution_collect_failure",
        workspaceId: "workspace_01",
        sessionId: session.id,
        attemptId: "attempt_collect_failure",
        ownerId: "node_01",
        generation: 1,
        expiresAt: "2026-08-26T03:16:00.000Z",
      },
      output: async (frame) => { output.push(frame); },
    })).rejects.toThrow("final collect failed");

    expect(output).toEqual([
      {
        id: "event_collect_failure_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:15:00.000Z",
      },
      {
        id: "event_collect_failure_02",
        type: "session.error",
        error: {
          type: "unknown_error",
          message: "final collect failed",
          retry_status: "exhausted",
        },
        processed_at: "2026-08-26T03:15:00.001Z",
      },
      {
        id: "event_collect_failure_03",
        type: "session.status_idle",
        stop_reason: { type: "retries_exhausted" },
        processed_at: "2026-08-26T03:15:00.002Z",
      },
    ]);
  });

  it.each([
    {
      type: "user.custom_tool_result" as const,
      customToolUseId: "event_custom_tool_01",
    },
    {
      type: "user.tool_result" as const,
      toolUseId: "event_custom_tool_01",
    },
  ])("resumes one turn for $type", async (result) => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const contexts: Array<{ acceptedEvents: unknown[] }> = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async () => { runs += 1; },
      }),
      buildHarnessContext: async (input) => {
        contexts.push(input);
        return input;
      },
      clock: { now: () => new Date("2026-08-26T03:30:00.000Z") },
      ids: { nextEventId: () => `event_resume_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const event: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_result_01",
      ...result,
      content: [{ type: "text", text: "Sunny" }],
      isError: false,
      processedAt: "2026-08-26T03:15:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [event],
      initialEvents: [],
      historyEvents: [
        {
          id: "event_custom_tool_01",
          type: "agent.custom_tool_use",
          name: "weather",
          input: { city: "Shanghai" },
          processedAt: "2026-08-26T03:00:00.000Z",
        },
        event,
      ],
      output: async (frame) => { output.push(frame); },
    });

    expect(runs).toBe(1);
    expect(contexts).toEqual([
      expect.objectContaining({ acceptedEvents: [event] }),
    ]);
    expect(output).toEqual([
      {
        id: "event_resume_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:30:00.000Z",
      },
      {
        id: "event_resume_02",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T03:30:00.001Z",
      },
    ]);
  });

  it.each([
    {
      result: "allow" as const,
      expectedContent: [{ type: "text" as const, text: "command completed" }],
      expectedIsError: false,
      expectedExecutions: 1,
    },
    {
      result: "deny" as const,
      denyMessage: "Do not run destructive commands",
      expectedContent: [{
        type: "text" as const,
        text: "Denied: Do not run destructive commands",
      }],
      expectedIsError: true,
      expectedExecutions: 0,
    },
  ])("handles a $result tool confirmation before resuming", async (verdict) => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const sandbox = {} as SandboxExecutor;
    const executions: object[] = [];
    let runs = 0;
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: {
        execute: async (input) => {
          executions.push(input);
          return {
            content: [{ type: "text", text: "command completed" }],
            isError: false,
          };
        },
      },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => { runs += 1; } }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T03:45:00.000Z") },
      ids: { nextEventId: () => `event_confirmation_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const toolUse: Extract<
      SessionEventView,
      { type: "agent.tool_use" }
    > = {
      id: "event_tool_use_01",
      type: "agent.tool_use",
      name: "bash",
      input: { command: "pwd" },
      evaluatedPermission: "ask",
      processedAt: "2026-08-26T03:35:00.000Z",
    };
    const confirmation: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_confirmation_01",
      type: "user.tool_confirmation",
      result: verdict.result,
      toolUseId: toolUse.id,
      ...(verdict.denyMessage !== undefined && {
        denyMessage: verdict.denyMessage,
      }),
      processedAt: "2026-08-26T03:40:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [confirmation],
      initialEvents: [],
      historyEvents: [toolUse, confirmation],
      output: async (frame) => { output.push(frame); },
    });

    expect(executions).toHaveLength(verdict.expectedExecutions);
    if (verdict.result === "allow") {
      expect(executions[0]).toEqual({
        workspaceId: "workspace_01",
        session,
        environment,
        sandbox,
        confirmation,
        toolUse,
        abortSignal: expect.any(AbortSignal),
      });
    }
    expect(runs).toBe(1);
    expect(output).toEqual([
      {
        id: "event_confirmation_01",
        type: "session.status_running",
        processed_at: "2026-08-26T03:45:00.000Z",
      },
      {
        id: "event_confirmation_02",
        type: "agent.tool_result",
        tool_use_id: toolUse.id,
        content: verdict.expectedContent,
        is_error: verdict.expectedIsError,
        processed_at: "2026-08-26T03:45:00.001Z",
      },
      {
        id: "event_confirmation_03",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T03:45:00.002Z",
      },
    ]);
  });

  describe("one confirmation runs the call once (plan cma-wave-1, 3.1, slice 4)", () => {
    const writeAct = (threadId?: string): Extract<
      SessionEventView,
      { type: "agent.mcp_tool_use" }
    > => ({
      id: "event_mcp_tool_use_01",
      type: "agent.mcp_tool_use",
      mcpServerName: "iiko",
      name: "write_act",
      input: { act: "A-1" },
      evaluatedPermission: "ask",
      processedAt: "2026-08-26T03:35:00.000Z",
      ...(threadId !== undefined && { sessionThreadId: threadId }),
    });
    const allow = (id: string, processedAt: string): Extract<
      NodeManagedSessionRunnerAcceptInput["events"][number],
      { type: "user.tool_confirmation" }
    > => ({
      id,
      type: "user.tool_confirmation",
      result: "allow",
      toolUseId: "event_mcp_tool_use_01",
      processedAt,
    });
    const writeActResult = (threadId?: string): Extract<
      SessionEventView,
      { type: "agent.mcp_tool_result" }
    > => ({
      id: "event_mcp_tool_result_01",
      type: "agent.mcp_tool_result",
      mcpToolUseId: "event_mcp_tool_use_01",
      content: [{ type: "text", text: "act written" }],
      isError: false,
      processedAt: "2026-08-26T03:41:00.000Z",
      ...(threadId !== undefined && { sessionThreadId: threadId }),
    });

    async function acceptConfirmations(input: {
      events: NodeManagedSessionRunnerAcceptInput["events"];
      historyEvents: SessionEventView[];
    }) {
      const modulePath = "../src/lib/node-managed-session-runner.ts";
      const runnerModule = await import(/* @vite-ignore */ modulePath) as {
        DefaultNodeManagedSessionRunner: RunnerConstructor;
      };
      const executions: string[] = [];
      let nextId = 0;
      let turns = 0;
      const runner = new runnerModule.DefaultNodeManagedSessionRunner({
        outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
        confirmedTools: {
          execute: async (call) => {
            executions.push(call.toolUse.id);
            return { content: [{ type: "text", text: "act written" }], isError: false };
          },
        },
        buildSandbox: async () => ({}) as SandboxExecutor,
        buildModel: async () => ({}),
        buildTools: async () => ({}),
        buildHarness: () => ({ run: async () => { turns += 1; } }),
        buildHarnessContext: async (context) => context,
        clock: { now: () => new Date("2026-08-26T03:45:00.000Z") },
        ids: { nextEventId: () => `event_once_0${++nextId}` },
      });
      await runner.start({
        workspaceId: "workspace_01",
        sessionId: session.id,
        session,
        environment,
        initialEvents: [],
      });
      const output: Array<{ type?: string }> = [];
      await runner.accept({
        workspaceId: "workspace_01",
        sessionId: session.id,
        session,
        environment,
        events: input.events,
        initialEvents: [],
        historyEvents: input.historyEvents,
        output: async (frame) => { output.push(frame as { type?: string }); },
      });
      return {
        executions,
        turns,
        results: output.filter((frame) => frame.type === "agent.mcp_tool_result"),
      };
    }

    it("a second allow on a call that already has a result runs nothing", async () => {
      const first = allow("event_user_confirmation_01", "2026-08-26T03:40:00.000Z");
      const second = allow("event_user_confirmation_02", "2026-08-26T03:44:00.000Z");

      const { executions, results } = await acceptConfirmations({
        events: [second],
        historyEvents: [writeAct(), first, writeActResult(), second],
      });

      expect(executions).toEqual([]);
      expect(results).toEqual([]);
    });

    it("skips a call whose result sits in another thread's history", async () => {
      const first = allow("event_user_confirmation_01", "2026-08-26T03:40:00.000Z");
      const second = allow("event_user_confirmation_02", "2026-08-26T03:44:00.000Z");

      const { executions, results } = await acceptConfirmations({
        events: [second],
        historyEvents: [
          writeAct("sthr_child"),
          first,
          writeActResult("sthr_child"),
          second,
        ],
      });

      expect(executions).toEqual([]);
      expect(results).toEqual([]);
    });

    it("still runs a later call that reuses the tool id of an answered one", async () => {
      const first = allow("event_user_confirmation_01", "2026-08-26T03:40:00.000Z");
      const second = allow("event_user_confirmation_02", "2026-08-26T03:44:00.000Z");
      const laterCall = { ...writeAct(), processedAt: "2026-08-26T03:43:00.000Z" };

      const { executions, results } = await acceptConfirmations({
        events: [second],
        historyEvents: [writeAct(), first, writeActResult(), laterCall, second],
      });

      expect(executions).toEqual(["event_mcp_tool_use_01"]);
      expect(results).toHaveLength(1);
    });

    // A repeated allow wakes no model either: the turn after the first allow
    // already ran, a second one would repeat its messages and builtin calls.
    it("a second allow on an answered call starts no model turn", async () => {
      const first = allow("event_user_confirmation_01", "2026-08-26T03:40:00.000Z");
      const second = allow("event_user_confirmation_02", "2026-08-26T03:44:00.000Z");

      const { executions, turns } = await acceptConfirmations({
        events: [second],
        historyEvents: [writeAct(), first, writeActResult(), second],
      });

      expect(executions).toEqual([]);
      expect(turns).toBe(0);
    });

    it("a replayed confirmation finds its own result and still finishes the turn", async () => {
      const first = allow("event_user_confirmation_01", "2026-08-26T03:40:00.000Z");

      // The worker wrote the result and died before the turn ended.
      const { executions, results, turns } = await acceptConfirmations({
        events: [first],
        historyEvents: [writeAct(), first, writeActResult()],
      });

      expect(executions).toEqual([]);
      expect(results).toEqual([]);
      expect(turns).toBe(1);
    });

    it("a user message next to a repeated allow still gets its turn", async () => {
      const first = allow("event_user_confirmation_01", "2026-08-26T03:40:00.000Z");
      const message: NodeManagedSessionRunnerAcceptInput["events"][number] = {
        id: "event_user_message_02",
        type: "user.message",
        content: [{ type: "text", text: "Что дальше?" }],
        processedAt: "2026-08-26T03:43:00.000Z",
      };
      const second = allow("event_user_confirmation_02", "2026-08-26T03:44:00.000Z");

      const { executions, turns } = await acceptConfirmations({
        events: [message, second],
        historyEvents: [writeAct(), first, writeActResult(), message, second],
      });

      expect(executions).toEqual([]);
      expect(turns).toBe(1);
    });

    it("two allows of one waiting call in the same run execute it once", async () => {
      const first = allow("event_user_confirmation_01", "2026-08-26T03:40:00.000Z");
      const second = allow("event_user_confirmation_02", "2026-08-26T03:40:01.000Z");

      const { executions, results } = await acceptConfirmations({
        events: [first, second],
        historyEvents: [writeAct(), first, second],
      });

      expect(executions).toEqual(["event_mcp_tool_use_01"]);
      expect(results).toHaveLength(1);
    });
  });

  it("runs and evaluates a defined outcome through official spans", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const evaluations: object[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: {
        evaluate: async (input) => {
          evaluations.push(input);
          return {
            result: "satisfied",
            explanation: "All contract checks pass",
            usage: {
              cacheCreationInputTokens: 1,
              cacheReadInputTokens: 2,
              inputTokens: 30,
              outputTokens: 4,
            },
          };
        },
      },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => { runs += 1; } }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T05:30:00.000Z") },
      ids: { nextEventId: () => `event_outcome_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const outcome: Extract<
      NodeManagedSessionRunnerAcceptInput["events"][number],
      { type: "user.define_outcome" }
    > = {
      id: "event_define_outcome_01",
      type: "user.define_outcome",
      description: "Ship the migration",
      rubric: { type: "text", content: "All SDK contracts pass" },
      maxIterations: 3,
      outcomeId: "outc_01",
      processedAt: "2026-08-26T05:00:00.000Z",
    };
    const output: unknown[] = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [outcome],
      initialEvents: [],
      historyEvents: [outcome],
      output: async (frame) => { output.push(frame); },
    });

    expect(runs).toBe(1);
    expect(evaluations).toEqual([{
      workspaceId: "workspace_01",
      session,
      environment,
      outcome,
      historyEvents: [
        outcome,
        {
          id: "event_outcome_01",
          type: "session.status_running",
          processedAt: "2026-08-26T05:30:00.000Z",
        },
      ],
      iteration: 0,
      abortSignal: expect.any(AbortSignal),
    }]);
    expect(output).toEqual([
      {
        id: "event_outcome_01",
        type: "session.status_running",
        processed_at: "2026-08-26T05:30:00.000Z",
      },
      {
        id: "event_outcome_02",
        type: "span.outcome_evaluation_start",
        iteration: 0,
        outcome_id: "outc_01",
        processed_at: "2026-08-26T05:30:00.001Z",
      },
      {
        id: "event_outcome_03",
        type: "span.outcome_evaluation_ongoing",
        iteration: 0,
        outcome_id: "outc_01",
        processed_at: "2026-08-26T05:30:00.002Z",
      },
      {
        id: "event_outcome_04",
        type: "span.outcome_evaluation_end",
        explanation: "All contract checks pass",
        iteration: 0,
        outcome_evaluation_start_id: "event_outcome_02",
        outcome_id: "outc_01",
        result: "satisfied",
        usage: {
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 2,
          input_tokens: 30,
          output_tokens: 4,
        },
        processed_at: "2026-08-26T05:30:00.003Z",
      },
      {
        id: "event_outcome_05",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T05:30:00.004Z",
      },
    ]);
  });

  it("revises an outcome until max_iterations_reached", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let runs = 0;
    let nextId = 0;
    const iterations: number[] = [];
    const contexts: unknown[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: {
        evaluate: async (input) => {
          iterations.push(input.iteration);
          return {
            result: "needs_revision",
            explanation: `revision ${input.iteration} required`,
            usage: {
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              inputTokens: 1,
              outputTokens: 1,
            },
          };
        },
      },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({} as SandboxExecutor),
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context) => {
          runs += 1;
          contexts.push(context);
        },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T06:00:00.000Z") },
      ids: { nextEventId: () => `event_revision_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const outcome: Extract<
      NodeManagedSessionRunnerAcceptInput["events"][number],
      { type: "user.define_outcome" }
    > = {
      id: "event_define_outcome_02",
      type: "user.define_outcome",
      description: "Ship the migration",
      rubric: { type: "text", content: "All SDK contracts pass" },
      maxIterations: 2,
      outcomeId: "outc_02",
      processedAt: "2026-08-26T05:45:00.000Z",
    };
    const output: Array<{ type?: string; result?: string }> = [];

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [outcome],
      initialEvents: [],
      historyEvents: [outcome],
      output: async (frame) => {
        output.push(frame as { type?: string; result?: string });
      },
    });

    expect(runs).toBe(2);
    expect(iterations).toEqual([0, 1]);
    expect(output
      .filter((event) => event.type === "span.outcome_evaluation_end")
      .map((event) => event.result)).toEqual([
        "needs_revision",
        "max_iterations_reached",
      ]);
    const revisionContext = contexts[1] as {
      runtime: { history: { getMessages(): Array<{ role: string; content: unknown }> } };
    };
    expect(revisionContext.runtime.history.getMessages().at(-1)).toEqual({
      role: "user",
      content: [{
        type: "text",
        text: [
          '<outcome_feedback iteration="0">',
          "revision 0 required",
          "",
          "Address the feedback and try again.",
          "</outcome_feedback>",
        ].join("\n"),
      }],
    });
  });

  describe("outcome evaluation waits for a confirmation (plan cma-wave-1, 3.1, slice 5)", () => {
    const writeAct = {
      type: "agent.mcp_tool_use",
      id: "event_mcp_tool_use_ask",
      mcp_server_name: "iiko",
      name: "write_act",
      input: { act: "A-1" },
      evaluated_permission: "ask",
    } as SessionEvent;
    const outcome: Extract<
      NodeManagedSessionRunnerAcceptInput["events"][number],
      { type: "user.define_outcome" }
    > = {
      id: "event_define_outcome_ask",
      type: "user.define_outcome",
      description: "Write the act",
      rubric: { type: "text", content: "The act is written" },
      maxIterations: 3,
      outcomeId: "outc_ask",
      processedAt: "2026-08-26T05:00:00.000Z",
    };

    async function runOutcome(input: {
      /** Harness runs (0-based) that stop on a call waiting for "Разрешить". */
      askOnRuns: number[];
      evaluation: "satisfied" | "needs_revision";
    }) {
      const modulePath = "../src/lib/node-managed-session-runner.ts";
      const runnerModule = await import(/* @vite-ignore */ modulePath) as {
        DefaultNodeManagedSessionRunner: RunnerConstructor;
      };
      let runs = 0;
      let nextId = 0;
      const iterations: number[] = [];
      const runner = new runnerModule.DefaultNodeManagedSessionRunner({
        outcomes: {
          evaluate: async (call) => {
            iterations.push(call.iteration);
            return {
              result: input.evaluation,
              explanation: "write the act",
              usage: { cacheCreationInputTokens: 0, cacheReadInputTokens: 0, inputTokens: 1, outputTokens: 1 },
            };
          },
        },
        confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
        buildSandbox: async () => ({} as SandboxExecutor),
        buildModel: async () => ({}),
        buildTools: async () => ({}),
        buildHarness: () => ({
          run: async (context) => {
            const run = runs;
            runs += 1;
            if (!input.askOnRuns.includes(run)) return;
            (context as { runtime: { broadcast(event: SessionEvent): void } })
              .runtime.broadcast(writeAct);
          },
        }),
        buildHarnessContext: async (context) => context,
        clock: { now: () => new Date("2026-08-26T05:30:00.000Z") },
        ids: { nextEventId: () => `event_outcome_ask_0${++nextId}` },
      });
      await runner.start({
        workspaceId: "workspace_01",
        sessionId: session.id,
        session,
        environment,
        initialEvents: [],
      });
      const output: Array<{ type?: string; result?: string; stop_reason?: object }> = [];
      await runner.accept({
        workspaceId: "workspace_01",
        sessionId: session.id,
        session,
        environment,
        events: [outcome],
        initialEvents: [],
        historyEvents: [outcome],
        output: async (frame) => { output.push(frame as (typeof output)[number]); },
      });
      return { runs, iterations, output };
    }

    it("does not evaluate while a call of the turn waits for a confirmation", async () => {
      const { runs, iterations, output } = await runOutcome({ askOnRuns: [0], evaluation: "satisfied" });

      expect(runs).toBe(1);
      expect(iterations).toEqual([]);
      expect(output.some((frame) => frame.type === "span.outcome_evaluation_start")).toBe(false);
      expect(output.at(-1)).toMatchObject({
        type: "session.status_idle",
        stop_reason: { type: "requires_action", event_ids: ["event_mcp_tool_use_ask"] },
      });
    });

    it("stops a revision that waits for a confirmation before the next evaluation", async () => {
      const { runs, iterations, output } = await runOutcome({ askOnRuns: [1], evaluation: "needs_revision" });

      expect(runs).toBe(2);
      expect(iterations).toEqual([0]);
      expect(output
        .filter((frame) => frame.type === "span.outcome_evaluation_end")
        .map((frame) => frame.result)).toEqual(["needs_revision"]);
      expect(output.at(-1)).toMatchObject({
        type: "session.status_idle",
        stop_reason: { type: "requires_action", event_ids: ["event_mcp_tool_use_ask"] },
      });
    });
  });

  it("interrupts the active turn without starting another harness run", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const sandbox = {} as SandboxExecutor;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let aborted = false;
    let runs = 0;
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => sandbox,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context) => {
          runs += 1;
          const signal = (context as {
            runtime: { abortSignal?: AbortSignal };
          }).runtime.abortSignal;
          markStarted?.();
          if (signal === undefined) return;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            }, { once: true });
          });
        },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => `event_interrupt_0${++nextId}` },
    });
    await runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    const output: unknown[] = [];
    const message: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_03",
      type: "user.message",
      content: [{ type: "text", text: "Long task" }],
      processedAt: "2026-08-26T03:30:00.000Z",
    };
    const turn = runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [message],
      historyEvents: [message],
      output: async (frame) => { output.push(frame); },
    });
    await started;
    const interrupt: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_interrupt_input_01",
      type: "user.interrupt",
      processedAt: "2026-08-26T03:31:00.000Z",
    };

    await runner.accept({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      events: [interrupt],
      historyEvents: [message, interrupt],
      output: async (frame) => { output.push(frame); },
    });
    await turn;

    expect(runs).toBe(1);
    expect(aborted).toBe(true);
    expect(output).toEqual([
      {
        id: "event_interrupt_01",
        type: "session.status_running",
        processed_at: "2026-08-26T04:00:00.000Z",
      },
      {
        id: "event_interrupt_02",
        type: "session.status_idle",
        stop_reason: { type: "end_turn" },
        processed_at: "2026-08-26T04:00:00.001Z",
      },
    ]);
  });

  it("does not report a failed turn when the execution lease was lost (another owner takes over)", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let nextId = 0;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => ({}) as SandboxExecutor,
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({
        run: async (context) => {
          const signal = (context as { runtime: { abortSignal?: AbortSignal } }).runtime.abortSignal!;
          markStarted?.();
          // A model request rejects when its signal aborts.
          await new Promise<void>((_, reject) => signal.addEventListener("abort",
            () => reject(new Error("This operation was aborted")), { once: true }));
        },
      }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => `event_lease_0${++nextId}` },
    });
    await runner.start({ workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [] });
    const output: Array<{ type: string }> = [];
    const message: NodeManagedSessionRunnerAcceptInput["events"][number] = {
      id: "event_user_lease", type: "user.message",
      content: [{ type: "text", text: "Long task" }], processedAt: "2026-08-26T03:30:00.000Z",
    };
    const turn = runner.accept({ workspaceId: "workspace_01", sessionId: session.id, session, environment,
      initialEvents: [], events: [message], historyEvents: [message],
      output: async (frame) => { output.push(frame as { type: string }); } });
    await started;
    runner.cancel({ workspaceId: "workspace_01", sessionId: session.id, reason: "lease_lost" });
    await expect(turn).rejects.toThrow("aborted");
    expect(output.map((frame) => frame.type)).toEqual(["session.status_running"]);
  });

  it("owns and destroys sandboxes by workspace and session scope", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    const built: string[] = [];
    const destroyed: string[] = [];
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async ({ workspaceId }) => {
        built.push(workspaceId);
        return {
          destroy: async () => { destroyed.push(workspaceId); },
        } as SandboxExecutor;
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => "event_scope" },
    });
    const start = (workspaceId: string) => runner.start({
      workspaceId,
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await start("workspace_a");
    await start("workspace_b");
    expect(built).toEqual(["workspace_a", "workspace_b"]);

    await runner.stop({
      workspaceId: "workspace_a",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    expect(destroyed).toEqual(["workspace_a"]);
    await runner.stop({
      workspaceId: "workspace_b",
      sessionId: session.id,
      session,
      reason: "deleted",
    });
    expect(destroyed).toEqual(["workspace_a", "workspace_b"]);
  });

  it("aborts sandbox acquisition when startup is cancelled and destroys a late sandbox", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let finishCreate: ((sandbox: SandboxExecutor) => void) | undefined;
    let destroyed = false;
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: () => {
        markStarted?.();
        return new Promise<SandboxExecutor>((resolve) => { finishCreate = resolve; });
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => "event_cancel_start" },
    });
    const controller = new AbortController();
    const pending = runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
      signal: controller.signal,
    });
    await started;
    const startedAt = Date.now();
    controller.abort(Object.assign(new Error("interrupt_requested"), { name: "AbortError" }));
    await expect(pending).rejects.toThrow("interrupt_requested");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    finishCreate?.({
      destroy: async () => { destroyed = true; },
    } as SandboxExecutor);
    await vi.waitFor(() => { expect(destroyed).toBe(true); });
  });

  it("cancels an in-flight sandbox acquisition through runner.cancel", async () => {
    const modulePath = "../src/lib/node-managed-session-runner.ts";
    const runnerModule = await import(/* @vite-ignore */ modulePath) as {
      DefaultNodeManagedSessionRunner: RunnerConstructor;
    };
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const runner = new runnerModule.DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: ({ signal }) => {
        markStarted?.();
        return new Promise<SandboxExecutor>((_resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("session_stopped"), { name: "AbortError" }));
          if (signal?.aborted) { fail(); return; }
          signal?.addEventListener("abort", fail, { once: true });
        });
      },
      buildModel: async () => ({}),
      buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => input,
      clock: { now: () => new Date("2026-08-26T04:00:00.000Z") },
      ids: { nextEventId: () => "event_cancel_runner" },
    });
    const pending = runner.start({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      initialEvents: [],
    });
    await started;
    runner.cancel({ workspaceId: "workspace_01", sessionId: session.id, reason: "session_stopped" });
    await expect(pending).rejects.toThrow("session_stopped");
  });
});

// A call of a subagent thread on always_ask waits for a person: the thread and
// the session stop on requires_action with that call (plan multiagent, 3.1,
// slice 2). Allowing the call in the subagent's thread is slice 3.
describe("a subagent call waits for a person (plan multiagent 3.1, slice 2)", () => {
  const WAITING = "The subagent is waiting for a tool confirmation. Its report will arrive as a separate message.";
  const checker = {
    type: "agent" as const,
    id: "agent_checker",
    description: null,
    mcpServers: [],
    model: { id: "local-model" },
    name: "Checker",
    skills: [],
    system: "Check the folder",
    tools: [{
      type: "agent_toolset_20260401" as const,
      configs: [{ name: "bash" as const, type: "bash" as const, enabled: true, permissionPolicy: { type: "always_ask" as const } }],
      defaultConfig: { enabled: true, permissionPolicy: { type: "always_allow" as const } },
    }],
    version: 1,
  };
  const coordinator: Session = {
    ...session,
    id: "session_waits",
    agent: { ...session.agent, name: "Coordinator", multiagent: { type: "coordinator", agents: [checker] } },
  };
  const childThread = "sthr_checker";

  type Context = {
    session: Session;
    runtime: ManagedNodeHarnessRuntime;
    subagents?: ManagedNodeSubagentControl;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
  };

  /** What Pi emits for a bash call: a tool without execute (always_ask) gets
   * evaluated_permission "ask" and the turn stops on it. */
  function callBash(context: Context, id: string): void {
    const toolset = context.session.agent.tools.find((tool) => tool.type === "agent_toolset_20260401");
    const bash = toolset?.type === "agent_toolset_20260401"
      ? toolset.configs.find((config) => config.name === "bash")
      : undefined;
    const asks = (bash?.permissionPolicy ?? toolset?.defaultConfig.permissionPolicy)?.type === "always_ask";
    context.runtime.broadcast({
      type: "agent.tool_use",
      id,
      name: "bash",
      input: { command: "ls" },
      ...(asks && { evaluated_permission: "ask" as const }),
    } as SessionEvent);
  }

  function fixture(run: (context: Context) => Promise<void>, store = new MemorySessionThreadStore()) {
    const frames: Array<Record<string, unknown>> = [];
    let id = 0;
    const dependencies: DefaultNodeManagedSessionRunnerDependencies = {
      buildSandbox: async () => ({}) as SandboxExecutor,
      buildModel: async () => ({}) as HarnessContext["model"],
      buildTools: async () => ({}),
      buildHarnessContext: async (input) => input as unknown as HarnessContext,
      buildHarness: () => ({ run: async (context) => run(context as unknown as Context) }),
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      clock: { now: () => new Date("2026-10-18T09:00:00.000Z") },
      ids: { nextEventId: () => `event_waits_${++id}` },
      subagentThreads: store,
      subagentPolicy: () => ({ enabled: true, maxConcurrentSubagents: 2 }),
    };
    const runner = new DefaultNodeManagedSessionRunner(dependencies);
    return {
      frames,
      store,
      async accept(history: SessionEventView[] = []) {
        await runner.start({ workspaceId: "workspace_01", sessionId: coordinator.id, session: coordinator, environment, initialEvents: [] });
        const message: NodeManagedSessionRunnerAcceptInput["events"][number] = {
          id: `event_user_${++id}`,
          type: "user.message",
          content: [{ type: "text", text: "Check the folder through the checker" }],
          processedAt: "2026-10-18T08:59:00.000Z",
        };
        await runner.accept({
          workspaceId: "workspace_01", sessionId: coordinator.id, session: coordinator, environment,
          initialEvents: [], events: [message], historyEvents: [...history, message],
          output: async (frame) => { frames.push(frame as Record<string, unknown>); },
        });
      },
    };
  }

  /** A checker thread of an earlier turn that stopped on its bash call. */
  async function waitingThread(store: MemorySessionThreadStore): Promise<SessionEventView[]> {
    const { type: _type, ...agent } = checker;
    await store.insert({ workspaceId: "workspace_01", thread: {
      id: childThread, sessionId: coordinator.id, parentThreadId: "sthr_primary",
      agent: { ...agent, type: "agent" }, archivedAt: null, createdAt: "2026-10-18T08:00:00.000Z",
      updatedAt: "2026-10-18T08:00:00.000Z", stats: null, usage: null, status: "idle",
    } });
    return [
      { id: "event_thread_created", type: "session.thread_created", agentName: "Checker",
        parentThreadId: "sthr_primary", processedAt: "2026-10-18T08:00:00.000Z", sessionThreadId: childThread },
      { id: "toolu_child_bash", type: "agent.tool_use", name: "bash", input: { command: "ls" },
        evaluatedPermission: "ask", processedAt: "2026-10-18T08:00:01.000Z", sessionThreadId: childThread },
      { id: "event_thread_idle", type: "session.thread_status_idle", agentName: "Checker",
        processedAt: "2026-10-18T08:00:02.000Z", sessionThreadId: childThread,
        stopReason: { type: "requires_action", eventIds: ["toolu_child_bash"] } },
    ] as SessionEventView[];
  }

  it("a subagent with bash on always_ask leaves the session in requires_action with the thread's call", async () => {
    let report: string | undefined;
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Coordinator") {
        report = await context.delegateToAgent!("agent_checker", "Check the folder");
        context.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: report }] });
      } else {
        callBash(context, "toolu_child_bash");
      }
    });

    await f.accept();

    const created = f.frames.find((frame) => frame.type === "session.thread_created")!;
    const thread = created.session_thread_id;
    expect(f.frames).toContainEqual(expect.objectContaining({
      type: "agent.tool_use", id: "toolu_child_bash", session_thread_id: thread, evaluated_permission: "ask",
    }));
    expect(f.frames.filter((frame) => frame.type === "session.thread_status_idle")).toEqual([
      expect.objectContaining({
        session_thread_id: thread,
        stop_reason: { type: "requires_action", event_ids: ["toolu_child_bash"] },
      }),
    ]);
    expect(report).toBe(WAITING);
    expect(f.frames.at(-1)).toMatchObject({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["toolu_child_bash"] },
    });
  });

  it("a waiting thread runs no queued message on top of its unanswered call", async () => {
    let childTurns = 0;
    let status: string | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Coordinator") {
        const child = await context.subagents!.create({ agentId: "agent_checker", message: "First" });
        await context.subagents!.resume({ threadId: child.threadId, message: "Second" });
        release();
        status = (await context.subagents!.wait({ threadIds: [child.threadId] })).subagents[0]?.status;
      } else {
        childTurns += 1;
        await gate;
        callBash(context, `toolu_child_bash_${childTurns}`);
      }
    });

    await f.accept();

    expect(childTurns).toBe(1);
    expect(status).toBe("requires_action");
  });

  it("a call that waits from an earlier turn still holds the session after a later message", async () => {
    const store = new MemorySessionThreadStore();
    const history = await waitingThread(store);
    const f = fixture(async (context) => {
      context.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Still waiting" }] });
    }, store);

    await f.accept(history);

    expect(f.frames.at(-1)).toMatchObject({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["toolu_child_bash"] },
    });
  });

  it("an archived thread holds nothing", async () => {
    const store = new MemorySessionThreadStore();
    const history = await waitingThread(store);
    await store.archive({ workspaceId: "workspace_01", sessionId: coordinator.id, threadId: childThread, archivedAt: "2026-10-18T08:30:00.000Z" });
    const f = fixture(async (context) => {
      context.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Done" }] });
    }, store);

    await f.accept(history);

    expect(f.frames.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
  });

  it("a result in any thread answers the subagent's call", async () => {
    const store = new MemorySessionThreadStore();
    const history = await waitingThread(store);
    // A session written before slice 3 holds the answer to a child's call without a thread.
    history.push({ id: "event_child_result", type: "agent.tool_result", toolUseId: "toolu_child_bash",
      content: [{ type: "text", text: "Denied" }], isError: true, processedAt: "2026-10-18T08:10:00.000Z" } as SessionEventView);
    const f = fixture(async (context) => {
      context.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "Done" }] });
    }, store);

    await f.accept(history);

    expect(f.frames.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
  });
});

describe("a confirmation in a subagent thread runs there (plan multiagent 3.1, slice 3)", () => {
  const checkerTools = [{
    type: "agent_toolset_20260401" as const,
    configs: [{ name: "bash" as const, type: "bash" as const, enabled: true, permissionPolicy: { type: "always_ask" as const } }],
    defaultConfig: { enabled: true, permissionPolicy: { type: "always_allow" as const } },
  }];
  const checker = {
    type: "agent" as const,
    id: "agent_checker",
    description: null,
    mcpServers: [],
    model: { id: "local-model" },
    name: "Checker",
    skills: [],
    system: "Check the folder",
    tools: checkerTools,
    version: 1,
  };
  const coordinator: Session = {
    ...session,
    id: "session_confirms",
    agent: { ...session.agent, name: "Coordinator", multiagent: { type: "coordinator", agents: [checker] } },
  };
  const childThread = "sthr_checker";

  type Context = { session: Session; runtime: ManagedNodeHarnessRuntime };
  type Accepted = NodeManagedSessionRunnerAcceptInput["events"][number];
  type Call = { id: string; asks: boolean; result?: string };

  function say(context: Context, text: string): void {
    context.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text }] } as SessionEvent);
  }

  function fixture(
    run: (context: Context) => Promise<void>,
    options: Pick<DefaultNodeManagedSessionRunnerDependencies, "sessionLimits"> = {},
  ) {
    const store = new MemorySessionThreadStore();
    const frames: Array<Record<string, unknown>> = [];
    const executions: Array<{ id: string; agent: string; tools: unknown }> = [];
    const runs: string[] = [];
    let id = 0;
    const runner = new DefaultNodeManagedSessionRunner({
      ...options,
      buildSandbox: async () => ({}) as SandboxExecutor,
      buildModel: async () => ({}) as HarnessContext["model"],
      buildTools: async () => ({}),
      buildHarnessContext: async (input) => input as unknown as HarnessContext,
      buildHarness: () => ({
        run: async (context) => {
          const harness = context as unknown as Context;
          runs.push(harness.session.agent.name);
          await run(harness);
        },
      }),
      confirmedTools: {
        execute: async (call) => {
          executions.push({ id: call.toolUse.id, agent: call.session.agent.name, tools: call.session.agent.tools });
          return { content: [{ type: "text", text: `ran ${call.toolUse.id}` }], isError: false };
        },
      },
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      clock: { now: () => new Date("2026-10-18T10:00:00.000Z") },
      ids: { nextEventId: () => `event_confirms_${++id}` },
      subagentThreads: store,
      subagentPolicy: () => ({ enabled: true, maxConcurrentSubagents: 2 }),
    });
    return {
      frames,
      executions,
      runs,
      /** An earlier execution: the coordinator delegated to the checker, the
       * checker stopped on its calls, the delegation returned the waiting text. */
      async seed(calls: Call[]): Promise<SessionEventView[]> {
        const { type: _type, ...agent } = checker;
        await store.insert({ workspaceId: "workspace_01", thread: {
          id: childThread, sessionId: coordinator.id, parentThreadId: "sthr_primary",
          agent: { ...agent, type: "agent" }, archivedAt: null, createdAt: "2026-10-18T09:00:00.000Z",
          updatedAt: "2026-10-18T09:00:00.000Z", stats: null, usage: null, status: "idle",
        } });
        let second = 0;
        const at = () => `2026-10-18T09:00:${String(++second).padStart(2, "0")}.000Z`;
        const asking = calls.filter((call) => call.asks).map((call) => call.id);
        return [
          { id: "event_user_task", type: "user.message", content: [{ type: "text", text: "Check the folder through the checker" }], processedAt: at() },
          { id: "toolu_delegate", type: "agent.tool_use", name: "call_agent_agent_checker", input: { message: "Check the folder" }, processedAt: at() },
          { id: "event_sent", type: "agent.thread_message_sent", toSessionThreadId: childThread, toAgentName: "Checker",
            content: [{ type: "text", text: "Check the folder" }], processedAt: at() },
          { id: "event_thread_created", type: "session.thread_created", agentName: "Checker",
            parentThreadId: "sthr_primary", processedAt: at(), sessionThreadId: childThread },
          { id: "event_received", type: "agent.thread_message_received", fromSessionThreadId: "sthr_primary", fromAgentName: "Coordinator",
            fromMessageId: "event_sent", content: [{ type: "text", text: "Check the folder" }], processedAt: at(), sessionThreadId: childThread },
          { id: "event_thread_running", type: "session.thread_status_running", agentName: "Checker", processedAt: at(), sessionThreadId: childThread },
          ...calls.map((call) => ({ id: call.id, type: "agent.tool_use", name: call.asks ? "bash" : "read",
            input: { command: call.id }, processedAt: at(), sessionThreadId: childThread,
            ...(call.asks && { evaluatedPermission: "ask" }) })),
          ...calls.filter((call) => call.result !== undefined).map((call) => ({ id: `event_result_${call.id}`, type: "agent.tool_result",
            toolUseId: call.id, content: [{ type: "text", text: call.result }], isError: false, processedAt: at(), sessionThreadId: childThread })),
          { id: "event_thread_idle", type: "session.thread_status_idle", agentName: "Checker", processedAt: at(), sessionThreadId: childThread,
            stopReason: { type: "requires_action", eventIds: asking } },
          { id: "event_delegate_result", type: "agent.tool_result", toolUseId: "toolu_delegate",
            content: [{ type: "text", text: "The subagent is waiting for a tool confirmation. Its report will arrive as a separate message." }],
            isError: false, processedAt: at() },
          { id: "event_waits", type: "agent.message", content: [{ type: "text", text: "The checker waits for you" }], processedAt: at() },
          { id: "event_idle", type: "session.status_idle", stopReason: { type: "requires_action", eventIds: asking }, processedAt: at() },
        ] as SessionEventView[];
      },
      async accept(events: Accepted[], history: SessionEventView[]) {
        await runner.start({ workspaceId: "workspace_01", sessionId: coordinator.id, session: coordinator, environment, initialEvents: [] });
        await runner.accept({
          workspaceId: "workspace_01", sessionId: coordinator.id, session: coordinator, environment,
          initialEvents: [], events, historyEvents: history,
          output: async (frame) => { frames.push(frame as Record<string, unknown>); },
        });
      },
    };
  }

  function confirm(id: string, toolUseId: string, result: "allow" | "deny", denyMessage?: string): Accepted {
    return {
      id, type: "user.tool_confirmation", result, toolUseId, sessionThreadId: childThread,
      processedAt: "2026-10-18T09:30:00.000Z", ...(denyMessage !== undefined && { denyMessage }),
    };
  }

  const childFrames = (frames: Array<Record<string, unknown>>, type: string) =>
    frames.filter((frame) => frame.type === type && frame.session_thread_id === childThread);
  /** The last event a model reads: status events of the thread are left out. */
  const lastTurnEvent = (events: SessionEvent[]) => events.filter((event) => !event.type.startsWith("session.")).at(-1);

  it("allow runs the call once with the subagent's tools, the subagent goes on and its report wakes the coordinator", async () => {
    let checkerHistory: SessionEvent[] = [];
    let coordinatorMessages: unknown[] = [];
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Checker") {
        checkerHistory = context.runtime.history.getEvents();
        say(context, "Three files");
      } else {
        coordinatorMessages = context.runtime.history.getMessages();
        say(context, "The checker found three files");
      }
    });
    const history = await f.seed([{ id: "toolu_child_bash", asks: true }]);
    const allow = confirm("event_allow", "toolu_child_bash", "allow");

    await f.accept([allow], [...history, allow]);

    expect(f.executions).toEqual([{ id: "toolu_child_bash", agent: "Checker", tools: checkerTools }]);
    expect(childFrames(f.frames, "agent.tool_result")).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_child_bash", content: [{ type: "text", text: "ran toolu_child_bash" }] }),
    ]);
    expect(f.frames.filter((frame) => frame.type === "agent.tool_result" && frame.session_thread_id === undefined)).toEqual([]);
    expect(f.runs).toEqual(["Checker", "Coordinator"]);
    // The checker goes on from the result, without a new message.
    expect(childFrames(f.frames, "agent.thread_message_received")).toEqual([]);
    expect(lastTurnEvent(checkerHistory)).toMatchObject({ type: "agent.tool_result", tool_use_id: "toolu_child_bash" });
    expect(childFrames(f.frames, "session.thread_status_idle")).toEqual([
      expect.objectContaining({ stop_reason: { type: "end_turn" } }),
    ]);
    const reports = f.frames.filter((frame) => frame.type === "agent.thread_message_received");
    expect(reports).toEqual([expect.objectContaining({
      from_session_thread_id: childThread, from_agent_name: "Checker", content: [{ type: "text", text: "Three files" }],
    })]);
    expect(reports[0]).not.toHaveProperty("session_thread_id");
    expect(coordinatorMessages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Three files" }] });
    expect(f.frames.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
  });

  it("two confirmations of one batch in the subagent thread both run", async () => {
    const f = fixture(async (context) => say(context, context.session.agent.name === "Checker" ? "Both ran" : "Done"));
    const history = await f.seed([{ id: "toolu_child_bash_1", asks: true }, { id: "toolu_child_bash_2", asks: true }]);
    const first = confirm("event_allow_1", "toolu_child_bash_1", "allow");
    const second = confirm("event_allow_2", "toolu_child_bash_2", "allow");

    await f.accept([first, second], [...history, first, second]);

    expect(f.executions.map((execution) => execution.id)).toEqual(["toolu_child_bash_1", "toolu_child_bash_2"]);
    expect(childFrames(f.frames, "agent.tool_result").map((frame) => frame.tool_use_id)).toEqual(["toolu_child_bash_1", "toolu_child_bash_2"]);
    expect(f.runs).toEqual(["Checker", "Coordinator"]);
  });

  it("deny puts the error into the subagent thread and the subagent goes on", async () => {
    let checkerHistory: SessionEvent[] = [];
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Checker") checkerHistory = context.runtime.history.getEvents();
      say(context, context.session.agent.name === "Checker" ? "Could not check" : "Done");
    });
    const history = await f.seed([{ id: "toolu_child_bash", asks: true }]);
    const deny = confirm("event_deny", "toolu_child_bash", "deny", "Not now");

    await f.accept([deny], [...history, deny]);

    expect(f.executions).toEqual([]);
    expect(childFrames(f.frames, "agent.tool_result")).toEqual([expect.objectContaining({
      tool_use_id: "toolu_child_bash", is_error: true, content: [{ type: "text", text: "Denied: Not now" }],
    })]);
    expect(lastTurnEvent(checkerHistory)).toMatchObject({ type: "agent.tool_result", tool_use_id: "toolu_child_bash", is_error: true });
    expect(f.runs).toEqual(["Checker", "Coordinator"]);
  });

  it("a second allow on an answered call of the subagent runs nothing and wakes no model", async () => {
    const f = fixture(async (context) => say(context, "Again"));
    const history = await f.seed([{ id: "toolu_child_bash", asks: true }]);
    const first = confirm("event_allow_1", "toolu_child_bash", "allow");
    const second = { ...confirm("event_allow_2", "toolu_child_bash", "allow"), processedAt: "2026-10-18T09:40:00.000Z" };
    const answered = [
      first,
      { id: "event_child_result", type: "agent.tool_result", toolUseId: "toolu_child_bash", content: [{ type: "text", text: "ran" }],
        isError: false, processedAt: "2026-10-18T09:30:01.000Z", sessionThreadId: childThread },
    ] as SessionEventView[];

    await f.accept([second], [...history, ...answered, second]);

    expect(f.executions).toEqual([]);
    expect(f.frames.filter((frame) => frame.type === "agent.tool_result")).toEqual([]);
    expect(f.runs).toEqual([]);
  });

  it("a mixed batch runs only the waiting call, and the subagent sees both results", async () => {
    let checkerHistory: SessionEvent[] = [];
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Checker") checkerHistory = context.runtime.history.getEvents();
      say(context, "Done");
    });
    const history = await f.seed([{ id: "toolu_child_read", asks: false, result: "a.txt" }, { id: "toolu_child_bash", asks: true }]);
    const allow = confirm("event_allow", "toolu_child_bash", "allow");

    await f.accept([allow], [...history, allow]);

    expect(f.executions.map((execution) => execution.id)).toEqual(["toolu_child_bash"]);
    const results = checkerHistory.filter((event) => event.type === "agent.tool_result");
    expect(results.map((event) => (event as { tool_use_id: string }).tool_use_id)).toEqual(["toolu_child_read", "toolu_child_bash"]);
    expect(f.runs).toEqual(["Checker", "Coordinator"]);
  });

  it("a subagent that asks again holds the session and wakes no coordinator", async () => {
    const f = fixture(async (context) => {
      context.runtime.broadcast({
        type: "agent.tool_use", id: "toolu_child_bash_again", name: "bash", input: { command: "rm a.txt" }, evaluated_permission: "ask",
      } as SessionEvent);
    });
    const history = await f.seed([{ id: "toolu_child_bash", asks: true }]);
    const allow = confirm("event_allow", "toolu_child_bash", "allow");

    await f.accept([allow], [...history, allow]);

    expect(f.runs).toEqual(["Checker"]);
    expect(f.frames.filter((frame) => frame.type === "agent.thread_message_received")).toEqual([]);
    expect(f.frames.at(-1)).toMatchObject({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["toolu_child_bash_again"] },
    });
  });

  /** What the run of the first allow wrote after it: the call's result, the
   * checker's turn and, unless the run crashed before it, the report. */
  function answeredTurn(reported: boolean): SessionEventView[] {
    const at = (second: number) => `2026-10-18T09:30:${String(second).padStart(2, "0")}.000Z`;
    return [
      { id: "event_child_result", type: "agent.tool_result", toolUseId: "toolu_child_bash",
        content: [{ type: "text", text: "ran toolu_child_bash" }], isError: false, processedAt: at(1), sessionThreadId: childThread },
      { id: "event_child_running", type: "session.thread_status_running", agentName: "Checker", processedAt: at(2), sessionThreadId: childThread },
      { id: "event_child_answer", type: "agent.message", content: [{ type: "text", text: "Three files" }], processedAt: at(3),
        sessionThreadId: childThread },
      { id: "event_child_idle", type: "session.thread_status_idle", agentName: "Checker", stopReason: { type: "end_turn" },
        processedAt: at(4), sessionThreadId: childThread },
      ...(reported ? [
        { id: "event_report", type: "agent.thread_message_received", fromSessionThreadId: childThread, fromAgentName: "Checker",
          content: [{ type: "text", text: "Three files" }], processedAt: at(5) },
        { id: "event_coordinator_answer", type: "agent.message", content: [{ type: "text", text: "The checker found three files" }],
          processedAt: at(6) },
        { id: "event_idle_after", type: "session.status_idle", stopReason: { type: "end_turn" }, processedAt: at(7) },
      ] : []),
    ] as SessionEventView[];
  }
  const reportsOf = (frames: Array<Record<string, unknown>>) =>
    frames.filter((frame) => frame.type === "agent.thread_message_received");

  it("a second allow sent before the first ran repeats neither the subagent's turn nor its report", async () => {
    const f = fixture(async (context) => say(context, "Again"));
    const history = await f.seed([{ id: "toolu_child_bash", asks: true }]);
    const first = confirm("event_allow_1", "toolu_child_bash", "allow");
    const second = confirm("event_allow_2", "toolu_child_bash", "allow");

    // Both allows were accepted before the run of the first one answered the call.
    await f.accept([second], [...history, first, second, ...answeredTurn(true)]);

    expect(f.executions).toEqual([]);
    expect(f.runs).toEqual([]);
    expect(reportsOf(f.frames)).toEqual([]);
  });

  it("a replay after the subagent's turn writes only its missing report and wakes the coordinator", async () => {
    let coordinatorMessages: unknown[] = [];
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Checker") throw new Error("the checker's turn already ran");
      coordinatorMessages = context.runtime.history.getMessages();
      say(context, "The checker found three files");
    });
    const history = await f.seed([{ id: "toolu_child_bash", asks: true }]);
    const allow = confirm("event_allow", "toolu_child_bash", "allow");

    await f.accept([allow], [...history, allow, ...answeredTurn(false)]);

    expect(f.executions).toEqual([]);
    expect(f.runs).toEqual(["Coordinator"]);
    expect(reportsOf(f.frames)).toEqual([expect.objectContaining({
      from_session_thread_id: childThread, from_agent_name: "Checker", content: [{ type: "text", text: "Three files" }],
    })]);
    expect(coordinatorMessages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "Three files" }] });
  });

  it("a replay before the subagent's turn ran runs that turn and not the call", async () => {
    const f = fixture(async (context) => say(context, context.session.agent.name === "Checker" ? "Three files" : "Done"));
    const history = await f.seed([{ id: "toolu_child_bash", asks: true }]);
    const allow = confirm("event_allow", "toolu_child_bash", "allow");

    await f.accept([allow], [...history, allow, answeredTurn(false)[0]!]);

    expect(f.executions).toEqual([]);
    expect(f.runs).toEqual(["Checker", "Coordinator"]);
    expect(reportsOf(f.frames)).toHaveLength(1);
  });

  it("a subagent that fails after the answer tells the coordinator and wakes it", async () => {
    let coordinatorMessages: unknown[] = [];
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Checker") throw new Error("the checker broke");
      coordinatorMessages = context.runtime.history.getMessages();
      say(context, "The checker failed");
    });
    const history = await f.seed([{ id: "toolu_child_bash", asks: true }]);
    const allow = confirm("event_allow", "toolu_child_bash", "allow");

    await f.accept([allow], [...history, allow]);

    const failed = "The subagent failed: its turn ended with an error.";
    expect(f.runs).toEqual(["Checker", "Coordinator"]);
    expect(reportsOf(f.frames)).toEqual([expect.objectContaining({
      from_session_thread_id: childThread, content: [{ type: "text", text: failed }],
    })]);
    expect(coordinatorMessages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: failed }] });
    expect(f.frames.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
  });

  it("a subagent stopped at the limit after the answer tells the coordinator, which reads it after a raise", async () => {
    const stopped = "The subagent stopped: the session limit is reached.";
    let coordinatorMessages: unknown[] = [];
    const run = async (context: Context) => {
      if (context.session.agent.name === "Checker") throw new Error("unexpected checker turn");
      coordinatorMessages = context.runtime.history.getMessages();
      say(context, "I will ask the checker again");
    };
    const atLimit = fixture(run, {
      sessionLimits: { read: async () => ({ maxTokens: 100, maxChildTurns: 20, usedTokens: 100, usedChildTurns: 1 }) },
    });
    const history = await atLimit.seed([{ id: "toolu_child_bash", asks: true }]);
    const allow = confirm("event_allow", "toolu_child_bash", "allow");

    await atLimit.accept([allow], [...history, allow]);

    expect(atLimit.executions.map((execution) => execution.id)).toEqual(["toolu_child_bash"]);
    expect(atLimit.runs).toEqual([]);
    expect(reportsOf(atLimit.frames)).toEqual([expect.objectContaining({
      from_session_thread_id: childThread, from_agent_name: "Checker", content: [{ type: "text", text: stopped }],
    })]);
    expect(atLimit.frames.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "budget_reached" } });

    // The raise continues the stopped turn: the coordinator reads the note and decides.
    const raised = fixture(run);
    const at = (second: number) => `2026-10-18T09:31:${String(second).padStart(2, "0")}.000Z`;
    await raised.accept([sessionLimitContinuationEvent("event_stop", at(9))] as Accepted[], [
      ...history,
      allow,
      { id: "event_child_result", type: "agent.tool_result", toolUseId: "toolu_child_bash",
        content: [{ type: "text", text: "ran toolu_child_bash" }], isError: false, processedAt: at(1), sessionThreadId: childThread },
      { id: "event_child_idle", type: "session.thread_status_idle", agentName: "Checker", stopReason: { type: "budget_reached" },
        processedAt: at(2), sessionThreadId: childThread },
      { id: "event_note", type: "agent.thread_message_received", fromSessionThreadId: childThread, fromAgentName: "Checker",
        content: [{ type: "text", text: stopped }], processedAt: at(3) },
      { id: "event_stop", type: "session.status_idle", stopReason: { type: "budget_reached" }, processedAt: at(4) },
    ] as SessionEventView[]);

    expect(raised.runs).toEqual(["Coordinator"]);
    expect(coordinatorMessages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: stopped }] });
  });

  it("a report from an earlier execution reaches the coordinator's model as a user message", async () => {
    let coordinatorMessages: unknown[] = [];
    const f = fixture(async (context) => {
      coordinatorMessages = context.runtime.history.getMessages();
      say(context, "Noted");
    });
    const history = await f.seed([{ id: "toolu_child_bash", asks: true, result: "ran" }]);
    const report = { id: "event_report", type: "agent.thread_message_received", fromSessionThreadId: childThread,
      fromAgentName: "Checker", content: [{ type: "text", text: "Three files" }], processedAt: "2026-10-18T09:31:00.000Z" } as SessionEventView;
    const message: Accepted = { id: "event_user_next", type: "user.message", content: [{ type: "text", text: "Next" }],
      processedAt: "2026-10-18T09:32:00.000Z" };

    await f.accept([message], [...history, report, message]);

    expect(coordinatorMessages.slice(-2)).toEqual([
      { role: "user", content: [{ type: "text", text: "Three files" }] },
      { role: "user", content: [{ type: "text", text: "Next" }] },
    ]);
  });
});

describe("the session stops at its limit (plan multiagent 3.Б, slice 2)", () => {
  const STOPPED = "The subagent stopped: the session limit is reached.";
  const WAITING = "The subagent is waiting for a tool confirmation. Its report will arrive as a separate message.";
  const checker = {
    type: "agent" as const,
    id: "agent_checker",
    description: null,
    mcpServers: [],
    model: { id: "local-model" },
    name: "Checker",
    skills: [],
    system: "Check the folder",
    tools: [{
      type: "agent_toolset_20260401" as const,
      configs: [{ name: "bash" as const, type: "bash" as const, enabled: true, permissionPolicy: { type: "always_ask" as const } }],
      defaultConfig: { enabled: true, permissionPolicy: { type: "always_allow" as const } },
    }],
    version: 1,
  };
  const coordinator: Session = {
    ...session,
    id: "session_limits",
    agent: { ...session.agent, name: "Coordinator", multiagent: { type: "coordinator", agents: [checker] } },
  };

  type Context = {
    session: Session;
    runtime: ManagedNodeHarnessRuntime;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
  };
  type Accepted = NodeManagedSessionRunnerAcceptInput["events"][number];
  type Frame = Record<string, unknown>;

  /** One model request as Pi makes it: the limit check first. At the limit
   * nothing goes out and Pi throws its own error. */
  async function request(context: Context, tokens: number): Promise<void> {
    await context.runtime.beforeModelRequest?.();
    if (context.runtime.limitReached) throw new SessionLimitError("Session limit reached");
    const start = `span_${Math.random().toString(36).slice(2)}`;
    context.runtime.broadcast({ type: "span.model_request_start", id: start, model: "local-model" } as unknown as SessionEvent);
    context.runtime.broadcast({
      type: "span.model_request_end", model: "local-model", model_request_start_id: start, is_error: false,
      model_usage: { input_tokens: tokens - 5, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as SessionEvent);
    await context.runtime.reportUsage(tokens - 5, 5);
  }

  function say(context: Context, text: string): void {
    context.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text }] } as SessionEvent);
  }

  /** The counter as the projection keeps it: the work of the frames written
   * so far plus the work of earlier executions. */
  function limitsOf(frames: Frame[], max: { maxTokens: number; maxChildTurns: number }, earlier = { tokens: 0, childTurns: 0 }) {
    return {
      read: vi.fn(async () => {
        let usedTokens = earlier.tokens;
        let usedChildTurns = earlier.childTurns;
        for (const frame of frames) {
          const usage = frame.model_usage as { input_tokens: number; output_tokens: number } | undefined;
          if (frame.type === "span.model_request_end" && usage) usedTokens += usage.input_tokens + usage.output_tokens;
          if (frame.type === "session.thread_status_running" && frame.session_thread_id !== "sthr_primary") usedChildTurns += 1;
        }
        return { ...max, usedTokens, usedChildTurns };
      }),
    };
  }

  function fixture(
    run: (context: Context) => Promise<void>,
    max: { maxTokens: number; maxChildTurns: number },
    options: { earlier?: { tokens: number; childTurns: number }; evaluate?: () => Promise<never> } = {},
  ) {
    const frames: Frame[] = [];
    const runs: string[] = [];
    const limits = limitsOf(frames, max, options.earlier);
    let id = 0;
    const runner = new DefaultNodeManagedSessionRunner({
      buildSandbox: async () => ({}) as SandboxExecutor,
      buildModel: async () => ({}) as HarnessContext["model"],
      buildTools: async () => ({}),
      buildHarnessContext: async (input) => input as unknown as HarnessContext,
      buildHarness: () => ({
        run: async (context) => {
          const harness = context as unknown as Context;
          runs.push(harness.session.agent.name);
          await run(harness);
        },
      }),
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      outcomes: { evaluate: options.evaluate ?? (async () => { throw new Error("unexpected outcome evaluation"); }) },
      clock: { now: () => new Date("2026-10-18T11:00:00.000Z") },
      ids: { nextEventId: () => `event_limits_${++id}` },
      harnessRetry: { attempts: 3, delayMs: () => 0 },
      subagentThreads: new MemorySessionThreadStore(),
      subagentPolicy: () => ({ enabled: true, maxConcurrentSubagents: 2 }),
      sessionLimits: limits,
    } as DefaultNodeManagedSessionRunnerDependencies);
    return {
      frames,
      runs,
      limits,
      async accept(events: Accepted[] = [{
        id: "event_user_task", type: "user.message",
        content: [{ type: "text", text: "Check the folder through the checker" }],
        processedAt: "2026-10-18T10:59:00.000Z",
      }], historyEvents: SessionEventView[] = events as SessionEventView[]) {
        await runner.start({ workspaceId: "workspace_01", sessionId: coordinator.id, session: coordinator, environment, initialEvents: [] });
        await runner.accept({
          workspaceId: "workspace_01", sessionId: coordinator.id, session: coordinator, environment,
          initialEvents: [], events, historyEvents,
          // A write takes time, as the SQL projection does: the check has
          // to wait for the frames before it reads the counter.
          output: async (frame) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            frames.push(frame as Frame);
          },
        });
      },
    };
  }

  const ofType = (frames: Frame[], type: string) => frames.filter((frame) => frame.type === type);
  const budget = { type: "budget_reached" };

  /** CMA order at the limit: the threads stop, then session.usage, then the
   * session goes idle with budget_reached. Nothing reports an error. */
  function expectStoppedAtLimit(frames: Frame[]): void {
    expect(ofType(frames, "session.error")).toEqual([]);
    expect(ofType(frames, "session.status_rescheduled")).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: budget });
    expect(frames.at(-2)).toMatchObject({ type: "session.usage" });
    const threadStops = frames.flatMap((frame, index) =>
      frame.type === "session.thread_status_idle" && (frame.stop_reason as { type?: string }).type === "budget_reached" ? [index] : []);
    for (const index of threadStops) expect(index).toBeLessThan(frames.length - 2);
  }

  it("a turn stops between requests at the token limit, without a retry and without session.error", async () => {
    const f = fixture(async (context) => {
      await request(context, 110);
      context.runtime.broadcast({ type: "agent.tool_use", id: "toolu_read", name: "read", input: { path: "a.txt" } } as SessionEvent);
      context.runtime.broadcast({ type: "agent.tool_result", tool_use_id: "toolu_read", content: [{ type: "text", text: "a" }] } as SessionEvent);
      await request(context, 110);
      say(context, "never written");
    }, { maxTokens: 100, maxChildTurns: 20 });

    await f.accept();

    expect(f.runs).toEqual(["Coordinator"]);
    expect(ofType(f.frames, "span.model_request_end")).toHaveLength(1);
    expect(ofType(f.frames, "agent.message")).toEqual([]);
    expectStoppedAtLimit(f.frames);
    expect(f.frames.at(-2)).toMatchObject({ usage: { input_tokens: 105, output_tokens: 5 } });
  });

  it("a session already at the limit sends no request on a new message", async () => {
    const f = fixture(async (context) => {
      await request(context, 10);
      say(context, "never written");
    }, { maxTokens: 100, maxChildTurns: 20 }, { earlier: { tokens: 100, childTurns: 0 } });

    await f.accept();

    expect(f.runs).toEqual(["Coordinator"]);
    expect(f.frames.map((frame) => frame.type)).toEqual(["session.status_running", "session.usage", "session.status_idle"]);
    expectStoppedAtLimit(f.frames);
  });

  it("a subagent beyond max_child_turns starts no turn, its message stays queued and the session stops", async () => {
    const reports: string[] = [];
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Checker") {
        await request(context, 20);
        say(context, "first check done");
        return;
      }
      await request(context, 20);
      reports.push(await context.delegateToAgent!("agent_checker", "Check the folder"));
      reports.push(await context.delegateToAgent!("agent_checker", "Check it again"));
      await request(context, 20);
      say(context, "never written");
    }, { maxTokens: 1000, maxChildTurns: 1 });

    await f.accept();

    expect(reports).toEqual(["first check done", STOPPED]);
    expect(f.runs).toEqual(["Coordinator", "Checker"]);
    const threads = ofType(f.frames, "session.thread_created").map((frame) => frame.session_thread_id);
    expect(threads).toHaveLength(2);
    const second = threads[1];
    expect(ofType(f.frames, "session.thread_status_running").map((frame) => frame.session_thread_id)).toEqual([threads[0]]);
    expect(f.frames.filter((frame) => frame.session_thread_id === second).map((frame) => frame.type))
      .toEqual(["session.thread_created", "session.thread_status_idle"]);
    expect(ofType(f.frames, "agent.thread_message_sent").filter((frame) => frame.to_session_thread_id === second)).toHaveLength(1);
    expect(ofType(f.frames, "session.thread_status_idle").find((frame) => frame.session_thread_id === second))
      .toMatchObject({ stop_reason: budget });
    expect(ofType(f.frames, "agent.message").map((frame) => (frame.content as Array<{ text: string }>)[0]!.text))
      .toEqual(["first check done"]);
    expectStoppedAtLimit(f.frames);
  });

  it("a subagent that spends the tokens stops its thread on budget_reached, and the coordinator stops after it", async () => {
    let report: string | undefined;
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Checker") {
        await request(context, 80);
        await request(context, 80);
        say(context, "never written");
        return;
      }
      await request(context, 30);
      report = await context.delegateToAgent!("agent_checker", "Check the folder");
      await request(context, 30);
      say(context, "never written");
    }, { maxTokens: 100, maxChildTurns: 20 });

    await f.accept();

    expect(report).toBe(STOPPED);
    expect(f.runs).toEqual(["Coordinator", "Checker"]);
    const thread = ofType(f.frames, "session.thread_created")[0]!.session_thread_id;
    expect(ofType(f.frames, "session.thread_status_idle")).toEqual([
      expect.objectContaining({ session_thread_id: thread, stop_reason: budget }),
    ]);
    expect(ofType(f.frames, "span.model_request_end")).toHaveLength(2);
    expect(ofType(f.frames, "agent.message")).toEqual([]);
    expectStoppedAtLimit(f.frames);
  });

  it("a call that waits for a person holds the session in requires_action over the limit", async () => {
    let report: string | undefined;
    const f = fixture(async (context) => {
      if (context.session.agent.name === "Checker") {
        await request(context, 110);
        context.runtime.broadcast({
          type: "agent.tool_use", id: "toolu_child_bash", name: "bash", input: { command: "ls" }, evaluated_permission: "ask",
        } as SessionEvent);
        return;
      }
      await request(context, 10);
      report = await context.delegateToAgent!("agent_checker", "Check the folder");
      await request(context, 10);
      say(context, "never written");
    }, { maxTokens: 100, maxChildTurns: 20 });

    await f.accept();

    expect(report).toBe(WAITING);
    expect(ofType(f.frames, "session.error")).toEqual([]);
    expect(f.frames.at(-1)).toMatchObject({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["toolu_child_bash"] },
    });
  });

  it("the outcome grader does not run at the limit", async () => {
    const evaluate = vi.fn(async (): Promise<never> => { throw new Error("unexpected outcome evaluation"); });
    const f = fixture(async (context) => {
      await request(context, 110);
      say(context, "migration shipped");
    }, { maxTokens: 100, maxChildTurns: 20 }, { evaluate });

    await f.accept([{
      id: "event_define_outcome", type: "user.define_outcome", description: "Ship the migration",
      rubric: { type: "text", content: "All SDK contracts pass" }, maxIterations: 3, outcomeId: "outc_limits",
      processedAt: "2026-10-18T10:59:00.000Z",
    }]);

    expect(evaluate).not.toHaveBeenCalled();
    expect(ofType(f.frames, "span.outcome_evaluation_start")).toEqual([]);
    expectStoppedAtLimit(f.frames);
  });

  describe("a raise continues the stopped turn (plan multiagent 3.Б, slice 3)", () => {
    const at = (second: number) => `2026-10-18T10:59:${String(second).padStart(2, "0")}.000Z`;
    const stoppedTurn: SessionEventView[] = [
      { id: "event_user_task", type: "user.message", content: [{ type: "text", text: "Read a.txt" }], processedAt: at(0) },
      { id: "toolu_read", type: "agent.tool_use", name: "read", input: { path: "a.txt" }, processedAt: at(1) },
      { id: "event_read_result", type: "agent.tool_result", toolUseId: "toolu_read", content: [{ type: "text", text: "a" }], processedAt: at(2) },
      { id: "event_stop", type: "session.status_idle", stopReason: { type: "budget_reached" }, processedAt: at(3) },
    ];
    const continuation = [sessionLimitContinuationEvent("event_stop", "2026-10-18T11:00:00.000Z")] as Accepted[];

    it("runs the turn from the log, without a new message", async () => {
      const f = fixture(async (context) => {
        await request(context, 10);
        say(context, "a holds the letter a");
      }, { maxTokens: 1000, maxChildTurns: 20 }, { earlier: { tokens: 100, childTurns: 0 } });

      await f.accept(continuation, stoppedTurn);

      expect(f.runs).toEqual(["Coordinator"]);
      expect(f.frames.map((frame) => frame.type)).toEqual([
        "session.status_running", "span.model_request_start", "span.model_request_end", "session.usage",
        "agent.message", "session.status_idle",
      ]);
      expect(f.frames.at(-1)).toMatchObject({ stop_reason: { type: "end_turn" } });
    });

    it("writes nothing when a turn ran after the stop", async () => {
      const f = fixture(async () => { throw new Error("unexpected turn"); }, { maxTokens: 1000, maxChildTurns: 20 });

      await f.accept(continuation, [
        ...stoppedTurn,
        { id: "event_running", type: "session.status_running", processedAt: at(4) },
        { id: "event_answer", type: "agent.message", content: [{ type: "text", text: "done" }], processedAt: at(5) },
        { id: "event_end", type: "session.status_idle", stopReason: { type: "end_turn" }, processedAt: at(6) },
      ]);

      expect(f.runs).toEqual([]);
      expect(f.frames).toEqual([]);
    });

    it("runs no model for a turn that already has its answer", async () => {
      const f = fixture(async () => { throw new Error("unexpected turn"); }, { maxTokens: 1000, maxChildTurns: 20 });

      await f.accept(continuation, [
        stoppedTurn[0]!,
        { id: "event_answer", type: "agent.message", content: [{ type: "text", text: "done" }], processedAt: at(1) },
        { id: "event_stop", type: "session.status_idle", stopReason: { type: "budget_reached" }, processedAt: at(2) },
      ]);

      expect(f.runs).toEqual([]);
      expect(f.frames.map((frame) => frame.type)).toEqual(["session.status_running", "session.status_idle"]);
      expect(f.frames.at(-1)).toMatchObject({ stop_reason: { type: "end_turn" } });
    });
  });
});
