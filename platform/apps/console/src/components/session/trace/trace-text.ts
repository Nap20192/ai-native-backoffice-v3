import type { TraceCoverage, TraceSource, TraceSpan, TraceStatus, TraceTurnSummary } from "../../../lib/trace-api";
import type { TraceKindGroup } from "../../../lib/trace-tree";
import { EMPTY_VALUE, formatClockRu, formatEventDateTimeRu, formatShortDurationRu } from "../format-ru";

/**
 * Тексты вкладки «Трейс»: подписи видов, статусов, значков хода и времени.
 * Чистые функции без React, чтобы строки и детали говорили одно и то же.
 */

export const GROUP_LABEL: Record<TraceKindGroup, string> = {
  turn: "Ход",
  model: "Модель",
  tool: "Инструмент",
  subagent: "Сабагент",
  sandbox: "Песочница",
  wait: "Ожидание",
};

const PHASE_LABEL: Record<string, string> = {
  acquire: "Выдача VM",
  restore: "Рабочая папка",
  inputs: "Входы сессии",
  vm_start: "Старт VM",
  start_vm: "Старт VM",
  packages: "Пакеты окружения",
  install_packages: "Пакеты окружения",
};

const KIND_TITLE: Record<TraceSpan["kind"], string> = {
  turn: "Ход",
  sandbox: "Песочница",
  sandbox_phase: "Фаза песочницы",
  harness_start: "Запуск агента",
  acp_prompt: "Ход агента ACP",
  agent_step: "Шаг агента",
  model_call: "Вызов модели",
  tool_call: "Инструмент",
  tool_wait: "Ожидание вас",
  tool_exec: "Выполнение",
  subagent: "Сабагент",
  outcome_eval: "Оценка результата",
  compaction: "Сжатие контекста",
  retry_wait: "Пауза перед повтором",
  hook: "Хук",
  event: "Событие",
};

/** Подпись вида для заголовка деталей и подсказок. */
export function kindTitle(kind: TraceSpan["kind"]): string {
  return KIND_TITLE[kind];
}

const EVENT_LABEL: Record<string, string> = {
  error: "Ошибка",
  warning: "Предупреждение",
  confirmation: "Подтверждение",
  mcp_connection: "Подключение MCP",
};

/** Сервер хранит имя события ключом («warning»), консоль показывает русскую подпись. */
export function eventLabel(name: string): string {
  return EVENT_LABEL[name] ?? name;
}

export function spanTitle(span: TraceSpan, options: { turnNumber?: number } = {}): string {
  switch (span.kind) {
    case "turn":
      return options.turnNumber ? `Ход ${options.turnNumber}` : "Ход";
    case "sandbox_phase":
      return PHASE_LABEL[span.name] ?? (span.name || KIND_TITLE.sandbox_phase);
    case "tool_call":
      return span.tool?.name || span.name || KIND_TITLE.tool_call;
    case "subagent":
      return span.name ? `Сабагент «${span.name}»` : "Сабагент";
    case "event":
      return span.name ? eventLabel(span.name) : KIND_TITLE.event;
    default:
      return KIND_TITLE[span.kind];
  }
}

