import { cn } from "@/lib/utils";

/**
 * Индикатор загрузки квоты: `role="meter"` от 0 до 100. Цвет заливки по
 * порогам: до 80 % brand-600, от 80 % amber-500, от 100 % rose-500. Дорожка
 * ink-100. Проценты за 100 в значении не растут, превышение видно по цвету и
 * по числу рядом с индикатором.
 */
export type MeterLevel = "ok" | "warning" | "full";

export function meterLevel(ratio: number): MeterLevel {
  if (ratio >= 1) return "full";
  if (ratio >= 0.8) return "warning";
  return "ok";
}

const FILL: Record<MeterLevel, string> = {
  ok: "bg-brand-600 dark:bg-brand-500",
  warning: "bg-amber-500 dark:bg-amber-400",
  full: "bg-rose-500 dark:bg-rose-400",
};

export function UsageMeter({
  ratio,
  label,
  className,
}: {
  /** Доля лимита от 0 до 1 и больше. */
  ratio: number;
  /** Подпись для скринридера: «<модель> <квота>, пиковая загрузка». */
  label: string;
  className?: string;
}) {
  const safe = Number.isFinite(ratio) && ratio > 0 ? ratio : 0;
  const percent = Math.min(100, Math.round(safe * 100));
  const level = meterLevel(safe);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-level={level}
      className={cn(
        "h-2 w-full overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800",
        className,
      )}
    >
      <div
        className={cn("h-full rounded-full", FILL[level], safe > 0 && "min-w-1")}
        style={{ width: `${Math.min(100, safe * 100)}%` }}
      />
    </div>
  );
}
