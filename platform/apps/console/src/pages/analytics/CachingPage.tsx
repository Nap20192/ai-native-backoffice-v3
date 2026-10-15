import { ArrowDownIcon, ArrowUpIcon, ChartColumnIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState } from "../../components/EmptyState";
import { LoadError } from "../../components/LoadError";
import { Page } from "../../components/Page";
import { SkeletonRows } from "../../components/Skeleton";
import {
  AS_OF_HINT,
  formatAmortization,
  formatAxisDay,
  formatCompact,
  formatDataAsOf,
  formatHourUtc,
  formatPercent,
  formatTokens,
} from "../../components/analytics/analytics-format";
import { DEFAULT_RANGE, resolveRange } from "../../components/analytics/analytics-params";
import { AnalyticsHeader } from "../../components/analytics/AnalyticsHeader";
import { ChartCard } from "../../components/analytics/ChartCard";
import { CompositionBar } from "../../components/analytics/CompositionBar";
import { FilterBar, FilterDivider } from "../../components/analytics/FilterBar";
import { InfoHint } from "../../components/analytics/InfoHint";
import { Legend } from "../../components/analytics/Legend";
import { LineChart, type LineSeries } from "../../components/analytics/LineChart";
import { MultiSelectFilter } from "../../components/analytics/MultiSelectFilter";
import { RangeFilter } from "../../components/analytics/RangeFilter";
import { assignSeriesColors, TOKEN_TYPE_COLORS } from "../../components/analytics/series-colors";
import { SeriesTable } from "../../components/analytics/SeriesTable";
import { SingleSelectFilter } from "../../components/analytics/SingleSelectFilter";
import { StackedBarChart } from "../../components/analytics/StackedBarChart";
import { StatTiles, type StatTile } from "../../components/analytics/StatTiles";
import { useAnalyticsParams } from "../../components/analytics/use-analytics-params";
import {
  isAnalyticsUnsupported,
  useAnalyticsFacets,
  useCacheReport,
  type CacheReport,
  type CacheRow,
  type CacheTotals,
} from "../../lib/analytics-api";
import { CACHE_GROUP_OPTIONS, TEXT, TOKEN_TYPE_LABELS } from "./analytics-text";
import { facetOptions } from "./UsageCostLayout";

const HOUR_MS = 3_600_000;
const VISIBLE_HOURS = 168;

// ── Часовые ряды и окна ──────────────────────────────────────────────────

interface HourlyKey {
  uncached: number[];
  read: number[];
  write: number[];
}

export interface HourlySeries {
  /** Начала часов всего ряда (336 часов). */
  hours: string[];
  /** Индекс первого часа из 168 видимых. */
  visibleFrom: number;
  keys: Map<string, HourlyKey>;
}

/** Раскладывает ряд сервера по часам: нули там, где вызовов не было. */
export function buildHourly(report: CacheReport): HourlySeries {
  const start = Date.parse(report.series_from_hour);
  const end = Date.parse(report.to_hour);
  const count = Math.max(0, Math.round((end - start) / HOUR_MS) + 1);
  const hours = Array.from({ length: count }, (_, i) => new Date(start + i * HOUR_MS).toISOString());
  const keys = new Map<string, HourlyKey>();
  const ensure = (key: string) => {
    let entry = keys.get(key);
    if (!entry) {
      entry = {
        uncached: new Array<number>(count).fill(0),
        read: new Array<number>(count).fill(0),
        write: new Array<number>(count).fill(0),
      };
      keys.set(key, entry);
    }
    return entry;
  };
  for (const row of report.rows) ensure(row.key);
  for (const point of report.series) {
    const i = Math.round((Date.parse(point.hour_start) - start) / HOUR_MS);
    if (i < 0 || i >= count) continue;
    const entry = ensure(point.key);
    entry.uncached[i] += point.uncached_input_tokens;
    entry.read[i] += point.cache_read_tokens;
    entry.write[i] += point.cache_write_tokens;
  }
  const visibleFrom = Math.max(0, Math.round((Date.parse(report.from_hour) - start) / HOUR_MS));
  return { hours, visibleFrom, keys };
}

