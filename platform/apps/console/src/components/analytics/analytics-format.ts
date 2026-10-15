/**
 * Форматы чисел, денег и времени для страниц аналитики.
 *
 * Все даты и время по UTC, числа по правилам ru-RU. Названия месяцев и время
 * собираются вручную, а не через Intl: Intl добавляет к году « г.» и меняет
 * сокращения между версиями ICU, а подписи графиков должны быть одинаковыми у
 * всех. Неразрывный пробел держит число и единицу в одной строке.
 */

const NBSP = " ";

const MONTHS_SHORT = [
  "янв.",
  "февр.",
  "мар.",
  "апр.",
  "мая",
  "июн.",
  "июл.",
  "авг.",
  "сент.",
  "окт.",
  "нояб.",
  "дек.",
] as const;

const integerFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

function fixedFormat(min: number, max: number = min): Intl.NumberFormat {
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: min, maximumFractionDigits: max });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function parseDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Слово в нужной форме по числу: 1 запрос, 2 запроса, 5 запросов. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(Math.trunc(n));
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

// ── Деньги ───────────────────────────────────────────────────────────────

/**
 * Деньги из миллионных долей доллара. До доллара четыре знака, от доллара два.
 * Без цены пишет «нет цены», сумма меньше четвёртого знака даёт «<$0,0001».
 */
export function formatUsd(micros: number | null | undefined): string {
  if (micros === null || micros === undefined || Number.isNaN(micros)) return "нет цены";
  if (micros === 0) return "$0";
  const usd = micros / 1_000_000;
  const fourDigits = Math.round(usd * 10_000);
  if (fourDigits === 0) return "<$0,0001";
  const digits = fourDigits >= 10_000 ? 2 : 4;
  return `$${fixedFormat(digits).format(usd)}`;
}

/** Подпись деления оси в долларах: без лишних нулей после запятой. */
export function formatUsdAxis(micros: number): string {
  if (micros === 0) return "$0";
  const usd = micros / 1_000_000;
  return `$${fixedFormat(0, usd >= 1 ? 2 : 4).format(usd)}`;
}

// ── Числа ────────────────────────────────────────────────────────────────

/** Число с разделителем тысяч: 1 611 100. */
export function formatTokens(n: number): string {
  return integerFormat.format(Math.round(n));
}

/** Компактная запись для осей и таблиц: 999, 1,2 тыс., 1,6 млн, 2,5 млрд. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${integerFormat.format(Math.round(abs))}`;
  const units: Array<[number, string]> = [
    [1_000, "тыс."],
    [1_000_000, "млн"],
    [1_000_000_000, "млрд"],
  ];
  let index = abs >= 1_000_000_000 ? 2 : abs >= 1_000_000 ? 1 : 0;
  let value = Math.round((abs / units[index][0]) * 10) / 10;
  // 999 999 после округления даёт 1000 тыс.: переходим к следующей единице.
  if (value >= 1000 && index < units.length - 1) {
    index += 1;
    value = Math.round((abs / units[index][0]) * 10) / 10;
  }
  return `${sign}${fixedFormat(0, 1).format(value)}${NBSP}${units[index][1]}`;
}

/** Доля 0..1 как процент: 86,9 %. Меньше половины процента это «<1 %». */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return "нет";
  if (ratio > 0 && ratio < 0.005) return `<1${NBSP}%`;
  return new Intl.NumberFormat("ru-RU", {
    style: "percent",
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(ratio);
}

/** Окупаемость записи кэша: 6,9×. */
export function formatAmortization(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "нет";
  return `${fixedFormat(0, 1).format(value)}×`;
}

/** Задержка в секундах: две цифры в таблице, три в карточке записи. */
export function formatLatency(ms: number | null | undefined, digits = 2): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "нет";
  return `${fixedFormat(digits).format(ms / 1000)}${NBSP}с`;
}

// ── Даты и время по UTC ──────────────────────────────────────────────────

function dayParts(value: string | number | Date): { d: number; m: string; y: number } | null {
  const date = parseDate(value);
  if (!date) return null;
  return { d: date.getUTCDate(), m: MONTHS_SHORT[date.getUTCMonth()], y: date.getUTCFullYear() };
}

/** День на оси: «16 окт.». */
export function formatAxisDay(value: string | number | Date): string {
  const p = dayParts(value);
  return p ? `${p.d} ${p.m}` : "";
}

/** День в подсказке и таблице: «16 окт. 2026 (UTC)». */
export function formatDayUtc(value: string | number | Date): string {
  const p = dayParts(value);
  return p ? `${p.d} ${p.m} ${p.y} (UTC)` : "";
}

/** Час в подсказке и таблице: «16 окт., 09:00 UTC». */
export function formatHourUtc(value: string | number | Date): string {
  const date = parseDate(value);
  const p = dayParts(value);
  if (!date || !p) return "";
  return `${p.d} ${p.m}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/** Час на оси суточного графика: «09:00». */
export function formatAxisHour(value: string | number | Date): string {
  const date = parseDate(value);
  return date ? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}` : "";
}

/** Подсказка к подписи «Данные на …»: что за время и как быстро появляются новые вызовы. */
export const AS_OF_HINT =
  "Время завершения последнего вызова модели, UTC. Новые вызовы появляются в отчётах сразу после завершения.";

/** Подпись «Данные на …»: «16 окт., 09:12 UTC». Пусто, если данных нет. */
export function formatDataAsOf(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  return formatHourUtc(value);
}

/** Время на момент: «09:15 UTC». */
export function formatTimeUtc(value: string | number | Date): string {
  const date = parseDate(value);
  return date ? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC` : "";
}

function dayLabelFromKey(day: string): string {
  const date = parseDate(`${day}T00:00:00.000Z`);
  const p = date ? dayParts(date) : null;
  return p ? `${p.d} ${p.m} ${p.y}` : day;
}

/** Период словами: «с 17 сент. 2026 по 16 окт. 2026» или один день. */
export function formatDateRange(from: string, to: string): string {
  if (from === to) return dayLabelFromKey(from);
  return `с ${dayLabelFromKey(from)} по ${dayLabelFromKey(to)}`;
}

/** Относительное время журнала: «20 минут назад». Точное время идёт в `title`. */
export function formatRelative(value: string | number | Date, now: Date = new Date()): string {
  const date = parseDate(value);
  if (!date) return "";
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (seconds < 60) return "только что";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} ${pluralRu(minutes, "минуту", "минуты", "минут")} назад`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${pluralRu(hours, "час", "часа", "часов")} назад`;
  }
  const days = Math.floor(hours / 24);
  return `${days} ${pluralRu(days, "день", "дня", "дней")} назад`;
}

/** Точное время для `title`: «16 окт. 2026, 09:12:03 UTC». */
export function formatExactUtc(value: string | number | Date): string {
  const date = parseDate(value);
  const p = dayParts(value);
  if (!date || !p) return "";
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  return `${p.d} ${p.m} ${p.y}, ${time} UTC`;
}
