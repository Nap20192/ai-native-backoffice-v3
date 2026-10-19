import type { SqlClient } from "@open-managed-agents/sql-client";
import type { DefaultNodeManagedSessionRunnerDependencies } from "../node-managed-session-runner.js";
import { createExecutionsReader } from "./executions-reader.js";
import { createHistoryWindow, createSessionInfoReader } from "./history-window.js";
import { createTraceObserver, decorateRunnerDependencies, type TraceObserver } from "./observer.js";
import { createTraceRecorder, type TraceRecorderLogger } from "./recorder.js";
import { createTraceRepair } from "./repair.js";
import { createTraceStore, type TraceStore } from "./store.js";
import type { TraceScope } from "./types.js";

/**
 * Wave 1 wiring of the agent trace in main-node (docs/plans/agent-trace.md,
 * TW1): the observer of the session driver, the sandbox phases of the runner
 * and the store behind both.
 */
export interface NodeTraceWiring {
  observer: TraceObserver;
  store: TraceStore;
  /** Deletes the trace with its session (plan 3.1). */
  deleteSession(scope: TraceScope): Promise<void>;
}

export function createNodeTraceWiring(input: {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  logger?: TraceRecorderLogger;
}): NodeTraceWiring | null {
  const store = createTraceStore({ sql: input.sql, dialect: input.dialect });
  const repair = createTraceRepair({
    store,
    executions: createExecutionsReader(input.sql),
    history: createHistoryWindow(input.sql),
    sessions: createSessionInfoReader(input.sql),
  });
  const recorder = createTraceRecorder({
    store,
    ...(input.logger !== undefined && { logger: input.logger }),
    // A later turn patched a span whose turn was never written: rebuild that turn.
    repairMissing: (scope, keyEventId) => repair.repairForEvent(scope, keyEventId),
  });
  const observer = createTraceObserver({
    recorder,
    ...(input.logger !== undefined && { logger: input.logger }),
    runnerPhases: true,
  });
  return {
    observer,
    store,
    deleteSession: (scope) => store.deleteSession(scope),
  };
}

/** Runner dependencies that report sandbox phases; unchanged without a trace. */
export function withTracePhases(
  wiring: NodeTraceWiring | null,
  dependencies: DefaultNodeManagedSessionRunnerDependencies,
): DefaultNodeManagedSessionRunnerDependencies {
  return wiring === null ? dependencies : decorateRunnerDependencies(dependencies, wiring.observer);
}