/**
 * Значение в точке часа `h` по окну `window`: суммы за часы `(h - window, h]`.
 * Час без входа (для окупаемости без записи) даёт `null`, и линия рвётся.
 */
export function windowedPoints(
  hourly: HourlySeries,
  key: string,
  window: number,
  mode: "ratio" | "amortization",
): Array<number | null> {
  const entry = hourly.keys.get(key);
  if (!entry) return [];
  const out: Array<number | null> = [];
  for (let h = hourly.visibleFrom; h < hourly.hours.length; h += 1) {
    let uncached = 0;
    let read = 0;
    let write = 0;
    for (let i = Math.max(0, h - window + 1); i <= h; i += 1) {
      uncached += entry.uncached[i];
      read += entry.read[i];
      write += entry.write[i];
    }
    if (mode === "ratio") {
      const total = uncached + read + write;
      out.push(total === 0 ? null : read / total);
    } else {
      out.push(write === 0 ? null : read / write);
    }
  }
  return out;
}

const RATIO_WINDOWS = [
  { value: "1", label: "1 ч" },
  { value: "3", label: "3 ч" },
  { value: "6", label: "6 ч" },
  { value: "24", label: "24 ч" },
];
const AMORT_WINDOWS = [
  { value: "1", label: "1 ч" },
  { value: "6", label: "6 ч" },
  { value: "24", label: "24 ч" },
  { value: "168", label: "7 дн" },
];

// ── Плитки ───────────────────────────────────────────────────────────────

function cacheTiles(totals: CacheTotals | undefined): StatTile[] {
  const empty = !totals || totals.requests === 0;
  return [
    {
      id: "uncached",
      label: "Вход без кэша",
      value: formatCompact(totals?.uncached_input_tokens ?? 0),
      hint: "Входные токены, которые не попали в кэш и не были записаны в него.",
      empty,
    },
    {
      id: "read",
      label: "Чтение из кэша",
      value: formatCompact(totals?.cache_read_tokens ?? 0),
      hint: "Входные токены, которые модель взяла из кэша промпта.",
      empty,
    },
    {
      id: "ratio",
      label: "Доля чтения из кэша",
      value: formatPercent(totals?.read_ratio ?? null),
      hint: "Чтение из кэша, делённое на весь вход: токены без кэша, чтение и запись.",
      empty,
    },
  ];
}

// ── Карточки таблиц ──────────────────────────────────────────────────────

