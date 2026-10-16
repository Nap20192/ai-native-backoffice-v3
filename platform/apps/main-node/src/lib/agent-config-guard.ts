// Guard before POST /v1/agents and POST /v1/agents/:id
// (docs/plans/models-harness.md, 4). It rejects a model or harness the server
// cannot run, before the shared upstream route stores the agent.
//
// Mount once: `v1.use("/agents/*", agentConfigGuard(deps))`. In Hono that
// pattern also matches `/agents`. The guard skips every other method and path,
// archive included. Hono caches the parsed body, so the route reads it again.
import type { MiddlewareHandler } from "hono";
import { checkAcpEnv, type AcpEnvProblem } from "./acp-env-policy.js";
import {
  BUILTIN_HARNESSES,
  compatibility,
  harnessDisplayLabel,
  type HarnessEntry,
} from "./harness-catalog.js";
import type { ModelOption } from "./model-options.js";

export interface AgentConfigGuardDeps {
  catalog(workspaceId: string): Promise<{ models: ModelOption[]; harnesses: HarnessEntry[] }>;
  loadAgent(workspaceId: string, agentId: string): Promise<{
    model: string | { id: string; effort?: string; speed?: string };
    _oma?: { harness?: string | null; acp?: { agent?: { id?: string; command?: string; env?: Record<string, string | null> } } | null };
  } | null>;
}

type AcpConfig = {
  agent?: { id?: unknown; command?: unknown; env?: unknown } | null;
} | null | undefined;

/** Final agent config after the update is laid over the stored agent. */
export interface GuardedAgentConfig {
  model: unknown;
  harness: string | null | undefined;
  acp: AcpConfig;
  /** True on create and when an update sets another harness value. */
  harnessChanged: boolean;
}

export interface GuardCatalog {
  models: readonly ModelOption[];
  harnesses: readonly HarnessEntry[];
}

const LOOP_HARNESSES: ReadonlySet<string> = new Set(["", "default", "pi"]);

/**
 * Checks of table 4.3 in order. Returns the first violation as text for a
 * person, or null when the config passes.
 */
export function checkAgentConfig(config: GuardedAgentConfig, catalog: GuardCatalog): string | null {
  const harness = config.harness ?? "";
  if (harness === "acp-proxy") {
    return "acp-proxy на этом сервере не работает. Выберите harness из GET /v1/oma/harnesses";
  }
  if (harness === "ai-sdk" && config.harnessChanged) {
    return "Harness ai-sdk устарел. Выберите встроенный цикл или ACP-агента из каталога";
  }
  // An old ai-sdk agent that keeps its harness is checked like the built-in loop.
  const isAcp = harness === "acp-sandbox";
  if (!isAcp && !LOOP_HARNESSES.has(harness) && harness !== "ai-sdk") {
    return `Неизвестный harness «${harness}»`;
  }

  let entry: HarnessEntry;
  if (isAcp) {
    const agent = config.acp?.agent;
    if (typeof agent?.command !== "string" || agent.command.trim() === "") {
      return "Для acp-sandbox задайте _oma.acp.agent.command";
    }
    const id = typeof agent.id === "string" ? agent.id : "";
    if (id === "") {
      return "Для acp-sandbox задайте _oma.acp.agent.id. Выберите вариант из GET /v1/oma/harnesses";
    }
    const found = catalog.harnesses.find(
      (candidate) => candidate.id === id && candidate.runtime_harness === "acp-sandbox",
    );
    if (found === undefined) {
      return `Harness «${id}» не найден. Выберите вариант из GET /v1/oma/harnesses`;
    }
    if (found.status === "unavailable") {
      return `Harness «${harnessDisplayLabel(found)}» недоступен: ${found.reason ?? ""}`.trimEnd();
    }
    entry = found;
  } else {
    entry = catalog.harnesses.find((candidate) => candidate.id === "pi") ?? BUILTIN_HARNESSES[0]!;
  }
  const label = harnessDisplayLabel(entry);

  const model = readModel(config.model);
  if (model !== null) {
    const option = catalog.models.find((candidate) => candidate.handle === model.handle);
    if (option === undefined) {
      return `Модель «${model.handle}» не найдена. Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY`;
    }
    if (!compatibility(entry, option).compatible) {
      const tail = option.protocols.length > 0
        ? `нужен протокол ${entry.protocols.join(", ")}, у модели ${option.protocols.join(", ")}`
        : "у модели нет протокола, который понимает прокси";
      return `Модель «${model.handle}» не подходит для «${label}»: ${tail}`;
    }
    if (isAcp && model.effort !== null) {
      return `${label} не принимает усилие: уберите model.effort`;
    }
    if (isAcp && model.speed === "fast") {
      return `${label} не принимает скорость: уберите model.speed`;
    }
    if (model.effort !== null && !(option.effort_levels as readonly string[]).includes(model.effort)) {
      return option.effort_levels.length > 0
        ? `Модель «${model.handle}» не поддерживает усилие «${model.effort}». Допустимо: ${option.effort_levels.join(", ")}`
        : `Модель «${model.handle}» не поддерживает усилие`;
    }
    if (model.speed === "fast" && !option.speed_fast) {
      return `Модель «${model.handle}» не поддерживает быструю скорость`;
    }
  }

  if (isAcp) {
    const env = config.acp?.agent?.env;
    const problems = checkAcpEnv(
      isEnvRecord(env) ? env : undefined,
      entry.allowed_env,
    );
    if (problems.length > 0) return envProblemText(problems[0]!, label, entry.allowed_env);
  }
  return null;
}

