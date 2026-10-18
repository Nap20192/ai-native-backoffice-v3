import { useCallback, useEffect, useReducer, useRef } from "react";

import { ApiError } from "../api";
import {
  postDecision,
  requestPreview,
  useAssistantApi,
  type AssistantApiFn,
  type DecisionOutcome,
  type PreviewResult,
} from "./api";

/**
 * Состояние карточки предложения и отправка решения (раздел 1.4 и 2.5 плана).
 * Карточка запрашивает preview, когда появляется, и по кнопке «Обновить».
 * Решение уходит с `preview_digest` той карточки, что на экране.
 */

export type BlockReason =
  | "disabled"
  | "schema"
  | "secret"
  | "class"
  | "not_found"
  | "not_pending"
  | "forbidden"
  | "args_stale";

/** Причина, по которой кнопка «Применить» выключена. */
export interface Block {
  reason: BlockReason;
  text: string;
}

const DISABLED_TEXT = "Ассистент выключен в пространстве";
const SECRET_TEXT =
  "В черновике значение секрета пространства. Секрет задаётся только в хранилище секретов";
const NOT_FOUND_TEXT = "Объект не найден";
const NOT_PENDING_TEXT = "Вызов уже не ждёт подтверждения";
const FORBIDDEN_TEXT = "Подтвердить может только тот, кто начал разговор";
const ARGS_STALE_TEXT =
  "Аргументы больше не подходят к текущему состоянию объекта. Попросите ассистента пересобрать предложение";
const GENERIC_CLASS_TEXT = "Операция вышла за первую версию. Выполните её в консоли";

/** Текст «вне первой версии» по инструменту операции. */
function classText(tool: string, serverReason: string | null): string {
  if (serverReason) return serverReason;
  switch (tool) {
    case "send_message":
      return "В первой версии ассистент отправляет только первое сообщение в сессию, которую создал сам";
    case "update_deployment":
      return "Деплоймент работает. В первой версии ассистент меняет только деплоймент на паузе";
    case "create_session":
      return "В первой версии ассистент не создаёт сессии с ассистентом и в архивных агентах и окружениях";
    default:
      return GENERIC_CLASS_TEXT;
  }
}

/** Что мешает применить предложение, по самому preview. */
export function blockFromPreview(preview: PreviewResult, tool: string): Block | null {
  if (preview.disabled) return { reason: "disabled", text: DISABLED_TEXT };
  if (preview.schemaError) return { reason: "schema", text: preview.schemaError };
  if (preview.notFound) return { reason: "not_found", text: NOT_FOUND_TEXT };
  if (preview.secret) return { reason: "secret", text: SECRET_TEXT };
  const out = preview.operations.find((o) => o.class === "out_of_v1");
  if (out || preview.class === "out_of_v1") {
    return { reason: "class", text: classText(out?.tool || tool, out?.outOfV1Reason ?? null) };
  }
  if (preview.argsStale) return { reason: "args_stale", text: ARGS_STALE_TEXT };
  return null;
}

/** Что мешает применить предложение, по ответу `confirm`. */
export function blockFromDecision(
  outcome: Extract<DecisionOutcome, { ok: false }>,
  preview: PreviewResult | null,
  tool: string,
): Block | null {
  switch (outcome.reason) {
    case "class": {
      // Карточка на экране собрана до смены состояния. Причину по новому состоянию пишет сервер в ответе 409.
      const out = preview?.operations.find((o) => o.class === "out_of_v1");
      return { reason: "class", text: classText(out?.tool || tool, out?.outOfV1Reason ?? (outcome.message || null)) };
    }
    case "secret":
      return { reason: "secret", text: SECRET_TEXT };
    case "disabled":
      return { reason: "disabled", text: DISABLED_TEXT };
    case "not_found":
      return { reason: "not_found", text: NOT_FOUND_TEXT };
    case "not_pending":
      return { reason: "not_pending", text: NOT_PENDING_TEXT };
    case "forbidden":
      return { reason: "forbidden", text: FORBIDDEN_TEXT };
    default:
      return null;
  }
}

const STALE_NOUN: Record<string, { nom: string; verb: string }> = {
  agent: { nom: "Агент", verb: "изменился" },
  environment: { nom: "Окружение", verb: "изменилось" },
  skill: { nom: "Навык", verb: "изменился" },
  deployment: { nom: "Деплоймент", verb: "изменился" },
  memory_store: { nom: "Хранилище памяти", verb: "изменилось" },
  memory: { nom: "Запись памяти", verb: "изменилась" },
  session: { nom: "Сессия", verb: "изменилась" },
  message: { nom: "Сессия", verb: "изменилась" },
  model_card: { nom: "Карточка модели", verb: "изменилась" },
};

/** «Агент изменился после предложения» по виду объекта. */
export function staleText(preview: PreviewResult | null): string {
  const ops = preview?.operations ?? [];
  if (ops.length > 1) return "Объекты изменились после предложения";
  const meta = ops[0] ? STALE_NOUN[ops[0].kind] : undefined;
  return meta ? `${meta.nom} ${meta.verb} после предложения` : "Объект изменился после предложения";
}

/* ---------- Состояние карточки ---------- */

export type CardPhase = "loading" | "ready" | "confirming" | "sent" | "denied" | "error";

export interface CardState {
  phase: CardPhase;
  preview: PreviewResult | null;
  block: Block | null;
  /** Объект изменился после предложения, на экране уже новая разница. */
  stale: boolean;
  notice: string | null;
}

