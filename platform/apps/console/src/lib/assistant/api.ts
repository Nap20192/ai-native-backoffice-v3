import { useMemo } from "react";

import { ApiError, useApi, type ApiRequestInit } from "../api";

/**
 * Клиент панели ассистента. Контракты берутся из раздела 1.4, 2.5, 3.6 и 3.7
 * плана docs/plans/builder-agent.md. Ответы сервера разбираются защитно: поле
 * неверного типа даёт пустое значение, а не падение карточки.
 *
 * Запросы идут через `useApi`: заголовок рабочего пространства и cookie те же,
 * что у остальной консоли. Тосты ошибок здесь выключены (`quiet`), карточка
 * сама пишет причину.
 */

/** Запрос консоли. Совместим с `useApi().api` и с подставной функцией в тестах. */
export type AssistantApiFn = (
  path: string,
  init?: ApiRequestInit,
) => Promise<unknown>;

export const PLATFORM_MCP_BASE = "/v1/oma/platform-mcp";
export const PLATFORM_SERVER_NAME = "platform";

/* ---------- Инструменты ---------- */

/** Инструменты чтения: одна свёрнутая строка в ленте, без карточки. */
export const READ_TOOLS = [
  "help",
  "search_docs",
  "search_config",
  "list",
  "get",
  "read_content",
  "get_session_events",
  "get_trajectory",
  "request_secret",
  "get_dependencies",
] as const;

/** Инструменты записи: каждый ждёт кнопки пользователя (раздел 2.3). */
export const WRITE_TOOLS = [
  "create_agent",
  "create_environment",
  "create_skill",
  "upload_file",
  "create_memory_store",
  "create_deployment",
  "create_session",
  "write_memory",
  "update_agent",
  "restore_agent_version",
  "update_environment",
  "create_skill_version",
  "update_memory_store",
  "update_deployment",
  "update_model_card",
  "send_message",
  "apply_changes",
  "update_session",
  "add_session_resource",
  "update_session_resource",
  "pause_deployment",
  "unpause_deployment",
  "run_deployment",
  "archive_object",
  "unarchive_object",
  "delete_object",
] as const;

/** Четыре инструмента набора «черновик» (раздел 1.1). */
export const DRAFT_SET_TOOLS = ["help", "list", "get", "preview_change"] as const;

