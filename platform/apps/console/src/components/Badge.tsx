import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Бейдж статуса DDC (`Badge` + `lib/tone.ts` портала): чип высотой 20px,
 * `rounded-md`, текст 12px medium. Цвет задаёт один из пяти статусных тонов
 * (neutral, info, warning, success, danger), контур рисует внутреннее
 * кольцо `ring-1 ring-inset`, а не рамка. Точку внутри тонового бейджа не
 * рисуют (раздел 4 правил DDC).
 */
export type StatusTone =
  | "idle"
  | "running"
  | "rescheduling"
  | "completed"
  | "errored"
  | "error"
  | "terminated"
  | "neutral";

const TONE_NEUTRAL = "bg-ddc-tone-neutral-bg text-ddc-tone-neutral-fg";
const TONE_INFO =
  "bg-ddc-tone-info-bg text-ddc-tone-info-fg ring-1 ring-inset ring-ddc-tone-info-ring";
const TONE_WARNING =
  "bg-ddc-tone-warning-bg text-ddc-tone-warning-fg ring-1 ring-inset ring-ddc-tone-warning-ring";
const TONE_SUCCESS =
  "bg-ddc-tone-success-bg text-ddc-tone-success-fg ring-1 ring-inset ring-ddc-tone-success-ring";
const TONE_DANGER =
  "bg-ddc-tone-danger-bg text-ddc-tone-danger-fg ring-1 ring-inset ring-ddc-tone-danger-ring";

const TONE_CLASS: Record<StatusTone, string> = {
  idle: TONE_NEUTRAL,
  running: TONE_INFO,
  rescheduling: TONE_WARNING,
  completed: TONE_SUCCESS,
  errored: TONE_DANGER,
  error: TONE_DANGER,
  terminated: TONE_DANGER,
  neutral: TONE_NEUTRAL,
};

/** Подписи статусов по-русски. Сырые значения (`running`, `idle`) в
 *  интерфейс не выводятся (раздел 5 DDC). */
const STATUS_LABEL: Record<StatusTone, string> = {
  idle: "Ожидает",
  running: "Выполняется",
  rescheduling: "Перезапуск",
  completed: "Завершено",
  errored: "Ошибка",
  error: "Ошибка",
  terminated: "Остановлено",
  neutral: "Не указано",
};

export function StatusPill({ status, label }: { status: StatusTone | string; label?: string }) {
  const known = (TONE_CLASS as Record<string, unknown>)[status] !== undefined;
  const tone: StatusTone = known ? (status as StatusTone) : "neutral";
  // Неизвестный статус показываем как есть, с заглавной буквы: перевести его
  // здесь нечем, а прятать значение нельзя.
  const text =
    label ??
    (known
      ? STATUS_LABEL[tone]
      : status
        ? status[0].toUpperCase() + status.slice(1)
        : STATUS_LABEL.neutral);
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md px-2 text-xs leading-4 font-medium whitespace-nowrap",
        TONE_CLASS[tone],
      )}
    >
      {text}
    </span>
  );
}

/**
 * Generic interactive badge — icon + label with hover affordance and
 * optional click. Used by session-header resource badges (agent / env /
 * vault) and similar contexts where a chip should feel clickable.
 *
 * Для неинтерактивных меток (длительность, возраст, счётчик) onClick не
 * передают: тогда это обычный приглушённый текст без подложки. Кликабельный
 * бейдж остаётся чипом 20px, а зона нажатия расширена до 32px.
 */
export function Badge({
  icon,
  label,
  title,
  onClick,
}: {
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      {icon && <span className="flex shrink-0 text-ddc-icon-muted">{icon}</span>}
      <span className="truncate" title={typeof label === "string" ? label : undefined}>
        {label}
      </span>
    </>
  );
  if (onClick) {
    return (
      <Button
        variant="ghost"
        onClick={onClick}
        className="relative h-5 min-h-0 max-w-xs gap-1 rounded-md px-2 py-0 text-xs leading-4 font-normal text-ddc-tone-ghost-fg ring-1 ring-ddc-tone-ghost-ring ring-inset after:absolute after:-inset-y-1.5 after:inset-x-0 after:content-[''] hover:bg-ddc-surface-muted hover:text-ddc-text"
        title={title ?? (typeof label === "string" ? label : undefined)}
      >
        {inner}
      </Button>
    );
  }
  return (
    <span
      className="flex items-center gap-1.5 px-2 py-0.5 text-xs leading-4 text-ddc-text-muted"
      title={title}
    >
      {inner}
    </span>
  );
}
