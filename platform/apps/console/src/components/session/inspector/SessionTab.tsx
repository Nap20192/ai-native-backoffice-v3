import { useMemo, useRef, useState, type ReactNode } from "react";
import type { BetaEnvironment } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import { PencilIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { OutcomeView, SessionTotals } from "../../../lib/session-stats";
import { AgentChip, EnvironmentChip, VaultChip } from "../../../pages/session-detail/Panels";
import { StatusPill, type StatusTone } from "../../Badge";
import {
  EMPTY_VALUE,
  formatCentsRu,
  formatClockRu,
  formatEventDateTimeRu,
  formatMinimapTimeRu,
  formatShortDurationRu,
  formatTokensRu,
  formatUsdMicrosRu,
} from "../format-ru";
import { CopyButton } from "../SessionHeader";
import type { SessionCost } from "../useSessionCost";

/**
 * Вкладка «Сессия»: таблица свойств, результат, стоимость с графиком,
 * использование и метаданные. Данные приходят готовыми, вкладка сама
 * ничего не грузит.
 */

export interface SessionTabProps {
  session: BetaManagedAgentsSession;
  environment: BetaEnvironment | null;
  vaults: ReadonlyArray<{ id: string; name?: string }>;
  status: string;
  totals: SessionTotals;
  outcomes: readonly OutcomeView[];
  cost: SessionCost;
  /** Строки «Источник» из metadata linear и slack. */
  sources?: ReactNode;
  onEditBudget(): void;
  onHoverTime?(ms: number | null): void;
}

// ── Диаграмма по времени ─────────────────────────────────────────────────

export interface ChartPoint {
  atMs: number;
  value: number;
}

/** Округление вверх до 1, 2, 2,5, 5 или 10 на порядок: верх оси Y. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * base >= value * (1 - 1e-9)) return factor * base;
  }
  return 10 * base;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TICK_STEPS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];

/** Метки оси времени: не больше пяти, по местному времени, кратные шагу. */
export function niceTimeTicks(startMs: number, endMs: number, maxTicks = 5): number[] {
  const span = endMs - startMs;
  if (!Number.isFinite(span) || span <= 0) return [];
  const step = TICK_STEPS.find((candidate) => span / candidate <= maxTicks) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const offset = new Date(startMs).getTimezoneOffset() * MINUTE;
  const ticks: number[] = [];
  for (let at = Math.ceil((startMs - offset) / step) * step + offset; at <= endMs; at += step) {
    ticks.push(at);
  }
  return ticks;
}

/** Подпись метки: время «15:00», а в полночь дата «16 окт.». */
function tickLabel(ms: number): string {
  const date = new Date(ms);
  if (date.getHours() === 0 && date.getMinutes() === 0) {
    return formatMinimapTimeRu(ms).split(",")[0] ?? EMPTY_VALUE;
  }
  return formatClockRu(ms).slice(0, 5);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export interface TimeChartProps<T extends ChartPoint> {
  /** Подпись для диктора. */
  label: string;
  /** Точки по времени. До первой точки значение ноль. */
  points: readonly T[];
  startMs: number;
  endMs: number;
  formatValue(value: number): string;
  /** Метки оси Y; по умолчанию ноль, середина и округлённый максимум. */
  yTicks?: readonly number[];
  renderTooltip?(point: T): ReactNode;
  onHoverTime?(ms: number | null): void;
  className?: string;
}

/**
 * Ступенчатый график с заливкой, как на вкладках «Сессия» и «Потоки».
 * Линия и заливка рисуются в растянутой рамке SVG, подписи осей, точка на
 * конце и подсказка лежат поверх обычной разметкой, чтобы не искажались.
 */
export function TimeChart<T extends ChartPoint>({
  label,
  points,
  startMs,
  endMs,
  formatValue,
  yTicks,
  renderTooltip,
  onHoverTime,
  className,
}: TimeChartProps<T>) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ ratio: number; point: T | null } | null>(null);

  const span = Math.max(1, endMs - startMs);
  const maxValue = points.reduce((max, point) => Math.max(max, point.value), 0);
  const yMax = yTicks && yTicks.length > 0 ? Math.max(...yTicks) : niceCeil(maxValue);
  const ticksY = yTicks ?? [0, yMax / 2, yMax];
  const x = (ms: number) => clamp01((ms - startMs) / span) * 100;
  const y = (value: number) => 100 - clamp01(value / yMax) * 100;

  const { line, area } = useMemo(() => {
    let path = "M 0 100";
    let previous = 100;
    for (const point of points) {
      path += ` L ${x(point.atMs)} ${previous} L ${x(point.atMs)} ${y(point.value)}`;
      previous = y(point.value);
    }
    path += ` L 100 ${previous}`;
    return { line: path, area: `${path} L 100 100 L 0 100 Z` };
    // x и y зависят только от границ, которые перечислены.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, startMs, span, yMax]);

  const ticksX = useMemo(() => niceTimeTicks(startMs, endMs), [startMs, endMs]);
  const last = points[points.length - 1];

  const onMove = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = clamp01((clientX - rect.left) / rect.width);
    const ms = startMs + ratio * span;
    let found: T | null = null;
    for (const point of points) {
      if (point.atMs <= ms) found = point;
      else break;
    }
    setHover({ ratio, point: found });
    onHoverTime?.(ms);
  };
  const onLeave = () => {
    setHover(null);
    onHoverTime?.(null);
  };

  return (
    <div
      role="img"
      aria-label={label}
      className={cn("relative pb-5 pl-11 text-2xs text-ddc-text-muted", className)}
    >
      <div
        ref={plotRef}
        data-chart-plot
        className="relative h-24 border-b border-ddc-divider"
        onPointerMove={(event) => onMove(event.clientX)}
        onPointerLeave={onLeave}
      >
        {ticksY.map((tick) => (
          <div
            key={tick}
            className="absolute inset-x-0 border-t border-dashed border-ddc-divider"
            style={{ top: `${y(tick)}%` }}
          >
            <span className="absolute top-0 -left-11 w-10 -translate-y-1/2 pr-1 text-right tabular-nums">
              {formatValue(tick)}
            </span>
          </div>
        ))}
        <svg
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
        >
          <path d={area} className="fill-ddc-tone-info-bg" stroke="none" />
          <path
            d={line}
            fill="none"
            className="stroke-ddc-dot-info"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {last && (
          <span
            data-chart-end
            aria-hidden="true"
            className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ddc-dot-info"
            style={{ left: `${x(last.atMs)}%`, top: `${y(last.value)}%` }}
          />
        )}
        {hover && (
          <>
            <span
              data-chart-cursor
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-ddc-border-strong"
              style={{ left: `${hover.ratio * 100}%` }}
            />
            {hover.point && renderTooltip && (
              <div
                className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-ddc-border bg-ddc-surface px-2 py-1.5 text-2xs whitespace-nowrap text-ddc-text shadow-card"
                style={{ left: `${Math.min(0.85, Math.max(0.15, hover.ratio)) * 100}%` }}
              >
                {renderTooltip(hover.point)}
              </div>
            )}
          </>
        )}
      </div>
      <div className="relative mt-1 h-4">
        {ticksX.map((tick) => (
          <span
            key={tick}
            className="absolute -translate-x-1/2 tabular-nums"
            style={{ left: `${x(tick)}%` }}
          >
            {tickLabel(tick)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Строки и разделы ─────────────────────────────────────────────────────

/** Строка «ярлык серым, значение». Страница кладёт такие же строки в `sources`. */
export function SessionPropertyRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  /** Ярлык моноширинным: ключи метаданных. */
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3 py-1.5 text-xs leading-5">
      <dt className={cn("min-w-0 break-words text-ddc-text-muted", mono && "font-mono")}>{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ddc-text">{children}</dd>
    </div>
  );
}

function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={id} className="text-sm font-semibold text-ddc-heading">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const RESULT_LABEL: Record<string, string> = {
  satisfied: "Выполнено",
  needs_revision: "Нужна доработка",
  max_iterations_reached: "Итерации исчерпаны",
  failed: "Оценка не удалась",
  interrupted: "Прервано",
  pending: "Ожидает оценки",
  running: "Идёт работа",
  evaluating: "Оценивается",
};

const RESULT_TONE: Record<string, StatusTone> = {
  satisfied: "completed",
  needs_revision: "rescheduling",
  failed: "errored",
  evaluating: "running",
};

interface OutcomeSummary {
  result: string;
  /** С единицы, как на экране. */
  iteration: number | null;
  completedMs: number | null;
  description: string;
  explanation: string | null;
}

function summarizeOutcome(
  outcomes: readonly OutcomeView[],
  session: BetaManagedAgentsSession,
): OutcomeSummary | null {
  const last = outcomes[outcomes.length - 1];
  if (last) {
    const evaluation = last.evaluations[last.evaluations.length - 1];
    return {
      result: evaluation?.result || "pending",
      iteration: evaluation ? evaluation.iteration + 1 : null,
      completedMs: evaluation?.atMs ?? null,
      description: last.description,
      explanation: evaluation?.explanation || null,
    };
  }
  const snapshot = session.outcome_evaluations?.[session.outcome_evaluations.length - 1];
  if (!snapshot) return null;
  const completed = snapshot.completed_at ? Date.parse(snapshot.completed_at) : Number.NaN;
  return {
    result: snapshot.result || "pending",
    iteration: snapshot.iteration + 1,
    completedMs: Number.isFinite(completed) ? completed : null,
    description: snapshot.description,
    explanation: snapshot.explanation || null,
  };
}

/** Длинная строка сжимается серединой: хвост остаётся виден («sesn_01S5djPEW…cr7RBiv»). */
function MiddleEllipsis({ text, tail = 8, className }: { text: string; tail?: number; className?: string }) {
  if (text.length <= tail + 4) {
    return (
      <span className={className} title={text}>
        {text}
      </span>
    );
  }
  return (
    <span className={cn("flex min-w-0 max-w-full", className)} title={text}>
      <span className="min-w-0 truncate">{text.slice(0, -tail)}</span>
      <span className="flex-none">{text.slice(-tail)}</span>
    </span>
  );
}

const HIDDEN_WITH_SOURCES = new Set(["linear", "slack"]);

export function SessionTab({
  session,
  environment,
  vaults,
  status,
  totals,
  outcomes,
  cost,
  sources,
  onEditBudget,
  onHoverTime,
}: SessionTabProps) {
  const createdMs = Date.parse(session.created_at);
  const updatedMs = Date.parse(session.updated_at);
  const outcome = summarizeOutcome(outcomes, session);
  const series = cost.series && cost.series.length > 0 ? cost.series : null;
  const metadata = Object.entries(session.metadata ?? {}).filter(
    ([key]) => !(sources && HIDDEN_WITH_SOURCES.has(key)),
  );
  const usage = totals.usage;
  const chartEnd = Math.max(
    totals.lastEventMs ?? 0,
    series ? series[series.length - 1]!.atMs : 0,
    createdMs + 1,
  );

  return (
    <div className="space-y-5 p-4">
      <dl className="m-0">
        <SessionPropertyRow label="ID">
          <span className="inline-flex max-w-full items-center gap-1">
            <MiddleEllipsis text={session.id} className="font-mono" />
            <CopyButton value={session.id} label="Копировать ID" />
          </span>
        </SessionPropertyRow>
        <SessionPropertyRow label="Статус">
          <StatusPill status={status} />
        </SessionPropertyRow>
        <SessionPropertyRow label="Создана">
          {Number.isFinite(createdMs) ? formatEventDateTimeRu(createdMs) : EMPTY_VALUE}
        </SessionPropertyRow>
        <SessionPropertyRow label="Обновлена">
          {Number.isFinite(updatedMs) ? formatEventDateTimeRu(updatedMs) : EMPTY_VALUE}
        </SessionPropertyRow>
        <SessionPropertyRow label="Агент">
          <AgentChip agent={session.agent} />
        </SessionPropertyRow>
        <SessionPropertyRow label="Окружение">
          <EnvironmentChip id={session.environment_id} environment={environment} />
        </SessionPropertyRow>
        <SessionPropertyRow label="Хранилища">
          {vaults.length > 0 ? (
            <span className="flex flex-wrap gap-1.5">
              {vaults.map((vault) => (
                <VaultChip key={vault.id} vault={vault} />
              ))}
            </span>
          ) : (
            EMPTY_VALUE
          )}
        </SessionPropertyRow>
        <SessionPropertyRow label="Деплоймент">
          {session.deployment_id ? (
            <span className="font-mono">{session.deployment_id}</span>
          ) : (
            EMPTY_VALUE
          )}
        </SessionPropertyRow>
        {sources}
      </dl>

      {outcome && (
        <Section id="session-tab-outcome" title="Результат">
          <dl className="m-0">
            <SessionPropertyRow label="Итог">
              <StatusPill
                status={RESULT_TONE[outcome.result] ?? "neutral"}
                label={RESULT_LABEL[outcome.result] ?? outcome.result}
              />
            </SessionPropertyRow>
            {outcome.iteration !== null && (
              <SessionPropertyRow label="Итерация">{outcome.iteration}</SessionPropertyRow>
            )}
            {outcome.completedMs !== null && (
              <SessionPropertyRow label="Завершено">
                {formatEventDateTimeRu(outcome.completedMs)}
              </SessionPropertyRow>
            )}
            <SessionPropertyRow label="Описание">{outcome.description}</SessionPropertyRow>
            {outcome.explanation && (
              <SessionPropertyRow label="Пояснение">
                <span className="whitespace-pre-wrap">{outcome.explanation}</span>
              </SessionPropertyRow>
            )}
          </dl>
        </Section>
      )}

      <Section
        id="session-tab-cost"
        title="Стоимость"
        aside={
          <span className="flex items-center gap-1 text-xs">
            <span className="font-medium text-ddc-text">
              {cost.loading ? "…" : formatUsdMicrosRu(cost.totalMicros)}
            </span>
            {cost.budgetCents !== null && (
              <span className="text-ddc-placeholder">/ {formatCentsRu(cost.budgetCents)}</span>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              className="size-6 text-ddc-icon-muted hover:text-ddc-text"
              aria-label="Изменить бюджет"
              title="Изменить бюджет"
              onClick={onEditBudget}
            >
              <PencilIcon className="size-3.5" />
            </Button>
          </span>
        }
      >
        {series ? (
          <TimeChart
            label="График стоимости"
            points={series.map((point) => ({
              atMs: point.atMs,
              value: point.cumulativeMicros,
              stepMicros: point.stepMicros,
            }))}
            startMs={Number.isFinite(createdMs) ? createdMs : series[0]!.atMs - 1}
            endMs={chartEnd}
            formatValue={formatUsdMicrosRu}
            onHoverTime={onHoverTime}
            renderTooltip={(point) => (
              <div className="space-y-0.5">
                <div className="font-medium tabular-nums">{formatClockRu(point.atMs)}</div>
                <div className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2 rounded-sm bg-ddc-dot-info" />
                  Стоимость {formatUsdMicrosRu(point.value)}
                </div>
                <div className="text-ddc-text-muted">{formatUsdMicrosRu(point.stepMicros)} этот шаг</div>
              </div>
            )}
          />
        ) : cost.source === "none" && !cost.loading ? (
          <p className="text-xs text-ddc-text-muted">
            У модели нет цены, график не построить. Цену задают в карточке модели.
          </p>
        ) : null}
      </Section>

      <Table aria-label="Использование" className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="h-8 px-0 text-xs font-semibold tracking-normal text-ddc-heading normal-case">
              Использование
            </TableHead>
            <TableHead className="h-8 px-0 text-xs font-semibold tracking-normal text-ddc-heading normal-case">
              Итого по сессии
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[
            ["Входные токены", formatTokensRu(usage.input)],
            ["Выходные токены", formatTokensRu(usage.output)],
            ["Чтение кэша", formatTokensRu(usage.cacheRead)],
            ["Запись кэша", formatTokensRu(usage.cacheWrite)],
            ["Активное время", totals.activeMs > 0 ? formatShortDurationRu(totals.activeMs) : EMPTY_VALUE],
          ].map(([name, value]) => (
            <TableRow key={name} className="border-0 hover:bg-transparent">
              <TableCell className="px-0 py-1 text-ddc-text-muted">{name}</TableCell>
              <TableCell className="px-0 py-1 tabular-nums">{value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {metadata.length > 0 && (
        <Section id="session-tab-metadata" title="Метаданные">
          <dl className="m-0">
            {metadata.map(([key, value]) => (
              <SessionPropertyRow key={key} label={key} mono>
                {value}
              </SessionPropertyRow>
            ))}
          </dl>
        </Section>
      )}
    </div>
  );
}