/** `mcp__platform__create_agent` и `create_agent` дают одно имя. */
export function assistantToolName(name: string): string {
  const prefix = `mcp__${PLATFORM_SERVER_NAME}__`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

export function isReadTool(name: string): boolean {
  return (READ_TOOLS as readonly string[]).includes(assistantToolName(name));
}

export function isWriteTool(name: string): boolean {
  return (WRITE_TOOLS as readonly string[]).includes(assistantToolName(name));
}

/* ---------- Предложение: preview ---------- */

export type OpClass = "read" | "draft" | "create" | "edit" | "danger" | "out_of_v1";

const CLASS_ORDER: OpClass[] = ["read", "draft", "create", "edit", "danger", "out_of_v1"];

const CLASS_ALIASES: Record<string, OpClass> = {
  read: "read",
  чтение: "read",
  draft: "draft",
  черновик: "draft",
  create: "create",
  создание: "create",
  update: "edit",
  edit: "edit",
  правка: "edit",
  danger: "danger",
  опасное: "danger",
  out_of_v1: "out_of_v1",
  "вне v1": "out_of_v1",
};

/** Класс операции из ответа сервера: латиница или русское название. */
export function normalizeOpClass(value: unknown): OpClass | null {
  if (typeof value !== "string") return null;
  return CLASS_ALIASES[value.trim().toLowerCase()] ?? null;
}

export function maxOpClass(classes: readonly OpClass[]): OpClass {
  let best = 0;
  for (const c of classes) best = Math.max(best, CLASS_ORDER.indexOf(c));
  return CLASS_ORDER[best] ?? "read";
}

/** Строка зависимости из GET /v1/oma/dependencies (docs/plans/crud.md, 1.2). */
export interface PreviewDependency {
  kind: string;
  id: string;
  name: string | null;
  status: string | null;
  note: string | null;
}

export interface PreviewDependencies {
  blocking: PreviewDependency[];
  affected: PreviewDependency[];
  truncated: boolean;
}

/** Архив, возврат из архива или удаление (crud.md, 3.2). */
export type DangerOperation = "archive" | "unarchive" | "delete";

export interface PreviewOperation {
  index: number;
  tool: string;
  /** Вид объекта: agent, environment, skill, deployment, memory, ... */
  kind: string;
  targetId: string | null;
  name: string | null;
  class: OpClass;
  /** Причина, по которой операция вышла за первую версию (текст сервера). */
  outOfV1Reason: string | null;
  beforeYaml: string | null;
  afterYaml: string | null;
  warnings: string[];
  /** Для строки пачки: «навык из строки 2». */
  refNote: string | null;
  versionFrom: number | null;
  versionTo: number | null;
  /** С чем объект получит доступ: окружение, хранилища секретов, файлы. */
  access: string[];
  /** Три ближайших запуска расписания деплоймента. */
  nextRuns: string[];
  /** Архив, возврат или удаление; `null` у остальных инструментов. */
  operation: DangerOperation | null;
  /** Что мешает операции и что она затронет; `null`, если сервер списка не прислал. */
  dependencies: PreviewDependencies | null;
  /** Удаление: «Это нельзя отменить». */
  irreversible: boolean;
}

export interface SessionPreviewInfo {
  agentId: string | null;
  agentName: string | null;
  agentVersion: number | null;
  environmentId: string | null;
  environmentName: string | null;
  title: string | null;
  files: Array<{ fileId: string; filename: string | null; mountPath: string | null }>;
  /** Что получит сессия: инструменты агента, MCP-серверы, навыки. */
  tools: string[];
  mcpServers: string[];
  skills: string[];
  /** Сеть окружения, готовой строкой. */
  network: string | null;
}

export interface MessagePreviewInfo {
  sessionId: string | null;
  sessionTitle: string | null;
  text: string;
  agentName: string | null;
  environmentName: string | null;
}

export interface PreviewResult {
  tool: string;
  digest: string | null;
  disabled: boolean;
  /** Ошибка схемы инструмента, текст сервера без полученного значения. */
  schemaError: string | null;
  /** В аргументах известное значение секрета (2.6). */
  secret: boolean;
  /** Аргументы не подходят к новому состоянию (устарела `expected_version`). */
  argsStale: boolean;
  /** Объекта правки нет в пространстве. */
  notFound: boolean;
  canConfirm: boolean;
  ownerName: string | null;
  class: OpClass;
  title: string | null;
  operations: PreviewOperation[];
  session: SessionPreviewInfo | null;
  message: MessagePreviewInfo | null;
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const DANGER_TOOL_OPERATION: Record<string, DangerOperation> = {
  archive_object: "archive",
  unarchive_object: "unarchive",
  delete_object: "delete",
};

function normalizeDependency(raw: unknown): PreviewDependency | null {
  const r = rec(raw);
  const kind = str(r.kind);
  const id = str(r.id);
  if (!kind || !id) return null;
  return { kind, id, name: str(r.name), status: str(r.status), note: str(r.note) };
}

function normalizeDependencies(raw: unknown): PreviewDependencies | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = rec(raw);
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : []).map(normalizeDependency).filter((d): d is PreviewDependency => d !== null);
  return { blocking: list(r.blocking), affected: list(r.affected), truncated: r.truncated === true };
}

function dangerOperation(tool: string, details: Record<string, unknown>): DangerOperation | null {
  const fromCard = str(rec(details.card).operation);
  if (fromCard === "archive" || fromCard === "unarchive" || fromCard === "delete") return fromCard;
  return DANGER_TOOL_OPERATION[assistantToolName(tool)] ?? null;
}

/**
 * Операция preview. Сервер (`previewJson` в main-node) шлёт `op_index`,
 * `target_kind`, `reason` и `details`; старые имена полей тоже читаются.
 */
function normalizeOperation(raw: unknown, fallbackIndex: number): PreviewOperation {
  const r = rec(raw);
  const details = rec(r.details);
  const cls = normalizeOpClass(r.class) ?? "create";
  return {
    index: num(r.op_index) ?? num(r.index) ?? fallbackIndex,
    tool: str(r.tool) ?? "",
    kind: str(r.target_kind) ?? str(r.kind) ?? "",
    targetId: str(r.target_id),
    name: str(r.name),
    class: cls,
    outOfV1Reason: str(r.out_of_v1_reason) ?? (cls === "out_of_v1" ? str(r.reason) : null),
    beforeYaml: str(r.before_yaml),
    afterYaml: str(r.after_yaml),
    warnings: strList(r.warnings),
    refNote: str(r.ref_note),
    versionFrom: num(r.version_from),
    versionTo: num(r.version_to),
    access: strList(r.access),
    nextRuns: r.next_runs !== undefined ? strList(r.next_runs) : strList(details.upcoming_runs),
    operation: dangerOperation(str(r.tool) ?? "", details),
    dependencies: normalizeDependencies(r.dependencies),
    irreversible: r.irreversible === true,
  };
}

