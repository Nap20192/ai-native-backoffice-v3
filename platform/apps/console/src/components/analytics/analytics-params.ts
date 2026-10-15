/**
 * Состояние фильтров аналитики и его запись в адрес страницы.
 *
 * Адрес хранит всё, что меняет данные: период, списки фильтров, группировку,
 * поля журнала, открытую запись и квоту. Значения по умолчанию в адрес не
 * пишутся, поэтому чистый адрес всегда означает «30 дней, группа по модели».
 * Все сутки считаются по UTC, как на сервере.
 */

export type RangePreset = "mtd" | "7d" | "30d" | "last_month";

export type RangeState =
  | { kind: "preset"; preset: RangePreset }
  | { kind: "custom"; from: string; to: string };

export interface DateRange {
  from: string;
  to: string;
}

/** Ключи группировки. `token_type` есть только в консоли, сервер получает `none`. */
export const GROUP_BY_VALUES = [
  "model",
  "token_type",
  "agent",
  "harness",
  "card",
  "environment",
  "speed",
] as const;
export type GroupBy = (typeof GROUP_BY_VALUES)[number];

export const STATUS_VALUES = ["ok", "error"] as const;
export type StatusFilter = "" | (typeof STATUS_VALUES)[number];

export const RANGE_PRESETS: readonly RangePreset[] = ["mtd", "7d", "30d", "last_month"];

const DEFAULT_PRESET: RangePreset = "30d";
export const DEFAULT_RANGE: RangeState = { kind: "preset", preset: DEFAULT_PRESET };
export const DEFAULT_GROUP_BY: GroupBy = "model";

/** Самый длинный период, который принимает сервер, в сутках. */
export const MAX_RANGE_DAYS = 92;

const DAY_MS = 86_400_000;

export interface AnalyticsState {
  range: RangeState;
  agent_id: string[];
  model: string[];
  harness: string[];
  card_id: string[];
  group_by: GroupBy;
  status: StatusFilter;
  session_id: string;
  q: string;
  request: string;
  focus: string;
}

