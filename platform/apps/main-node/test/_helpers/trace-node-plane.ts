// In-process Node control plane for the agent trace tests (docs/plans/agent-trace.md,
// TW1): SQLite in a temp folder, a local subprocess sandbox and the built-in
// Pi loop. Only the model is fake: the Pi faux provider answers each request.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  createModels,
  fauxProvider,
  type AssistantMessage,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { PiHarness } from "@open-managed-agents/agent/harness/pi-loop";
import { registerHarness } from "@open-managed-agents/agent/harness/registry";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { nodeDefaults } from "../../src/components.js";
import { loadNodeConfig } from "../../src/config.js";
import { createNodeControlPlane, type NodeControlPlane } from "../../src/control-plane.js";
import { openNodeDatabase } from "../../src/database.js";
import type { TraceSpan, TraceTurnSummary } from "../../src/lib/trace/types.js";

export const TRACE_MODEL = "claude-sonnet-4-6";
const BETA = { "anthropic-beta": "managed-agents-2026-04-01" };

export interface TraceResponse {
  trace_id: string;
  session_id: string;
  turns: TraceTurnSummary[];
  turns_before: string | null;
  spans: TraceSpan[];
  spans_next: string | null;
  cursor: string;
  collecting: boolean;
}

export interface TurnPage {
  turn_id: string;
  turn: TraceTurnSummary;
  spans: TraceSpan[];
  page_next: string | null;
  collecting: boolean;
}

export type WireEvent = Record<string, unknown> & { id: string; type: string; processed_at: string };

/**
 * Replaces the model of the registered "pi" harness with the faux provider.
 * node-foundation registers the core harnesses once, on import, so the
 * replacement holds for every control plane of the test file.
 */
export function useFauxPiModel(): FauxProviderHandle {
  const faux = fauxProvider({
    models: [{ id: TRACE_MODEL, contextWindow: 200_000, maxTokens: 8_192 }],
    tokensPerSecond: 5_000,
  });
  const models = createModels();
  models.setProvider(faux.provider);
  registerHarness("pi", () => ({
    run: (ctx: HarnessContext) => new PiHarness().run({
      ...ctx,
      pi: { ...ctx.pi!, models, model: faux.getModel() },
    }),
  }));
  return faux;
}

/** The message is built when the request starts, so its timestamp is the request start. */
export function slowAnswer(build: () => AssistantMessage, delayMs: number) {
  return async () => {
    const message = build();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return message;
  };
}

export function createTraceRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "oma-trace-http-"));
}

export function removeTraceRoot(root: string): Promise<void> {
  return rm(root, { recursive: true, force: true });
}

export async function waitFor<T>(what: string, read: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface TracePlane {
  plane: NodeControlPlane;
  /** The plane's own connection, without any test wrapper. */
  sql: SqlClient;
  api(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
  post<T = Record<string, any>>(path: string, body: unknown): Promise<T>;
  events(sessionId: string): Promise<WireEvent[]>;
  trace(sessionId: string): Promise<TraceResponse>;
  turn(sessionId: string, turnId: string): Promise<TurnPage>;
  stop(): Promise<void>;
}

/** Starts a control plane on `root`. A second start on the same root is a restart. */
export async function startTracePlane(
  root: string,
  options: { wrapSql?: (sql: SqlClient) => SqlClient } = {},
): Promise<TracePlane> {
  const config = loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    // The agent guard accepts only models of GET /v1/oma/model_options.
    ANTHROPIC_API_KEY: "unused-by-the-faux-model",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(root, "oma.db"),
    AUTH_DATABASE_PATH: join(root, "auth.db"),
    SANDBOX_WORKDIR: join(root, "sandbox"),
    MEMORY_BLOB_DIR: join(root, "memory"),
    FILES_BLOB_DIR: join(root, "files"),
    SESSION_OUTPUTS_DIR: join(root, "outputs"),
  });
  const database = await openNodeDatabase(config.database);
  const sql = database.sql;
  const plane = await createNodeControlPlane(await nodeDefaults(config, {
    database: options.wrapSql === undefined ? database : { ...database, sql: options.wrapSql(sql) },
  }));
  await plane.start();

  const api: TracePlane["api"] = (path, init = {}) => Promise.resolve(plane.fetch(new Request(`http://control-plane${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...BETA, "content-type": "application/json" },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  })));
  const json = async <T>(path: string, response: Response, status = 200): Promise<T> => {
    expect(response.status, `${path}: ${await response.clone().text()}`).toBe(status);
    return response.json() as Promise<T>;
  };
  return {
    plane,
    sql,
    api,
    async post(path, body) {
      const response = await api(path, { body });
      expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
      return response.json();
    },
    async events(sessionId) {
      const path = `/v1/sessions/${sessionId}/events?limit=1000`;
      return (await json<{ data: WireEvent[] }>(path, await api(path))).data;
    },
    async trace(sessionId) {
      const path = `/v1/oma/sessions/${sessionId}/trace`;
      return json<TraceResponse>(path, await api(path));
    },
    async turn(sessionId, turnId) {
      const path = `/v1/oma/sessions/${sessionId}/trace?turn_id=${encodeURIComponent(turnId)}`;
      return json<TurnPage>(path, await api(path));
    },
    stop: () => plane.stop("test"),
  };
}

/** A cloud environment, a Pi agent and an idle session. */
export async function createPiSession(
  plane: TracePlane,
  options: { bashPolicy?: "always_allow" | "always_ask" } = {},
): Promise<{ sessionId: string }> {
  const environment = await plane.post("/v1/environments", {
    name: "trace",
    config: { type: "cloud", networking: { type: "unrestricted" }, packages: { type: "packages" } },
  });
  const agent = await plane.post("/v1/agents", {
    name: "Trace agent",
    model: TRACE_MODEL,
    system: "Use bash when asked.",
    tools: [{
      type: "agent_toolset_20260401",
      ...(options.bashPolicy !== undefined && {
        configs: [{ name: "bash", permission_policy: { type: options.bashPolicy } }],
      }),
    }],
    _oma: { harness: "pi" },
  });
  const session = await plane.post("/v1/sessions", {
    agent: { type: "agent", id: agent.id, version: agent.version },
    environment_id: environment.id,
    title: "trace",
  });
  return { sessionId: session.id as string };
}

/** Sends events and waits until the session reports one more idle status. */
export async function runTurn(plane: TracePlane, sessionId: string, events: unknown[]): Promise<WireEvent[]> {
  const idleBefore = (await plane.events(sessionId)).filter((event) => event.type === "session.status_idle").length;
  await plane.post(`/v1/sessions/${sessionId}/events`, { events });
  return waitFor("the idle turn", async () => {
    const current = await plane.events(sessionId);
    return current.filter((event) => event.type === "session.status_idle").length > idleBefore ? current : null;
  });
}
