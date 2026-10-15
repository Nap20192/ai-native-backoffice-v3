import type { Event } from "../../lib/events";

/**
 * Layout constants — kept here as the single source of truth so that
 * Tailwind utility classes (`w-56`, `w-20`) and pixel arithmetic
 * (`224 + chartPx + 80`) stay in sync. Change here, change both.
 */
export const LABEL_COL_W = 224; // === w-56
export const DURATION_COL_W = 80; // === w-20
export const SIDE_PANEL_W = 420;
/** Hard cap on waterfall chart width. Auto density based on median event
 *  gaps can otherwise produce hundreds of thousands of CSS pixels for a
 *  multi-minute turn (or a schedule wait), which freezes the main thread
 *  when switching to Timeline on long sessions. */
export const MAX_CHART_PX = 4_000;
/** Keep time-axis tick DOM nodes bounded regardless of turn duration. */
export const MAX_TICKS = 48;

/**
 * One row in the timeline waterfall. A span can be an instant marker
 * (durationMs === 0) or a paired range (start + end events). Rendering
 * consumes only this shape; deriveSpans converts raw event streams to
 * Span[].
 */
export interface Span {
  key: string;
  family: SpanFamily;
  label: string;
  detail?: string;
  /** ms since the first event */
  startMs: number;
  /** 0 for instants */
  durationMs: number;
  /** Optional: ms from this span's start to first-token (model spans only).
   *  Used to render a TTFT divider inside the bar. */
  ttftMs?: number;
  /** Source events that contributed to this span (1 for instants,
   *  2 for paired spans, possibly more for tool calls with streaming
   *  input chunks). Click-to-expand renders the raw JSON of these. */
  events: Event[];
}

export type SpanFamily =
  | "model"
  | "tool"
  | "mcp"
  | "custom_tool"
  | "user"
  | "agent"
  | "system"
  | "warn"
  | "error"
  | "schedule"     // schedule tool's "waiting for alarm" window (10s, 1h, …)
  | "wakeup"       // user.message synthesized by onScheduledWakeup
  | "compaction"   // span.compaction_summarize_*
  | "outcome"      // span.outcome_evaluation_*
  | "thread"       // sub-agent thread lifecycle / messages
  | "aux"          // aux.model_call (web_fetch summarizer etc.)
  | "thinking"     // agent.thinking marker
  | "marker";      // catch-all for unrecognized event types

/**
 * Цвета семейств берутся из токенов DDC: точки статусов `ddc-dot-*`
 * (info, success, warning, danger, neutral) и шкала brand для того, что
 * означает «своё» (пользователь, MCP, сжатие). Фиолетовой краски в DDC нет.
 */
export const FAMILY_DOT: Record<SpanFamily, string> = {
  model: "bg-ddc-dot-info",
  tool: "bg-ddc-dot-success",
  mcp: "bg-brand-500",
  custom_tool: "bg-ddc-dot-warning",
  user: "bg-brand-600",
  agent: "bg-ddc-text-muted",
  system: "bg-ddc-dot-neutral",
  warn: "bg-ddc-dot-warning",
  error: "bg-ddc-dot-danger",
  schedule: "bg-ddc-dot-info",
  wakeup: "bg-ddc-dot-info",
  compaction: "bg-brand-400",
  outcome: "bg-ddc-dot-success",
  thread: "bg-ddc-text-muted",
  aux: "bg-ddc-dot-neutral",
  thinking: "bg-ddc-dot-neutral",
  marker: "bg-ddc-dot-neutral",
};

export const FAMILY_BAR: Record<SpanFamily, string> = {
  model: "bg-ddc-dot-info/70",
  tool: "bg-ddc-dot-success/70",
  mcp: "bg-brand-500/70",
  custom_tool: "bg-ddc-dot-warning/70",
  user: "bg-brand-600/70",
  agent: "bg-ddc-text-muted/70",
  system: "bg-ddc-dot-neutral/70",
  warn: "bg-ddc-dot-warning/70",
  error: "bg-ddc-dot-danger/70",
  schedule: "bg-ddc-dot-info/40",
  wakeup: "bg-ddc-dot-info/70",
  compaction: "bg-brand-400/60",
  outcome: "bg-ddc-dot-success/50",
  thread: "bg-ddc-text-muted/50",
  aux: "bg-ddc-dot-neutral/70",
  thinking: "bg-ddc-dot-neutral/50",
  marker: "bg-ddc-dot-neutral/50",
};

/**
 * A "turn" is the unit of agent work between a user trigger event
 * (user.message / user.tool_confirmation / user.custom_tool_result) and
 * the next session.status_idle / .status_terminated / .error. This is the
 * same definition the harness uses internally (see drainEventQueue in
 * apps/agent/src/runtime/session-do.ts) and matches Conversation view's
 * notion of a turn — so a Timeline burst card lines up 1:1 with a chat
 * exchange.
 */
export type TurnTriggerKind =
  | "user_message"
  | "wakeup"
  | "tool_confirmation"
  | "custom_tool_result"
  | "init";

export type TurnStatus = "completed" | "running" | "errored" | "terminated";

export interface Turn {
  id: string;
  triggerKind: TurnTriggerKind;
  trigger?: Event;
  /** Wall-clock ms epoch of the trigger (or first event for init turn). */
  triggerTs: number;
  /** Inclusive: trigger event + everything until the closing status event. */
  events: Event[];
  status: TurnStatus;
  /** Wall-clock ms epoch when the turn closed; undefined while still running. */
  endedAt?: number;
}

export const TRIGGER_LABEL: Record<TurnTriggerKind, string> = {
  user_message: "Сообщение пользователя",
  wakeup: "Пробуждение по расписанию",
  tool_confirmation: "Подтверждение инструмента",
  custom_tool_result: "Результат пользовательского инструмента",
  init: "Запуск сессии",
};

export const TRIGGER_DOT: Record<TurnTriggerKind, string> = {
  user_message: "bg-brand-600",
  wakeup: "bg-ddc-dot-info",
  tool_confirmation: "bg-ddc-dot-warning",
  custom_tool_result: "bg-ddc-dot-warning",
  init: "bg-ddc-dot-neutral",
};

export const STATUS_TEXT: Record<TurnStatus, string> = {
  completed: "text-ddc-text-muted",
  running: "text-ddc-tone-info-fg",
  errored: "text-ddc-danger-text",
  terminated: "text-ddc-danger-text",
};

/** Статус хода по-русски: сырые значения (`errored`) в интерфейс не выводятся. */
export const STATUS_LABEL: Record<TurnStatus, string> = {
  completed: "Завершён",
  running: "Выполняется",
  errored: "Ошибка",
  terminated: "Остановлен",
};

/**
 * What's currently selected for the side detail panel. Lifted up to
 * TimelineView so a click in any TurnCard updates one shared panel.
 */
export interface TimelineSelection {
  spanKey: string;
  spanLabel: string;
  events: Event[];
}