function attrText(span: TraceSpan, key: string): string | null {
  const value = span.attrs[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Серая подпись справа от названия: модель, аргумент инструмента, тип песочницы. */
export function spanSubtitle(
  span: TraceSpan,
  options: { toolInput?: string | null; parentToolName?: string | null },
): string | null {
  switch (span.kind) {
    case "turn":
      // Ход, которого ещё нет в таблице трейса, сервер называет «turn»: имени агента у него нет.
      return span.name && span.name !== "turn" ? span.name : null;
    case "model_call":
      return span.model ?? (span.name || null);
    case "acp_prompt":
      return span.harness;
    case "tool_call":
      return options.toolInput?.trim() ? options.toolInput : null;
    case "tool_wait":
    case "tool_exec":
      return span.tool?.name ?? options.parentToolName ?? null;
    case "hook":
      return span.name || null;
    case "sandbox": {
      if (span.attrs.reused === true) return "тёплая";
      const attempt = span.attrs.attempt;
      return typeof attempt === "number" && attempt > 1 ? `попытка ${attempt}` : null;
    }
    case "event": {
      const result = attrText(span, "result");
      if (span.name === "confirmation" && result) return result === "deny" ? "отклонено" : "разрешено";
      return attrText(span, "message") ?? attrText(span, "server");
    }
    default:
      return null;
  }
}

/* ---------- Время ---------- */

export interface DurationContext {
  nowMs: number;
  /** Конец последнего хода сессии: до него тянется узел «ждёт». */
  lastTurnEndMs: number;
}

export function spanDurationMs(span: TraceSpan, context: DurationContext): number {
  let end: number;
  if (span.end_ms !== null) end = span.end_ms;
  else if (span.status === "waiting") end = context.lastTurnEndMs;
  else if (span.status === "running") end = context.nowMs;
  else end = span.start_ms;
  return Math.max(0, end - span.start_ms);
}

/** Ячейка «Длительность»: «2,6 с», «≈ 2,6 с» для узла по событиям, «идёт», «ждёт». */
export function durationCellText(span: TraceSpan, context: DurationContext): string {
  if (span.end_ms === null && span.status === "waiting") return "ждёт";
  if (span.end_ms === null && span.status === "running") return "идёт";
  const ms = spanDurationMs(span, context);
  if (span.kind === "event" || ms === 0) return EMPTY_VALUE;
  const text = formatShortDurationRu(ms);
  return span.precision === "by_events" ? `≈ ${text}` : text;
}

const pad3 = (ms: number) => String(Math.floor(((ms % 1000) + 1000) % 1000)).padStart(3, "0");

/** «11:40:01.250». */
export function formatClockMsRu(ms: number): string {
  return `${formatClockRu(ms)}.${pad3(ms)}`;
}

/** «чт, 16 окт., 11:40:01.250». */
export function formatDateTimeMsRu(ms: number): string {
  return `${formatEventDateTimeRu(ms)}.${pad3(ms)}`;
}

/** «ждёт с 12:03». */
export function waitingSinceText(span: TraceSpan): string {
  return `ждёт с ${formatClockRu(span.start_ms).slice(0, 5)}`;
}

/* ---------- Статус ---------- */

export const STATUS_LABEL: Record<TraceStatus, string> = {
  running: "Идёт",
  ok: "Успешно",
  error: "Ошибка",
  denied: "Отклонено",
  interrupted: "Прервано",
  cancelled: "Отменено",
  waiting: "Ждёт подтверждения",
};

const STATUS_SHORT: Record<TraceStatus, string | null> = {
  running: "идёт",
  ok: null,
  error: "ошибка",
  denied: "отклонено",
  interrupted: "прервано",
  cancelled: "отменено",
  waiting: "ждёт",
};

/** Короткий статус в строке. Успешный узел тихий, ход с requires_action ждёт подтверждения. */
export function rowStatusText(span: TraceSpan): string | null {
  if (span.kind === "turn" && span.status === "ok" && span.attrs.stop_reason === "requires_action") {
    return "ждёт подтверждения";
  }
  return STATUS_SHORT[span.status];
}

/** Ошибки внутри хода или сабагента, видимые на свёрнутой строке. */
export function errorBadgeText(span: TraceSpan, summary: TraceTurnSummary | null): string | null {
  if (span.kind !== "turn" && span.kind !== "subagent") return null;
  if (summary && summary.error_count !== null) return summary.error_count > 0 ? `ошибок: ${summary.error_count}` : null;
  return span.attrs.has_error === true ? "есть ошибки" : null;
}

/* ---------- Полнота хода ---------- */

const LOST_LABEL: Record<string, string> = {
  harness_timing: "время harness",
  ttft: "время до первого токена",
  tool_exec: "выполнение инструментов",
  sandbox_phases: "фазы песочницы",
};

export function lostText(lost: readonly string[]): string {
  return lost.map((code) => LOST_LABEL[code] ?? code).join(", ");
}

const SOURCE_LABEL: Record<TraceSource, string> = {
  events: "события платформы",
  runner: "раннер",
  otel: "OpenTelemetry (со слов агента)",
  rollout: "трасса агента (rollout)",
};

export function sourceText(sources: readonly TraceSource[]): string {
  return sources.map((source) => SOURCE_LABEL[source] ?? source).join(", ");
}

export interface TraceBadge {
  key: "partial" | "coverage" | "state";
  text: string;
  hint: string;
  tone: "warning" | "neutral";
}

/** Значки хода: «неполный», полнота данных, «не построен». */
export function turnBadges(summary: TraceTurnSummary): TraceBadge[] {
  if (summary.state === "not_built") {
    return [
      {
        key: "state",
        text: "не построен",
        tone: "neutral",
        hint: "Трейс хода ещё не собран. Он соберётся при раскрытии по событиям сессии.",
      },
    ];
  }
  const badges: TraceBadge[] = [];
  if (summary.partial) {
    badges.push({
      key: "partial",
      text: "неполный",
      tone: "warning",
      hint: summary.lost.length
        ? `Не удалось восстановить: ${lostText(summary.lost)}.`
        : "Часть данных потеряна при сбое.",
    });
  }
  const { coverage } = summary;
  if (coverage.model_calls === "absent" && coverage.tools === "absent") {
    badges.push(
      isSilentHarness(summary)
        ? {
            key: "coverage",
            text: "нет данных",
            tone: "neutral",
            hint: "Harness не сообщает вызовы модели и инструменты. Видны ход, песочница и итог.",
          }
        : {
            key: "coverage",
            text: "данные не пришли",
            tone: "warning",
            hint: "Harness должен сообщать вызовы модели и инструменты, но данных нет.",
          },
    );
  } else if (coverage.model_calls === "turn_only") {
    badges.push({
      key: "coverage",
      text: "только ход агента",
      tone: "neutral",
      hint: "Вызов модели виден целиком, как ход агента. Отдельных вызовов нет.",
    });
  }
  // Время по событиям строка показывает знаком ≈, а объяснение стоит в деталях хода.
  return badges;
}

/** Harness, который по таблице 2.5 ничего не сообщает о работе агента (уровень 0). */
function isSilentHarness(summary: TraceTurnSummary): boolean {
  return expectedModelCoverage(summary.turn.harness) === "absent";
}

/** Ход уровня 0: данных нет и не ждали. Только у него рисуется серый участок «нет данных». */
export function isLevelZeroTurn(summary: TraceTurnSummary): boolean {
  return (
    summary.state !== "not_built" &&
    summary.coverage.model_calls === "absent" &&
    summary.coverage.tools === "absent" &&
    isSilentHarness(summary)
  );
}

/**
 * Какое покрытие вызовов модели ждёт сервер от harness (M/src/lib/trace/harness-coverage.ts).
 * Сейчас работает только Pi. Ветки `ai-sdk` и ACP нужны старым ходам из истории.
 */
export function expectedModelCoverage(harness: string | null): TraceCoverage["model_calls"] {
  if (harness === null || harness === "" || harness === "default" || harness === "pi") return "measured";
  if (harness === "ai-sdk") return "by_events";
  if (harness === "acp-sandbox" || harness === "acp-proxy" || harness.endsWith("-acp")) return "turn_only";
  return "absent";
}

/** Пояснения к покрытию в деталях хода. */
export function coverageNotes(summary: TraceTurnSummary): string[] {
  const notes: string[] = [];
  if (summary.state === "not_built") return notes;
  const { model_calls: modelCalls } = summary.coverage;
  if (modelCalls === "absent") {
    notes.push(
      expectedModelCoverage(summary.turn.harness) === "absent"
        ? "Нет данных о вызовах модели: harness их не сообщает."
        : "Данные о вызовах модели не пришли.",
    );
  } else if (modelCalls === "turn_only") {
    notes.push("Вызов модели виден целиком, как ход агента: отдельных вызовов harness не сообщает.");
  }
  if (modelCalls === "by_events" || summary.coverage.tools === "by_events") {
    notes.push("Время вызовов и инструментов взято из меток событий, поэтому оно приблизительное.");
  }
  return notes;
}
