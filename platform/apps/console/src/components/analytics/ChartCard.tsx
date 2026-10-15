import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "@/lib/utils";

import { Skeleton } from "../Skeleton";
import { ViewToggle, type ChartView } from "./ViewToggle";

/**
 * Карточка графика: заголовок, описание, справа управление и переключатель
 * «График | Таблица», под телом легенда. Вид живёт в состоянии карточки и в
 * адрес не пишется. Пока грузятся новые фильтры, тело приглушается
 * (`dimmed`), а на холодной загрузке вместо него серая плита.
 */
export function ChartCard({
  title,
  description,
  controls,
  chart,
  table,
  legend,
  loading = false,
  dimmed = false,
  defaultView = "chart",
}: {
  title: string;
  description?: string;
  controls?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  legend?: ReactNode;
  loading?: boolean;
  dimmed?: boolean;
  defaultView?: ChartView;
}) {
  const [view, setView] = useState<ChartView>(defaultView);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="card min-w-0 p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-60">
          <h2 id={headingId} className="section-title">
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-ddc-text-muted">{description}</p>}
        </div>
        <div className="flex flex-none items-center gap-2">
          {controls}
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>
      {loading ? (
        <div aria-busy="true">
          <span className="sr-only">Загрузка данных графика</span>
          <Skeleton className="h-[300px] w-full" />
        </div>
      ) : (
        <div className={cn("min-w-0 transition-opacity", dimmed && "opacity-60")}>
          {view === "chart" ? chart : table}
          {legend}
        </div>
      )}
    </section>
  );
}

/**
 * Ширина области графика в пикселях. Растёт и сжимается вместе с контейнером.
 * В окружении без вёрстки (тесты) остаётся запасная ширина.
 */
export function useChartWidth<T extends HTMLElement>(
  fallback = 640,
): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = Math.round(el.getBoundingClientRect().width);
      if (next > 0) setWidth(Math.max(next, 240));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export interface TooltipRow {
  key: string;
  label: string;
  value: string;
  /** Класс цвета квадрата или отрезка. */
  swatch: string;
}

/**
 * Подсказка графика: белая карточка с тенью. Заголовок с датой, строки
 * «цвет, жирное значение, подпись», черта и «Итого».
 */
export function ChartTooltip({
  title,
  rows,
  total,
  footer,
  marker = "square",
  style,
}: {
  title: string;
  rows: TooltipRow[];
  total?: { label: string; value: string };
  footer?: string | null;
  marker?: "square" | "line";
  style: React.CSSProperties;
}) {
  return (
    <div
      role="tooltip"
      style={style}
      className="card pointer-events-none absolute z-10 min-w-40 max-w-64 rounded-xl px-3 py-2 text-xs"
    >
      <div className="mb-1.5 font-medium text-ddc-heading">{title}</div>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                "shrink-0",
                marker === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-sm",
                row.swatch,
              )}
            />
            <span className="font-semibold tabular-nums text-ddc-heading">{row.value}</span>
            <span className="min-w-0 truncate text-ddc-text-muted">{row.label}</span>
          </li>
        ))}
      </ul>
      {total && (
        <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-ddc-divider pt-1.5">
          <span className="text-ddc-text-muted">{total.label}</span>
          <span className="font-semibold tabular-nums text-ddc-heading">{total.value}</span>
        </div>
      )}
      {footer && <div className="mt-1 text-ddc-text-muted">{footer}</div>}
    </div>
  );
}
