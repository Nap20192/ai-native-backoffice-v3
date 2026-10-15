/**
 * Форматы для разделов «Навыки» и «Память» (правило 14 DDC): дата
 * `дд.мм.гггг`, время `чч:мм` без запятой (одна реализация в
 * lib/date-format.ts), размеры и склонение числительных по-русски.
 */

import { formatDateTime } from "../lib/date-format";

export { formatDate, formatDateTime } from "../lib/date-format";

/**
 * Версия навыка для людей. API отдаёт метку времени создания версии в
 * микросекундах (`1792068333531000`): число длиной в 16 цифр ничего не
 * говорит и ломает ширину столбца. Метку показываем датой и временем
 * `dd.MM.yyyy HH:mm`, короткий номер как `v3`, нечисловое значение как есть.
 */
export function formatSkillVersion(version: string | null | undefined): string {
  if (!version) return "–";
  const value = Number(version);
  if (!Number.isFinite(value)) return version;
  if (value >= 1e14) return formatDateTime(value / 1000);
  if (value >= 1e11) return formatDateTime(value);
  return `v${version}`;
}

/** «512 Б», «1,5 КБ», «2,0 МБ». */
export function formatBytes(bytes: number): string {
  const fixed = (n: number) => n.toFixed(1).replace(".", ",");
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${fixed(bytes / 1024)} КБ`;
  return `${fixed(bytes / (1024 * 1024))} МБ`;
}

/** Русское склонение: plural(1, "навык", "навыка", "навыков") -> «навык». */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}