function normalizeSession(raw: unknown): SessionPreviewInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = rec(raw);
  const files = Array.isArray(r.files) ? r.files : [];
  return {
    agentId: str(r.agent_id),
    agentName: str(r.agent_name),
    agentVersion: num(r.agent_version),
    environmentId: str(r.environment_id),
    environmentName: str(r.environment_name),
    title: str(r.title),
    files: files.map((f) => {
      const fr = rec(f);
      return {
        fileId: str(fr.file_id) ?? "",
        filename: str(fr.filename),
        mountPath: str(fr.mount_path),
      };
    }),
    tools: strList(r.tools),
    mcpServers: strList(r.mcp_servers),
    skills: strList(r.skills),
    network: str(r.network),
  };
}

function normalizeMessage(raw: unknown): MessagePreviewInfo | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = rec(raw);
  return {
    sessionId: str(r.session_id),
    sessionTitle: str(r.session_title),
    text: str(r.text) ?? "",
    agentName: str(r.agent_name),
    environmentName: str(r.environment_name),
  };
}

/** Ответ `POST /preview` в виде, который читают карточки. */
export function normalizePreview(raw: unknown): PreviewResult {
  const r = rec(raw);
  const ops = (Array.isArray(r.operations) ? r.operations : []).map(normalizeOperation);
  const serverClass = normalizeOpClass(r.class);
  return {
    tool: str(r.tool) ?? "",
    digest: str(r.preview_digest),
    disabled: r.disabled === true,
    // Ошибка схемы аргументов или тела объекта: сервер шлёт их разными полями.
    schemaError: str(r.schema_error) ?? str(r.invalid),
    secret: r.secret === true,
    argsStale: r.args_stale === true,
    // Сервер шлёт текст причины («Агент не найден»), старый вариант это true.
    notFound: r.not_found === true || (typeof r.not_found === "string" && r.not_found.length > 0),
    canConfirm: r.can_confirm !== false,
    ownerName: str(r.owner_name),
    class: serverClass ?? (ops.length ? maxOpClass(ops.map((o) => o.class)) : "read"),
    title: str(r.title),
    operations: ops,
    session: normalizeSession(r.session),
    message: normalizeMessage(r.message),
  };
}

export async function requestPreview(
  api: AssistantApiFn,
  input: { sessionId: string; toolUseId: string },
): Promise<PreviewResult> {
  const raw = await api(`${PLATFORM_MCP_BASE}/preview`, {
    method: "POST",
    body: JSON.stringify({ session_id: input.sessionId, tool_use_id: input.toolUseId }),
    quiet: true,
  });
  return normalizePreview(raw);
}

/* ---------- Решение: confirm ---------- */

export type DecisionReason =
  | "stale"
  | "class"
  | "secret"
  | "disabled"
  | "not_pending"
  | "not_found"
  | "forbidden"
  | "other";

export type DecisionOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: DecisionReason;
      status: number;
      /** Текст для человека, уже переведённый консолью. */
      message: string;
      /** Причина 409 так, как её прислал сервер (у platform-mcp она по-русски). Пусто, если сервер её не дал. */
      serverReason?: string;
    };

const CONFLICT_REASONS: readonly DecisionReason[] = [
  "stale",
  "class",
  "secret",
  "disabled",
  "not_pending",
];

function reasonFromError(err: unknown): {
  reason: DecisionReason;
  status: number;
  message: string;
  serverReason?: string;
} {
  if (err instanceof ApiError) {
    if (err.status === 404) return { reason: "not_found", status: 404, message: err.message };
    if (err.status === 403) return { reason: "forbidden", status: 403, message: err.message };
    if (err.status === 409) {
      const hit = CONFLICT_REASONS.find((r) => r === err.code);
      return { reason: hit ?? "other", status: 409, message: err.message, serverReason: err.serverMessage.trim() };
    }
    return { reason: "other", status: err.status, message: err.message };
  }
  return {
    reason: "other",
    status: 0,
    message: err instanceof Error ? err.message : "Не удалось отправить решение",
  };
}

/**
 * Решение пользователя по карточке. Отпечаток `preview_digest` это отпечаток
 * той карточки, что на экране: сервер сверяет его с пересчитанным и при
 * расхождении отвечает 409 `stale`.
 */