export function initialCardState(): CardState {
  return { phase: "loading", preview: null, block: null, stale: false, notice: null };
}

export type CardAction =
  | { type: "previewLoaded"; preview: PreviewResult; tool: string; keepStale?: boolean }
  | { type: "previewFailed"; status: number }
  | { type: "refreshStart" }
  | { type: "decisionStart"; result: "allow" | "deny" }
  | { type: "decisionOk"; result: "allow" | "deny" }
  | { type: "decisionFailed"; outcome: Extract<DecisionOutcome, { ok: false }>; tool: string };

export function reduceCard(state: CardState, action: CardAction): CardState {
  switch (action.type) {
    case "refreshStart":
      return { ...state, phase: "loading", notice: state.stale ? state.notice : null };
    case "previewLoaded": {
      const stale = action.keepStale ? state.stale : false;
      return {
        phase: "ready",
        preview: action.preview,
        block: blockFromPreview(action.preview, action.tool),
        stale,
        notice: stale ? state.notice : null,
      };
    }
    case "previewFailed":
      if (action.status === 404) {
        return { ...state, phase: "error", block: { reason: "not_found", text: NOT_FOUND_TEXT }, notice: null };
      }
      return {
        ...state,
        phase: "error",
        block: null,
        notice: "Не удалось получить предложение. Нажмите «Обновить»",
      };
    case "decisionStart":
      return { ...state, phase: "confirming", notice: null };
    case "decisionOk":
      return { ...state, phase: action.result === "allow" ? "sent" : "denied", notice: null };
    case "decisionFailed": {
      const { outcome } = action;
      if (outcome.reason === "stale") {
        return { ...state, phase: "ready", stale: true, notice: staleText(state.preview) };
      }
      const block = blockFromDecision(outcome, state.preview, action.tool);
      if (block) return { ...state, phase: "ready", block, notice: null };
      return { ...state, phase: "ready", notice: "Не удалось отправить решение. Повторите" };
    }
  }
}

/* ---------- Хук карточки ---------- */

export interface ProposalController {
  state: CardState;
  refresh: () => void;
  allow: () => void;
  deny: (reason?: string) => void;
  /** Отказ с причиной `stale`: ассистент соберёт предложение заново. */
  askRebuild: () => void;
}

const REBUILD_MESSAGE =
  "stale: объект изменился после предложения, аргументы не подходят. Пересобери предложение по новому состоянию.";

export function useProposal(input: {
  sessionId: string;
  toolUseId: string;
  tool: string;
  /** false, если решение уже принято (применено, отклонено): preview не нужен. */
  active: boolean;
}): ProposalController {
  const api = useAssistantApi();
  const [state, dispatch] = useReducer(reduceCard, undefined, initialCardState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const { sessionId, toolUseId, tool, active } = input;

  const load = useCallback(
    async (keepStale: boolean) => {
      try {
        const preview = await requestPreview(api as AssistantApiFn, { sessionId, toolUseId });
        if (alive.current) dispatch({ type: "previewLoaded", preview, tool, keepStale });
      } catch (err) {
        if (alive.current) {
          dispatch({ type: "previewFailed", status: err instanceof ApiError ? err.status : 0 });
        }
      }
    },
    [api, sessionId, toolUseId, tool],
  );

  useEffect(() => {
    if (active) void load(false);
  }, [active, load]);

  const refresh = useCallback(() => {
    dispatch({ type: "refreshStart" });
    void load(false);
  }, [load]);

  const decide = useCallback(
    async (result: "allow" | "deny", denyMessage?: string) => {
      const current = stateRef.current;
      dispatch({ type: "decisionStart", result });
      const outcome = await postDecision(api as AssistantApiFn, {
        sessionId,
        toolUseId,
        result,
        digest: current.preview?.digest ?? null,
        denyMessage,
      });
      if (!alive.current) return;
      if (outcome.ok) {
        dispatch({ type: "decisionOk", result });
        return;
      }
      dispatch({ type: "decisionFailed", outcome, tool });
      // Объект изменился: показываем новую разницу, подтвердить её можно той же кнопкой.
      if (outcome.reason === "stale") void load(true);
    },
    [api, sessionId, toolUseId, tool, load],
  );

  return {
    state,
    refresh,
    allow: () => void decide("allow"),
    deny: (reason) => void decide("deny", reason?.trim() || undefined),
    askRebuild: () => void decide("deny", REBUILD_MESSAGE),
  };
}

/* ---------- Возврат версии агента ---------- */

const REVERT_FIELDS = [
  "name",
  "description",
  "model",
  "system",
  "tools",
  "mcp_servers",
  "skills",
  "multiagent",
] as const;

/**
 * «Вернуть версию 3»: консоль создаёт новую версию с полями версии 3. Запись
 * идёт с текущей версией, поэтому чужая правка между делом даёт конфликт.
 */
export async function revertAgentVersion(
  api: AssistantApiFn,
  input: { agentId: string; toVersion: number; currentVersion: number },
): Promise<{ version: number }> {
  const id = encodeURIComponent(input.agentId);
  const old = (await api(`/v1/agents/${id}?version=${input.toVersion}`, { quiet: true })) as Record<string, unknown>;
  const body: Record<string, unknown> = { version: input.currentVersion };
  for (const key of REVERT_FIELDS) {
    if (key in old) body[key] = old[key];
  }
  const out = (await api(`/v1/agents/${id}`, { method: "POST", body: JSON.stringify(body) })) as Record<string, unknown>;
  return { version: typeof out.version === "number" ? out.version : input.currentVersion + 1 };
}
