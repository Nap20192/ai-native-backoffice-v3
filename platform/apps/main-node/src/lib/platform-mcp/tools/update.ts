// Edit tools and write_memory (builder-agent.md 2.3). The revision the user
// confirmed goes into the write (2.5, step 8): `version` in the body, `If-Match`
// or `precondition.content_sha256`. The route compares it atomically.

import { z } from "zod";
import { classifyDeploymentEdit, classifyDeploymentState, classifyEdit, classifyWriteMemory } from "../classify";
import { routeErrorMessage } from "../inner-api";
import { ROUTES } from "../route-rules";
import { cleanObject } from "../response-shape";
import {
  configSchema,
  emptyPlan,
  encodeId,
  memoryListQuery,
  formatSchemaError,
  isRef,
  mergeAfter,
  parseConfig,
  readObject,
  RouteError,
  writeOutcome,
  type OpContext,
  type OpPlan,
  type ToolDef,
} from "./common";
import { agentModelProblem, checkSkillFiles, fileOrMemoryResource, skillFilesAfter, skillFilesSchema, skillForm, userMessageEvent } from "./create";
import { pageOf } from "./read";

const ifMatch = (revision: string | null) => (revision ? { headers: { "if-match": revision } } : undefined);
const notFoundPlan = (message: string): OpPlan => ({ ...emptyPlan("update"), notFound: message });

function validateUpdate(ctx: OpContext, kind: "agent" | "environment" | "deployment" | "memory_store", body: unknown): string | undefined {
  const schema = ctx.deps.schemas[kind]?.update;
  if (!schema) return undefined;
  const parsed = schema.safeParse(body);
  return parsed.success ? undefined : formatSchemaError(parsed.error);
}

function parseChanges(value: unknown): { changes: Record<string, unknown>; invalid?: string } {
  const parsed = parseConfig(value);
  if (!parsed.ok) return { changes: {}, invalid: parsed.message };
  return { changes: parsed.value };
}

// ---------- agent ----------

const updateAgentArgs = z
  .object({ agent_id: z.string().min(1), expected_version: z.number().int().min(1), changes: configSchema })
  .strict();

export const updateAgentTool: ToolDef<z.infer<typeof updateAgentArgs>> = {
  name: "update_agent",
  group: "write",
  description: "Изменить агента, получится новая версия. expected_version бери из get. Ждёт подтверждения.",
  args: updateAgentArgs,
  routes: [ROUTES.agentUpdate, ROUTES.modelOptions],
  precondition: "version_in_body",
  op: {
    targetKind: "agent",
    targetKey: (args) => `agent:${args.agent_id}`,
    async plan(ctx, args) {
      const found = await readObject(ctx, "agent", `/v1/agents/${encodeId(args.agent_id)}`, "version");
      if (!found) return notFoundPlan("Агент не найден");
      const own = (await ctx.assistant()).agentId === args.agent_id;
      const cls = classifyEdit({ archived: Boolean(found.raw?.archived_at), ownAssistantTarget: own });
      const { changes, invalid } = parseChanges(args.changes);
      delete changes.version;
      const version = Number(found.raw?.version);
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: args.agent_id,
        revision: String(version),
        state: { archived: Boolean(found.raw?.archived_at) },
        before: found.clean,
        after: mergeAfter(found.clean, changes),
        invalid:
          invalid ??
          validateUpdate(ctx, "agent", { ...changes, version }) ??
          ("model" in changes ? await agentModelProblem(ctx, changes) : undefined),
        argsStale: args.expected_version !== undefined && args.expected_version !== version,
      };
    },
    async write(ctx, args, _plan, revision) {
      const { changes } = parseChanges(args.changes);
      delete changes.version;
      const response = await ctx.api.post(`/v1/agents/${encodeId(args.agent_id)}`, { ...changes, version: Number(revision) });
      return writeOutcome(ctx, response, (json) => ({
        targetId: args.agent_id,
        revision: json?.version === undefined ? null : String(json.version),
        summary: `Агент изменён, версия ${revision} стала ${json?.version}`,
      }));
    },
  },
};

const AGENT_FIELDS = ["name", "description", "model", "system", "tools", "mcp_servers", "skills", "multiagent"] as const;

const restoreArgs = z
  .object({ agent_id: z.string().min(1), version: z.number().int().min(1), expected_version: z.number().int().min(1).optional() })
  .strict();

