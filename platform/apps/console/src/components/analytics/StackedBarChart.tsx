import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

import { dayStartIndices, niceTicks, pickLabelIndices, thinIndices } from "./axis";
import { ChartTooltip, useChartWidth } from "./ChartCard";
import type { SeriesColor } from "./series-colors";

export interface BarSeries {
  key: string;
  label: string;
  color: SeriesColor;
  /** Значения по корзинам, в том же порядке, что и `buckets`. */
  values: number[];
}

export interface StackedBarChartProps {
  /** Начала корзин, ISO. */
  buckets: string[];
  series: BarSeries[];
  ariaLabel: string;
  formatValue: (value: number) => string;
  formatAxis: (value: number) => string;
  /** Заголовок подсказки корзины. */
  formatTitle: (iso: string) => string;
  /** Подпись корзины на оси X. */
  formatLabel: (iso: string) => string;
  /** `dayStart`: подписи на полночь UTC, для почасовых рядов. */
  labelMode?: "even" | "dayStart";
  totalLabel?: string;
  /** Строка под итогом в подсказке корзины. */
  footer?: (index: number) => string | null;
  onBucketClick?: (iso: string, index: number) => void;
  height?: number;
}

const MARGIN = { top: 8, right: 8, bottom: 28, left: 56 };

/**
 * Столбчатый график со стопкой рядов на SVG. Высота столбца равна сумме
 * рядов корзины. Подсказка по наведению, клик по столбцу и стрелки с Enter
 * для клавиатуры.
 */
export function StackedBarChart({
  buckets,
  series,
  ariaLabel,
  formatValue,
  formatAxis,
  formatTitle,
  formatLabel,
  labelMode = "even",
  totalLabel = "Итого",
  footer,
  onBucketClick,
  height = 300,
}: StackedBarChartProps) {
  const [ref, width] = useChartWidth<HTMLDivElement>();
  const hintId = useId();
  const [active, setActive] = useState<number | null>(null);

  const count = buckets.length;
  const plotW = Math.max(width - MARGIN.left - MARGIN.right, 1);
  const plotH = Math.max(height - MARGIN.top - MARGIN.bottom, 1);
  const band = plotW / Math.max(count, 1);
  const barW = Math.min(Math.max(band * 0.68, 2), 44);

  const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const { ticks, max: yMax } = niceTicks(Math.max(0, ...totals));
  const yOf = (value: number) => MARGIN.top + plotH - (value / yMax) * plotH;

  const maxLabels = Math.min(6, Math.max(2, Math.floor(plotW / 72)));
  const labelIndices =
    labelMode === "dayStart"
      ? thinIndices(dayStartIndices(buckets), maxLabels)
      : pickLabelIndices(count, maxLabels);

  const move = (event: KeyboardEvent<SVGSVGElement>) => {
    if (count === 0) return;
    if (event.key === "ArrowRight") {
      setActive((cur) => (cur === null ? 0 : Math.min(cur + 1, count - 1)));
    } else if (event.key === "ArrowLeft") {
      setActive((cur) => (cur === null ? count - 1 : Math.max(cur - 1, 0)));
    } else if (event.key === "Home") {
      setActive(0);
    } else if (event.key === "End") {
      setActive(count - 1);
    } else if (event.key === "Enter" && active !== null && onBucketClick) {
      onBucketClick(buckets[active], active);
    } else if (event.key === "Escape") {
      setActive(null);
      return;
    } else {
      return;
    }
    event.preventDefault();
  };

  const tooltip = (() => {
    if (active === null || active >= count) return null;
    const centerX = MARGIN.left + (active + 0.5) * band;
    const rows = series
      .filter((s) => (s.values[active] ?? 0) > 0)
      .map((s) => ({
        key: s.key,
        label: s.label,
        value: formatValue(s.values[active] ?? 0),
        swatch: s.color.bg,
      }));
    const placeLeft = centerX > width / 2;
    return (
      <ChartTooltip
        title={formatTitle(buckets[active])}
        rows={rows}
        total={{ label: totalLabel, value: formatValue(totals[active]) }}
        footer={footer?.(active) ?? null}
        style={{
          top: MARGIN.top,
          ...(placeLeft
            ? { right: width - centerX + barW / 2 + 6 }
            : { left: centerX + barW / 2 + 6 }),
        }}
      />
    );
  })();

  return (
    <div ref={ref} className="relative w-full min-w-0">
      <svg
        role="img"
        aria-label={ariaLabel}
        aria-describedby={onBucketClick ? hintId : undefined}
        tabIndex={0}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block max-w-full select-none rounded-lg"
        onKeyDown={move}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={yOf(tick)}
              y2={yOf(tick)}
              strokeWidth={1}
              className="stroke-ddc-divider"
            />
            <text
              x={MARGIN.left - 8}
              y={yOf(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-ddc-text-muted text-2xs tabular-nums"
            >
              {formatAxis(tick)}
            </text>
          </g>
        ))}

        {active !== null && active < count && (
          <rect
            x={MARGIN.left + active * band}
            y={MARGIN.top}
            width={band}
            height={plotH}
            className="fill-ddc-surface-muted"
          />
        )}

        {buckets.map((bucket, i) => {
          const x = MARGIN.left + i * band + (band - barW) / 2;
          let acc = 0;
          return (
            <g key={bucket}>
              {series.map((s) => {
                const value = s.values[i] ?? 0;
                if (value <= 0) return null;
                const top = yOf(acc + value);
                const bottom = yOf(acc);
                acc += value;
                return (
                  <rect
                    key={s.key}
                    data-series={s.key}
                    x={x}
                    y={top}
                    width={barW}
                    height={Math.max(bottom - top, 1)}
                    className={s.color.fill}
                  />
                );
              })}
            </g>
          );
        })}

        {labelIndices.map((i) => {
          const x = MARGIN.left + (i + 0.5) * band;
          const anchor = x < MARGIN.left + 18 ? "start" : x > width - MARGIN.right - 18 ? "end" : "middle";
          return (
            <text
              key={buckets[i]}
              x={anchor === "start" ? MARGIN.left : anchor === "end" ? width - MARGIN.right : x}
              y={height - 8}
              textAnchor={anchor}
              className="fill-ddc-text-muted text-2xs tabular-nums"
            >
              {formatLabel(buckets[i])}
            </text>
          );
        })}

        {buckets.map((bucket, i) => (
          <rect
            key={`hit-${bucket}`}
            data-bucket-index={i}
            x={MARGIN.left + i * band}
            y={MARGIN.top}
            width={band}
            height={plotH}
            className={cn("fill-transparent", onBucketClick && "cursor-pointer")}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
            onClick={() => onBucketClick?.(bucket, i)}
          />
        ))}
      </svg>
      {onBucketClick && (
        <span id={hintId} className="sr-only">
          Стрелками двигайтесь по столбцам, Enter приближает график до этого периода.
        </span>
      )}
      {tooltip}
    </div>
  );
}
