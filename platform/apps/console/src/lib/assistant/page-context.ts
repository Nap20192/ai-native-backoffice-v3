/**
 * Контекст страницы для ассистента (раздел 1.2 плана). Консоль собирает его из
 * адреса, поэтому страницы править не нужно. Блок уходит в `user.message`
 * отдельным текстом `<page_context>{JSON до 2 КБ}</page_context>`, а системный
 * промпт ассистента говорит, что это данные, а не указания.
 */

export type PageKind =
  | "session"
  | "agent"
  | "agent_new"
  | "environment"
  | "memory_store"
  | "vault"
  | "list"
  | "other";

export interface PageContext {
  kind: PageKind;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Для списков: что за список (`sessions`, `agents`, ...). */
  listOf?: string;
  agent?: string;
  session?: string;
  environment?: string;
  /** Черновик YAML с правой панели «Описать агента». */
  draftYaml?: string;
  draftYaml_truncated?: boolean;
}

export const PAGE_CONTEXT_MAX_BYTES = 2048;
const OPEN = "<page_context>";
const CLOSE = "</page_context>";

/** Параметры адреса, которые попадают к модели. Остальное (токены и т. п.) нет. */
const QUERY_KEYS = new Set([
  "event",
  "inspector",
  "agent",
  "session",
  "tab",
  "version",
  "view",
  "q",
  "status",
  "statuses",
  "agent_id",
  "environment",
  "model",
  "from",
  "to",
  "sort",
  "order",
  "filter",
  "kind",
  "archived",
]);

const DETAIL_KINDS: Record<string, PageKind> = {
  sessions: "session",
  agents: "agent",
  environments: "environment",
  memory: "memory_store",
  vaults: "vault",
};

export const LIST_TITLES: Record<string, string> = {
  agents: "Агенты",
  sessions: "Сессии",
  files: "Файлы",
  environments: "Окружения",
  vaults: "Хранилища секретов",
  skills: "Навыки",
  memory: "Хранилища памяти",
  "model-cards": "Карточки моделей",
  evals: "Оценки",
  members: "Участники",
  "api-keys": "API-ключи",
};

export function buildPageContext(
  location: { pathname: string; search: string },
  extra?: { draftYaml?: string | null },
): PageContext {
  const segments = location.pathname.split("/").filter(Boolean);
  const [section, second] = segments;
  const params: Record<string, string> = {};
  const query: Record<string, string> = {};
  const sp = new URLSearchParams(location.search);
  for (const [key, value] of sp.entries()) {
    if (QUERY_KEYS.has(key) && value !== "") query[key] = value.slice(0, 200);
  }

  const ctx: PageContext = { kind: "other", path: location.pathname, params, query };

  if (section === "agents" && second === "new") {
    ctx.kind = "agent_new";
  } else if (section && second && DETAIL_KINDS[section]) {
    ctx.kind = DETAIL_KINDS[section];
    params.id = decodeURIComponent(second);
    if (ctx.kind === "session") ctx.session = params.id;
    if (ctx.kind === "agent") ctx.agent = params.id;
    if (ctx.kind === "environment") ctx.environment = params.id;
  } else if (section && LIST_TITLES[section] && !second) {
    ctx.kind = "list";
    ctx.listOf = section;
  }

  if (extra?.draftYaml) ctx.draftYaml = extra.draftYaml;
  return ctx;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** JSON без строки `</`: данные не должны закрыть обёртку блока. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

/**
 * `<page_context>{...}</page_context>` не длиннее 2 КБ внутри. Первым режется
 * черновик YAML, затем значения параметров адреса.
 */
export function serializePageContext(ctx: PageContext): string {
  const fits = (c: PageContext) => byteLength(safeJson(c)) <= PAGE_CONTEXT_MAX_BYTES;
  let work: PageContext = { ...ctx };

  if (!fits(work) && work.draftYaml) {
    const full = work.draftYaml;
    let lo = 0;
    let hi = full.length;
    // Наибольшая длина черновика, при которой блок ещё помещается.
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = { ...work, draftYaml: full.slice(0, mid), draftYaml_truncated: true };
      if (fits(candidate)) lo = mid;
      else hi = mid - 1;
    }
    work =
      lo > 0
        ? { ...work, draftYaml: full.slice(0, lo), draftYaml_truncated: true }
        : (({ draftYaml: _drop, ...rest }) => rest)(work);
  }
  if (!fits(work)) {
    work = { ...work, query: Object.fromEntries(Object.entries(work.query).map(([k, v]) => [k, v.slice(0, 40)])) };
  }
  if (!fits(work)) work = { ...work, query: {} };
  return `${OPEN}${safeJson(work)}${CLOSE}`;
}