async function readOldVersion(ctx: OpContext, args: z.infer<typeof restoreArgs>): Promise<Record<string, unknown> | null> {
  const old = await ctx.api.get(`/v1/agents/${encodeId(args.agent_id)}?version=${args.version}`);
  if (old.status === 404) return null;
  if (!old.ok) throw new RouteError(old);
  const fields: Record<string, unknown> = {};
  for (const field of AGENT_FIELDS) if (old.json?.[field] !== undefined) fields[field] = old.json[field];
  return fields;
}

export const restoreAgentVersionTool: ToolDef<z.infer<typeof restoreArgs>> = {
  name: "restore_agent_version",
  group: "write",
  description: "Вернуть поля старой версии агента, получится новая версия. Ждёт подтверждения.",
  args: restoreArgs,
  routes: [ROUTES.agent, ROUTES.agentUpdate],
  precondition: "version_in_body",
  op: {
    targetKind: "agent",
    targetKey: (args) => `agent:${args.agent_id}`,
    async plan(ctx, args) {
      const found = await readObject(ctx, "agent", `/v1/agents/${encodeId(args.agent_id)}`, "version");
      if (!found) return notFoundPlan("Агент не найден");
      const old = await readOldVersion(ctx, args);
      if (!old) return notFoundPlan(`Версии ${args.version} у агента нет`);
      const own = (await ctx.assistant()).agentId === args.agent_id;
      const cls = classifyEdit({ archived: Boolean(found.raw?.archived_at), ownAssistantTarget: own });
      const version = Number(found.raw?.version);
      const oldClean = cleanObject("agent", old, ctx.known, ctx.libs).value;
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: args.agent_id,
        revision: String(version),
        state: { archived: Boolean(found.raw?.archived_at), restored_version: args.version },
        before: found.clean,
        after: mergeAfter(found.clean, oldClean),
        argsStale: args.expected_version !== undefined && args.expected_version !== version,
      };
    },
    async write(ctx, args, _plan, revision) {
      const old = await readOldVersion(ctx, args);
      if (!old) return { type: "error", message: `Версии ${args.version} у агента нет` };
      const response = await ctx.api.post(`/v1/agents/${encodeId(args.agent_id)}`, { ...old, version: Number(revision) });
      return writeOutcome(ctx, response, (json) => ({
        targetId: args.agent_id,
        revision: json?.version === undefined ? null : String(json.version),
        summary: `Поля версии ${args.version} вернулись, новая версия ${json?.version}`,
      }));
    },
  },
};

// ---------- environment ----------

const updateEnvironmentArgs = z
  .object({ environment_id: z.string().min(1), changes: configSchema, expected_revision: z.string().min(1).optional() })
  .strict();

export const updateEnvironmentTool: ToolDef<z.infer<typeof updateEnvironmentArgs>> = {
  name: "update_environment",
  group: "write",
  description: "Изменить окружение. Ревизию бери из get. Ждёт подтверждения.",
  args: updateEnvironmentArgs,
  routes: [ROUTES.environmentUpdate],
  precondition: "if_match",
  op: {
    targetKind: "environment",
    targetKey: (args) => `environment:${args.environment_id}`,
    async plan(ctx, args) {
      const found = await readObject(ctx, "environment", `/v1/environments/${encodeId(args.environment_id)}`);
      if (!found) return notFoundPlan("Окружение не найдено");
      const own = (await ctx.assistant()).environmentId === args.environment_id;
      const cls = classifyEdit({ archived: Boolean(found.raw?.archived_at), ownAssistantTarget: own });
      const { changes, invalid } = parseChanges(args.changes);
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: args.environment_id,
        revision: found.revision,
        state: { archived: Boolean(found.raw?.archived_at) },
        before: found.clean,
        after: mergeAfter(found.clean, changes),
        invalid: invalid ?? validateUpdate(ctx, "environment", changes),
        argsStale: args.expected_revision !== undefined && args.expected_revision !== found.revision,
      };
    },
    async write(ctx, args, _plan, revision) {
      const { changes } = parseChanges(args.changes);
      const response = await ctx.api.post(`/v1/environments/${encodeId(args.environment_id)}`, changes, ifMatch(revision));
      return writeOutcome(ctx, response, () => ({
        targetId: args.environment_id,
        revision: response.headers.get("etag"),
        summary: "Окружение изменено",
      }));
    },
  },
};

