import { useId, useState, type KeyboardEvent } from "react";

import {
  dayStartIndices,
  logPosition,
  logTicks,
  niceTicks,
  pickLabelIndices,
  rangeTicks,
  thinIndices,
} from "./axis";
import { ChartTooltip, useChartWidth } from "./ChartCard";
import type { SeriesColor } from "./series-colors";

export interface LineSeries {
  key: string;
  label: string;
  color: SeriesColor;
  /** Значения по корзинам, `null` рвёт линию. */
  points: Array<number | null>;
}

export interface LineChartProps {
  buckets: string[];
  series: LineSeries[];
  ariaLabel: string;
  formatValue: (value: number) => string;
  formatAxis: (value: number) => string;
  formatTitle: (iso: string) => string;
  formatLabel?: (iso: string) => string;
  /** `linear` от нуля или `log` для окупаемости записи. */
  scale?: "linear" | "log";
  /** `auto`: ось по границам данных, а не от нуля. Только для `linear`. */
  domain?: "zero" | "auto";
  /** Горизонтальная пунктирная линия лимита. */
  limit?: { value: number; label: string };
  labelMode?: "even" | "dayStart";
  height?: number;
}

const MARGIN = { top: 12, right: 12, bottom: 28, left: 56 };

interface Scale {
  ticks: number[];
  position: (value: number) => number;
}

function buildScale(
  scale: "linear" | "log",
  domain: "zero" | "auto",
  values: number[],
  limit: number | undefined,
): Scale {
  const all = limit !== undefined ? [...values, limit] : values;
  if (scale === "log") {
    const positive = all.filter((v) => v > 0);
    if (positive.length === 0) {
      const ticks = [0.5, 1, 2];
      return { ticks, position: (v) => logPosition(v, ticks[0], ticks[ticks.length - 1]) };
    }
    const ticks = logTicks(Math.min(...positive), Math.max(...positive));
    return { ticks, position: (v) => logPosition(v, ticks[0], ticks[ticks.length - 1]) };
  }
  if (all.length === 0) {
    return { ticks: [0, 1], position: (v) => Math.min(1, Math.max(0, v)) };
  }
  if (domain === "auto") {
    const r = rangeTicks(Math.min(...all), Math.max(...all));
    const span = r.max - r.min || 1;
    return { ticks: r.ticks, position: (v) => (v - r.min) / span };
  }
  const r = niceTicks(Math.max(...all));
  return { ticks: r.ticks, position: (v) => v / r.max };
}

function segments(points: Array<number | null>): number[][] {
  const out: number[][] = [];
  let current: number[] = [];
  points.forEach((value, i) => {
    if (value === null || value === undefined) {
      if (current.length) out.push(current);
      current = [];
    } else {
      current.push(i);
    }
  });
  if (current.length) out.push(current);
  return out;
}

/**
 * Линейный график на SVG: линии по группам, линейная или логарифмическая
 * ось, пунктир лимита. Одно значение рисуется точкой. Подсказка и стрелки
 * работают так же, как у столбчатого графика.
 */
