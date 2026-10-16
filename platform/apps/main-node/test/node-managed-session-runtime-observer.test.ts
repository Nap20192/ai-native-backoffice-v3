import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Environment,
  RecordSessionRuntimeEventsCommand,
  Session,
} from "@open-managed-agents/managed-agents-application";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";
import {
  DefaultNodeManagedSessionRuntimeDriver,
  type StartNodeManagedSessionRuntime,
} from "../src/lib/node-managed-session-runtime.js";
import type { SessionExecutionObserver } from "../src/lib/trace/types.js";

// Driver hooks of the agent trace (docs/plans/agent-trace.md, 2.1 and TW1).

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    openma: { harness: "pi" },
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
  title: "Node session",
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

const fence: SessionExecutionFence = {
  executionId: "event_input_01",
  workspaceId: "workspace_01",
  sessionId: "session_01",
  attemptId: "attempt_01",
  ownerId: "node_01",
  generation: 1,
  expiresAt: "2026-08-26T01:01:00.000Z",
};

const NOW = Date.parse("2026-08-26T00:30:00.000Z");
const scope = { workspaceId: "workspace_01", sessionId: "session_01" };
const input = {
  id: "event_input_01",
  type: "user.message" as const,
  content: [{ type: "text" as const, text: "Run" }],
  processedAt: "2026-08-26T00:29:00.000Z",
};

type Call = [string, ...unknown[]];

/** Records every observer call and every history write in one ordered log. */
function recordingObserver(log: Call[], overrides: Partial<SessionExecutionObserver> = {}): SessionExecutionObserver {
  return {
    executionStarted: (value) => { log.push(["executionStarted", value]); },
    startAttempt: (value) => { log.push(["startAttempt", value]); },
    startAttemptSettled: (value) => { log.push(["startAttemptSettled", value]); },
    startCancelled: (value) => { log.push(["startCancelled", value]); },
    frame: (frameScope, frame) => { log.push(["frame", frameScope, (frame as { type: string }).type]); },
    executionSettled: async (value) => { log.push(["executionSettled", value]); },
    sessionStopped: async (value) => { log.push(["sessionStopped", value]); },
    ...overrides,
  };
}

function createDriver(options: {
  observer?: SessionExecutionObserver;
  log: Call[];
  start?: (input: StartNodeManagedSessionRuntime) => Promise<void>;
  frames?: unknown[];
  delayMs?: (attempt: number) => number;
  logger?: { warn(obj: Record<string, unknown>, msg: string): void };
}) {
  let emit: ((frame: unknown) => Promise<void>) | undefined;
  let id = 0;
  const driver = new DefaultNodeManagedSessionRuntimeDriver({
    engine: {
      start: async (startInput, output) => {
        await (options.start ?? (async () => {}))(startInput);
        emit = output;
      },
      stop: async () => {},
      accept: async () => {
        for (const frame of options.frames ?? []) await emit?.(frame);
      },
      archiveThread: async () => {},
    },
    realtime: new MemorySessionRealtimeHub(),
    projectionFor: () => ({
      recordSessionRuntimeEvents: async (command: RecordSessionRuntimeEventsCommand) => {
        for (const event of command.events) options.log.push(["history", event.type]);
        return { type: "recorded", session };
      },
    }),
    clock: { now: () => new Date(NOW) },
    ids: { nextEventId: () => `event_driver_0${++id}` },
    startRetry: { attempts: 3, delayMs: options.delayMs ?? (() => 0) },
    ...(options.observer !== undefined && { observer: options.observer }),
    ...(options.logger !== undefined && { logger: options.logger }),
  });
  const accept = () => driver.accept({
    workspaceId: "workspace_01",
    sessionId: session.id,
    session,
    environment,
    events: [input],
    executionFence: fence,
  });
  return { driver, accept };
}

const names = (log: Call[]) => log.map((call) => call[0] === "frame" || call[0] === "history"
  ? `${call[0]}:${String(call.at(-1))}`
  : call[0]);