// ---------- skill version ----------

const skillVersionArgs = z
  .object({ skill_id: z.string().min(1), files: skillFilesSchema, expected_latest_version: z.string().min(1).optional() })
  .strict();

export const createSkillVersionTool: ToolDef<z.infer<typeof skillVersionArgs>> = {
  name: "create_skill_version",
  group: "write",
  description:
    "Новая версия навыка из файлов. SKILL.md начинается с frontmatter между строками ---: name (1-64 знака: строчные латинские буквы, цифры, дефис внутри) и description (до 1024 знаков). Без frontmatter сервер отклонит версию. Ждёт подтверждения.",
  args: skillVersionArgs,
  routes: [ROUTES.skillVersionCreate],
  precondition: "if_match",
  op: {
    targetKind: "skill",
    targetKey: (args) => `skill:${args.skill_id}`,
    async plan(ctx, args) {
      const found = await readObject(ctx, "skill", `/v1/skills/${encodeId(args.skill_id)}`, "latest_version");
      if (!found) return notFoundPlan("Навык не найден");
      const latest = found.raw?.latest_version ?? null;
      return {
        ...emptyPlan("update"),
        targetId: args.skill_id,
        revision: found.revision,
        state: { latest_version: latest },
        before: found.clean,
        after: { ...(found.clean as object), files: skillFilesAfter(args.files) },
        invalid: checkSkillFiles(ctx, args.files),
        argsStale: args.expected_latest_version !== undefined && args.expected_latest_version !== latest,
      };
    },
    async write(ctx, args, _plan, revision) {
      const response = await ctx.api.postForm(`/v1/skills/${encodeId(args.skill_id)}/versions`, skillForm(args.files), ifMatch(revision));
      return writeOutcome(ctx, response, (json) => ({
        targetId: args.skill_id,
        revision: response.headers.get("etag") ?? json?.version ?? null,
        summary: `Новая версия навыка ${json?.version ?? ""}`.trim(),
      }));
    },
  },
};

// ---------- memory store ----------

const memoryStoreArgs = z
  .object({
    memory_store_id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    expected_revision: z.string().min(1).optional(),
  })
  .strict();

function memoryStoreChanges(args: z.infer<typeof memoryStoreArgs>): Record<string, unknown> {
  return {
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.description === undefined ? {} : { description: args.description }),
  };
}

export const updateMemoryStoreTool: ToolDef<z.infer<typeof memoryStoreArgs>> = {
  name: "update_memory_store",
  group: "write",
  description: "Изменить имя или описание хранилища памяти. Ждёт подтверждения.",
  args: memoryStoreArgs,
  routes: [ROUTES.memoryStoreUpdate],
  precondition: "if_match",
  op: {
    targetKind: "memory_store",
    targetKey: (args) => `memory_store:${args.memory_store_id}`,
    async plan(ctx, args) {
      const found = await readObject(ctx, "memory_store", `/v1/memory_stores/${encodeId(args.memory_store_id)}`);
      if (!found) return notFoundPlan("Хранилище памяти не найдено");
      const cls = classifyEdit({ archived: Boolean(found.raw?.archived_at) });
      const changes = memoryStoreChanges(args);
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: args.memory_store_id,
        revision: found.revision,
        state: { archived: Boolean(found.raw?.archived_at) },
        before: found.clean,
        after: mergeAfter(found.clean, changes),
        invalid: validateUpdate(ctx, "memory_store", changes),
        argsStale: args.expected_revision !== undefined && args.expected_revision !== found.revision,
      };
    },
    async write(ctx, args, _plan, revision) {
      const response = await ctx.api.post(`/v1/memory_stores/${encodeId(args.memory_store_id)}`, memoryStoreChanges(args), ifMatch(revision));
      return writeOutcome(ctx, response, () => ({
        targetId: args.memory_store_id,
        revision: response.headers.get("etag"),
        summary: "Хранилище памяти изменено",
      }));
    },
  },
};

// ---------- deployment ----------

