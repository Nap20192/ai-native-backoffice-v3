// archive_object, unarchive_object and delete_object (docs/plans/crud.md, 3.1
// to 3.4). Archive and delete are the danger class: the plan reads the
// dependency report, a blocking row puts the operation out of v1, and the
// report goes into the digest. Restore from the archive is an edit.

import { z } from "zod";
import { routeErrorMessage } from "../inner-api";
import { classifyDanger, classifyUnarchive, isAssistantAgent } from "../classify";
import { DEPENDENCY_ROUTES, ROUTES, type DependencyKind } from "../route-rules";
import type { RouteRule } from "../ports";
import type { ShapeKind } from "../response-shape";
import {
  dependencyReportOf,
  emptyPlan,
  encodeId,
  EMPTY_DEPENDENCIES,
  readObject,
  RouteError,
  writeOutcome,
  type DependencyReport,
  type OpContext,
  type OpPlan,
  type ReadObject,
  type ToolDef,
} from "./common";

export const ARCHIVE_KINDS = ["agent", "environment", "session", "deployment", "memory_store", "model_card"] as const;
export const DELETE_KINDS = [
  "agent",
  "environment",
  "session",
  "file",
  "skill",
  "skill_version",
  "memory_store",
  "memory",
  "session_resource",
  "model_card",
] as const;

type DangerKind = (typeof DELETE_KINDS)[number] | (typeof ARCHIVE_KINDS)[number];

/** Every kind of `get_dependencies`: the union of the archive and the delete kinds. */
export const DELETE_OR_ARCHIVE_KINDS = [...DELETE_KINDS, "deployment"] as const;
type Operation = "archive" | "unarchive" | "delete";

export const IRREVERSIBLE_NOTE = "Это нельзя отменить";
export const ARCHIVE_NOTE = "Объект можно вернуть из архива";
export const ALREADY_ARCHIVED = "Объект уже в архиве";
export const NOT_ARCHIVED = "Объект не в архиве, запись ничего не изменит";
export const DEPLOYMENT_PAUSED_NOTE = "Деплоймент вернётся из архива на паузе";
/** The archive time is set by the route; the card shows this mark in its place. */
export const ARCHIVE_MARK = "при подтверждении";

interface Target {
  kind: DangerKind;
  id: string;
  parent_id?: string;
  version?: string | number;
}

interface KindSpec {
  noun: string;
  notFound: string;
  shape: ShapeKind | null;
  /** `parent_id` is required: memory store, session. */
  parent?: boolean;
  /** `version` is required: skill version. */
  version?: boolean;
  path(target: Target): string;
  revisionField?: string;
  /** The revision does not come from the object itself. */
  revisionOf?(ctx: OpContext, target: Target, found: ReadObject): Promise<string | null>;
  /** Revision the route compares: `If-Match`, or `expected_content_sha256` for a memory. */
  precondition: "if_match" | "query" | "none";
  dependency: DependencyKind | null;
  routes: Partial<Record<Operation, RouteRule>>;
}

const enc = encodeId;