/** Текст пользователя и блок контекста одним сообщением. */
export function withPageContext(text: string, ctx: PageContext | null): string {
  if (!ctx) return text;
  return `${text}\n\n${serializePageContext(ctx)}`;
}

/** Сообщение так, как его видит пользователь: без блока контекста. */
export function stripPageContext(text: string): string {
  const start = text.lastIndexOf(OPEN);
  if (start === -1 || !text.trimEnd().endsWith(CLOSE)) return text;
  return text.slice(0, start).trimEnd();
}

/** Подпись чипа над полем. `names` приходят из запросов страницы или кэша. */
export function contextChipLabel(
  ctx: PageContext,
  names: { name?: string | null; version?: number | null },
): string {
  const name = names.name?.trim();
  switch (ctx.kind) {
    case "agent": {
      const base = name ? `Агент «${name}»` : `Агент ${ctx.params.id ?? ""}`.trim();
      const version = ctx.query.version ?? (names.version ? String(names.version) : "");
      return version ? `${base}, версия ${version}` : base;
    }
    case "session":
      return name ? `Сессия «${name}»` : `Сессия ${ctx.params.id ?? ""}`.trim();
    case "environment":
      return name ? `Окружение «${name}»` : `Окружение ${ctx.params.id ?? ""}`.trim();
    case "memory_store":
      return name ? `Хранилище памяти «${name}»` : `Хранилище памяти ${ctx.params.id ?? ""}`.trim();
    case "vault":
      return name ? `Хранилище секретов «${name}»` : `Хранилище секретов ${ctx.params.id ?? ""}`.trim();
    case "agent_new":
      return "Новый агент";
    case "list":
      return `Список: ${LIST_TITLES[ctx.listOf ?? ""] ?? ctx.listOf ?? ""}`.trim();
    default:
      return ctx.path === "/" ? "Главная" : "Страница консоли";
  }
}

export interface StarterCard {
  title: string;
  prompt: string;
}

const SESSION_CARDS: StarterCard[] = [
  { title: "Найти ошибки", prompt: "Найди ошибки в этой сессии и объясни, что пошло не так." },
  { title: "Разобрать скорость", prompt: "Разбери, на что в этой сессии ушло время и где можно ускорить работу." },
  { title: "Ход разговора", prompt: "Коротко перескажи ход этой сессии: что просили, что сделал агент, чем закончилось." },
  { title: "Что улучшить", prompt: "Что стоит улучшить в агенте или окружении по итогам этой сессии?" },
];

const AGENT_CARDS: StarterCard[] = [
  { title: "Улучшить системный промпт", prompt: "Предложи, как улучшить системный промпт этого агента, и покажи разницу." },
  { title: "Написать навык", prompt: "Предложи навык для этого агента и покажи его файлы." },
  { title: "Подготовить деплоймент", prompt: "Подготовь деплоймент для этого агента. Создай его на паузе." },
  { title: "Что умеет агент", prompt: "Расскажи, что умеет этот агент: модель, инструменты, навыки и MCP-серверы." },
];

const OTHER_CARDS: StarterCard[] = [
  { title: "Создать агента", prompt: "Помоги создать агента. Спроси, что он должен делать." },
  { title: "Собрать окружение", prompt: "Помоги собрать окружение для агента: пакеты и сеть." },
  { title: "Найти упавшие сессии", prompt: "Найди недавние сессии, которые закончились ошибкой, и назови вероятные причины." },
  { title: "Что умеет ассистент", prompt: "Что ты умеешь в этой платформе и чего не делаешь сам?" },
];

export function starterCardsFor(kind: PageKind): StarterCard[] {
  if (kind === "session") return SESSION_CARDS;
  if (kind === "agent") return AGENT_CARDS;
  return OTHER_CARDS;
}