export interface ApiFilters {
  agent_id: string[];
  model: string[];
  harness: string[];
  card_id: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toDay(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Миллисекунды начала суток UTC или `null`, если строка не дата. */
function dayStart(day: string): number | null {
  if (!DATE_RE.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  // Date.parse принимает 2026-02-31 и сдвигает на март: сравниваем обратно.
  return toDay(new Date(ms)) === day ? ms : null;
}

export function isValidDay(day: string): boolean {
  return dayStart(day) !== null;
}

/** Сегодняшние сутки по UTC, `YYYY-MM-DD`. */
export function utcToday(now: Date = new Date()): string {
  return toDay(now);
}

export function addDays(day: string, delta: number): string {
  const start = dayStart(day);
  if (start === null) return day;
  return toDay(new Date(start + delta * DAY_MS));
}

/** Сколько суток в периоде, включая обе границы. */
export function daysInRange(from: string, to: string): number {
  const a = dayStart(from);
  const b = dayStart(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

/** Проверка своего периода так же, как на сервере. `null` значит «верно». */
export function validateCustomRange(from: string, to: string): string | null {
  if (dayStart(from) === null || dayStart(to) === null) return "Укажите обе даты периода.";
  if (from > to) return "Начало периода позже конца.";
  if (daysInRange(from, to) > MAX_RANGE_DAYS) return `Период не больше ${MAX_RANGE_DAYS} дней.`;
  return null;
}

/** Границы периода по UTC от сегодняшнего дня. */
export function resolveRange(range: RangeState, now: Date = new Date()): DateRange {
  if (range.kind === "custom") return { from: range.from, to: range.to };
  const today = utcToday(now);
  switch (range.preset) {
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "mtd":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "last_month": {
      const firstOfThisMonth = `${today.slice(0, 8)}01`;
      const lastDay = addDays(firstOfThisMonth, -1);
      return { from: `${lastDay.slice(0, 8)}01`, to: lastDay };
    }
  }
}

/** Одни сутки рисуются по часам, всё остальное по дням. */
export function bucketFor(from: string, to: string): "day" | "hour" {
  return from === to ? "hour" : "day";
}

/** Приближение графика до одного дня: свой период из одних суток. */
export function zoomToDay(day: string): RangeState {
  return { kind: "custom", from: day, to: day };
}

export function defaultState(): AnalyticsState {
  return {
    range: DEFAULT_RANGE,
    agent_id: [],
    model: [],
    harness: [],
    card_id: [],
    group_by: DEFAULT_GROUP_BY,
    status: "",
    session_id: "",
    q: "",
    request: "",
    focus: "",
  };
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

function parseRange(sp: URLSearchParams): RangeState {
  const preset = sp.get("range");
  if (preset && (RANGE_PRESETS as readonly string[]).includes(preset)) {
    return { kind: "preset", preset: preset as RangePreset };
  }
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  if (from && to && validateCustomRange(from, to) === null) {
    return { kind: "custom", from, to };
  }
  return DEFAULT_RANGE;
}

export function parseAnalyticsParams(sp: URLSearchParams): AnalyticsState {
  const groupBy = sp.get("group_by") ?? "";
  const status = sp.get("status") ?? "";
  return {
    range: parseRange(sp),
    agent_id: parseList(sp.get("agent_id")),
    model: parseList(sp.get("model")),
    harness: parseList(sp.get("harness")),
    card_id: parseList(sp.get("card_id")),
    group_by: (GROUP_BY_VALUES as readonly string[]).includes(groupBy)
      ? (groupBy as GroupBy)
      : DEFAULT_GROUP_BY,
    status: (STATUS_VALUES as readonly string[]).includes(status) ? (status as StatusFilter) : "",
    session_id: sp.get("session_id") ?? "",
    q: sp.get("q") ?? "",
    request: sp.get("request") ?? "",
    focus: sp.get("focus") ?? "",
  };
}

function isDefaultRange(range: RangeState): boolean {
  return range.kind === "preset" && range.preset === DEFAULT_PRESET;
}

/** Адрес из состояния: только то, что отличается от значений по умолчанию. */
export function serializeAnalyticsParams(state: AnalyticsState): URLSearchParams {
  const sp = new URLSearchParams();
  if (!isDefaultRange(state.range)) {
    if (state.range.kind === "preset") {
      sp.set("range", state.range.preset);
    } else {
      sp.set("from", state.range.from);
      sp.set("to", state.range.to);
    }
  }
  for (const key of ["agent_id", "model", "harness", "card_id"] as const) {
    if (state[key].length > 0) sp.set(key, state[key].join(","));
  }
  if (state.group_by !== DEFAULT_GROUP_BY) sp.set("group_by", state.group_by);
  if (state.status) sp.set("status", state.status);
  if (state.session_id) sp.set("session_id", state.session_id);
  if (state.q) sp.set("q", state.q);
  if (state.request) sp.set("request", state.request);
  if (state.focus) sp.set("focus", state.focus);
  return sp;
}

/** Поля состояния, которые не считаются фильтрами и не включают «Сбросить». */
const NOT_FILTERS: ReadonlyArray<keyof AnalyticsState> = ["request", "focus"];

/**
 * Отличается ли хоть один фильтр от значения по умолчанию. `ignore` убирает
 * поля, которых нет на странице (например, период на «Кэшировании»).
 */
export function hasActiveFilters(
  state: AnalyticsState,
  ignore: ReadonlyArray<keyof AnalyticsState> = [],
): boolean {
  const skip = new Set<keyof AnalyticsState>([...NOT_FILTERS, ...ignore]);
  const base = defaultState();
  for (const key of Object.keys(base) as Array<keyof AnalyticsState>) {
    if (skip.has(key)) continue;
    if (key === "range") {
      if (!isDefaultRange(state.range)) return true;
      continue;
    }
    const value = state[key];
    if (Array.isArray(value)) {
      if (value.length > 0) return true;
    } else if (value !== base[key]) {
      return true;
    }
  }
  return false;
}

/** Состояние после «Сбросить»: фильтры по умолчанию, открытая запись остаётся. */
export function resetFilters(state: AnalyticsState): AnalyticsState {
  return { ...defaultState(), request: state.request, focus: state.focus };
}

/** Списки фильтров для клиента API. */
export function toApiFilters(state: AnalyticsState): ApiFilters {
  return {
    agent_id: state.agent_id,
    model: state.model,
    harness: state.harness,
    card_id: state.card_id,
  };
}