const SPECS: Readonly<Record<DangerKind, KindSpec>> = {
  agent: {
    noun: "агент",
    notFound: "Агент не найден",
    shape: "agent",
    path: (t) => `/v1/agents/${enc(t.id)}`,
    revisionOf: async (_ctx, _t, found) => (found.raw?.version === undefined ? null : String(found.raw.version)),
    precondition: "if_match",
    dependency: "agent",
    routes: { archive: ROUTES.agentArchive, unarchive: ROUTES.agentUnarchive, delete: ROUTES.agentDelete },
  },
  environment: {
    noun: "окружение",
    notFound: "Окружение не найдено",
    shape: "environment",
    path: (t) => `/v1/environments/${enc(t.id)}`,
    precondition: "if_match",
    dependency: "environment",
    routes: { archive: ROUTES.environmentArchive, unarchive: ROUTES.environmentUnarchive, delete: ROUTES.environmentDelete },
  },
  session: {
    noun: "сессия",
    notFound: "Сессия не найдена",
    shape: "session",
    path: (t) => `/v1/sessions/${enc(t.id)}`,
    precondition: "if_match",
    dependency: "session",
    routes: { archive: ROUTES.sessionArchive, unarchive: ROUTES.sessionUnarchive, delete: ROUTES.sessionDelete },
  },
  deployment: {
    noun: "деплоймент",
    notFound: "Деплоймент не найден",
    shape: "deployment",
    path: (t) => `/v1/deployments/${enc(t.id)}`,
    precondition: "if_match",
    dependency: "deployment",
    routes: { archive: ROUTES.deploymentArchive, unarchive: ROUTES.deploymentUnarchive },
  },
  file: {
    noun: "файл",
    notFound: "Файл не найден",
    shape: "file",
    path: (t) => `/v1/files/${enc(t.id)}`,
    revisionOf: async () => null,
    precondition: "none",
    dependency: "file",
    routes: { delete: ROUTES.fileDelete },
  },
  skill: {
    noun: "навык",
    notFound: "Навык не найден",
    shape: "skill",
    path: (t) => `/v1/skills/${enc(t.id)}`,
    precondition: "if_match",
    dependency: "skill",
    routes: { delete: ROUTES.skillDelete },
  },
  skill_version: {
    noun: "версия навыка",
    notFound: "Версия навыка не найдена",
    shape: "skill_version",
    version: true,
    path: (t) => `/v1/skills/${enc(t.id)}/versions/${enc(String(t.version ?? ""))}`,
    // The route compares the revision of the skill (crud.md 1.4).
    async revisionOf(ctx, t) {
      const skill = await ctx.api.get(`/v1/skills/${enc(t.id)}`);
      if (!skill.ok) return null;
      return skill.headers.get("etag");
    },
    precondition: "if_match",
    dependency: "skill_version",
    routes: { delete: ROUTES.skillVersionDelete },
  },
  memory_store: {
    noun: "хранилище памяти",
    notFound: "Хранилище памяти не найдено",
    shape: "memory_store",
    path: (t) => `/v1/memory_stores/${enc(t.id)}`,
    precondition: "if_match",
    dependency: "memory_store",
    routes: { archive: ROUTES.memoryStoreArchive, unarchive: ROUTES.memoryStoreUnarchive, delete: ROUTES.memoryStoreDelete },
  },
  memory: {
    noun: "запись памяти",
    notFound: "Запись памяти не найдена",
    shape: "memory",
    parent: true,
    path: (t) => `/v1/memory_stores/${enc(t.parent_id ?? "")}/memories/${enc(t.id)}`,
    revisionOf: async (_ctx, _t, found) => (typeof found.raw?.content_sha256 === "string" ? found.raw.content_sha256 : null),
    precondition: "query",
    dependency: null,
    routes: { delete: ROUTES.memoryDelete },
  },
  session_resource: {
    noun: "ресурс сессии",
    notFound: "Ресурс сессии не найден",
    shape: "session_resource",
    parent: true,
    path: (t) => `/v1/sessions/${enc(t.parent_id ?? "")}/resources/${enc(t.id)}`,
    revisionOf: async () => null,
    precondition: "none",
    dependency: null,
    routes: { delete: ROUTES.sessionResourceDelete },
  },
  model_card: {
    noun: "карточка модели",
    notFound: "Карточка модели не найдена",
    shape: "model_card",
    path: (t) => `/v1/oma/model_cards/${enc(t.id)}`,
    revisionField: "updated_at",
    revisionOf: async (_ctx, _t, found) => found.revision ?? found.raw?.created_at ?? null,
    precondition: "if_match",
    dependency: "model_card",
    routes: { archive: ROUTES.modelCardArchive, unarchive: ROUTES.modelCardUnarchive, delete: ROUTES.modelCardDelete },
  },
};

const BUILDER_ROLE = "builder";

/** The assistant's own agent, environment or conversation (crud.md 3.1). */
async function isOwn(ctx: OpContext, target: Target, raw: any): Promise<boolean> {
  const assistant = await ctx.assistant();
  switch (target.kind) {
    case "agent":
      return assistant.agentId === target.id || isAssistantAgent(raw, ctx.deps.platformMcpUrl) || raw?.metadata?.oma_role === BUILDER_ROLE;
    case "environment":
      return assistant.environmentId === target.id || raw?.metadata?.oma_role === BUILDER_ROLE;
    case "session":
      return target.id === ctx.actor.sessionId || isAssistantAgent(raw?.agent, ctx.deps.platformMcpUrl);
    case "session_resource": {
      if (target.parent_id === ctx.actor.sessionId) return true;
      const session = await ctx.api.get(`/v1/sessions/${enc(target.parent_id ?? "")}`);
      return session.ok && isAssistantAgent(session.json?.agent, ctx.deps.platformMcpUrl);
    }
    default:
      return false;
  }
}

