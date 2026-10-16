// Create tools (builder-agent.md 2.3). Every one makes one nested request and
// writes a new object in one insert; a failed create leaves nothing behind.

import { Cron } from "croner";
import { z } from "zod";
import { ROUTES } from "../route-rules";
import type { SchemaKind } from "../ports";
import {
  assistantLabels,
  configSchema,
  emptyPlan,
  encodeId,
  formatSchemaError,
  isRecord,
  isRef,
  parseConfig,
  writeOutcome,
  type OpContext,
  type OpPlan,
  type ToolDef,
} from "./common";
import { pageOf } from "./read";

const MAX_BYTES = 1024 * 1024;

function validate(ctx: OpContext, kind: SchemaKind, mode: "create" | "update", body: unknown): string | undefined {
  const schema = ctx.deps.schemas[kind]?.[mode];
  if (!schema) return undefined;
  const parsed = schema.safeParse(body);
  return parsed.success ? undefined : formatSchemaError(parsed.error);
}

/** The `model` of an agent config: a handle string or `{id}`. */
function modelHandle(body: Record<string, unknown>): string | undefined {
  if (typeof body.model === "string") return body.model;
  if (isRecord(body.model) && typeof body.model.id === "string") return body.model.id;
  return undefined;
}

/**
 * The agent route takes a model handle from GET /v1/oma/model_options. A card
 * id or an unknown name fails there with 400, so the card says it before the
 * click. Without the catalog route the check stays silent.
 */
export async function agentModelProblem(ctx: OpContext, body: Record<string, unknown>): Promise<string | undefined> {
  const model = modelHandle(body);
  if (model === undefined) return undefined;
  const response = await ctx.api.get("/v1/oma/model_options");
  if (!response.ok) return undefined;
  const options = pageOf(response.json).items.filter((option) => typeof option?.handle === "string");
  if (options.some((option) => option.handle === model)) return undefined;
  const card = options.find((option) => option.card_id === model);
  if (card) return `«${model}» это id карточки модели. В поле model пиши handle модели «${card.handle}»`;
  const handles = options.map((option) => String(option.handle)).slice(0, 10);
  return handles.length > 0
    ? `Модель «${model}» не найдена. В поле model пиши handle из list kind models: ${handles.join(", ")}`
    : `Модель «${model}» не найдена. Карточек моделей нет, её создаёт человек в консоли`;
}

/** Warnings about the skills of an agent. */
export async function agentWarnings(ctx: OpContext, body: Record<string, unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const skills = Array.isArray(body.skills) ? body.skills : [];
  for (const skill of skills) {
    const id = isRecord(skill) ? skill.skill_id : undefined;
    if (typeof id !== "string" || isRef(id)) continue;
    const found = await ctx.api.get(`/v1/skills/${encodeId(id)}`);
    if (found.status === 404) warnings.push(`Навык ${id} не найден`);
  }
  return warnings;
}

/**
 * An object with this name that this conversation already made and did not
 * archive. The model repeats a create after a long plan; a second agent with
 * the same name is never what the user asked for.
 */
async function createdInConversation(ctx: OpContext, listPath: string, name: unknown): Promise<{ id: string } | null> {
  if (typeof name !== "string" || name.length === 0) return null;
  const response = await ctx.api.get(`${listPath}?limit=100`);
  if (!response.ok) return null;
  const found = pageOf(response.json).items.find(
    (item) =>
      item?.name === name &&
      !item?.archived_at &&
      isRecord(item?.metadata) &&
      item.metadata.oma_assistant_session === ctx.actor.sessionId,
  );
  return typeof found?.id === "string" ? { id: found.id } : null;
}

const REPEAT_TAIL = "Не создавай его снова. Сверься с тем, что уже сделано в этом разговоре, и переходи к следующему шагу плана";

function withLabels(ctx: OpContext, config: Record<string, unknown>): Record<string, unknown> {
  const metadata = isRecord(config.metadata) ? config.metadata : {};
  return { ...config, metadata: { ...metadata, ...assistantLabels(ctx.actor.sessionId) } };
}

const createAgentArgs = z.object({ config: configSchema }).strict();

