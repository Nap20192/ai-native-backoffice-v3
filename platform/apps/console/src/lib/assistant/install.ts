import {
  BUILDER_ROLE_KEY,
  BUILDER_ROLE_VALUE,
  findBuilderEnvironment,
  type AssistantApiFn,
  type BuilderRef,
} from "./api";

/**
 * Установка ассистента в пространство (раздел 1.5 плана). Комплект отдаёт
 * `GET /v1/oma/platform-mcp/builder-bundle`: тела создания окружения «Ассистент»
 * и агента. Ставит их консоль обычным API от имени пользователя, сам ассистент
 * установку не вызывает.
 */

export interface BuilderBundle {
  environment: Record<string, unknown>;
  agent: Record<string, unknown>;
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Метка роли обязательна: по ней консоль находит ассистента и окружение. */
function withRole(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    metadata: { ...rec(body.metadata), [BUILDER_ROLE_KEY]: BUILDER_ROLE_VALUE },
  };
}

export interface BuilderToolGroup {
  id: string;
  title: string;
  /** Инструменты группы спрашивают подтверждение у человека. */
  confirm: boolean;
  tools: string[];
}

export interface BuilderBundleInfo {
  /** Сервер не получил модель: в теле агента её нет. */
  needsModel: boolean;
  environment: Record<string, unknown>;
  agent: Record<string, unknown>;
  toolGroups: BuilderToolGroup[];
}

/** Комплект для диалога шаблона «Конструктор»: тела и группы инструментов. */
export async function fetchBuilderBundle(
  api: AssistantApiFn,
  model: string | null,
): Promise<BuilderBundleInfo> {
  const query = model ? `?model=${encodeURIComponent(model)}` : "";
  const raw = rec(await api(`/v1/oma/platform-mcp/builder-bundle${query}`, { quiet: true }));
  const environment = rec(raw.environment);
  const agent = rec(raw.agent);
  if (Object.keys(environment).length === 0 || Object.keys(agent).length === 0) {
    throw new Error("Сервер не вернул комплект ассистента");
  }
  const groups = Array.isArray(raw.tool_groups) ? raw.tool_groups.map(rec) : [];
  const toolGroups: BuilderToolGroup[] = [];
  for (const g of groups) {
    if (typeof g.id !== "string" || typeof g.title !== "string" || !Array.isArray(g.tools)) continue;
    toolGroups.push({
      id: g.id,
      title: g.title,
      confirm: g.confirm === true,
      tools: g.tools.filter((t): t is string => typeof t === "string"),
    });
  }
  return { needsModel: raw.needs_model === true, environment, agent, toolGroups };
}

export async function installBuilder(
  api: AssistantApiFn,
  input: { model: string | null },
): Promise<BuilderRef> {
  const query = input.model ? `?model=${encodeURIComponent(input.model)}` : "";
  const raw = rec(await api(`/v1/oma/platform-mcp/builder-bundle${query}`, { quiet: true }));
  const environmentBody = rec(raw.environment);
  const agentBody = rec(raw.agent);
  if (Object.keys(environmentBody).length === 0 || Object.keys(agentBody).length === 0) {
    throw new Error("Сервер не вернул комплект ассистента");
  }

  // Окружение могло остаться от прошлой неудачной установки: второе не создаём.
  let environment = await findBuilderEnvironment(api);
  if (!environment) {
    const created = rec(
      await api("/v1/environments", { method: "POST", body: JSON.stringify(withRole(environmentBody)) }),
    );
    if (typeof created.id !== "string") throw new Error("Сервер не вернул id окружения");
    environment = {
      id: created.id,
      name: typeof created.name === "string" ? created.name : "Ассистент",
    };
  }

  const agent = rec(await api("/v1/agents", { method: "POST", body: JSON.stringify(withRole(agentBody)) }));
  if (typeof agent.id !== "string") throw new Error("Сервер не вернул id агента");
  return {
    agent: {
      id: agent.id,
      name: typeof agent.name === "string" ? agent.name : "Ассистент",
      version: typeof agent.version === "number" ? agent.version : 1,
    },
    environment,
  };
}

export interface ModelChoice {
  /** Что идёт в `agent.model`: идентификатор карточки. */
  id: string;
  label: string;
  provider: string;
}

/** Карточки моделей пространства для выбора модели ассистента. */
export async function fetchModelChoices(api: AssistantApiFn): Promise<ModelChoice[]> {
  const data = rec(await api("/v1/oma/model_cards?limit=100", { quiet: true })).data;
  const list = Array.isArray(data) ? data.map(rec) : [];
  return list
    .filter((c) => typeof c.model_id === "string" && c.model_id && !c.archived_at)
    .map((c) => ({
      id: c.model_id as string,
      label: c.model_id as string,
      provider: typeof c.provider === "string" ? c.provider : "",
    }));
}