/** The dependency report of the route; a memory and a session resource have none. */
export async function readDependencies(
  ctx: OpContext,
  kind: DependencyKind | null,
  target: { id: string; version?: string | number },
  operation: "archive" | "delete",
): Promise<DependencyReport> {
  if (kind === null) return EMPTY_DEPENDENCIES;
  const query = new URLSearchParams({ operation, ...(target.version === undefined ? {} : { version: String(target.version) }) });
  const response = await ctx.api.get(`/v1/oma/dependencies/${kind}/${enc(target.id)}?${query}`);
  if (!response.ok) throw new RouteError(response);
  return dependencyReportOf(response.json);
}

function routeOf(spec: KindSpec, operation: Operation, target: Target, revision: string | null): string {
  const base = spec.path(target);
  if (operation === "archive") return `${base}/archive`;
  if (operation === "unarchive") return `${base}/unarchive`;
  if (spec.precondition === "query" && revision) return `${base}?${new URLSearchParams({ expected_content_sha256: revision })}`;
  return base;
}

function invalidPlan(cls: OpPlan["cls"], message: string): OpPlan {
  return { ...emptyPlan(cls), invalid: message };
}

function summaryOf(operation: Operation, spec: KindSpec, target: Target): string {
  const what = `${spec.noun} ${target.kind === "skill_version" ? `${target.id} версии ${target.version}` : target.id}`;
  if (operation === "archive") return `В архиве: ${what}. Вернуть можно через unarchive_object`;
  if (operation === "unarchive") return `Возвращено из архива: ${what}${target.kind === "deployment" ? ". Деплоймент на паузе" : ""}`;
  return `Удалено: ${what}`;
}

function makeOp(operation: Operation): ToolDef<any>["op"] {
  const danger = operation !== "unarchive";
  return {
    targetKind: "object",
    kindOf: (args: Target) => args.kind,
    targetKey: (args: Target) => `${args.kind}:${args.parent_id ?? ""}:${args.id}:${args.version ?? ""}`,
    async plan(ctx, args: Target & { expected_revision?: string }) {
      const spec = SPECS[args.kind];
      const base = danger ? "danger" : "update";
      if (!spec.routes[operation]) return invalidPlan(base, `Вид ${args.kind} не поддерживает эту операцию`);
      if (spec.parent && !args.parent_id) return invalidPlan(base, `Для вида ${args.kind} нужен parent_id`);
      if (spec.version && args.version === undefined) return invalidPlan(base, `Для вида ${args.kind} нужен version`);
      const found = await readObject(ctx, spec.shape ?? "file", spec.path(args), spec.revisionField);
      if (!found) return { ...emptyPlan(base), notFound: spec.notFound };
      const revision = spec.revisionOf ? await spec.revisionOf(ctx, args, found) : found.revision;
      const own = await isOwn(ctx, args, found.raw);
      const archived = Boolean(found.raw?.archived_at);
      const card = { operation, kind: args.kind, id: args.id, parent_id: args.parent_id ?? null, version: args.version ?? null };
      const shared = {
        targetId: args.id,
        revision,
        before: found.clean,
        argsStale: args.expected_revision !== undefined && args.expected_revision !== revision,
      };
      if (!danger) {
        const cls = classifyUnarchive({ ownAssistantTarget: own });
        const warnings = [...(archived ? [] : [NOT_ARCHIVED]), ...(args.kind === "deployment" ? [DEPLOYMENT_PAUSED_NOTE] : [])];
        return {
          ...emptyPlan(cls.cls),
          ...shared,
          reason: cls.reason,
          state: { archived, operation },
          after: { ...(found.clean as object), archived_at: null },
          warnings,
          details: { card },
        };
      }
      const dependencies = await readDependencies(ctx, spec.dependency, args, operation === "archive" ? "archive" : "delete");
      let cls = classifyDanger({ ownAssistantTarget: own, blocking: dependencies.blocking });
      if (operation === "archive" && archived && cls.cls === "danger") cls = { cls: "out_of_v1", reason: ALREADY_ARCHIVED };
      return {
        ...emptyPlan(cls.cls),
        ...shared,
        reason: cls.reason,
        state: { archived, operation },
        after: operation === "archive" ? { ...(found.clean as object), archived_at: ARCHIVE_MARK } : null,
        dependencies,
        irreversible: operation === "delete",
        details: { card, note: operation === "delete" ? IRREVERSIBLE_NOTE : ARCHIVE_NOTE },
      };
    },
    async write(ctx, args: Target, plan, revision) {
      const spec = SPECS[args.kind];
      const path = routeOf(spec, operation, args, revision);
      const options = spec.precondition === "if_match" && revision ? { headers: { "if-match": revision } } : undefined;
      const response = operation === "delete" ? await ctx.api.delete(path, options) : await ctx.api.post(path, {}, options);
      // Restore answers 409 when the agent or the environment of a deployment is gone: not a stale card.
      if (operation === "unarchive" && response.status === 409) {
        return { type: "error", message: ctx.libs.scan(routeErrorMessage(response), ctx.known).text };
      }
      return writeOutcome(ctx, response, () => ({
        targetId: plan.targetId,
        revision: response.headers.get("etag"),
        summary: summaryOf(operation, spec, args),
      }));
    },
  };
}