export const createAgentTool: ToolDef<z.infer<typeof createAgentArgs>> = {
  name: "create_agent",
  group: "write",
  description: "Создать агента. config это объект или YAML: name, model, system, tools, mcp_servers, skills, metadata. Ждёт подтверждения.",
  args: createAgentArgs,
  routes: [ROUTES.agentCreate, ROUTES.agents, ROUTES.modelOptions],
  precondition: "new_object",
  op: {
    targetKind: "agent",
    targetKey: () => null,
    async plan(ctx, args) {
      const parsed = parseConfig(args.config);
      if (!parsed.ok) return { ...emptyPlan("create"), invalid: parsed.message };
      const body = withLabels(ctx, parsed.value);
      const repeat = await createdInConversation(ctx, "/v1/agents", body.name);
      return {
        ...emptyPlan("create"),
        after: body,
        invalid:
          validate(ctx, "agent", "create", body) ??
          (repeat ? `Агент «${String(body.name)}» уже создан в этом разговоре, id ${repeat.id}. ${REPEAT_TAIL}` : undefined) ??
          (await agentModelProblem(ctx, body)),
        warnings: await agentWarnings(ctx, body),
      };
    },
    async write(ctx, _args, plan) {
      const response = await ctx.api.post("/v1/agents", plan.after);
      return writeOutcome(ctx, response, (json) => ({
        targetId: json?.id ?? null,
        revision: json?.version === undefined ? null : String(json.version),
        summary: `Создан агент «${json?.name ?? ""}», id ${json?.id}, версия ${json?.version ?? 1}`,
        next: `окружение через create_environment, если его ещё нет, затем create_session с agent_id ${json?.id}, если пользователь просил запуск`,
      }));
    },
  },
};

const createEnvironmentArgs = z.object({ config: configSchema }).strict();

export const createEnvironmentTool: ToolDef<z.infer<typeof createEnvironmentArgs>> = {
  name: "create_environment",
  group: "write",
  description: "Создать окружение. config: name, description, config (тип, сеть, пакеты), metadata. Ждёт подтверждения.",
  args: createEnvironmentArgs,
  routes: [ROUTES.environmentCreate, ROUTES.environments],
  precondition: "new_object",
  op: {
    targetKind: "environment",
    targetKey: () => null,
    async plan(ctx, args) {
      const parsed = parseConfig(args.config);
      if (!parsed.ok) return { ...emptyPlan("create"), invalid: parsed.message };
      const body = withLabels(ctx, parsed.value);
      const repeat = await createdInConversation(ctx, "/v1/environments", body.name);
      return {
        ...emptyPlan("create"),
        after: body,
        invalid:
          validate(ctx, "environment", "create", body) ??
          (repeat ? `Окружение «${String(body.name)}» уже создано в этом разговоре, id ${repeat.id}. ${REPEAT_TAIL}` : undefined),
      };
    },
    async write(ctx, _args, plan) {
      const response = await ctx.api.post("/v1/environments", plan.after);
      return writeOutcome(ctx, response, (json) => ({
        targetId: json?.id ?? null,
        revision: response.headers.get("etag"),
        summary: `Создано окружение «${json?.name ?? ""}», id ${json?.id}`,
        next: `агент через create_agent, если его ещё нет, затем create_session с environment_id ${json?.id}, если пользователь просил запуск`,
      }));
    },
  },
};

