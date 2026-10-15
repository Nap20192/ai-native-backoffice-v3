/**
 * Форматы дат, времени и длительности для страниц консоли (раздел 14 правил
 * DDC): дата `dd.MM.yyyy`, время `HH:mm`, прочерк для пустого значения.
 * Всё считается по местному времени и не зависит от языка интерфейса, чтобы
 * вид не менялся между устройствами.
 */

/** Пустое значение. Среднее тире, как в таблицах портала. */
export const EMPTY = "–";

export { formatDate, formatDateTime } from "../lib/date-format";

function toDate(value?: string | number | Date | null): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Длительность между двумя отметками: `5 с`, `2 мин 10 с`, `1 ч 5 мин`.
 *  Без конца считается до текущего момента. */
export function formatSpan(start?: string, end?: string): string {
  const from = toDate(start);
  if (!from) return EMPTY;
  const to = toDate(end) ?? new Date();
  const sec = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (sec < 60) return `${sec} с`;
  if (sec < 3600) return `${Math.floor(sec / 60)} мин ${sec % 60} с`;
  return `${Math.floor(sec / 3600)} ч ${Math.floor((sec % 3600) / 60)} мин`;
}

/** Давность: `5 с назад`, `12 мин назад`, `3 ч назад`, `2 дн назад`. */
export function formatAgo(value?: string): string {
  const date = toDate(value);
  if (!date) return EMPTY;
  const ms = Math.max(0, Date.now() - date.getTime());
  if (ms < 60_000) return `${Math.round(ms / 1000)} с назад`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} мин назад`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} ч назад`;
  return `${Math.round(ms / 86_400_000)} дн назад`;
}