function routesOf(operation: Operation): RouteRule[] {
  const rules = Object.values(SPECS).flatMap((spec) => (spec.routes[operation] ? [spec.routes[operation]!] : []));
  const reads = [ROUTES.agent, ROUTES.environment, ROUTES.session, ROUTES.deployment, ROUTES.file, ROUTES.skill, ROUTES.skillVersion, ROUTES.memoryStore, ROUTES.memory, ROUTES.sessionResource, ROUTES.modelCard];
  const dependencies = operation === "unarchive" ? [] : Object.values(DEPENDENCY_ROUTES);
  return [...rules, ...reads, ...dependencies];
}

const archiveArgs = z
  .object({ kind: z.enum(ARCHIVE_KINDS), id: z.string().min(1), expected_revision: z.string().min(1).optional() })
  .strict();

const deleteArgs = z
  .object({
    kind: z.enum(DELETE_KINDS),
    id: z.string().min(1),
    parent_id: z.string().min(1).optional(),
    version: z.union([z.string().min(1), z.number().int().min(1)]).optional(),
    expected_revision: z.string().min(1).optional(),
  })
  .strict();

export const archiveObjectTool: ToolDef<z.infer<typeof archiveArgs>> = {
  name: "archive_object",
  group: "write",
  description:
    "Архивировать объект. Опасная операция: одна на карточку, не входит в apply_changes. Сначала проверь get_dependencies. Ждёт подтверждения.",
  args: archiveArgs,
  routes: routesOf("archive"),
  precondition: "if_match",
  op: makeOp("archive"),
};

export const unarchiveObjectTool: ToolDef<z.infer<typeof archiveArgs>> = {
  name: "unarchive_object",
  group: "write",
  description: "Вернуть объект из архива. Деплоймент возвращается на паузе. Ждёт подтверждения.",
  args: archiveArgs,
  routes: routesOf("unarchive"),
  precondition: "if_match",
  op: makeOp("unarchive"),
};

export const deleteObjectTool: ToolDef<z.infer<typeof deleteArgs>> = {
  name: "delete_object",
  group: "write",
  description:
    "Удалить объект навсегда. parent_id нужен для memory (хранилище) и session_resource (сессия), version для skill_version. Опасная операция: одна на карточку. Сначала проверь get_dependencies. Ждёт подтверждения.",
  args: deleteArgs,
  routes: routesOf("delete"),
  precondition: "if_match",
  op: makeOp("delete"),
};

/** Tools of the danger class: never part of a batch (crud.md 3.1). */
export const DANGER_TOOL_NAMES: ReadonlySet<string> = new Set([archiveObjectTool.name, deleteObjectTool.name]);

export const DANGER_TOOLS = [archiveObjectTool, unarchiveObjectTool, deleteObjectTool];
