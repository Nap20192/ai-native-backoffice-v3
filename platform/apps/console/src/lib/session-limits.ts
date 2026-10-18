import type { SessionUpdateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { Event } from "./events";

/**
 * Предел работы сессии (docs/plans/multiagent.md, 3.Б). Сервер считает токены
 * и ходы субагентов, на пределе ход встаёт с `budget_reached`. Консоль чисел
 * не показывает: по причине остановки шапка пишет заметку, а кнопка поднимает
 * оба предела вдвое правкой сессии с `_oma.limits`.
 */

/** `_oma.limits` из ответа `GET /v1/sessions/:id` (API_LAYER.md, «Session limits»). */
export interface SessionLimits {
  maxTokens: number;
  maxChildTurns: number;
  usedTokens: number;
  usedChildTurns: number;
}

/** Тело правки сессии, которое поднимает предел. Поля `_oma` в SDK нет, его
 *  объявляет `API_LAYER.md` сервера. */
export type RaiseSessionLimitsBody = SessionUpdateParams & {
  _oma: { limits: { max_tokens: number; max_child_turns: number } };
};

/** Последняя остановка сессии: `session.status_idle`, после которого ход не
 *  начинался. Потоки субагентов пишут `session.thread_status_*`, их здесь нет. */
export function lastSessionStop(events: readonly Event[]): { eventId: string; reason: string | null } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event.type.startsWith("session.status_")) continue;
    if (event.type !== "session.status_idle") return null;
    return { eventId: event.id ?? `idle:${index}`, reason: event.stop_reason?.type ?? null };
  }
  return null;
}

function count(value: unknown): number | null {
  // Postgres отдаёт BIGINT строкой, поэтому строка с числом тоже годится.
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : null;
}

/** Предел и израсходованное из сессии. Старый сервер поля не отдаёт: тогда null. */
export function readSessionLimits(session: unknown): SessionLimits | null {
  const oma = (session as { _oma?: { limits?: Record<string, unknown> } } | null)?._oma;
  const limits = oma?.limits;
  if (!limits) return null;
  const maxTokens = count(limits.max_tokens);
  const maxChildTurns = count(limits.max_child_turns);
  const usedTokens = count(limits.used_tokens);
  const usedChildTurns = count(limits.used_child_turns);
  if (maxTokens === null || maxChildTurns === null || usedTokens === null || usedChildTurns === null) return null;
  return { maxTokens, maxChildTurns, usedTokens, usedChildTurns };
}

/** Оба предела вдвое (решение 8 плана). Удваивается большее из предела и
 *  израсходованного: последний запрос мог уйти за предел, а сервер принимает
 *  только предел выше израсходованного. */
export function raisedSessionLimits(limits: SessionLimits): RaiseSessionLimitsBody {
  const double = (max: number, used: number) => Math.max(1, 2 * Math.max(max, used));
  return {
    _oma: {
      limits: {
        max_tokens: double(limits.maxTokens, limits.usedTokens),
        max_child_turns: double(limits.maxChildTurns, limits.usedChildTurns),
      },
    },
  };
}
