import { cn } from "@/lib/utils";

import { formatPercent, formatTokens } from "./analytics-format";
import type { SeriesColor } from "./series-colors";

export interface CompositionSegment {
  key: string;
  label: string;
  value: number;
  color: SeriesColor;
}

/**
 * Полоса состава входа: 8 px, скруглённая, из сегментов «Чтение кэша»,
 * «Запись кэша» и «Вход без кэша». У сегмента подсказка «название, объём,
 * доля». Сегмент с нулём не рисуется.
 */
export function CompositionBar({
  segments,
  className,
}: {
  segments: CompositionSegment[];
  className?: string;
}) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const visible = total > 0 ? segments.filter((s) => s.value > 0) : [];
  const description =
    total > 0
      ? `Состав входа: ${visible
          .map((s) => `${s.label} ${formatPercent(s.value / total)}`)
          .join(", ")}`
      : "Состав входа: нет данных";

  return (
    <div
      role="img"
      aria-label={description}
      className={cn(
        "flex h-2 w-full min-w-24 overflow-hidden rounded-full bg-ddc-surface-sunken",
        className,
      )}
    >
      {visible.map((segment) => {
        const share = segment.value / total;
        return (
          <span
            key={segment.key}
            data-segment={segment.key}
            title={`${segment.label}: ${formatTokens(segment.value)} (${formatPercent(share)})`}
            className={cn("h-full", segment.color.bg)}
            style={{ width: `${share * 100}%` }}
          />
        );
      })}
    </div>
  );
}
