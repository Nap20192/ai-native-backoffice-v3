// Node scheduler wiring — registers the same cron handlers as the CF
// entry. Started after the HTTP server boots; stopped on SIGTERM.
//
// Single-instance default: croner runs the schedule in-process. The
// retention sweeps are idempotent SQL DELETEs, so when scaling to
// multiple replicas later the worst case is "two replicas DELETE the
// same rows in the same minute" — both succeed harmlessly.

import type { AgentService } from "@open-managed-agents/agents-store";
import type { EnvironmentService } from "@open-managed-agents/environments-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { EvalRunService } from "@open-managed-agents/evals-store";
import type { MemoryStoreService } from "@open-managed-agents/memory-store";
import type { KvStore } from "@open-managed-agents/kv-store";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("node-scheduler");
import { createNodeScheduler } from "@open-managed-agents/scheduler/node";
import { memoryRetentionTick } from "@open-managed-agents/scheduler/jobs/memory-retention";
import {
  tickEvalRuns,
  type EvalRunnerContext,
  type EvalRunnerServices,
  type SandboxFetcher,
} from "@open-managed-agents/evals-runner";

export interface NodeSchedulerDeps {
  evalServices: EvalRunnerServices;
  memory: MemoryStoreService;
  /** Shared Session-output candidate sweeper, enabled only with shared blob storage. */
  sessionOutputGarbageCollection?: (() => Promise<number>) | null;
  /** Cron expressions; the control plane resolves them from configuration
   *  so an operator can quiet noisy crons without a code change. */
  cron?: Partial<NodeSchedulerCron>;
}

export interface NodeSchedulerCron {
  evalTick: string;
  memoryRetention: string;
}

export function buildNodeScheduler(deps: NodeSchedulerDeps) {
  const cron = (key: keyof NodeSchedulerCron, fallback: string) => {
    const v = deps.cron?.[key];
    return v && v.trim() ? v : fallback;
  };

  const scheduler = createNodeScheduler();

  // Eval-tick: runs every minute by default. Node's eval runner has no
  // SANDBOX_<env> binding to call into yet — until cloud environments
  // land on Node, this just iterates `evals.listActive()` (empty under
  // SQLite default) and exits. Cheap.
  const evalCtx: EvalRunnerContext = {
    forEachShard: async (fn) => [await fn(deps.evalServices)],
    getServicesForTenant: async () => deps.evalServices,
    getSandboxBinding: async (): Promise<SandboxFetcher | null> => null,
  };
  scheduler.register({
    name: "eval-tick",
    cron: cron("evalTick", "* * * * *"),
    handler: async () => {
      try {
        await tickEvalRuns(evalCtx);
      } catch (err) {
        log.warn({ err, op: "scheduler.eval_tick.failed" }, "eval-tick failed");
      }
    },
  });

  // Memory retention.
  scheduler.register({
    name: "memory-retention",
    cron: cron("memoryRetention", "* * * * *"),
    handler: memoryRetentionTick({
      forEachShard: async (fn) => [await fn({ memory: deps.memory }, "default")],
    }),
  });

  if (deps.sessionOutputGarbageCollection) {
    const sweep = deps.sessionOutputGarbageCollection;
    scheduler.register({
      name: "session-output-candidates-retention",
      cron: "* * * * *",
      handler: async () => {
        try { await sweep(); }
        catch (err) { log.warn({ err, op: "scheduler.session_output_gc.failed" }, "Session output GC failed"); }
      },
    });
  }

  return scheduler;
}

export type {
  AgentService,
  EnvironmentService,
  SessionService,
  EvalRunService,
  KvStore,
};