const deploymentChanges = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    agent: z.object({ id: z.string().min(1), version: z.number().int().min(1).optional() }).strict().optional(),
    environment_id: z.string().min(1).optional(),
    schedule: z.object({ cron: z.string().min(1), timezone: z.string().min(1) }).strict().nullable().optional(),
    initial_events: z.array(userMessageEvent).min(1).max(50).optional(),
    resources: z.array(fileOrMemoryResource).max(100).nullable().optional(),
    vault_ids: z.array(z.string().min(1)).max(50).nullable().optional(),
  })
  .strict();

const updateDeploymentArgs = z
  .object({ deployment_id: z.string().min(1), changes: deploymentChanges, expected_revision: z.string().min(1).optional() })
  .strict();

function deploymentPatch(changes: z.infer<typeof deploymentChanges>): Record<string, unknown> {
  const { agent, schedule, ...rest } = changes;
  return {
    ...rest,
    ...(agent ? { agent: { type: "agent", ...agent } } : {}),
    ...(schedule === undefined ? {} : { schedule: schedule === null ? null : { type: "cron", expression: schedule.cron, timezone: schedule.timezone } }),
  };
}

export const updateDeploymentTool: ToolDef<z.infer<typeof updateDeploymentArgs>> = {
  name: "update_deployment",
  group: "write",
  description: "Изменить деплоймент. У работающего деплоймента новую конфигурацию возьмёт следующий запуск. Ждёт подтверждения.",
  args: updateDeploymentArgs,
  routes: [ROUTES.deploymentUpdate],
  precondition: "if_match",
  op: {
    targetKind: "deployment",
    targetKey: (args) => `deployment:${args.deployment_id}`,
    async plan(ctx, args) {
      const found = await readObject(ctx, "deployment", `/v1/deployments/${encodeId(args.deployment_id)}`);
      if (!found) return notFoundPlan("Деплоймент не найден");
      const cls = classifyDeploymentEdit(found.raw ?? {});
      const patch = deploymentPatch(args.changes);
      const warnings: string[] = cls.warning ? [cls.warning] : [];
      if (args.changes.vault_ids?.length) warnings.push(`Деплоймент получит доступ к хранилищам секретов: ${args.changes.vault_ids.join(", ")}`);
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: args.deployment_id,
        revision: found.revision,
        state: { status: found.raw?.status ?? null, archived: Boolean(found.raw?.archived_at) },
        before: found.clean,
        after: mergeAfter(found.clean, patch),
        warnings,
        invalid: validateUpdate(ctx, "deployment", patch),
        argsStale: args.expected_revision !== undefined && args.expected_revision !== found.revision,
      };
    },
    async write(ctx, args, plan, revision) {
      const response = await ctx.api.post(`/v1/deployments/${encodeId(args.deployment_id)}`, deploymentPatch(args.changes), ifMatch(revision));
      return writeOutcome(ctx, response, (json) => ({
        targetId: args.deployment_id,
        revision: response.headers.get("etag"),
        summary: (json?.status ?? plan.state.status) === "paused" ? "Деплоймент изменён, он остаётся на паузе" : "Деплоймент изменён. Следующий запуск возьмёт новую конфигурацию",
      }));
    },
  },
};

// ---------- deployment state (crud.md 3.1, 3.2) ----------

const deploymentStateArgs = z
  .object({ deployment_id: z.string().min(1), expected_revision: z.string().min(1).optional() })
  .strict();

type DeploymentAction = "pause" | "unpause" | "run";

export const RUN_WARNING = "Запуск создаст сессию, агент сразу начнёт работу";
export const UNPAUSE_WARNING = "Деплоймент начнёт запуски по расписанию";

const DEPLOYMENT_ACTION: Record<DeploymentAction, { summary: (id: string, json: any) => string; warning: string | null }> = {
  pause: { summary: (id) => `Деплоймент ${id} на паузе`, warning: null },
  unpause: { summary: (id) => `Деплоймент ${id} снят с паузы`, warning: UNPAUSE_WARNING },
  run: {
    summary: (id, json) => `Деплоймент ${id} запущен, прогон ${json?.id ?? ""}, сессия ${json?.session_id ?? ""}. Читай ход через get_session_events`,
    warning: RUN_WARNING,
  },
};