export function envProblemText(
  problem: AcpEnvProblem,
  harnessLabel: string,
  allowed: readonly string[] | null,
): string {
  const name = problem.name;
  switch (problem.kind) {
    case "bad_name":
      return `Имя переменной «${name}» недопустимо: латиница, цифры и подчёркивание`;
    case "server_name":
      return `Переменную «${name}» задаёт сервер, уберите её из env агента`;
    case "secret_name":
      return `Переменная «${name}» похожа на секрет. Ключи в env агента не кладите: модель подключается через прокси сервера`;
    case "secret_value":
      return `Значение переменной «${name}» похоже на ключ. Уберите его из env агента`;
    case "not_allowed":
      return allowed !== null && allowed.length > 0
        ? `Harness «${harnessLabel}» не разрешает переменную «${name}». Разрешены: ${allowed.join(", ")}`
        : `Harness «${harnessLabel}» не разрешает переменную «${name}». Разрешённых переменных нет`;
  }
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
    const oma = readOma(body._oma);
    if (oma === "invalid") return next();

    let config: GuardedAgentConfig;
    if (target.kind === "create") {
      config = { model: body.model, harness: oma?.harness, acp: oma?.acp, harnessChanged: true };
    } else {
      const touchesHarness = oma !== undefined && (oma.hasHarness || oma.hasAcp);
      if (!("model" in body) && !touchesHarness) return next();
      const current = await deps.loadAgent(workspaceId, target.agentId);
      // The route answers 404 for a missing agent.
      if (current === null) return next();
      const currentHarness = current._oma?.harness ?? null;
      const harness = oma?.hasHarness ? oma.harness : currentHarness;
      config = {
        model: "model" in body ? body.model : current.model,
        harness,
        acp: oma?.hasAcp ? oma.acp : current._oma?.acp,
        harnessChanged: oma?.hasHarness === true && (harness ?? "") !== (currentHarness ?? ""),
      };
      // A form or YAML save sends the stored model and _oma back with every
      // change. When nothing the guard checks differs from the stored agent,
      // the save passes: an agent whose card or model was deleted, or an old
      // agent with a server variable in env, can still be renamed.
      if (checkedFieldsKey(config.model, config.harness, config.acp)
        === checkedFieldsKey(current.model, currentHarness, current._oma?.acp)) {
        return next();
      }
    }

    const message = checkAgentConfig(config, await deps.catalog(workspaceId));
    if (message !== null) {
      return c.json({ type: "error", error: { type: "invalid_request_error", message } }, 400);
    }
    return next();
  };
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

interface ReadOma {
  hasHarness: boolean;
  harness: string | null;
  hasAcp: boolean;
  acp: AcpConfig;
}

/** `_oma` fields the guard reads, or "invalid" when the route schema will reject them. */
function readOma(value: unknown): ReadOma | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "invalid";
  const harness = value.harness;
  if (harness !== undefined && harness !== null && typeof harness !== "string") return "invalid";
  const acp = value.acp;
  if (acp !== undefined && acp !== null && !isRecord(acp)) return "invalid";
  if (isRecord(acp) && acp.agent !== undefined && !isRecord(acp.agent)) return "invalid";
  return {
    hasHarness: "harness" in value,
    harness: typeof harness === "string" ? harness : null,
    hasAcp: "acp" in value,
    acp: isRecord(acp) ? acp as AcpConfig : null,
  };
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

/**
 * The fields checkAgentConfig reads, as one comparable string: model handle,
 * effort and fast speed, the harness, the ACP agent id, command and string
 * env values. Equal keys mean a save changes nothing the guard checks.
 */
function checkedFieldsKey(model: unknown, harness: string | null | undefined, acp: unknown): string {
  const read = readModel(model);
  const agent = isRecord(acp) && isRecord(acp.agent) ? acp.agent : null;
  const env = agent !== null && isRecord(agent.env)
    ? Object.entries(agent.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    : [];
  return JSON.stringify([
    read === null ? null : [read.handle, read.effort, read.speed === "fast"],
    harness ?? "",
    agent === null ? null : [agent.id ?? null, agent.command ?? null, env],
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvRecord(value: unknown): value is Record<string, string | null> {
  return isRecord(value)
    && Object.values(value).every((item) => item === null || typeof item === "string");
}