export async function postDecision(
  api: AssistantApiFn,
  input: {
    sessionId: string;
    toolUseId: string;
    result: "allow" | "deny";
    digest: string | null;
    denyMessage?: string;
  },
): Promise<DecisionOutcome> {
  const body: Record<string, unknown> = {
    session_id: input.sessionId,
    tool_use_id: input.toolUseId,
    result: input.result,
    preview_digest: input.digest,
  };
  if (input.denyMessage) body.deny_message = input.denyMessage;
  try {
    await api(`${PLATFORM_MCP_BASE}/confirm`, {
      method: "POST",
      body: JSON.stringify(body),
      quiet: true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, ...reasonFromError(err) };
  }
}

/* ---------- Выключатель ---------- */

export interface AssistantSettings {
  enabled: boolean;
  canChange: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

function normalizeSettings(raw: unknown): AssistantSettings {
  const r = rec(raw);
  return {
    // Пока записи нет, ассистент включён (раздел 3.7).
    enabled: r.enabled !== false,
    canChange: r.can_change === true,
    updatedBy: str(r.updated_by),
    updatedAt: str(r.updated_at),
  };
}

export async function fetchSettings(api: AssistantApiFn): Promise<AssistantSettings> {
  return normalizeSettings(await api(`${PLATFORM_MCP_BASE}/settings`, { quiet: true }));
}

export async function saveSettings(
  api: AssistantApiFn,
  enabled: boolean,
): Promise<AssistantSettings> {
  return normalizeSettings(
    await api(`${PLATFORM_MCP_BASE}/settings`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  );
}

/* ---------- Журнал действий ---------- */

export interface ActionRow {
  id: string;
  createdAt: string | null;
  tool: string;
  class: OpClass | null;
  result: string;
  targetKind: string | null;
  targetId: string | null;
  errorMessage: string | null;
  opIndex: number;
}

export async function fetchActions(
  api: AssistantApiFn,
  input: { sessionId: string; cursor?: string | null },
): Promise<{ rows: ActionRow[]; nextCursor: string | null }> {
  const sp = new URLSearchParams({ session_id: input.sessionId });
  if (input.cursor) sp.set("cursor", input.cursor);
  const raw = rec(await api(`${PLATFORM_MCP_BASE}/actions?${sp.toString()}`, { quiet: true }));
  // Сервер отдаёт строки журнала в `actions` рядом с `confirmations`.
  const data = Array.isArray(raw.actions) ? raw.actions : Array.isArray(raw.data) ? raw.data : [];
  return {
    rows: data.map((item) => {
      const r = rec(item);
      return {
        id: str(r.id) ?? "",
        createdAt: str(r.created_at),
        tool: str(r.tool) ?? "",
        class: normalizeOpClass(r.class),
        result: str(r.result) ?? "",
        targetKind: str(r.target_kind),
        targetId: str(r.target_id),
        errorMessage: str(r.error_message),
        opIndex: num(r.op_index) ?? 0,
      };
    }),
    nextCursor: str(raw.next_cursor) ?? str(raw.next_page),
  };
}

/* ---------- Агент и окружение ассистента ---------- */

export interface BuilderRef {
  agent: { id: string; name: string; version: number };
  environment: { id: string; name: string };
}

export const BUILDER_ROLE_KEY = "oma_role";
export const BUILDER_ROLE_VALUE = "builder";
export const BUILDER_ENV_NAME = "Ассистент";

function isBuilderMeta(metadata: unknown): boolean {
  return rec(metadata)[BUILDER_ROLE_KEY] === BUILDER_ROLE_VALUE;
}

function listOf(raw: unknown): Record<string, unknown>[] {
  const data = rec(raw).data;
  return Array.isArray(data) ? data.map(rec) : [];
}

function pickBuilderEnvironment(envs: Record<string, unknown>[]): BuilderRef["environment"] | null {
  const live = envs.filter((e) => !e.archived_at && typeof e.id === "string");
  const env =
    live.find((e) => isBuilderMeta(e.metadata)) ?? live.find((e) => e.name === BUILDER_ENV_NAME);
  return env ? { id: env.id as string, name: str(env.name) ?? BUILDER_ENV_NAME } : null;
}

/** Окружение ассистента: по метке `oma_role: builder`, затем по имени «Ассистент». */
export async function findBuilderEnvironment(
  api: AssistantApiFn,
): Promise<BuilderRef["environment"] | null> {
  return pickBuilderEnvironment(listOf(await api("/v1/environments?limit=100", { quiet: true })));
}

/**
 * Агент пространства с меткой `oma_role: builder` и его окружение. Архивные не
 * берутся.
 */
export async function findBuilder(api: AssistantApiFn): Promise<BuilderRef | null> {
  const [agentsRaw, envsRaw] = await Promise.all([
    api("/v1/agents?limit=100", { quiet: true }),
    api("/v1/environments?limit=100", { quiet: true }),
  ]);
  const agent = listOf(agentsRaw).find(
    (a) => isBuilderMeta(a.metadata) && !a.archived_at && typeof a.id === "string",
  );
  if (!agent) return null;
  const environment = pickBuilderEnvironment(listOf(envsRaw));
  if (!environment) return null;
  return {
    agent: {
      id: agent.id as string,
      name: str(agent.name) ?? "Ассистент",
      version: num(agent.version) ?? 1,
    },
    environment,
  };
}

/* ---------- Сессия ассистента ---------- */

export type AssistantMode = "full" | "draft";

/** Метки сессии разговора с ассистентом. Нужны только для списка «История». */
export const CHAT_META_KEY = "oma_assistant_chat";
export const CHAT_USER_META_KEY = "oma_assistant_user";

/**
 * Набор «черновик» (раздел 1.1): первой записью выключенный встроенный набор,
 * иначе сервер не обслужит сессию (3.2). Остаются `help`, `list`, `get`,
 * `preview_change`.
 */
export function draftToolset(): unknown[] {
  return [
    { type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] },
    {
      type: "mcp_toolset",
      mcp_server_name: PLATFORM_SERVER_NAME,
      default_config: { enabled: false, permission_policy: { type: "always_ask" } },
      configs: DRAFT_SET_TOOLS.map((name) => ({
        name,
        enabled: true,
        permission_policy: { type: "always_allow" },
      })),
    },
  ];
}

/**
 * Новая сессия ассистента с явной версией агента. Без `initial_events`: первое
 * сообщение консоль шлёт отдельным запросом. Модель и набор инструментов
 * меняют сессию только через `agent_with_overrides`.
 */
export async function createAssistantSession(
  api: AssistantApiFn,
  input: {
    builder: BuilderRef;
    userId: string | null;
    mode?: AssistantMode;
    model?: string | null;
    title?: string;
  },
): Promise<string> {
  const { builder } = input;
  const overrides: Record<string, unknown> = {};
  if (input.model) overrides.model = input.model;
  if (input.mode === "draft") overrides.tools = draftToolset();
  const agent =
    Object.keys(overrides).length > 0
      ? {
          type: "agent_with_overrides",
          id: builder.agent.id,
          version: builder.agent.version,
          ...overrides,
        }
      : { type: "agent", id: builder.agent.id, version: builder.agent.version };
  const metadata: Record<string, string> = { [CHAT_META_KEY]: "1" };
  if (input.userId) metadata[CHAT_USER_META_KEY] = input.userId;
  const created = rec(
    await api("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        agent,
        environment_id: builder.environment.id,
        title: input.title ?? "Разговор с ассистентом",
        metadata,
      }),
    }),
  );
  const id = str(created.id);
  if (!id) throw new Error("Сервер не вернул id сессии ассистента");
  return id;
}