export const skillFilesSchema = z
  .array(
    z
      .object({
        path: z.string().min(1).max(500),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(200);

export function decodeFiles(files: z.infer<typeof skillFilesSchema>): { path: string; bytes: Uint8Array; text: string | null }[] {
  return files.map((file) => {
    const bytes = file.encoding === "base64" ? new Uint8Array(Buffer.from(file.content, "base64")) : new TextEncoder().encode(file.content);
    return { path: file.path, bytes, text: file.encoding === "base64" ? null : file.content };
  });
}

/** Spec check of a skill and its size limit. */
export function checkSkillFiles(ctx: OpContext, files: z.infer<typeof skillFilesSchema>): string | undefined {
  const decoded = decodeFiles(files);
  const total = decoded.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > MAX_BYTES) return "Файлы навыка больше 1 МБ";
  const check = ctx.libs.checkSkill(decoded.map((file) => ({ path: file.path, content: file.text ?? "" })));
  return check.ok ? undefined : `Навык не прошёл проверку спецификации. ${check.errors.join("; ")}`;
}

export function skillForm(files: z.infer<typeof skillFilesSchema>, displayTitle?: string): FormData {
  const form = new FormData();
  if (displayTitle !== undefined) form.set("display_title", displayTitle);
  for (const file of decodeFiles(files)) form.append("files[]", new File([file.bytes.slice().buffer as ArrayBuffer], file.path));
  return form;
}

export function skillFilesAfter(files: z.infer<typeof skillFilesSchema>): unknown[] {
  return decodeFiles(files).map((file) => (file.text === null ? { path: file.path, size_bytes: file.bytes.length } : { path: file.path, content: file.text }));
}

const createSkillArgs = z.object({ display_title: z.string().min(1).max(200), files: skillFilesSchema }).strict();

export const createSkillTool: ToolDef<z.infer<typeof createSkillArgs>> = {
  name: "create_skill",
  group: "write",
  description: "Создать навык из файлов: SKILL.md и остальные, всего до 1 МБ. Ждёт подтверждения.",
  args: createSkillArgs,
  routes: [ROUTES.skillCreate],
  precondition: "new_object",
  op: {
    targetKind: "skill",
    targetKey: () => null,
    async plan(ctx, args) {
      return {
        ...emptyPlan("create"),
        after: { display_title: args.display_title, files: skillFilesAfter(args.files) },
        invalid: checkSkillFiles(ctx, args.files),
      };
    },
    async write(ctx, args) {
      const response = await ctx.api.postForm("/v1/skills", skillForm(args.files, args.display_title));
      return writeOutcome(ctx, response, (json) => ({
        targetId: json?.id ?? null,
        revision: response.headers.get("etag") ?? json?.latest_version ?? null,
        summary: `Создан навык «${json?.display_title ?? args.display_title}», id ${json?.id}, версия ${json?.latest_version ?? 1}`,
        next: `подключи навык к агенту через update_agent, поле skills с skill_id ${json?.id}, если это входит в план`,
      }));
    },
  },
};

const uploadFileArgs = z
  .object({
    filename: z.string().min(1).max(255),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
    media_type: z.string().min(1).max(200).optional(),
  })
  .strict();

export const uploadFileTool: ToolDef<z.infer<typeof uploadFileArgs>> = {
  name: "upload_file",
  group: "write",
  description: "Загрузить файл до 1 МБ. Файл потом не меняется, новая редакция это новый файл. Ждёт подтверждения.",
  args: uploadFileArgs,
  routes: [ROUTES.fileUpload],
  precondition: "new_object",
  op: {
    targetKind: "file",
    targetKey: () => null,
    async plan(_ctx, args) {
      const bytes = args.encoding === "base64" ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
      return {
        ...emptyPlan("create"),
        after: {
          filename: args.filename,
          media_type: args.media_type ?? "text/plain",
          size_bytes: bytes.length,
          ...(args.encoding === "base64" ? {} : { content: args.content }),
        },
        invalid: bytes.length > MAX_BYTES ? "Файл больше 1 МБ" : undefined,
      };
    },
    async write(ctx, args) {
      const bytes = args.encoding === "base64" ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
      const form = new FormData();
      form.set("file", new File([new Uint8Array(bytes).buffer as ArrayBuffer], args.filename, { type: args.media_type ?? "text/plain" }));
      const response = await ctx.api.postForm("/v1/files", form);
      return writeOutcome(ctx, response, (json) => ({
        targetId: json?.id ?? null,
        revision: null,
        summary: `Загружен файл «${json?.filename ?? args.filename}», id ${json?.id}`,
      }));
    },
  },
};

const createMemoryStoreArgs = z
  .object({ name: z.string().min(1).max(200), description: z.string().max(2000).optional() })
  .strict();

export const createMemoryStoreTool: ToolDef<z.infer<typeof createMemoryStoreArgs>> = {
  name: "create_memory_store",
  group: "write",
  description: "Создать хранилище памяти. Ждёт подтверждения.",
  args: createMemoryStoreArgs,
  routes: [ROUTES.memoryStoreCreate, ROUTES.memoryStores],
  precondition: "new_object",
  op: {
    targetKind: "memory_store",
    targetKey: () => null,
    async plan(ctx, args) {
      const body = withLabels(ctx, { name: args.name, ...(args.description === undefined ? {} : { description: args.description }) });
      const repeat = await createdInConversation(ctx, "/v1/memory_stores", body.name);
      return {
        ...emptyPlan("create"),
        after: body,
        invalid:
          validate(ctx, "memory_store", "create", body) ??
          (repeat ? `Хранилище памяти «${args.name}» уже создано в этом разговоре, id ${repeat.id}. ${REPEAT_TAIL}` : undefined),
      };
    },
    async write(ctx, _args, plan) {
      const response = await ctx.api.post("/v1/memory_stores", plan.after);
      return writeOutcome(ctx, response, (json) => ({
        targetId: json?.id ?? null,
        revision: response.headers.get("etag"),
        summary: `Создано хранилище памяти «${json?.name ?? ""}», id ${json?.id}`,
      }));
    },
  },
};

export const fileOrMemoryResource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), file_id: z.string().min(1), mount_path: z.string().min(1).optional() }).strict(),
  z
    .object({
      type: z.literal("memory_store"),
      memory_store_id: z.string().min(1),
      access: z.enum(["read_write", "read_only"]).optional(),
      instructions: z.string().optional(),
    })
    .strict(),
]);

