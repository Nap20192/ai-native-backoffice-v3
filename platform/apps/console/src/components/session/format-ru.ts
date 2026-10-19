/**
 * Русские форматы для страниц сессий: склонение, длительность, возраст,
 * размер файла, дата и время.
 *
 * Пустое значение рисуется одним средним тире, как в портале DDC.
 */

import { formatDate, formatDateTime } from "../../lib/date-format";

export const EMPTY_VALUE = "–";

/** plural(1, "вызов", "вызова", "вызовов") даёт «вызов»; 2 даёт «вызова»; 5 даёт «вызовов». */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function decimal(value: number, digits: number): string {
  return value.toFixed(digits).replace(".", ",");
}

/** Возраст для чипов: «12 с назад», «5 мин назад», «3 ч назад», «4 дн. назад». */
export function formatRelativeRu(diffMs: number): string {
  const abs = Math.abs(diffMs);
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return `${sec} с назад`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ч назад`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} дн. назад`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} мес. назад`;
  return `${Math.floor(mo / 12)} г. назад`;
}

/** «512 Б», «1,5 КБ», «2,3 МБ», «1,25 ГБ». */
export function formatBytesRu(n: number): string {
  if (!Number.isFinite(n) || n < 0) return EMPTY_VALUE;
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${decimal(n / 1024, 1)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${decimal(n / 1024 / 1024, 1)} МБ`;
  return `${decimal(n / 1024 / 1024 / 1024, 2)} ГБ`;
}

/** Дата в таблице: dd.MM.yyyy. */
export function formatDateRu(value: string | number | Date): string {
  return formatDate(value, EMPTY_VALUE);
}

/** Дата и время: dd.MM.yyyy HH:mm, без запятой. */
export function formatDateTimeRu(value: string | number | Date): string {
  return formatDateTime(value, EMPTY_VALUE);
}

/** Текст хода, у события session.error которого нет причины. */
export const TURN_FAILED_FALLBACK = "Ход завершился ошибкой.";

/** Причина из session.error: API отдаёт error объектом {type, message, retry_status},
 *  старые события и поток могут прислать строку. Объект в JSX не рендерится. */
export function sessionErrorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return TURN_FAILED_FALLBACK;
}

/* ---------- Форматы страницы сессии (разговор, мини-карта, шапка) ---------- */

/** Число с одной десятой через запятую, «1,0» без десятой: «57,7», «30». */
function oneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : decimal(rounded, 1);
}

/**
 * Короткая длительность для строки вызова, подсказок и шапки:
 * «<1 мс», «119 мс», «1,1 с», «57,7 с», «3 мин 5 с», «14 ч 2 мин».
 * Нулевая младшая единица опускается («3 мин», «2 ч»). Пустое значение
 * даёт прочерк.
 */
export function formatShortDurationRu(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return EMPTY_VALUE;
  if (ms < 1) return "<1 мс";
  if (Math.round(ms) < 1000) return `${Math.round(ms)} мс`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 59.95) return `${oneDecimal(ms / 1000)} с`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const rest = totalSeconds % 60;
    return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
  }
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} ч` : `${hours} ч ${minutes} мин`;
}

/** Токены: «275», «6,5 тыс.», «411,1 тыс.», «1,2 млн», «2,5 млрд». */
export function formatTokensRu(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  const units: Array<[number, string]> = [
    [1_000, "тыс."],
    [1_000_000, "млн"],
    [1_000_000_000, "млрд"],
  ];
  let index = abs >= 1_000_000_000 ? 2 : abs >= 1_000_000 ? 1 : 0;
  let value = Math.round((abs / units[index]![0]) * 10) / 10;
  // 999 999 после округления даёт «1000 тыс.»: берём следующую единицу.
  if (value >= 1000 && index < units.length - 1) {
    index += 1;
    value = Math.round((abs / units[index]![0]) * 10) / 10;
  }
  return `${sign}${oneDecimal(value)} ${units[index]![1]}`;
}

/** Доля как процент: 0,35 даёт «35 %». Малая ненулевая доля даёт «<1 %». */
export function formatPercentRu(ratio: number): string {
  if (!Number.isFinite(ratio)) return EMPTY_VALUE;
  if (ratio > 0 && ratio < 0.005) return "<1 %";
  return `${Math.round(ratio * 100)} %`;
}

const MONTHS_SHORT_RU = [
  "янв.", "февр.", "мар.", "апр.", "мая", "июн.",
  "июл.", "авг.", "сент.", "окт.", "нояб.", "дек.",
] as const;
const WEEKDAYS_SHORT_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

interface ClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** Части даты в нужном поясе. Названия месяцев и дней собираем сами:
 *  сокращения Intl зависят от версии ICU, а подписи должны быть одинаковыми. */
function clockParts(ms: number, timeZone?: string): ClockParts | null {
  if (!Number.isFinite(ms)) return null;
  const key = timeZone ?? "";
  let formatter = partsFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(key, formatter);
  }
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  const { year, month, day, hour, minute, second } = values;
  if ([year, month, day, hour, minute, second].some((value) => value === undefined || Number.isNaN(value))) {
    return null;
  }
  return {
    year: year!,
    month: month!,
    day: day!,
    hour: hour! % 24,
    minute: minute!,
    second: second!,
  };
}

const pad2 = (value: number) => String(value).padStart(2, "0");

function clockText(parts: ClockParts, withSeconds: boolean): string {
  const base = `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  return withSeconds ? `${base}:${pad2(parts.second)}` : base;
}

function dateText(parts: ClockParts): string {
  return `${parts.day} ${MONTHS_SHORT_RU[parts.month - 1]}`;
}

function weekdayText(parts: ClockParts): string {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return WEEKDAYS_SHORT_RU[day]!;
}

/** Время события: «11:40:01». */
export function formatClockRu(ms: number, timeZone?: string): string {
  const parts = clockParts(ms, timeZone);
  return parts ? clockText(parts, true) : EMPTY_VALUE;
}

/** Дата и время с днём недели: «чт, 15 окт., 11:39:27». */
export function formatEventDateTimeRu(ms: number, timeZone?: string): string {
  const parts = clockParts(ms, timeZone);
  return parts
    ? `${weekdayText(parts)}, ${dateText(parts)}, ${clockText(parts, true)}`
    : EMPTY_VALUE;
}

/** Подпись курсора мини-карты: «15 окт., 11:41:08». */
export function formatMinimapTimeRu(ms: number, timeZone?: string): string {
  const parts = clockParts(ms, timeZone);
  return parts ? `${dateText(parts)}, ${clockText(parts, true)}` : EMPTY_VALUE;
}

/** Разрыв времени между ходами: «пт, 16 окт., 01:42 (13 ч 56 мин)». */
export function formatGapRu(atMs: number, gapMs: number, timeZone?: string): string {
  const parts = clockParts(atMs, timeZone);
  if (!parts) return EMPTY_VALUE;
  return `${weekdayText(parts)}, ${dateText(parts)}, ${clockText(parts, false)} (${formatShortDurationRu(gapMs)})`;
}
