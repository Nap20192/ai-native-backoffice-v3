import { ChartColumnIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { EmptyState } from "../../components/EmptyState";
import { LoadError } from "../../components/LoadError";
import { Page } from "../../components/Page";
import {
  formatAxisDay,
  formatAxisHour,
  formatCompact,
  formatDayUtc,
  formatHourUtc,
  formatTokens,
  formatUsd,
  formatUsdAxis,
  pluralRu,
} from "../../components/analytics/analytics-format";
import {
  bucketFor,
  hasActiveFilters,
  toApiFilters,
  zoomToDay,
  type GroupBy,
} from "../../components/analytics/analytics-params";
import { AnalyticsHeader } from "../../components/analytics/AnalyticsHeader";
import { ChartCard } from "../../components/analytics/ChartCard";
import { FilterBar, FilterDivider } from "../../components/analytics/FilterBar";
import { Legend, type LegendItem } from "../../components/analytics/Legend";
import { MultiSelectFilter, type FilterOption } from "../../components/analytics/MultiSelectFilter";
import { RangeFilter } from "../../components/analytics/RangeFilter";
import {
  assignSeriesColors,
  MAX_NAMED_SERIES,
  OTHER_COLOR,
  TOKEN_TYPE_COLORS,
  type TokenTypeKey,
} from "../../components/analytics/series-colors";
import { SeriesTable, type SeriesTableColumn } from "../../components/analytics/SeriesTable";
import { SingleSelectFilter } from "../../components/analytics/SingleSelectFilter";
import { StackedBarChart, type BarSeries } from "../../components/analytics/StackedBarChart";
import { StatTiles, type StatTile } from "../../components/analytics/StatTiles";
import { useAnalyticsParams } from "../../components/analytics/use-analytics-params";
import {
  ANALYTICS_BASE,
  isAnalyticsUnsupported,
  useAnalyticsCsv,
  useAnalyticsFacets,
  useUsageReport,
  type AnalyticsFacets,
  type UsageGroup,
  type UsageGroupBy,
  type UsageReport,
} from "../../lib/analytics-api";
import { NO_CARD_LABEL, TEXT, TOKEN_TYPE_LABELS, USAGE_GROUP_OPTIONS, harnessLabel } from "./analytics-text";

export type LayoutKind = "usage" | "cost";

const OTHER_KEY = "__other";
const TOKEN_ORDER: TokenTypeKey[] = ["cache_read", "cache_write", "output", "input"];

const tokensOf = (p: {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}) => p.input_tokens + p.output_tokens + p.cache_read_tokens + p.cache_write_tokens;

export interface ChartModel {
  series: BarSeries[];
  legend: LegendItem[];
  columns: SeriesTableColumn[];
  /** Запросы без цены по корзинам, для подсказки стоимости. */
  unpriced: number[];
}

/** Ряды графика из отчёта: по группам или по типам токенов. */
export function buildChartModel(report: UsageReport, kind: LayoutKind, groupBy: GroupBy): ChartModel {
  const indexOf = new Map(report.buckets.map((bucket, i) => [bucket, i]));
  const zeros = () => report.buckets.map(() => 0);
  const unpriced = zeros();
  for (const point of report.series) {
    const i = indexOf.get(point.bucket_start);
    if (i !== undefined) unpriced[i] += point.unpriced_requests;
  }

  let series: BarSeries[];
  if (groupBy === "token_type") {
    const values: Record<TokenTypeKey, number[]> = {
      cache_read: zeros(),
      cache_write: zeros(),
      output: zeros(),
      input: zeros(),
    };
    for (const point of report.series) {
      const i = indexOf.get(point.bucket_start);
      if (i === undefined) continue;
      if (kind === "cost") {
        const parts = point.cost_parts_usd_micros;
        values.cache_read[i] += parts.cache_read;
        values.cache_write[i] += parts.cache_write;
        values.output[i] += parts.output;
        values.input[i] += parts.input;
      } else {
        values.cache_read[i] += point.cache_read_tokens;
        values.cache_write[i] += point.cache_write_tokens;
        values.output[i] += point.output_tokens;
        values.input[i] += point.input_tokens;
      }
    }
    series = TOKEN_ORDER.map((type) => ({
      key: type,
      label: TOKEN_TYPE_LABELS[type],
      color: TOKEN_TYPE_COLORS[type],
      values: values[type],
    }));
  } else {
    const groups: UsageGroup[] =
      kind === "cost"
        ? [...report.groups].sort(
            (a, b) => b.cost_usd_micros - a.cost_usd_micros || tokensOf(b) - tokensOf(a) || a.key.localeCompare(b.key),
          )
        : report.groups;
    const named = groups.slice(0, MAX_NAMED_SERIES);
    const tail = groups.slice(MAX_NAMED_SERIES);
    const colors = assignSeriesColors(named.map((g) => g.key));
    const tailKeys = new Set(tail.map((g) => g.key));
    const metric = (p: UsageReport["series"][number]) => (kind === "cost" ? p.cost_usd_micros : tokensOf(p));
    series = named.map((group) => {
      const values = zeros();
      for (const point of report.series) {
        if (point.key !== group.key) continue;
        const i = indexOf.get(point.bucket_start);
        if (i !== undefined) values[i] += metric(point);
      }
      return { key: group.key, label: group.label, color: colors.get(group.key) ?? OTHER_COLOR, values };
    });
    if (tail.length > 0) {
      const values = zeros();
      for (const point of report.series) {
        if (!tailKeys.has(point.key)) continue;
        const i = indexOf.get(point.bucket_start);
        if (i !== undefined) values[i] += metric(point);
      }
      series.push({ key: OTHER_KEY, label: "Остальные", color: OTHER_COLOR, values });
    }
  }

  return {
    series,
    legend: series.map((s) => ({ key: s.key, label: s.label, color: s.color })),
    columns: series.map((s) => ({ key: s.key, label: s.label })),
    unpriced,
  };
}

function usageTiles(report: UsageReport | undefined): StatTile[] {
  const t = report?.totals;
  const empty = !t || t.requests === 0;
  return [
    {
      id: "in",
      label: TEXT.usage.tileIn,
      value: formatTokens(t ? t.input_tokens + t.cache_read_tokens + t.cache_write_tokens : 0),
      note: `из них из кэша: ${formatTokens(t?.cache_read_tokens ?? 0)}`,
      empty,
    },
    { id: "out", label: TEXT.usage.tileOut, value: formatTokens(t?.output_tokens ?? 0), empty },
    {
      id: "requests",
      label: TEXT.usage.tileRequests,
      value: formatTokens(t?.requests ?? 0),
      note: `из них с ошибкой: ${formatTokens(t?.errors ?? 0)}`,
      empty,
    },
  ];
}

function costTiles(report: UsageReport | undefined): StatTile[] {
  const t = report?.totals;
  const parts = t?.cost_parts_usd_micros;
  const empty = !t || t.requests === 0;
  return [
    {
      id: "total",
      label: TEXT.cost.tileTotal,
      value: formatUsd(t?.cost_usd_micros ?? 0),
      hint: TEXT.cost.tileTotalHint,
      empty,
    },
    { id: "io", label: TEXT.cost.tileTokens, value: formatUsd((parts?.input ?? 0) + (parts?.output ?? 0)), empty },
    { id: "cache", label: TEXT.cost.tileCache, value: formatUsd((parts?.cache_read ?? 0) + (parts?.cache_write ?? 0)), empty },
    {
      id: "unpriced",
      label: TEXT.cost.tileUnpriced,
      value: formatTokens(t?.unpriced_requests ?? 0),
      hint: TEXT.cost.tileUnpricedHint,
      empty,
    },
  ];
}

export interface FacetOptions {
  agents: FilterOption[];
  models: FilterOption[];
  harnesses: FilterOption[];
  cards: FilterOption[];
}

export function facetOptions(facets: AnalyticsFacets | undefined): FacetOptions {
  return {
    agents: (facets?.agents ?? []).map((a) => ({ value: a.id, label: a.name })),
    models: (facets?.models ?? []).map((m) => ({ value: m.key, label: m.key })),
    harnesses: (facets?.harnesses ?? []).map((h) => ({ value: h.key, label: harnessLabel(h.key) })),
    cards: [
      { value: "none", label: NO_CARD_LABEL },
      ...(facets?.cards ?? []).map((c) => ({ value: c.id, label: c.model })),
    ],
  };
}

/**
 * Общее тело «Использования» и «Стоимости»: фильтры, плитки, график с
 * таблицей и выгрузка CSV. Страницы различаются тем, что считается высотой
 * столбца: токены или стоимость.
 */
export function UsageCostLayout({ kind }: { kind: LayoutKind }) {
  const { state, range, patch, reset } = useAnalyticsParams();
  const bucket = bucketFor(range.from, range.to);
  const apiGroup: UsageGroupBy = state.group_by === "token_type" ? "none" : state.group_by;
  const filters = toApiFilters(state);

  const facets = useAnalyticsFacets(range.from, range.to);
  const options = useMemo(() => facetOptions(facets.data), [facets.data]);
  const report = useUsageReport({ from: range.from, to: range.to, bucket, group_by: apiGroup, ...filters });
  const csv = useAnalyticsCsv();

  const data = report.data;
  const model = useMemo(
    () => (data ? buildChartModel(data, kind, state.group_by) : null),
    [data, kind, state.group_by],
  );

  const copy = kind === "usage" ? TEXT.usage : TEXT.cost;
  const unsupported = isAnalyticsUnsupported(report.error);
  const failed = report.isError && !data;
  const isEmpty = Boolean(data && data.totals.requests === 0);
  const cost = kind === "cost";

  const formatValue = cost ? formatUsd : formatTokens;
  const formatAxis = cost ? formatUsdAxis : formatCompact;
  const chartLabel = cost ? TEXT.cost.chartLabel(bucket) : TEXT.usage.chartLabel(bucket);

  const exportCsv = () =>
    csv.download(
      `${ANALYTICS_BASE}/usage`,
      { from: range.from, to: range.to, bucket, group_by: apiGroup, ...filters },
      `analytics-usage-${range.from}_${range.to}.csv`,
    );

  const refresh = () => {
    void report.refetch();
    void facets.refetch();
  };

  return (
    <Page
      header={
        <AnalyticsHeader
          title={copy.title}
          description={copy.description}
          latestEndedAt={data?.latest_ended_at}
          onRefresh={refresh}
          refreshing={report.isFetching}
        />
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        {!unsupported && (
          <FilterBar
            showReset={hasActiveFilters(state)}
            onReset={reset}
            onExport={exportCsv}
            exporting={csv.pending}
          >
            <RangeFilter value={state.range} onChange={(next) => patch({ range: next })} />
            <MultiSelectFilter
              label="Агент"
              options={options.agents}
              selected={state.agent_id}
              onChange={(next) => patch({ agent_id: next })}
            />
            <MultiSelectFilter
              label="Модель"
              options={options.models}
              selected={state.model}
              onChange={(next) => patch({ model: next })}
            />
            <MultiSelectFilter
              label="Harness"
              options={options.harnesses}
              selected={state.harness}
              onChange={(next) => patch({ harness: next })}
            />
            <MultiSelectFilter
              label="Карточка"
              options={options.cards}
              selected={state.card_id}
              onChange={(next) => patch({ card_id: next })}
            />
            <FilterDivider />
            <SingleSelectFilter
              label="Группировать по"
              options={USAGE_GROUP_OPTIONS}
              value={state.group_by}
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
            <StatTiles
              tiles={cost ? costTiles(data) : usageTiles(data)}
              columns={cost ? 4 : 3}
              loading={report.isPending}
            />
            {isEmpty ? (
              <EmptyState icon={<ChartColumnIcon />} title={TEXT.common.empty} />
            ) : (
              <ChartCard
                title={cost ? TEXT.cost.chartTitle(bucket) : TEXT.usage.chartTitle}
                description={cost ? TEXT.cost.chartDescription : TEXT.usage.chartDescription(bucket)}
                loading={report.isPending || !data || !model}
                dimmed={report.isPlaceholderData}
                legend={model ? <Legend items={model.legend} /> : null}
                chart={
                  data && model ? (
                    <StackedBarChart
                      buckets={data.buckets}
                      series={model.series}
                      ariaLabel={chartLabel}
                      formatValue={formatValue}
                      formatAxis={formatAxis}
                      formatTitle={bucket === "day" ? formatDayUtc : formatHourUtc}
                      formatLabel={bucket === "day" ? formatAxisDay : formatAxisHour}
                      footer={
                        cost
                          ? (i) => {
                              const n = model.unpriced[i] ?? 0;
                              return n > 0
                                ? `Без цены: ${n} ${pluralRu(n, "запрос", "запроса", "запросов")}`
                                : null;
                            }
                          : undefined
                      }
                      onBucketClick={
                        bucket === "day"
                          ? (iso) => patch({ range: zoomToDay(iso.slice(0, 10)) })
                          : undefined
                      }
                    />
                  ) : null
                }
                table={
                  data && model ? (
                    <SeriesTable
                      caption={chartLabel}
                      firstColumnLabel={bucket === "day" ? "Дата (UTC)" : "Время (UTC)"}
                      columns={model.columns}
                      rows={data.buckets.map((b, i) => ({
                        key: b,
                        label: bucket === "day" ? formatDayUtc(b) : formatHourUtc(b),
                        values: model.series.map((s) => s.values[i] ?? 0),
                      }))}
                      formatValue={formatValue}
                    />
                  ) : null
                }
              />
            )}
          </>
        )}
      </div>
    </Page>
  );
}