export function LineChart({
  buckets,
  series,
  ariaLabel,
  formatValue,
  formatAxis,
  formatTitle,
  formatLabel,
  scale = "linear",
  domain = "zero",
  limit,
  labelMode = "even",
  height = 300,
}: LineChartProps) {
  const [ref, width] = useChartWidth<HTMLDivElement>();
  const hintId = useId();
  const [active, setActive] = useState<number | null>(null);

  const count = buckets.length;
  const plotW = Math.max(width - MARGIN.left - MARGIN.right, 1);
  const plotH = Math.max(height - MARGIN.top - MARGIN.bottom, 1);
  const band = plotW / Math.max(count, 1);

  const values = series.flatMap((s) => s.points.filter((p): p is number => p !== null));
  const axis = buildScale(scale, domain, values, limit?.value);
  const yOf = (value: number) => MARGIN.top + plotH - axis.position(value) * plotH;
  const xOf = (i: number) => MARGIN.left + (i + 0.5) * band;

  const maxLabels = Math.min(6, Math.max(2, Math.floor(plotW / 72)));
  const labelIndices =
    labelMode === "dayStart"
      ? thinIndices(dayStartIndices(buckets), maxLabels)
      : pickLabelIndices(count, maxLabels);

  const move = (event: KeyboardEvent<SVGSVGElement>) => {
    if (count === 0) return;
    if (event.key === "ArrowRight") setActive((cur) => (cur === null ? 0 : Math.min(cur + 1, count - 1)));
    else if (event.key === "ArrowLeft") setActive((cur) => (cur === null ? count - 1 : Math.max(cur - 1, 0)));
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(count - 1);
    else if (event.key === "Escape") {
      setActive(null);
      return;
    } else return;
    event.preventDefault();
  };

  const tooltip = (() => {
    if (active === null || active >= count) return null;
    const rows = series
      .filter((s) => s.points[active] !== null && s.points[active] !== undefined)
      .map((s) => ({
        key: s.key,
        label: s.label,
        value: formatValue(s.points[active] as number),
        swatch: s.color.bg,
      }));
    const centerX = xOf(active);
    const placeLeft = centerX > width / 2;
    return (
      <ChartTooltip
        title={formatTitle(buckets[active])}
        rows={rows}
        marker="line"
        style={{
          top: MARGIN.top,
          ...(placeLeft ? { right: width - centerX + 8 } : { left: centerX + 8 }),
        }}
      />
    );
  })();

  return (
    <div ref={ref} className="relative w-full min-w-0">
      <svg
        role="img"
        aria-label={ariaLabel}
        aria-describedby={hintId}
        tabIndex={0}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block max-w-full select-none rounded-lg"
        onKeyDown={move}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        {axis.ticks.map((tick) => (
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

        {limit && (
          <g>
            <line
              data-testid="limit-line"
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={yOf(limit.value)}
              y2={yOf(limit.value)}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              className="stroke-ddc-text"
            />
            <text
              x={width - MARGIN.right - 4}
              y={yOf(limit.value) - 5}
              textAnchor="end"
              className="fill-ddc-text-muted text-2xs"
            >
              {limit.label}
            </text>
          </g>
        )}

        {active !== null && active < count && (
          <line
            x1={xOf(active)}
            x2={xOf(active)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
            strokeWidth={1}
            className="stroke-ddc-border-strong"
          />
        )}

        {series.map((s) => {
          const parts = segments(s.points);
          return (
            <g key={s.key}>
              {parts.map((part) =>
                part.length === 1 ? (
                  <circle
                    key={`${s.key}-${part[0]}`}
                    data-series={s.key}
                    cx={xOf(part[0])}
                    cy={yOf(s.points[part[0]] as number)}
                    r={3.5}
                    className={s.color.fill}
                  />
                ) : null,
              )}
              {parts.some((part) => part.length > 1) && (
                <path
                  data-series={s.key}
                  d={parts
                    .filter((part) => part.length > 1)
                    .map((part) =>
                      part
                        .map(
                          (i, k) =>
                            `${k === 0 ? "M" : "L"}${xOf(i).toFixed(1)} ${yOf(s.points[i] as number).toFixed(1)}`,
                        )
                        .join(" "),
                    )
                    .join(" ")}
                  fill="none"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={s.color.stroke}
                />
              )}
              {active !== null && s.points[active] !== null && s.points[active] !== undefined && (
                <circle
                  data-hover-dot={s.key}
                  cx={xOf(active)}
                  cy={yOf(s.points[active] as number)}
                  r={4}
                  className={s.color.fill}
                />
              )}
            </g>
          );
        })}

        {formatLabel &&
          labelIndices.map((i) => {
            const x = xOf(i);
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
            className="fill-transparent"
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive((cur) => (cur === i ? null : cur))}
          />
        ))}
      </svg>
      <span id={hintId} className="sr-only">
        Стрелками двигайтесь по точкам графика.
      </span>
      {tooltip}
    </div>
  );
}
