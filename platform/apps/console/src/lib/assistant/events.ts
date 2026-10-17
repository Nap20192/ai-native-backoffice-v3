import { load as loadYaml } from "js-yaml";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api";
import type { Event } from "../events";
import { OptimisticUserMessages, createOptimisticUserEvent, userMessageText } from "../optimistic-user-message";
import { useManagedApi } from "../useManagedApi";
import { assistantToolName, isWriteTool } from "./api";
import { stripPageContext } from "./page-context";

/**
 * События сессии ассистента → лента панели. Чистые функции разбирают события в
 * строки ленты (реплики, свёрнутое чтение, предложения, черновики карточек),
 * хук `useAssistantEvents` догружает историю и держит поток.
 */

export interface AppliedInfo {
  tool: string;
  kind: string;
  id: string | null;
  name: string | null;
  version: number | null;
  action: AppliedAction;
}

/** Архив, возврат из архива и удаление делают опасные инструменты (crud.md, 3.2). */
export type AppliedAction = "create" | "update" | "archive" | "unarchive" | "delete";

export type ProposalPhase = "pending" | "sent" | "denied" | "applied" | "failed";
export type ReadStatus = "running" | "done" | "error";

export type ThreadItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "read"; id: string; tool: string; label: string; status: ReadStatus; link?: string }
  | {
      kind: "proposal";
      id: string;
      tool: string;
      input: Record<string, unknown>;
      phase: ProposalPhase;
      denyMessage?: string;
      resultText?: string;
      applied?: AppliedInfo[];
    }
  | {
      kind: "draft";
      id: string;
      draftKind: "model_card" | "harness_card";
      body: Record<string, unknown>;
    };

/* ---------- Слияние событий ---------- */

/** Событие с тем же id заменяет прежнее, новое дописывается. */
export function mergeEvent(list: Event[], event: Event): Event[] {
  if (typeof event.id === "string") {
    const index = list.findIndex((e) => e.id === event.id);
    if (index >= 0) {
      const next = list.slice();
      next[index] = event;
      return next;
    }
  }
  return [...list, event];
}

