import { load } from "js-yaml";

import type { Event } from "../events";
import { userMessageText } from "../optimistic-user-message";
import { assistantToolName } from "./api";

/**
 * Черновик результата сессии («Предложить результат», раздел 1.1 плана).
 * Ассистент в наборе «черновик» зовёт `preview_change` с видом `outcome`, а
 * консоль подставляет описание и критерии в диалог «Задать результат». Событие
 * `user.define_outcome` отправляет человек кнопкой диалога.
 */

export interface OutcomeSuggestion {
  description: string;
  rubric: string;
  maxIterations: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultText(event: Event): string {
  return typeof event.content === "string" ? event.content : userMessageText(event.content);
}

function parseSuggestion(text: string): OutcomeSuggestion | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.kind !== "outcome" || typeof raw.after_yaml !== "string") return null;
  let body: unknown;
  try {
    body = load(raw.after_yaml);
  } catch {
    return null;
  }
  if (!isRecord(body)) return null;
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const rubric = body.rubric;
  // Рубрика-файл в диалоге не поддерживается: там только текст.
  if (!description || !isRecord(rubric) || rubric.type !== "text" || typeof rubric.content !== "string") return null;
  const content = rubric.content.trim();
  if (!content) return null;
  const iterations = body.max_iterations;
  return {
    description,
    rubric: content,
    maxIterations: typeof iterations === "number" && Number.isInteger(iterations) ? iterations : null,
  };
}

/** Последний удачный черновик результата из событий сессии ассистента. */
export function extractOutcomeDraft(events: readonly Event[]): OutcomeSuggestion | null {
  const results = new Map<string, Event>();
  for (const e of events) {
    if (e.type === "agent.mcp_tool_result" && typeof e.mcp_tool_use_id === "string") {
      results.set(e.mcp_tool_use_id, e);
    }
  }
  let found: OutcomeSuggestion | null = null;
  for (const e of events) {
    if (e.type !== "agent.mcp_tool_use" || typeof e.id !== "string") continue;
    if (assistantToolName(typeof e.name === "string" ? e.name : "") !== "preview_change") continue;
    if (!isRecord(e.input) || e.input.kind !== "outcome") continue;
    const res = results.get(e.id);
    if (!res || res.is_error === true) continue;
    const parsed = parseSuggestion(resultText(res));
    if (parsed) found = parsed;
  }
  return found;
}

/** Просьба к ассистенту. Контекст страницы консоль добавляет сама. */
export function outcomeRequestText(sessionId: string): string {
  return [
    `Предложи результат для сессии ${sessionId}.`,
    "Прочитай её ход и подготовь черновик через preview_change с kind outcome:",
    "описание того, что должна выдать сессия, и текстовые критерии оценки (rubric типа text).",
    "Ничего не записывай: черновик подставит в диалог человек.",
  ].join(" ");
}