function deploymentStateTool(action: DeploymentAction, name: string, description: string): ToolDef<z.infer<typeof deploymentStateArgs>> {
  const route = action === "pause" ? ROUTES.deploymentPause : action === "unpause" ? ROUTES.deploymentUnpause : ROUTES.deploymentStart;
  const meta = DEPLOYMENT_ACTION[action];
  return {
    name,
    group: "write",
    description,
    args: deploymentStateArgs,
    routes: [ROUTES.deployment, route],
    // A run takes no revision: it makes a new run and a new session.
    precondition: action === "run" ? "new_object" : "if_match",
    op: {
      targetKind: "deployment",
      targetKey: (args) => `deployment:${args.deployment_id}`,
      async plan(ctx, args) {
        const found = await readObject(ctx, "deployment", `/v1/deployments/${encodeId(args.deployment_id)}`);
        if (!found) return notFoundPlan("Деплоймент не найден");
        const cls = classifyDeploymentState(found.raw ?? {});
        const status = found.raw?.status ?? null;
        return {
          ...emptyPlan(cls.cls),
          reason: cls.reason,
          targetId: args.deployment_id,
          revision: found.revision,
          state: { status, archived: Boolean(found.raw?.archived_at), action },
          before: found.clean,
          after: action === "run" ? found.clean : mergeAfter(found.clean, { status: action === "pause" ? "paused" : "active" }),
          warnings: meta.warning ? [meta.warning] : [],
          argsStale: args.expected_revision !== undefined && args.expected_revision !== found.revision,
        };
      },
      async write(ctx, args, _plan, revision) {
        const response = await ctx.api.post(`/v1/deployments/${encodeId(args.deployment_id)}/${action}`, {}, action === "run" ? undefined : ifMatch(revision));
        // A run answers 409 when the deployment cannot start: the text says why.
        if (action === "run" && response.status === 409) {
          return { type: "error", message: ctx.libs.scan(routeErrorMessage(response), ctx.known).text };
        }
        return writeOutcome(ctx, response, (json) => ({
          targetId: args.deployment_id,
          revision: response.headers.get("etag"),
          summary: meta.summary(args.deployment_id, json),
        }));
      },
    },
  };
}

export const pauseDeploymentTool = deploymentStateTool("pause", "pause_deployment", "Поставить деплоймент на паузу. Ждёт подтверждения.");
export const unpauseDeploymentTool = deploymentStateTool(
  "unpause",
  "unpause_deployment",
  "Снять деплоймент с паузы, запуски пойдут по расписанию. Ждёт подтверждения.",
);
export const runDeploymentTool = deploymentStateTool(
  "run",
  "run_deployment",
  "Запустить деплоймент сейчас. Запуск создаёт сессию, агент сразу начинает работу. Ждёт подтверждения отдельной карточкой.",
);

// ---------- model card ----------

export const modelCardChanges = z
  .object({
    model: z.string().min(1).max(200).optional(),
    model_id: z.string().min(1).max(200).optional(),
    pi_config: z.record(z.string(), z.unknown()).nullable().optional(),
    is_default: z.boolean().optional(),
  })
  .strict();

const updateModelCardArgs = z
  .object({ model_card_id: z.string().min(1), changes: modelCardChanges, expected_updated_at: z.string().min(1).optional() })
  .strict();

function cardRevision(found: { revision: string | null; raw: any }): string | null {
  return found.revision ?? found.raw?.created_at ?? null;
}

export const updateModelCardTool: ToolDef<z.infer<typeof updateModelCardArgs>> = {
  name: "update_model_card",
  group: "write",
  description: "Изменить model, model_id, pi_config или is_default карточки модели. Ключ, адрес и заголовки меняет человек. Ждёт подтверждения.",
  args: updateModelCardArgs,
  routes: [ROUTES.modelCardUpdate],
  precondition: "if_match",
  op: {
    targetKind: "model_card",
    targetKey: (args) => `model_card:${args.model_card_id}`,
    async plan(ctx, args) {
      const found = await readObject(ctx, "model_card", `/v1/oma/model_cards/${encodeId(args.model_card_id)}`, "updated_at");
      if (!found) return notFoundPlan("Карточка модели не найдена");
      const cls = classifyEdit({ archived: Boolean(found.raw?.archived_at) });
      const revision = cardRevision(found);
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: args.model_card_id,
        revision,
        state: { archived: Boolean(found.raw?.archived_at) },
        before: found.clean,
        after: mergeAfter(found.clean, args.changes),
        argsStale: args.expected_updated_at !== undefined && args.expected_updated_at !== revision,
      };
    },
    async write(ctx, args, _plan, revision) {
      const response = await ctx.api.post(`/v1/oma/model_cards/${encodeId(args.model_card_id)}`, args.changes, ifMatch(revision));
      return writeOutcome(ctx, response, (json) => ({
        targetId: args.model_card_id,
        revision: response.headers.get("etag") ?? json?.updated_at ?? null,
        summary: "Карточка модели изменена",
      }));
    },
  },
};

