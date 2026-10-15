import { StatusPill, type StatusTone } from "../components/Badge";

/** Статус запуска, задачи или попытки оценки на стороне сервера. */
export type EvalStatus = "pending" | "running" | "completed" | "failed";

/** Тон и подпись статуса. Сырые значения (`pending`, `failed`) в интерфейс
 *  не выводятся (раздел 5 правил DDC). */
const EVAL_STATUS: Record<EvalStatus, { tone: StatusTone; label: string }> = {
  pending: { tone: "neutral", label: "В очереди" },
  running: { tone: "running", label: "Выполняется" },
  completed: { tone: "completed", label: "Завершено" },
  failed: { tone: "error", label: "Ошибка" },
};

/** Подпись статуса. Неизвестное значение показывается как есть. */
export function evalStatusLabel(status: string): string {
  return EVAL_STATUS[status as EvalStatus]?.label ?? status;
}

/** Бейдж статуса оценки высотой 20px из общего `StatusPill`. */
export function EvalStatusPill({ status }: { status: string }) {
  const known = EVAL_STATUS[status as EvalStatus];
  return <StatusPill status={known?.tone ?? "neutral"} label={known?.label ?? status} />;
}

/** Сводка статусов попыток: «Завершено: 3, Ошибка: 1». Порядок по первому
 *  появлению статуса. */
export function summarizeStatuses(statuses: string[]): string {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return Array.from(counts, ([status, n]) => `${evalStatusLabel(status)}: ${n}`).join(", ");
}
