import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { WorkspacePersistencePort } from "@open-managed-agents/runtime-resource-contract";
import type { DefaultNodeManagedSessionRunnerDependencies } from "../node-managed-session-runner.js";
import type { NodeManagedWorkspaceCheckpoints } from "../node-managed-workspace-checkpoints.js";
import { createTraceProjector, type TraceProjector } from "./projector.js";
import type { TraceRecorder, TraceRecorderLogger } from "./recorder.js";
import type {
  SessionExecutionObserver,
  TraceAttrs,
  TracePhaseSink,
  TraceProjectorInput,
  TraceScope,
} from "./types.js";

/**
 * Observer of the session driver (plan section 2.1): it owns one projector per
 * running execution and hands its operations to the recorder. Any failure is
 * logged as main-node.trace.observer_failed and never reaches the turn.
 */
export interface TraceObserverOptions {
  recorder: TraceRecorder;
  logger?: TraceRecorderLogger;
  /** Harness of the session when the driver does not pass it. */
  harnessOf?: (scope: TraceScope) => string | null | undefined;
  /** Set when decorateRunnerDependencies wraps the runner: an attempt without phases reused a warm sandbox. */
  runnerPhases?: boolean;
  /** How long executionSettled waits for the final flush. */
  settleTimeoutMs?: number;
  now?: () => number;
}

export type TraceObserver = SessionExecutionObserver & TracePhaseSink & {
  /** Projector of the running execution, for tests and diagnostics. */
  projectorOf(scope: TraceScope): TraceProjector | undefined;
};

const keyOf = (scope: TraceScope) => `${scope.workspaceId}\u0000${scope.sessionId}`;

export function createTraceObserver(options: TraceObserverOptions): TraceObserver {
  const projectors = new Map<string, TraceProjector>();
  const now = options.now ?? Date.now;
  const settleTimeoutMs = options.settleTimeoutMs ?? 2_000;

  const failed = (scope: TraceScope, step: string, error: unknown) => {
    try {
      options.logger?.warn({
        op: "main-node.trace.observer_failed",
        workspace_id: scope.workspaceId,
        session_id: scope.sessionId,
        step,
        err: error instanceof Error ? error.message : String(error),
      }, "trace observer failed; the turn continues");
    } catch {
      // Logging must not break the driver either.
    }
  };

  const push = (scope: TraceScope, input: TraceProjectorInput, step: string): TraceProjector | undefined => {
    try {
      const projector = projectors.get(keyOf(scope));
      if (projector === undefined) return undefined;
      const ops = projector.push(input);
      const turnId = projector.turnId();
      if (turnId !== null && ops.length > 0) {
        options.recorder.record(scope, { turnId, attemptId: projector.attemptId(), ops });
      }
      return projector;
    } catch (error) {
      failed(scope, step, error);
      return undefined;
    }
  };

  return {
    now,
    projectorOf: (scope) => projectors.get(keyOf(scope)),

    executionStarted(input) {
      const scope = { workspaceId: input.workspaceId, sessionId: input.sessionId };
      try {
        const harness = input.harness ?? options.harnessOf?.(scope) ?? null;
        projectors.set(keyOf(scope), createTraceProjector({
          sessionId: input.sessionId,
          harness,
          mode: "live",
          runnerPhases: options.runnerPhases === true,
        }));
        push(scope, {
          kind: "execution_started",
          atMs: input.atMs,
          events: input.events,
          ...(input.fence !== undefined && { fence: input.fence }),
          ...(input.agentName !== undefined && { agentName: input.agentName }),
          harness,
        }, "execution_started");
        // The claim goes out at once, so a stale attempt is fenced as early as possible.
        void options.recorder.flush(scope).catch((error: unknown) => failed(scope, "claim_flush", error));
      } catch (error) {
        failed(scope, "execution_started", error);
      }
    },

    startAttempt(input) {
      push(input, { kind: "start_attempt", attempt: input.attempt, atMs: input.atMs }, "start_attempt");
    },

    startAttemptSettled(input) {
      push(input, {
        kind: "start_attempt_settled",
        attempt: input.attempt,
        atMs: input.atMs,
        outcome: input.outcome,
        ...(input.error !== undefined && { error: input.error }),
        ...(input.retryInMs !== undefined && { retryInMs: input.retryInMs }),
      }, "start_attempt_settled");
    },

    startCancelled(input) {
      push(input, { kind: "start_cancelled", atMs: input.atMs, ...(input.reason !== undefined && { reason: input.reason }) }, "start_cancelled");
    },

    frame(scope, frame) {
      push(scope, { kind: "frame", frame }, "frame");
    },

    sandboxPhase(scope, phase) {
      push(scope, {
        kind: "sandbox_phase",
        name: phase.name,
        startMs: phase.startMs,
        endMs: phase.endMs,
        ...(phase.error !== undefined && { error: phase.error }),
        ...(phase.attrs !== undefined && { attrs: phase.attrs }),
      }, "sandbox_phase");
    },

    async executionSettled(input) {
      const scope = { workspaceId: input.workspaceId, sessionId: input.sessionId };
      const projector = push(scope, {
        kind: "execution_settled",
        atMs: input.atMs,
        outcome: input.outcome,
        ...(input.reason !== undefined && { reason: input.reason }),
      }, "execution_settled");
      projectors.delete(keyOf(scope));
      if (projector === undefined || projector.turnId() === null) return;
      const settle = options.recorder.settle(scope, {
        turnId: projector.turnId()!,
        attemptId: projector.attemptId(),
        complete: input.outcome !== "lease_lost",
        historyCursor: projector.lastEventId(),
      }).catch((error: unknown) => failed(scope, "execution_settled", error));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        settle,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, settleTimeoutMs); }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
    },

    async sessionStopped(input) {
      const scope = { workspaceId: input.workspaceId, sessionId: input.sessionId };
      try {
        await options.recorder.cancelWaiting(scope, input.atMs);
      } catch (error) {
        failed(scope, "session_stopped", error);
      }
    },
  };
}