/* ---------- Разбор входа и результата ---------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Поля `config`, `changes` и `body` бывают объектом или строкой YAML. */
export function parseToolInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = loadYaml(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resultText(event: Event | undefined): string {
  if (!event) return "";
  const content = event.content;
  if (typeof content === "string") return content;
  return userMessageText(content);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const KIND_SINGULAR: Record<string, string> = {
  agent: "агент",
  agents: "агент",
  agent_versions: "версия агента",
  environment: "окружение",
  environments: "окружение",
  skill: "навык",
  skills: "навык",
  skill_versions: "версия навыка",
  file: "файл",
  files: "файл",
  memory_store: "хранилище памяти",
  memory_stores: "хранилище памяти",
  memory: "запись памяти",
  memories: "запись памяти",
  vault: "хранилище секретов",
  vaults: "хранилище секретов",
  credentials: "учётные данные",
  deployment: "деплоймент",
  deployments: "деплоймент",
  deployment_runs: "запуск деплоймента",
  session: "сессия",
  sessions: "сессия",
  eval_runs: "прогон оценки",
  models: "карточка модели",
  model_card: "карточка модели",
  harnesses: "harness",
  harness_card: "карточка harness",
  harness_cards: "карточка harness",
  outcome: "результат",
};

const KIND_PLURAL: Record<string, string> = {
  agents: "агенты",
  agent_versions: "версии агента",
  environments: "окружения",
  skills: "навыки",
  skill_versions: "версии навыка",
  files: "файлы",
  memory_stores: "хранилища памяти",
  memories: "записи памяти",
  vaults: "хранилища секретов",
  credentials: "учётные данные",
  deployments: "деплойменты",
  deployment_runs: "запуски деплойментов",
  sessions: "сессии",
  eval_runs: "прогоны оценок",
  models: "карточки моделей",
  harnesses: "harness",
  harness_cards: "карточки harness",
};

const s = (v: unknown): string => (typeof v === "string" ? v : "");

function countOf(result: unknown): number | null {
  if (!isRecord(result)) return null;
  for (const key of ["items", "data", "results"]) {
    const list = result[key];
    if (Array.isArray(list)) return list.length;
  }
  return typeof result.count === "number" ? result.count : null;
}

/** Подпись свёрнутой строки чтения. */
export function readRowLabel(
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
  status: ReadStatus,
): string {
  const running = status === "running";
  switch (tool) {
    case "list": {
      const kind = s(input.kind);
      const noun = KIND_PLURAL[kind] ?? kind;
      const count = countOf(result);
      const base = `${running ? "Читаю" : "Прочитал"} список: ${noun}`;
      return count !== null && !running ? `${base} (${count})` : base;
    }
    case "get": {
      const noun = KIND_SINGULAR[s(input.kind)] ?? s(input.kind);
      return `${running ? "Читаю" : "Прочитал"}: ${noun} ${s(input.id)}`.trim();
    }
    case "search_docs":
      return `Поиск по документации: «${s(input.query)}»`;
    case "search_config":
      return `Поиск по конфигурации: «${s(input.query)}»`;
    case "read_content": {
      const noun = KIND_SINGULAR[s(input.kind)] ?? s(input.kind);
      return `${running ? "Читаю" : "Прочитал"} содержимое: ${noun} ${s(input.id)}`.trim();
    }
    case "get_session_events":
      return `${running ? "Читаю" : "Прочитал"} события сессии ${s(input.session_id)}`.trim();
    case "get_trajectory":
      return `${running ? "Читаю" : "Прочитал"} ход сессии ${s(input.session_id)}`.trim();
    case "help":
      return `${running ? "Читаю" : "Прочитал"} справку: ${s(input.topic) || "обзор"}`;
    case "request_secret":
      return `Ссылка на форму секрета: ${s(input.name)}`.trim();
    case "preview_change":
      return `${running ? "Собираю" : "Собрал"} черновик: ${KIND_SINGULAR[s(input.kind)] ?? s(input.kind)}`;
    default:
      return `${running ? "Читаю" : "Прочитал"}: ${tool}`;
  }
}

/** Ссылка из `request_secret`: только путь консоли, чужие адреса не берём. */
function consoleLink(result: unknown, text: string): string | undefined {
  const candidate = isRecord(result)
    ? s(result.url) || s(result.link) || s(result.href)
    : /^\/[^\s]*$/.test(text.trim())
      ? text.trim()
      : "";
  // Только путь внутри консоли: без «//», обратной косой черты и пробелов.
  return /^\/(?!\/)[^\s\\]*$/.test(candidate) ? candidate : undefined;
}

/* ---------- Итог записи ---------- */

const TOOL_KIND: Record<string, { kind: string; action: "create" | "update"; idField?: string }> = {
  create_agent: { kind: "agent", action: "create" },
  create_environment: { kind: "environment", action: "create" },
  create_skill: { kind: "skill", action: "create" },
  upload_file: { kind: "file", action: "create" },
  create_memory_store: { kind: "memory_store", action: "create" },
  create_deployment: { kind: "deployment", action: "create" },
  create_session: { kind: "session", action: "create" },
  write_memory: { kind: "memory", action: "update" },
  update_agent: { kind: "agent", action: "update" },
  restore_agent_version: { kind: "agent", action: "update" },
  update_environment: { kind: "environment", action: "update" },
  create_skill_version: { kind: "skill", action: "update" },
  update_memory_store: { kind: "memory_store", action: "update" },
  update_deployment: { kind: "deployment", action: "update" },
  update_model_card: { kind: "model_card", action: "update" },
  update_harness_card: { kind: "harness_card", action: "update" },
  send_message: { kind: "message", action: "create" },
  update_session: { kind: "session", action: "update", idField: "session_id" },
  add_session_resource: { kind: "session", action: "update", idField: "session_id" },
  update_session_resource: { kind: "session", action: "update", idField: "session_id" },
  pause_deployment: { kind: "deployment", action: "update", idField: "deployment_id" },
  unpause_deployment: { kind: "deployment", action: "update", idField: "deployment_id" },
  run_deployment: { kind: "deployment", action: "update", idField: "deployment_id" },
};

/** Опасные инструменты: вид объекта и его id лежат во входе вызова. */
const DANGER_ACTION: Record<string, "archive" | "unarchive" | "delete"> = {
  archive_object: "archive",
  unarchive_object: "unarchive",
  delete_object: "delete",
};

function nameFromInput(tool: string, input: Record<string, unknown>): string | null {
  const fields = parseToolInput(input.config ?? input.changes ?? input.body);
  const name =
    s(input.display_title) ||
    s(input.name) ||
    s(input.filename) ||
    s(fields.name) ||
    s(fields.display_title) ||
    (tool === "write_memory" ? s(input.path) : "");
  return name || null;
}

function appliedFromInput(tool: string, input: Record<string, unknown>): AppliedInfo | null {
  const danger = DANGER_ACTION[tool];
  if (danger) {
    const kind = s(input.kind);
    if (!kind) return null;
    return { tool, kind, id: s(input.id) || null, name: null, version: null, action: danger };
  }
  const meta = TOOL_KIND[tool];
  if (!meta) return null;
  return {
    tool,
    kind: meta.kind,
    id: meta.idField ? s(input[meta.idField]) || null : null,
    name: nameFromInput(tool, input),
    version: null,
    action: meta.action,
  };
}

function appliedFromResultRow(row: Record<string, unknown>, fallbackTool: string): AppliedInfo | null {
  const tool = s(row.tool) || fallbackTool;
  const meta = TOOL_KIND[tool];
  const kind = s(row.kind) || meta?.kind;
  if (!kind) return null;
  const action: AppliedAction =
    row.action === "update" || row.action === "create" ? row.action : (DANGER_ACTION[tool] ?? meta?.action ?? "create");
  return {
    tool,
    kind,
    id: s(row.id) || null,
    name: s(row.name) || null,
    version: typeof row.version === "number" ? row.version : null,
    action,
  };
}

/** Итог записи: из JSON результата, иначе из входа вызова. */
export function parseApplied(
  tool: string,
  input: Record<string, unknown>,
  text: string,
): AppliedInfo[] {
  const parsed = parseJson(text);
  if (isRecord(parsed)) {
    const rows = Array.isArray(parsed.results)
      ? parsed.results
      : Array.isArray(parsed.operations)
        ? parsed.operations
        : null;
    if (rows) {
      const out = rows
        .filter(isRecord)
        .map((r) => appliedFromResultRow(r, tool))
        .filter((x): x is AppliedInfo => x !== null);
      if (out.length > 0) return out;
    } else if (parsed.kind || parsed.id) {
      const one = appliedFromResultRow(parsed, tool);
      if (one) return [one];
    }
  }
  if (tool === "apply_changes") {
    const ops = Array.isArray(input.operations) ? input.operations : [];
    return ops
      .filter(isRecord)
      .map((op) => appliedFromInput(assistantToolName(s(op.tool)), isRecord(op.args) ? op.args : {}))
      .filter((x): x is AppliedInfo => x !== null);
  }
  const one = appliedFromInput(tool, input);
  return one ? [one] : [];
}

const APPLIED_NOUN: Record<string, { noun: string; gender: "m" | "f" | "n"; href?: (id: string | null) => string | null }> = {
  agent: { noun: "агент", gender: "m", href: (id) => (id ? `/agents/${encodeURIComponent(id)}` : null) },
  environment: { noun: "окружение", gender: "n", href: (id) => (id ? `/environments/${encodeURIComponent(id)}` : null) },
  skill: { noun: "навык", gender: "m", href: () => "/skills" },
  file: { noun: "файл", gender: "m", href: () => "/files" },
  memory_store: { noun: "хранилище памяти", gender: "n", href: (id) => (id ? `/memory/${encodeURIComponent(id)}` : null) },
  memory: { noun: "запись памяти", gender: "f" },
  deployment: { noun: "деплоймент на паузе", gender: "m" },
  session: { noun: "сессия", gender: "f", href: (id) => (id ? `/sessions/${encodeURIComponent(id)}` : null) },
  model_card: { noun: "карточка модели", gender: "f", href: () => "/model-cards" },
  harness_card: { noun: "карточка harness", gender: "f", href: () => "/harnesses" },
};

const PAST: Record<"create" | "update", Record<"m" | "f" | "n", string>> = {
  create: { m: "Создан", f: "Создана", n: "Создано" },
  update: { m: "Изменён", f: "Изменена", n: "Изменено" },
};

const DANGER_VERB: Record<"archive" | "unarchive" | "delete", string> = {
  archive: "Отправлено в архив",
  unarchive: "Возвращено из архива",
  delete: "Удалено",
};

/** Вид объекта в строке итога опасной записи. */
const DANGER_NOUN: Record<string, string> = {
  agent: "агент",
  deployment: "деплоймент",
  skill_version: "версия навыка",
  session_resource: "ресурс сессии",
};

export interface AppliedLine {
  text: string;
  href: string | null;
}

/** Строки «Создан навык «…», версия 1» с ссылкой на объект. */
export function appliedLines(items: readonly AppliedInfo[]): AppliedLine[] {
  return items.map((it) => {
    if (it.kind === "message") {
      return {
        text: it.name
          ? `Отправлено первое сообщение в сессию «${it.name}»`
          : "Отправлено первое сообщение в сессию",
        href: it.id ? `/sessions/${encodeURIComponent(it.id)}` : null,
      };
    }
    const meta = APPLIED_NOUN[it.kind];
    const noun = meta?.noun ?? it.kind;
    if (it.action === "archive" || it.action === "unarchive" || it.action === "delete") {
      // Безличная строка: имя объекта ассистент передаёт не всегда, только id.
      const what = `${DANGER_NOUN[it.kind] ?? noun} ${it.name ?? it.id ?? ""}`.trim();
      const href = it.action === "delete" ? null : (meta?.href?.(it.id) ?? null);
      return { text: `${DANGER_VERB[it.action]}: ${what}`, href };
    }
    const verb = PAST[it.action][meta?.gender ?? "m"];
    const name = it.name ? ` «${it.name}»` : "";
    const version = it.version !== null ? `, версия ${it.version}` : "";
    return { text: `${verb} ${noun}${name}${version}`, href: meta?.href?.(it.id) ?? null };
  });
}

/* ---------- Лента ---------- */

function eventText(event: Event): string {
  const content = event.content;
  return typeof content === "string" ? content : userMessageText(content);
}

/** Разбор событий в строки ленты, по порядку событий. */
export function buildThread(events: readonly Event[]): ThreadItem[] {
  const results = new Map<string, Event>();
  const confirmations = new Map<string, Event>();
  for (const e of events) {
    if (e.type === "agent.mcp_tool_result" && typeof e.mcp_tool_use_id === "string") {
      results.set(e.mcp_tool_use_id, e);
    }
    if (e.type === "user.tool_confirmation" && typeof e.tool_use_id === "string") {
      confirmations.set(e.tool_use_id, e);
    }
  }

  const items: ThreadItem[] = [];
  for (const e of events) {
    const id = typeof e.id === "string" ? e.id : `idx-${items.length}`;
    if (e.type === "user.message") {
      const text = stripPageContext(eventText(e));
      if (text.trim()) items.push({ kind: "user", id, text });
    } else if (e.type === "agent.message") {
      const text = eventText(e);
      if (text.trim()) items.push({ kind: "assistant", id, text });
    } else if (e.type === "session.error") {
      const text = typeof e.error === "string" ? e.error : typeof e.message === "string" ? e.message : "Ошибка сессии";
      items.push({ kind: "error", id, text });
    } else if (e.type === "agent.mcp_tool_use") {
      const tool = assistantToolName(typeof e.name === "string" ? e.name : "");
      const input = isRecord(e.input) ? e.input : {};
      const res = results.get(id);
      const text = resultText(res);
      const failed = res?.is_error === true;

      if (isWriteTool(tool)) {
        const conf = confirmations.get(id);
        let phase: ProposalPhase = "pending";
        if (res) phase = failed ? "failed" : "applied";
        else if (conf?.result === "allow") phase = "sent";
        // Отказ пользователя: сервер пишет результат is_error «Denied», карточка
        // остаётся «Отклонено», а не «Не применено».
        if (conf?.result === "deny") phase = "denied";
        const item: Extract<ThreadItem, { kind: "proposal" }> = { kind: "proposal", id, tool, input, phase };
        if (conf?.result === "deny" && typeof conf.deny_message === "string") item.denyMessage = conf.deny_message;
        if (res && failed) item.resultText = text;
        if (res && !failed) item.applied = parseApplied(tool, input, text);
        items.push(item);
        continue;
      }

      if (tool === "preview_change") {
        const draftKind = s(input.kind);
        if (res && !failed && (draftKind === "model_card" || draftKind === "harness_card")) {
          items.push({ kind: "draft", id, draftKind, body: parseToolInput(input.body) });
          continue;
        }
      }

      const status: ReadStatus = res ? (failed ? "error" : "done") : "running";
      const parsed = parseJson(text);
      const row: Extract<ThreadItem, { kind: "read" }> = {
        kind: "read",
        id,
        tool,
        label: readRowLabel(tool, input, parsed, status),
        status,
      };
      if (tool === "request_secret" && res && !failed) {
        const link = consoleLink(parsed, text);
        if (link) row.link = link;
      }
      items.push(row);
    }
  }
  return items;
}

/** Что делает сессия сейчас, по последнему событию состояния. */
export function sessionActivity(events: readonly Event[]): "running" | "idle" | "requires_action" {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "session.status_running" || e.type === "session.status_rescheduled") return "running";
    if (e.type === "session.status_idle") {
      return e.stop_reason?.type === "requires_action" ? "requires_action" : "idle";
    }
    if (e.type === "session.status_terminated") return "idle";
  }
  return "idle";
}