export async function sendAssistantMessage(
  api: AssistantApiFn,
  sessionId: string,
  text: string,
): Promise<void> {
  await api(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text }] }],
    }),
  });
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: string | null;
}

/** Прошлые разговоры этого пользователя с ассистентом, новые первыми. */
export async function fetchChatHistory(
  api: AssistantApiFn,
  input: { agentId: string; userId: string | null },
): Promise<ChatSummary[]> {
  const raw = rec(
    await api(
      `/v1/sessions?agent_id=${encodeURIComponent(input.agentId)}&limit=50&order=desc`,
      { quiet: true },
    ),
  );
  const data = Array.isArray(raw.data) ? raw.data : [];
  return data
    .map(rec)
    .filter((s) => {
      const meta = rec(s.metadata);
      if (meta[CHAT_META_KEY] !== "1" || typeof s.id !== "string" || s.archived_at) return false;
      return !input.userId || meta[CHAT_USER_META_KEY] === input.userId;
    })
    .map((s) => ({
      id: s.id as string,
      title: str(s.title) ?? "Разговор с ассистентом",
      createdAt: str(s.created_at),
    }));
}

/** Хук с запросом консоли, подходящим под `AssistantApiFn`. */
export function useAssistantApi(): AssistantApiFn {
  const { api } = useApi();
  return useMemo(() => api as AssistantApiFn, [api]);
}