describe("DefaultNodeManagedSessionRuntimeDriver trace observer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the turn before the first start attempt and sees each frame before history", async () => {
    const log: Call[] = [];
    const { accept } = createDriver({
      log,
      observer: recordingObserver(log),
      frames: [
        { id: "event_running", type: "session.status_running", processed_at: "2026-08-26T00:30:00.001Z" },
        { id: "event_span", type: "span.tool_execution_start", tool_use_id: "toolu_1", name: "bash", at_ms: NOW },
        { id: "event_idle", type: "session.status_idle", stop_reason: { type: "end_turn" }, processed_at: "2026-08-26T00:30:00.002Z" },
      ],
    });

    await accept();

    expect(names(log)).toEqual([
      "executionStarted",
      "startAttempt",
      "startAttemptSettled",
      "frame:session.status_running",
      "history:session.status_running",
      "frame:span.tool_execution_start",
      "frame:session.status_idle",
      "history:session.status_idle",
      "executionSettled",
    ]);
    expect(log[0]).toEqual(["executionStarted", {
      ...scope,
      events: [input],
      fence,
      atMs: NOW,
      agentName: "Coding agent",
      harness: "pi",
    }]);
    expect(log[1]).toEqual(["startAttempt", { ...scope, attempt: 1, atMs: NOW }]);
    expect(log[2]).toEqual(["startAttemptSettled", { ...scope, attempt: 1, atMs: NOW, outcome: "ok" }]);
    expect(log[3]).toEqual(["frame", scope, "session.status_running"]);
    expect(log.at(-1)).toEqual(["executionSettled", { ...scope, atMs: NOW, outcome: "completed" }]);
  });

  it("settles each failed start attempt before the driver projects the failure", async () => {
    const log: Call[] = [];
    const { accept } = createDriver({
      log,
      observer: recordingObserver(log),
      start: async () => { throw new Error("sprite preparation failed"); },
      delayMs: (attempt) => attempt * 10,
    });

    await expect(accept()).rejects.toThrow("sprite preparation failed");

    expect(names(log)).toEqual([
      "executionStarted",
      "startAttempt",
      "startAttemptSettled",
      "frame:session.error",
      "history:session.error",
      "frame:session.status_rescheduled",
      "history:session.status_rescheduled",
      "startAttempt",
      "startAttemptSettled",
      "frame:session.error",
      "history:session.error",
      "frame:session.status_rescheduled",
      "history:session.status_rescheduled",
      "startAttempt",
      "startAttemptSettled",
      "frame:session.error",
      "history:session.error",
      "frame:session.status_idle",
      "history:session.status_idle",
      "executionSettled",
    ]);
    const settled = log.filter((call) => call[0] === "startAttemptSettled").map((call) => call[1]);
    expect(settled).toEqual([
      { ...scope, attempt: 1, atMs: NOW, outcome: "error", error: "sprite preparation failed", retryInMs: 10 },
      { ...scope, attempt: 2, atMs: NOW, outcome: "error", error: "sprite preparation failed", retryInMs: 20 },
      { ...scope, attempt: 3, atMs: NOW, outcome: "error", error: "sprite preparation failed" },
    ]);
    expect(log.at(-1)).toEqual(["executionSettled", {
      ...scope,
      atMs: NOW,
      outcome: "failed",
      reason: "sprite preparation failed",
    }]);
  });

  it("reports a cancel in the retry pause before the closing idle", async () => {
    const log: Call[] = [];
    let markBackoff: (() => void) | undefined;
    const backoff = new Promise<void>((resolve) => { markBackoff = resolve; });
    const { accept, driver } = createDriver({
      log,
      observer: recordingObserver(log),
      start: async () => { throw new Error("sprite preparation failed"); },
      delayMs: () => {
        markBackoff?.();
        return 10_000;
      },
    });

    const pending = accept();
    await backoff;
    driver.cancel({ ...scope, reason: "interrupt_requested" });
    await expect(pending).rejects.toThrow("interrupt_requested");

    expect(names(log)).toEqual([
      "executionStarted",
      "startAttempt",
      "startAttemptSettled",
      "frame:session.error",
      "history:session.error",
      "frame:session.status_rescheduled",
      "history:session.status_rescheduled",
      "startCancelled",
      "frame:session.status_idle",
      "history:session.status_idle",
      "executionSettled",
    ]);
    expect(log.find((call) => call[0] === "startCancelled")).toEqual(["startCancelled", {
      ...scope,
      atMs: NOW,
      reason: "interrupt_requested",
    }]);
    expect(log.at(-1)).toEqual(["executionSettled", {
      ...scope,
      atMs: NOW,
      outcome: "cancelled",
      reason: "interrupt_requested",
    }]);
  });

  it("marks an attempt stopped mid-flight as cancelled", async () => {
    const log: Call[] = [];
    let markAttempt: (() => void) | undefined;
    const attemptStarted = new Promise<void>((resolve) => { markAttempt = resolve; });
    const { accept, driver } = createDriver({
      log,
      observer: recordingObserver(log),
      start: async (startInput) => {
        markAttempt?.();
        await new Promise<void>((_resolve, reject) => {
          startInput.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("interrupt_requested"), { name: "AbortError" }));
          }, { once: true });
        });
      },
    });

    const pending = accept();
    await attemptStarted;
    driver.cancel({ ...scope, reason: "interrupt_requested" });
    await expect(pending).rejects.toThrow("interrupt_requested");

    expect(log.find((call) => call[0] === "startAttemptSettled")).toEqual(["startAttemptSettled", {
      ...scope,
      attempt: 1,
      atMs: NOW,
      outcome: "cancelled",
    }]);
    expect(log.at(-1)).toEqual(["executionSettled", {
      ...scope,
      atMs: NOW,
      outcome: "cancelled",
      reason: "interrupt_requested",
    }]);
  });

  it("leaves the turn to the next owner when the lease is lost", async () => {
    const log: Call[] = [];
    let markBackoff: (() => void) | undefined;
    const backoff = new Promise<void>((resolve) => { markBackoff = resolve; });
    const { accept, driver } = createDriver({
      log,
      observer: recordingObserver(log),
      start: async () => { throw new Error("sprite preparation failed"); },
      delayMs: () => {
        markBackoff?.();
        return 10_000;
      },
    });

    const pending = accept();
    await backoff;
    driver.cancel({ ...scope, reason: "lease_lost" });
    await expect(pending).rejects.toThrow("lease_lost");

    expect(log.at(-1)).toEqual(["executionSettled", {
      ...scope,
      atMs: NOW,
      outcome: "lease_lost",
      reason: "lease_lost",
    }]);
    expect(names(log)).not.toContain("frame:session.status_idle");
  });

  it("waits for the trace flush before the turn returns", async () => {
    const log: Call[] = [];
    let flushed = false;
    const { accept } = createDriver({
      log,
      observer: recordingObserver(log, {
        executionSettled: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          flushed = true;
        },
      }),
    });

    await accept();

    expect(flushed).toBe(true);
  });

  it("stops waiting for the trace flush after 2 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const log: Call[] = [];
    const { accept } = createDriver({
      log,
      observer: recordingObserver(log, { executionSettled: () => new Promise<void>(() => {}) }),
    });

    let done = false;
    const pending = accept().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it("keeps the turn running when the observer throws and logs the failure", async () => {
    const log: Call[] = [];
    const warnings: Array<Record<string, unknown>> = [];
    const fail = () => { throw new Error("trace store is down"); };
    const { accept } = createDriver({
      log,
      observer: {
        executionStarted: fail,
        startAttempt: fail,
        startAttemptSettled: fail,
        startCancelled: fail,
        frame: fail,
        executionSettled: async () => { throw new Error("trace store is down"); },
      },
      logger: { warn: (obj) => { warnings.push(obj); } },
      frames: [
        { id: "event_running", type: "session.status_running", processed_at: "2026-08-26T00:30:00.001Z" },
      ],
    });

    await accept();

    expect(names(log)).toEqual(["history:session.status_running"]);
    expect(warnings.map((warning) => [warning.op, warning.step])).toEqual([
      ["main-node.trace.observer_failed", "execution_started"],
      ["main-node.trace.observer_failed", "start_attempt"],
      ["main-node.trace.observer_failed", "start_attempt_settled"],
      ["main-node.trace.observer_failed", "frame"],
      ["main-node.trace.observer_failed", "execution_settled"],
    ]);
    expect(warnings[0]).toMatchObject({
      workspace_id: "workspace_01",
      session_id: "session_01",
      err: "trace store is down",
    });
  });

  it("tells the observer when the session stops", async () => {
    const log: Call[] = [];
    const { driver } = createDriver({ log, observer: recordingObserver(log) });

    await driver.stop({ ...scope, session, reason: "archived" });

    expect(log).toEqual([["sessionStopped", { ...scope, atMs: NOW, reason: "archived" }]]);
  });
});