/**
 * Wraps the runner dependencies so the sandbox start reports its phases:
 * acquire (buildSandbox), restore (workspace materialize and attach) and
 * inputs (prepareSandbox). A failed phase is recorded and rethrown.
 */
export function decorateRunnerDependencies<D extends Pick<DefaultNodeManagedSessionRunnerDependencies, "buildSandbox" | "prepareSandbox" | "workspaceCheckpoints">>(
  dependencies: D,
  sink: TracePhaseSink,
  options: { now?: () => number } = {},
): D {
  const now = options.now ?? (sink.now !== undefined ? () => sink.now!() : Date.now);
  const timed = async <T>(scope: TraceScope, name: string, run: () => Promise<T>, attrs?: TraceAttrs): Promise<T> => {
    const startMs = now();
    try {
      const value = await run();
      report(scope, { name, startMs, endMs: now(), ...(attrs !== undefined && { attrs }) });
      return value;
    } catch (error) {
      report(scope, { name, startMs, endMs: now(), error: error instanceof Error ? error.message : String(error), ...(attrs !== undefined && { attrs }) });
      throw error;
    }
  };
  const report = (scope: TraceScope, phase: Parameters<TracePhaseSink["sandboxPhase"]>[1]) => {
    try {
      sink.sandboxPhase(scope, phase);
    } catch {
      // The trace never breaks the sandbox start.
    }
  };
  const decorated: D = {
    ...dependencies,
    buildSandbox: (input: Parameters<D["buildSandbox"]>[0]) =>
      timed({ workspaceId: input.workspaceId, sessionId: input.session.id }, "acquire", () => dependencies.buildSandbox(input)),
  };
  if (dependencies.prepareSandbox !== undefined) {
    const prepare = dependencies.prepareSandbox.bind(dependencies);
    decorated.prepareSandbox = (input) =>
      timed({ workspaceId: input.workspaceId, sessionId: input.session.id }, "inputs", () => prepare(input));
  }
  if (dependencies.workspaceCheckpoints !== undefined) {
    decorated.workspaceCheckpoints = decorateCheckpoints(dependencies.workspaceCheckpoints, timed);
  }
  return decorated;
}

function decorateCheckpoints(
  checkpoints: NodeManagedWorkspaceCheckpoints,
  timed: <T>(scope: TraceScope, name: string, run: () => Promise<T>) => Promise<T>,
): NodeManagedWorkspaceCheckpoints {
  // Keep the prototype: the runner calls other methods of the same instance.
  const wrapped = Object.create(checkpoints) as NodeManagedWorkspaceCheckpoints;
  wrapped.port = (sandbox: SandboxExecutor): WorkspacePersistencePort => {
    const port = checkpoints.port(sandbox);
    const scopeOf = (input: { scope: { workspaceId: string; sessionId: string } }) =>
      ({ workspaceId: input.scope.workspaceId, sessionId: input.scope.sessionId });
    return Object.assign(Object.create(port) as WorkspacePersistencePort, {
      materialize: (input: Parameters<WorkspacePersistencePort["materialize"]>[0]) =>
        timed(scopeOf(input), "restore", () => port.materialize(input)),
      attach: (input: Parameters<WorkspacePersistencePort["attach"]>[0]) =>
        timed(scopeOf(input), "restore", () => port.attach(input)),
    });
  };
  return wrapped;
}