/* ---------- Хук: история и поток ---------- */

export interface AssistantEventsState {
  events: Event[];
  loaded: boolean;
  /** Показывает реплику сразу, не дожидаясь сервера. Возвращает локальный id. */
  addOptimistic: (text: string) => string;
  dropOptimistic: (localId: string) => void;
}

/**
 * История сессии и живой поток событий. Пока `sessionId` пуст, ничего не
 * грузится. Повторные подключения делаются только после сбоя сети и ответов
 * 5xx, ответ 4xx закрывает поток (как на странице сессии).
 */
export function useAssistantEvents(sessionId: string | null): AssistantEventsState {
  const managedApi = useManagedApi();
  const [events, setEvents] = useState<Event[]>([]);
  const [loaded, setLoaded] = useState(false);
  const optimistic = useRef(new OptimisticUserMessages());

  useEffect(() => {
    setEvents([]);
    setLoaded(false);
    optimistic.current.clear();
    if (!sessionId) return;
    const abort = new AbortController();

    const add = (raw: unknown) => {
      if (abort.signal.aborted || !isRecord(raw)) return;
      const event = raw as Event;
      if (!event.ts && typeof event.processed_at === "string") event.ts = event.processed_at;
      // Локальную реплику забираем до setEvents: функцию обновления React в
      // StrictMode зовёт дважды, и второй вызов уже не нашёл бы запись.
      const claimed =
        event.type === "user.message"
          ? optimistic.current.claimForEvent(
              typeof event.id === "string" ? event.id : undefined,
              userMessageText(event.content),
            )
          : undefined;
      setEvents((prev) => mergeEvent(claimed ? prev.filter((e) => e.id !== claimed) : prev, event));
    };

    void (async () => {
      let page: string | undefined;
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        try {
          const res = await managedApi.sessions.events.list(sessionId, { limit: 100, order: "asc", page });
          for (const e of res.data) add(e);
          if (!res.next_page || seen.has(res.next_page)) break;
          seen.add(res.next_page);
          page = res.next_page;
        } catch {
          break;
        }
      }
      if (!abort.signal.aborted) setLoaded(true);
    })();

    void (async () => {
      const backoff = [1_000, 2_000, 4_000, 8_000];
      let failures = 0;
      while (!abort.signal.aborted) {
        try {
          const live = await managedApi.sessions.events.stream(sessionId, {}, { signal: abort.signal });
          failures = 0;
          for await (const event of live) {
            if (abort.signal.aborted) break;
            add(event);
          }
        } catch (error) {
          if (abort.signal.aborted) break;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) break;
        }
        if (abort.signal.aborted) break;
        const delay = backoff[Math.min(failures, backoff.length - 1)];
        failures += 1;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          abort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    })();

    return () => abort.abort();
  }, [sessionId, managedApi]);

  const addOptimistic = useCallback((text: string) => {
    const localId = optimistic.current.add(text);
    const event = createOptimisticUserEvent(localId, text, new Date().toISOString());
    setEvents((prev) => [...prev, event]);
    return localId;
  }, []);

  const dropOptimistic = useCallback((localId: string) => {
    optimistic.current.release(localId);
    setEvents((prev) => prev.filter((e) => e.id !== localId));
  }, []);

  return { events, loaded, addOptimistic, dropOptimistic };
}