function LowCacheCard({ report, loading }: { report: CacheReport | undefined; loading: boolean }) {
  const noCache = report
    ? report.totals.cache_read_tokens === 0 && report.totals.cache_write_tokens === 0
    : false;
  return (
    <section aria-labelledby="low-cache-title" className="card min-w-0 p-5">
      <h2 id="low-cache-title" className="section-title">
        Агенты с низкой долей кэша
      </h2>
      <p className="mt-1 mb-4 text-sm text-ddc-text-muted">
        Агенты, у которых за 7 дней вход не меньше 10 тыс. токенов, а доля чтения из кэша меньше половины.
      </p>
      {loading || !report ? (
        <SkeletonRows count={3} height={32} />
      ) : noCache ? (
        <p className="text-sm text-ddc-text-muted">Кэш не используется: токены чтения и записи равны нулю.</p>
      ) : report.low_cache_agents.length === 0 ? (
        <p className="text-sm text-ddc-text-muted">
          Все агенты с заметным входом читают из кэша больше половины.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max text-sm tabular-nums">
            <thead>
              <tr className="border-b border-ddc-divider text-xs text-ddc-text-muted">
                <th scope="col" className="sticky left-0 bg-ddc-surface px-3 py-2 text-left font-medium">Агент</th>
                <th scope="col" className="px-3 py-2 text-left font-medium">Модель</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Вход</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Доля чтения</th>
              </tr>
            </thead>
            <tbody>
              {report.low_cache_agents.map((agent) => (
                <tr key={`${agent.agent_id}:${agent.model}`} className="border-b border-ddc-divider last:border-b-0">
                  <th scope="row" className="sticky left-0 bg-ddc-surface px-3 py-2 text-left font-normal">
                    {agent.agent_name}
                  </th>
                  <td className="px-3 py-2 font-mono text-xs">{agent.model}</td>
                  <td className="px-3 py-2 text-right">{formatCompact(agent.total_input_tokens)}</td>
                  <td className="px-3 py-2 text-right">{formatPercent(agent.read_ratio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function compositionSegments(row: Pick<CacheTotals, "cache_read_tokens" | "cache_write_tokens" | "uncached_input_tokens">) {
  return [
    { key: "cache_read", label: TOKEN_TYPE_LABELS.cache_read, value: row.cache_read_tokens, color: TOKEN_TYPE_COLORS.cache_read },
    { key: "cache_write", label: TOKEN_TYPE_LABELS.cache_write, value: row.cache_write_tokens, color: TOKEN_TYPE_COLORS.cache_write },
    { key: "input", label: TOKEN_TYPE_LABELS.input, value: row.uncached_input_tokens, color: TOKEN_TYPE_COLORS.input },
  ];
}

function BreakdownCard({
  report,
  loading,
  groupLabel,
}: {
  report: CacheReport | undefined;
  loading: boolean;
  groupLabel: string;
}) {
  const [direction, setDirection] = useState<"desc" | "asc">("desc");
  const rows = useMemo(() => {
    const list = [...(report?.rows ?? [])];
    list.sort((a, b) =>
      direction === "desc"
        ? b.total_input_tokens - a.total_input_tokens
        : a.total_input_tokens - b.total_input_tokens,
    );
    return list;
  }, [report?.rows, direction]);

  const line = (row: CacheRow | (CacheTotals & { key: string; label: string }), bold = false) => (
    <tr key={row.key} className="border-b border-ddc-divider last:border-b-0">
      <th
        scope="row"
        className={`sticky left-0 max-w-56 truncate bg-ddc-surface px-3 py-2 text-left ${bold ? "font-semibold" : "font-normal"}`}
        title={row.label}
      >
        {row.label}
      </th>
      <td className={`px-3 py-2 text-right ${bold ? "font-semibold" : ""}`}>{formatTokens(row.total_input_tokens)}</td>
      <td className="px-3 py-2">
        <CompositionBar segments={compositionSegments(row)} />
      </td>
      <td className={`px-3 py-2 text-right ${bold ? "font-semibold" : ""}`}>{formatPercent(row.read_ratio)}</td>
      <td className={`px-3 py-2 text-right ${bold ? "font-semibold" : ""}`}>
        {formatAmortization(row.write_amortization)}
      </td>
    </tr>
  );

  return (
    <section aria-labelledby="breakdown-title" className="card min-w-0 p-5">
      <h2 id="breakdown-title" className="section-title mb-4">
        Разбивка кэша
      </h2>
      {loading || !report ? (
        <SkeletonRows count={4} height={32} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm tabular-nums">
              <thead>
                <tr className="border-b border-ddc-divider text-xs text-ddc-text-muted">
                  <th scope="col" className="sticky left-0 bg-ddc-surface px-3 py-2 text-left font-medium">
                    {groupLabel}
                  </th>
                  <th
                    scope="col"
                    aria-sort={direction === "desc" ? "descending" : "ascending"}
                    className="px-3 py-2 text-right font-medium"
                  >
                    <button
                      type="button"
                      onClick={() => setDirection((d) => (d === "desc" ? "asc" : "desc"))}
                      className="inline-flex items-center gap-1 hover:text-ddc-text"
                    >
                      Вход
                      {direction === "desc" ? (
                        <ArrowDownIcon className="size-3.5" aria-hidden="true" />
                      ) : (
                        <ArrowUpIcon className="size-3.5" aria-hidden="true" />
                      )}
                    </button>
                  </th>
                  <th scope="col" className="w-64 px-3 py-2 text-left font-medium">
                    Состав входа
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Доля чтения
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    <span className="inline-flex items-center gap-1">
                      Окупаемость записи
                      <InfoHint subject="Окупаемость записи">
                        Сколько токенов прочитано из кэша на один записанный. Чем больше, тем лучше окупается запись.
                      </InfoHint>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {line({ ...report.totals, key: "__total", label: TEXT.common.total }, true)}
                {rows.map((row) => line(row))}
              </tbody>
            </table>
          </div>
          <Legend
            items={[
              { key: "cache_read", label: TOKEN_TYPE_LABELS.cache_read, color: TOKEN_TYPE_COLORS.cache_read },
              { key: "cache_write", label: TOKEN_TYPE_LABELS.cache_write, color: TOKEN_TYPE_COLORS.cache_write },
              { key: "input", label: TOKEN_TYPE_LABELS.input, color: TOKEN_TYPE_COLORS.input },
            ]}
          />
        </>
      )}
    </section>
  );
}

// ── Графики ──────────────────────────────────────────────────────────────

function CompositionCard({
  hourly,
  loading,
  dimmed,
  groupLabel,
  options,
}: {
  hourly: HourlySeries | null;
  loading: boolean;
  dimmed: boolean;
  groupLabel: string;
  options: Array<{ value: string; label: string }>;
}) {
  const [selected, setSelected] = useState("all");
  const keys = hourly ? [...hourly.keys.keys()] : [];
  const active = selected === "all" || keys.includes(selected) ? selected : "all";

  const model = useMemo(() => {
    if (!hourly) return null;
    const hours = hourly.hours.slice(hourly.visibleFrom);
    const pick = (field: keyof HourlyKey) =>
      hours.map((_, j) => {
        const i = hourly.visibleFrom + j;
        let sum = 0;
        for (const [key, entry] of hourly.keys) {
          if (active === "all" || key === active) sum += entry[field][i];
        }
        return sum;
      });
    return {
      hours,
      series: [
        { key: "cache_read", label: TOKEN_TYPE_LABELS.cache_read, color: TOKEN_TYPE_COLORS.cache_read, values: pick("read") },
        { key: "cache_write", label: TOKEN_TYPE_LABELS.cache_write, color: TOKEN_TYPE_COLORS.cache_write, values: pick("write") },
        { key: "input", label: TOKEN_TYPE_LABELS.input, color: TOKEN_TYPE_COLORS.input, values: pick("uncached") },
      ],
    };
  }, [hourly, active]);

  return (
    <ChartCard
      title="Состав входа"
      description="Доля чтения, записи и входа без кэша. Чем меньше входа без кэша, тем дешевле."
      loading={loading || !model}
      dimmed={dimmed}
      controls={
        <SingleSelectFilter
          label={groupLabel}
          options={[{ value: "all", label: "Все" }, ...options]}
          value={active}
          onChange={setSelected}
        />
      }
      legend={
        <Legend
          items={(model?.series ?? []).map((s) => ({ key: s.key, label: s.label, color: s.color }))}
        />
      }
      chart={
        model ? (
          <StackedBarChart
            buckets={model.hours}
            series={model.series}
            ariaLabel="Состав входа по часам"
            formatValue={formatTokens}
            formatAxis={formatCompact}
            formatTitle={formatHourUtc}
            formatLabel={formatAxisDay}
            labelMode="dayStart"
          />
        ) : null
      }
      table={
        model ? (
          <SeriesTable
            caption="Состав входа по часам"
            firstColumnLabel="Время (UTC)"
            columns={model.series.map((s) => ({ key: s.key, label: s.label }))}
            rows={model.hours.map((hour, j) => ({
              key: hour,
              label: formatHourUtc(hour),
              values: model.series.map((s) => s.values[j]),
            }))}
            formatValue={formatTokens}
          />
        ) : null
      }
    />
  );
}

function LineCard({
  title,
  description,
  windowOptions,
  defaultWindow,
  mode,
  hourly,
  rows,
  loading,
  dimmed,
}: {
  title: string;
  description: string;
  windowOptions: Array<{ value: string; label: string }>;
  defaultWindow: string;
  mode: "ratio" | "amortization";
  hourly: HourlySeries | null;
  rows: CacheRow[];
  loading: boolean;
  dimmed: boolean;
}) {
  const [windowHours, setWindowHours] = useState(defaultWindow);
  const keys = useMemo(() => {
    const ordered = rows.map((r) => r.key);
    for (const key of hourly?.keys.keys() ?? []) if (!ordered.includes(key)) ordered.push(key);
    return ordered;
  }, [rows, hourly]);
  const colors = useMemo(() => assignSeriesColors(keys), [keys]);
  const labels = useMemo(() => new Map(rows.map((r) => [r.key, r.label])), [rows]);

  const model = useMemo(() => {
    if (!hourly) return null;
    const hours = hourly.hours.slice(hourly.visibleFrom);
    const series: LineSeries[] = keys.map((key) => ({
      key,
      label: labels.get(key) ?? key,
      color: colors.get(key) ?? TOKEN_TYPE_COLORS.input,
      points: windowedPoints(hourly, key, Number(windowHours), mode),
    }));
    return { hours, series };
  }, [hourly, keys, labels, colors, windowHours, mode]);

  const formatValue = mode === "ratio" ? (v: number) => formatPercent(v) : formatAmortization;

  return (
    <ChartCard
      title={title}
      description={description}
      loading={loading || !model}
      dimmed={dimmed}
      controls={
        <SingleSelectFilter
          label="Окно"
          options={windowOptions}
          value={windowHours}
          onChange={setWindowHours}
        />
      }
      legend={
        <Legend
          variant="line"
          items={(model?.series ?? []).map((s) => ({ key: s.key, label: s.label, color: s.color }))}
        />
      }
      chart={
        model ? (
          <LineChart
            buckets={model.hours}
            series={model.series}
            ariaLabel={`${title} по часам`}
            formatValue={formatValue}
            formatAxis={mode === "ratio" ? (v) => formatPercent(v) : formatAmortization}
            formatTitle={formatHourUtc}
            formatLabel={formatAxisDay}
            labelMode="dayStart"
            scale={mode === "ratio" ? "linear" : "log"}
            domain={mode === "ratio" ? "auto" : "zero"}
          />
        ) : null
      }
      table={
        model ? (
          <SeriesTable
            caption={`${title} по часам`}
            firstColumnLabel="Время (UTC)"
            columns={model.series.map((s) => ({ key: s.key, label: s.label, color: s.color }))}
            rows={model.hours.map((hour, j) => ({
              key: hour,
              label: formatHourUtc(hour),
              values: model.series.map((s) => s.points[j] ?? null),
            }))}
            formatValue={formatValue}
            showTotal={false}
          />
        ) : null
      }
    />
  );
}

// ── Страница ─────────────────────────────────────────────────────────────

/** Страница «Кэширование»: чтение и запись кэша промпта за последние 7 суток. */
export function CachingPage() {
  const { state, patch, reset } = useAnalyticsParams();
  const groupBy: "model" | "agent" = state.group_by === "agent" ? "agent" : "model";
  const groupLabel = groupBy === "agent" ? "Агент" : "Модель";

  const facetRange = useMemo(() => resolveRange(DEFAULT_RANGE), []);
  const facets = useAnalyticsFacets(facetRange.from, facetRange.to);
  const options = useMemo(() => facetOptions(facets.data), [facets.data]);
  const report = useCacheReport({ group_by: groupBy, model: state.model, agent_id: state.agent_id });

  const data = report.data;
  const hourly = useMemo(() => (data ? buildHourly(data) : null), [data]);
  const unsupported = isAnalyticsUnsupported(report.error);
  const failed = report.isError && !data;
  const isEmpty = Boolean(data && data.totals.requests === 0);
  const showReset = state.model.length > 0 || state.agent_id.length > 0 || groupBy !== "model";
  const asOf = formatDataAsOf(data?.latest_ended_at);
  const chartOptions = (data?.rows ?? []).map((r) => ({ value: r.key, label: r.label }));

  return (
    <Page
      header={
        <AnalyticsHeader
          title={TEXT.caching.title}
          description={TEXT.caching.description}
          showAsOf={false}
          onRefresh={() => {
            void report.refetch();
            void facets.refetch();
          }}
          refreshing={report.isFetching}
        />
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        {!unsupported && (
          <FilterBar
            sticky
            showReset={showReset}
            onReset={reset}
            trailing={
              asOf ? (
                <span className="text-xs text-ddc-text-muted tabular-nums" title={AS_OF_HINT}>
                  Данные на {asOf}
                </span>
              ) : null
            }
          >
            <MultiSelectFilter
              label="Модель"
              options={options.models}
              selected={state.model}
              onChange={(next) => patch({ model: next })}
            />
            <MultiSelectFilter
              label="Агент"
              options={options.agents}
              selected={state.agent_id}
              onChange={(next) => patch({ agent_id: next })}
            />
            <RangeFilter value={{ kind: "preset", preset: "7d" }} onChange={() => {}} disabled />
            <FilterDivider />
            <SingleSelectFilter
              label="Группировать по"
              options={CACHE_GROUP_OPTIONS}
              value={groupBy}
              onChange={(next) => patch({ group_by: next })}
            />
          </FilterBar>
        )}

        {unsupported ? (
          <div className="callout-warning" role="note">
            <TriangleAlertIcon className="mt-0.5 size-4 flex-none" aria-hidden="true" />
            <span>{TEXT.common.unsupported}</span>
          </div>
        ) : failed ? (
          <LoadError
            title={TEXT.common.loadErrorTitle}
            message={report.error instanceof Error ? report.error.message : "Повторите попытку."}
            onRetry={() => void report.refetch()}
            retrying={report.isFetching}
          />
        ) : (
          <>
            <StatTiles tiles={cacheTiles(data?.totals)} loading={report.isPending} />
            {isEmpty ? (
              <EmptyState icon={<ChartColumnIcon />} title={TEXT.common.empty} />
            ) : (
              <>
                <LowCacheCard report={data} loading={report.isPending} />
                <BreakdownCard report={data} loading={report.isPending} groupLabel={groupLabel} />
                <CompositionCard
                  hourly={hourly}
                  loading={report.isPending}
                  dimmed={report.isPlaceholderData}
                  groupLabel={groupLabel}
                  options={chartOptions}
                />
                <LineCard
                  title="Доля чтения из кэша"
                  description="Чтение из кэша, делённое на весь вход, по группам."
                  windowOptions={RATIO_WINDOWS}
                  defaultWindow="6"
                  mode="ratio"
                  hourly={hourly}
                  rows={data?.rows ?? []}
                  loading={report.isPending}
                  dimmed={report.isPlaceholderData}
                />
                <LineCard
                  title="Окупаемость записи"
                  description="Сколько токенов прочитано на один записанный."
                  windowOptions={AMORT_WINDOWS}
                  defaultWindow="24"
                  mode="amortization"
                  hourly={hourly}
                  rows={data?.rows ?? []}
                  loading={report.isPending}
                  dimmed={report.isPlaceholderData}
                />
              </>
            )}
          </>
        )}
      </div>
    </Page>
  );
}
