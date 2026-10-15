/**
 * Русские форматы для страниц сессий: склонение, длительность, возраст,
 * размер файла, дата и время. Общий lib/format.ts отдаёт английские
 * подписи («12s ago», «1.23s»), а им пользуются и другие разделы, поэтому
 * здесь лежат свои версии для сессий.
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

/** «<1 мс», «123 мс», «1,23 с», «2 мин 17 с». */
export function formatDurationRu(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return EMPTY_VALUE;
  if (ms < 1) return "<1 мс";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  if (ms < 60_000) return `${decimal(ms / 1000, 2)} с`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} мин ${total % 60} с`;
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