// ---------- memory ----------

const writeMemoryArgs = z
  .object({ memory_store_id: z.string().min(1), path: z.string().min(1).max(1000), content: z.string().max(102400) })
  .strict();

export const ABSENT = "absent";

async function findMemory(ctx: OpContext, storeId: string, path: string): Promise<any | null> {
  const listed = await ctx.api.get(`/v1/memory_stores/${encodeId(storeId)}/memories?${memoryListQuery(path)}`);
  if (!listed.ok) throw new RouteError(listed);
  return pageOf(listed.json).items.find((item) => item?.path === path) ?? null;
}

export const writeMemoryTool: ToolDef<z.infer<typeof writeMemoryArgs>> = {
  name: "write_memory",
  group: "write",
  description: "Записать текст в память по пути. Свободный путь создаёт запись, занятый меняет её. Ждёт подтверждения.",
  args: writeMemoryArgs,
  routes: [ROUTES.memoryCreate, ROUTES.memoryUpdate],
  precondition: "content_sha256_or_new_path",
  op: {
    targetKind: "memory",
    targetKey: (args) => `memory:${args.memory_store_id}:${args.path}`,
    async plan(ctx, args) {
      if (isRef(args.memory_store_id)) {
        return { ...emptyPlan("create"), revision: ABSENT, state: { path: ABSENT }, after: { path: args.path, content: args.content } };
      }
      const store = await ctx.api.get(`/v1/memory_stores/${encodeId(args.memory_store_id)}`);
      if (store.status === 404) return notFoundPlan("Хранилище памяти не найдено");
      if (!store.ok) throw new RouteError(store);
      const existing = await findMemory(ctx, args.memory_store_id, args.path);
      const cls = classifyWriteMemory({ pathTaken: existing !== null, storeArchived: Boolean(store.json?.archived_at) });
      if (!existing) {
        return { ...emptyPlan(cls.cls), reason: cls.reason, revision: ABSENT, state: { path: ABSENT }, after: { path: args.path, content: args.content } };
      }
      const full = await ctx.api.get(`/v1/memory_stores/${encodeId(args.memory_store_id)}/memories/${encodeId(existing.id)}?view=full`);
      if (!full.ok) throw new RouteError(full);
      const before = { path: args.path, content: ctx.libs.scan(String(full.json?.content ?? ""), ctx.known).text };
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: existing.id,
        revision: String(existing.content_sha256 ?? full.json?.content_sha256 ?? ""),
        state: { path: "taken" },
        before,
        after: { path: args.path, content: args.content },
      };
    },
    async write(ctx, args, plan, revision) {
      const storeId = args.memory_store_id;
      if (revision === ABSENT || revision === null) {
        const response = await ctx.api.post(`/v1/memory_stores/${encodeId(storeId)}/memories`, { path: args.path, content: args.content });
        return writeOutcome(ctx, response, (json) => ({
          targetId: json?.id ?? null,
          revision: json?.content_sha256 ?? null,
          summary: `Создана запись памяти ${args.path}`,
        }));
      }
      const response = await ctx.api.post(`/v1/memory_stores/${encodeId(storeId)}/memories/${encodeId(String(plan.targetId))}`, {
        content: args.content,
        precondition: { type: "content_sha256", content_sha256: revision },
      });
      return writeOutcome(ctx, response, (json) => ({
        targetId: plan.targetId,
        revision: json?.content_sha256 ?? null,
        summary: `Изменена запись памяти ${args.path}`,
      }));
    },
  },
};

export const UPDATE_TOOLS = [
  writeMemoryTool,
  updateAgentTool,
  restoreAgentVersionTool,
  updateEnvironmentTool,
  createSkillVersionTool,
  updateMemoryStoreTool,
  updateDeploymentTool,
  updateModelCardTool,
  pauseDeploymentTool,
  unpauseDeploymentTool,
  runDeploymentTool,
];

