// Guard before POST /v1/agents and POST /v1/agents/:id
// (docs/plans/models-harness.md, 4). It rejects a model or harness the server
// cannot run, before the shared upstream route stores the agent.
//
// Only the built-in Pi loop runs agents (D41). A body that sets `_oma.harness`
// to anything but `default` or `pi`, or sends an `_oma.acp` block, is refused.
// A stored agent with an old harness still reads and runs on Pi; an update
// that does not send these fields passes.
//
// Mount once: `v1.use("/agents/*", agentConfigGuard(deps))`. In Hono that
// pattern also matches `/agents`. The guard skips every other method and path,
// archive included. Hono caches the parsed body, so the route reads it again.
import type { Context, MiddlewareHandler } from "hono";
import type { ModelOption } from "./model-options.js";

export const ONLY_PI_MESSAGE = "Остался только встроенный цикл. Уберите harness и блок acp.";

/** Harness values a new or saved agent may carry; a missing value means Pi too. */
const PI_HARNESSES: ReadonlySet<string> = new Set(["default", "pi"]);

/** The stored model as the guard compares it. */
export type GuardModel = string | { id: string; effort?: string; speed?: string };

export interface AgentConfigGuardDeps {
  /** Model options of the workspace, as GET /v1/oma/model_options lists them. */
  models(workspaceId: string): Promise<readonly ModelOption[]>;
  loadAgent(workspaceId: string, agentId: string): Promise<{ model: GuardModel } | null>;
}

/** Domain agent fields the guard reads. */
export interface StoredAgentForGuard {
  model: { id: string; effort?: string; speed?: string };
}

/** A stored agent in the shape of AgentConfigGuardDeps.loadAgent. */
export function storedAgentForGuard(agent: StoredAgentForGuard): { model: GuardModel } {
  return {
    model: {
      id: agent.model.id,
      ...(agent.model.effort === undefined ? {} : { effort: agent.model.effort }),
      ...(agent.model.speed === undefined ? {} : { speed: agent.model.speed }),
    },
  };
}

/**
 * Harness rule of D41: null when `_oma` keeps the agent on Pi, else the
 * message. A missing or null harness is Pi; an `acp` block is refused
 * whatever its content, `acp: null` passes.
 */
export function checkHarnessFields(oma: Record<string, unknown>): string | null {
  const harness = oma.harness;
  if (typeof harness === "string" && !PI_HARNESSES.has(harness)) return ONLY_PI_MESSAGE;
  if (oma.acp !== undefined && oma.acp !== null) return ONLY_PI_MESSAGE;
  return null;
}

/**
 * Model checks in order. Returns the first violation as text for a person,
 * or null when the model passes or the route schema will reject it.
 */
export function checkAgentModel(model: unknown, options: readonly ModelOption[]): string | null {
  const read = readModel(model);
  if (read === null) return null;
  const option = options.find((candidate) => candidate.handle === read.handle);
  if (option === undefined) {
    return `Модель «${read.handle}» не найдена. Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY`;
  }
  if (read.effort !== null && !(option.effort_levels as readonly string[]).includes(read.effort)) {
    return option.effort_levels.length > 0
      ? `Модель «${read.handle}» не поддерживает усилие «${read.effort}». Допустимо: ${option.effort_levels.join(", ")}`
      : `Модель «${read.handle}» не поддерживает усилие`;
  }
  if (read.speed === "fast" && !option.speed_fast) {
    return `Модель «${read.handle}» не поддерживает быструю скорость`;
  }
  return null;
}

export function agentConfigGuard(deps: AgentConfigGuardDeps): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const target = agentWriteTarget(c.req.path);
    if (target === null) return next();
    const workspaceId = (c.var as { tenant_id?: string }).tenant_id;
    if (!workspaceId) return next();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // The route answers 400 for a body that is not JSON.
      return next();
    }
    if (!isRecord(body)) return next();

    if (isRecord(body._oma)) {
      const message = checkHarnessFields(body._oma);
      if (message !== null) return refuse(c, message);
    }

    if (!("model" in body)) return next();
    if (target.kind === "update") {
      const current = await deps.loadAgent(workspaceId, target.agentId);
      // The route answers 404 for a missing agent.
      if (current === null) return next();
      // A form or YAML save sends the stored model back with every change.
      // When the model the guard checks is the stored one, the save passes:
      // an agent whose card or model was deleted can still be renamed.
      if (modelKey(body.model) === modelKey(current.model)) return next();
    }

    const message = checkAgentModel(body.model, await deps.models(workspaceId));
    if (message !== null) return refuse(c, message);
    return next();
  };
}

function refuse(c: Context, message: string) {
  return c.json({ type: "error", error: { type: "invalid_request_error", message } }, 400);
}

type AgentWriteTarget = { kind: "create" } | { kind: "update"; agentId: string };

function agentWriteTarget(path: string): AgentWriteTarget | null {
  const match = /\/agents(?:\/([^/]+))?$/.exec(path);
  if (match === null) return null;
  if (match[1] === undefined) return { kind: "create" };
  try {
    return { kind: "update", agentId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

interface ReadModel {
  handle: string;
  effort: string | null;
  speed: string | null;
}

/** Model as a handle or an object; null when the route schema will reject it. */
function readModel(value: unknown): ReadModel | null {
  if (typeof value === "string") {
    return value.length > 0 ? { handle: value, effort: null, speed: null } : null;
  }
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return null;
  return {
    handle: value.id,
    effort: readEffort(value.effort),
    speed: typeof value.speed === "string" ? value.speed : null,
  };
}

function readEffort(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.type === "string") return value.type;
  return null;
}

/** Model handle, effort and fast speed as one comparable string. */
function modelKey(model: unknown): string {
  const read = readModel(model);
  return JSON.stringify(read === null ? null : [read.handle, read.effort, read.speed === "fast"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
