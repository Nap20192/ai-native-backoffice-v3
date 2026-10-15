/**
 * Единственная реализация дат консоли (правило 14 DDC): дата `dd.MM.yyyy`,
 * дата со временем `dd.MM.yyyy HH:mm` без запятой, по местному часовому
 * поясу. Модули разделов (`pages/agents/format`, `pages/ru-format`,
 * `components/knowledge-format`, `components/session/format-ru`) берут формат
 * отсюда и отличаются только знаком для пустого значения.
 */
const pad = (value: number): string => String(value).padStart(2, "0");

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `15.10.2026`. Пустое или неразборчивое значение даёт `empty`. */
export function formatDate(
  value: string | number | Date | null | undefined,
  empty = "–",
): string {
  const date = toDate(value);
  if (!date) return empty;
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** `15.10.2026 14:05`. Пустое или неразборчивое значение даёт `empty`. */
export function formatDateTime(
  value: string | number | Date | null | undefined,
  empty = "–",
): string {
  const date = toDate(value);
  if (!date) return empty;
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
