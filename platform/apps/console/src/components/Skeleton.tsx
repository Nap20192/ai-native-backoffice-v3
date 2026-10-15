import type { CSSProperties, JSX } from "react";

import { Skeleton as ShadcnSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface SkeletonProps {
  className?: string;
  rounded?: "sm" | "md" | "lg" | "full";
  style?: CSSProperties;
}

const radiusCls: Record<NonNullable<SkeletonProps["rounded"]>, string> = {
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
};

/**
 * Статичный блок-заглушка для данных в пути. Оборачивает shadcn `Skeleton`,
 * которому DDC даёт подложку ink-100 (в тёмной теме ink-800) и блик
 * `animate-shimmer`. Скелетон повторяет разметку: строка `h-4` под
 * text-sm, `h-3` под text-xs, заголовок `h-5 w-40`, аватар `rounded-full`,
 * бейдж `h-5 rounded-md`. По умолчанию скругление `rounded-lg`.
 *
 * Размер задаёт вызывающий код через className. Пример:
 *   <Skeleton className="h-4 w-32" />
 *   <Skeleton className="h-8 w-8" rounded="full" />
 */
export function Skeleton({ className = "", rounded = "lg", style }: SkeletonProps): JSX.Element {
  return (
    <ShadcnSkeleton
      aria-hidden="true"
      style={style}
      className={cn(radiusCls[rounded], className)}
    />
  );
}

interface SkeletonRowsProps {
  count: number;
  height?: number;
  gap?: number;
}

/**
 * Convenience for "loading a tabular list" — N evenly-spaced full-width
 * rows. Высота строки по умолчанию 40px, как у строки таблицы DDC, чтобы
 * список не прыгал, когда придут данные. Обёртке стоит `aria-busy`, а
 * диктор читает скрытое «Загрузка…».
 */
export function SkeletonRows({ count, height = 40, gap = 8 }: SkeletonRowsProps): JSX.Element {
  return (
    <div className="px-4 py-3" style={{ display: "grid", gap: `${gap}px` }} aria-busy="true">
      <span className="sr-only">Загрузка…</span>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="w-full" rounded="lg" style={{ height: `${height}px` }} />
      ))}
    </div>
  );
}
