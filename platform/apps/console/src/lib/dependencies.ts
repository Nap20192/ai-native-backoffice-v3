/**
 * Зависимости архива и удаления (docs/plans/crud.md, 1.2 и 1.3). Сервер отдаёт
 * их заранее через GET /v1/oma/dependencies/:kind/:id и повторяет в ответе 409
 * `dependency_conflict_error`. Файл без зависимостей от api.ts, чтобы
 * `ApiError` мог хранить разобранный список.
 */

export type DependencyOperation = "archive" | "delete";

/** Вид объекта в адресе GET /v1/oma/dependencies/:kind/:id. */
export type DependencyTargetKind =
  | "agent"
  | "environment"
  | "session"
  | "deployment"
  | "file"
  | "skill"
  | "skill_version"
  | "memory_store"
  | "memory"
  | "session_resource"
  | "model_card"
  | "harness_card"
  | "vault";

export interface DependencyEntry {
  kind: string;
  id: string;
  name: string | null;
  status: string | null;
  note: string | null;
}

export interface DependencyReport {
  blocking: DependencyEntry[];
  affected: DependencyEntry[];
  truncated: boolean;
}

export const EMPTY_DEPENDENCY_REPORT: DependencyReport = {
  blocking: [],
  affected: [],
  truncated: false,
};

/** Заголовок раздела «Мешает» и «Затронет» одним местом для всех окон. */
export const DEPENDENCY_KIND_LABELS: Record<string, string> = {
  agent: "Агент",
  session: "Сессия",
  deployment: "Деплоймент",
  environment_work: "Задание окружения",
  file: "Файл",
  skill_version: "Версия навыка",
  memory: "Запись памяти",
  credential: "Учётные данные",
  model_card: "Карточка модели",
};

function entryOf(value: unknown): DependencyEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || typeof raw.id !== "string") return null;
  return {
    kind: raw.kind,
    id: raw.id,
    name: typeof raw.name === "string" ? raw.name : null,
    status: typeof raw.status === "string" ? raw.status : null,
    note: typeof raw.note === "string" ? raw.note : null,
  };
}

function entriesOf(value: unknown): DependencyEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = entryOf(item);
    return entry ? [entry] : [];
  });
}

/** Список из тела ответа или `null`, если тело не похоже на список. */
export function parseDependencyReport(value: unknown): DependencyReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.blocking) && !Array.isArray(raw.affected)) return null;
  return {
    blocking: entriesOf(raw.blocking),
    affected: entriesOf(raw.affected),
    truncated: raw.truncated === true,
  };
}

/** Список из тела ошибки 409: `{error: {type: "dependency_conflict_error", dependencies}}`. */
export function dependenciesFromErrorBody(body: unknown): DependencyReport | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  return parseDependencyReport((error as { dependencies?: unknown }).dependencies);
}