export const userMessageEvent = z
  .object({
    type: z.literal("user.message"),
    content: z.array(z.object({ type: z.literal("text"), text: z.string().min(1) }).strict()).min(1),
  })
  .strict();

const createDeploymentArgs = z
  .object({
    name: z.string().min(1).max(200),
    agent: z.object({ id: z.string().min(1), version: z.number().int().min(1).optional() }).strict(),
    environment_id: z.string().min(1),
    initial_events: z.array(userMessageEvent).min(1).max(50),
    resources: z.array(fileOrMemoryResource).max(100).optional(),
    schedule: z.object({ cron: z.string().min(1), timezone: z.string().min(1) }).strict().optional(),
    vault_ids: z.array(z.string().min(1)).max(50).optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();

/** The next runs of a schedule for the card. */
export function upcomingRuns(cron: string, timezone: string, count = 3): string[] | null {
  try {
    return new Cron(cron, { timezone, paused: true }).nextRuns(count).map((date) => date.toISOString());
  } catch {
    return null;
  }
}

export function deploymentBody(ctx: OpContext, args: z.infer<typeof createDeploymentArgs>, version: number | undefined): Record<string, unknown> {
  return {
    name: args.name,
    ...(args.description === undefined ? {} : { description: args.description }),
    agent: { type: "agent", id: args.agent.id, ...(version === undefined ? {} : { version }) },
    environment_id: args.environment_id,
    initial_events: args.initial_events,
    ...(args.resources ? { resources: args.resources } : {}),
    ...(args.schedule ? { schedule: { type: "cron", expression: args.schedule.cron, timezone: args.schedule.timezone } } : {}),
    ...(args.vault_ids ? { vault_ids: args.vault_ids } : {}),
    metadata: assistantLabels(ctx.actor.sessionId),
  };
}

export const createDeploymentTool: ToolDef<z.infer<typeof createDeploymentArgs>> = {
  name: "create_deployment",
  group: "write",
  description: "Создать деплоймент сразу на паузе. Запускает его человек в консоли. Ждёт подтверждения.",
  args: createDeploymentArgs,
  routes: [ROUTES.deploymentCreate],
  precondition: "new_object",
  op: {
    targetKind: "deployment",
    targetKey: () => null,
    async plan(ctx, args) {
      let version = args.agent.version;
      const plan: OpPlan = emptyPlan("create");
      if (version === undefined && !isRef(args.agent.id)) {
        const agent = await ctx.api.get(`/v1/agents/${encodeId(args.agent.id)}`);
        if (agent.status === 404) return { ...plan, notFound: "Агент не найден" };
        version = typeof agent.json?.version === "number" ? agent.json.version : undefined;
      }
      const body = deploymentBody(ctx, args, version);
      const warnings: string[] = [];
      if (args.vault_ids?.length) warnings.push(`Деплоймент получит доступ к хранилищам секретов: ${args.vault_ids.join(", ")}`);
      const runs = args.schedule ? upcomingRuns(args.schedule.cron, args.schedule.timezone) : null;
      return {
        ...plan,
        revision: version === undefined ? null : String(version),
        state: { agent_version: version ?? null },
        after: { ...body, _oma: { paused: true } },
        invalid: args.schedule && runs === null ? "Расписание cron не разбирается" : validate(ctx, "deployment", "create", body),
        warnings,
        details: { upcoming_runs: runs, note: "Деплоймент создаётся на паузе. Запустить его можно в консоли" },
      };
    },
    async write(ctx, args, _plan, revision) {
      const version = revision === null ? undefined : Number(revision);
      const body = { ...deploymentBody(ctx, args, version), _oma: { paused: true } };
      const response = await ctx.api.post("/v1/deployments", body);
      return writeOutcome(ctx, response, (json) => ({
        targetId: json?.id ?? null,
        revision: response.headers.get("etag"),
        summary: `Создан деплоймент «${json?.name ?? args.name}» на паузе, id ${json?.id}`,
      }));
    },
  },
};

export const CREATE_TOOLS = [
  createAgentTool,
  createEnvironmentTool,
  createSkillTool,
  uploadFileTool,
  createMemoryStoreTool,
  createDeploymentTool,
];
