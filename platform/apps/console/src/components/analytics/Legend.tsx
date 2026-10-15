import { cn } from "@/lib/utils";

import type { SeriesColor } from "./series-colors";

export interface LegendItem {
  key: string;
  label: string;
  color: SeriesColor;
}

/**
 * Легенда под графиком: квадрат 8 px и подпись. Для линейных графиков вместо
 * квадрата короткий отрезок цвета линии.
 */
export function Legend({
  items,
  variant = "square",
  className,
}: {
  items: LegendItem[];
  variant?: "square" | "line";
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Легенда" className={cn("mt-4 flex flex-wrap gap-x-4 gap-y-1.5", className)}>
      {items.map((item) => (
        <li key={item.key} className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ddc-label">
          <span
            aria-hidden="true"
            className={cn(
              "shrink-0",
              variant === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-sm",
              item.color.bg,
            )}
          />
          <span className="truncate" title={item.label}>
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
