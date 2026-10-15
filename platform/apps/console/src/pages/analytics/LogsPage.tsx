import { ChartColumnIcon, RefreshCwIcon, TriangleAlertIcon, XIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";

import { EmptyState } from "../../components/EmptyState";
import { LoadError } from "../../components/LoadError";
import { Page } from "../../components/Page";
import { formatTimeUtc } from "../../components/analytics/analytics-format";
import { hasActiveFilters, toApiFilters } from "../../components/analytics/analytics-params";
import { AnalyticsHeader } from "../../components/analytics/AnalyticsHeader";
import { FilterBar } from "../../components/analytics/FilterBar";
import { MultiSelectFilter } from "../../components/analytics/MultiSelectFilter";
import { RangeFilter } from "../../components/analytics/RangeFilter";
import { SingleSelectFilter } from "../../components/analytics/SingleSelectFilter";
import { useAnalyticsParams } from "../../components/analytics/use-analytics-params";
import {
  ANALYTICS_BASE,
  isAnalyticsUnsupported,
  useAnalyticsCsv,
  useAnalyticsFacets,
  useModelCall,
  useModelCalls,
} from "../../lib/analytics-api";
import { LogTable } from "./LogTable";
import { RequestCard } from "./RequestCard";
import { STATUS_OPTIONS, TEXT } from "./analytics-text";
import { facetOptions } from "./UsageCostLayout";

const PAGE_SIZE = 20;

/** Страница «Журнал запросов»: отдельные вызовы модели, новые сверху. */
export function LogsPage() {
  const { state, range, patch, reset } = useAnalyticsParams();
  const filters = toApiFilters(state);
  const facets = useAnalyticsFacets(range.from, range.to);
  const options = useMemo(() => facetOptions(facets.data), [facets.data]);
  const csv = useAnalyticsCsv();

  const query = {
    from: range.from,
    to: range.to,
    ...filters,
    status: state.status,
    session_id: state.session_id,
    q: state.q,
  };
  const queryKey = JSON.stringify(query);

  // Курсоры страниц лежат стеком. Смена фильтров начинает список заново.
  const [paging, setPaging] = useState<{ key: string; cursors: string[] }>({ key: queryKey, cursors: [] });
  const cursors = paging.key === queryKey ? paging.cursors : [];
  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : null;

  const report = useModelCalls({ ...query, limit: PAGE_SIZE }, cursor);
  const data = report.data;
  const rows = useMemo(() => data?.data ?? [], [data]);

  const pageRow = rows.find((r) => r.id === state.request);
  // Одиночную запись просим, когда список уже загружен и записи в нём нет.
  const single = useModelCall(state.request && !pageRow && !report.isPending ? state.request : null);
  const record = pageRow ?? single.data ?? null;
  const index = pageRow ? rows.indexOf(pageRow) : -1;

  const unsupported = isAnalyticsUnsupported(report.error);
  const failed = report.isError && !data;
  const isEmpty = Boolean(data && rows.length === 0 && cursors.length === 0);

  const goNext = () => {
    if (data?.next_cursor) setPaging({ key: queryKey, cursors: [...cursors, data.next_cursor] });
  };
  const goPrevious = () => setPaging({ key: queryKey, cursors: cursors.slice(0, -1) });

  const exportCsv = () =>
    csv.download(
      `${ANALYTICS_BASE}/model_calls`,
      { ...query },
      `analytics-model-calls-${range.from}_${range.to}.csv`,
    );

  return (
    <Page
      header={
        <AnalyticsHeader
          title={TEXT.logs.title}
          description={TEXT.logs.description}
          latestEndedAt={data?.latest_ended_at}
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
            <SingleSelectFilter
              label="Статус"
              options={STATUS_OPTIONS}
              value={state.status}
              onChange={(next) => patch({ status: next })}
            />
            {state.session_id && (
              <span className="chip tone-brand h-8 gap-1.5 rounded-lg pr-1 pl-3 text-xs">
                <span className="truncate">Сессия: {state.session_id}</span>
                <PlainButton
                  aria-label="Убрать фильтр по сессии"
                  title="Убрать фильтр по сессии"
                  onClick={() => patch({ session_id: "" })}
                  className="inline-flex size-6 items-center justify-center rounded-md hover:bg-ddc-tone-brand-ring"
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </PlainButton>
              </span>
            )}
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
        ) : isEmpty ? (
          <EmptyState icon={<ChartColumnIcon />} title={TEXT.common.empty} />
        ) : (
          <div className="card min-w-0 p-2">
            <div className={report.isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
              <LogTable
                rows={rows}
                selectedId={state.request}
                onSelect={(id) => patch({ request: id })}
                loading={report.isPending}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-3 pt-3 pb-1">
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label="Предыдущая страница"
                  title="Предыдущая страница"
                  disabled={cursors.length === 0}
                  onClick={goPrevious}
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label="Следующая страница"
                  title="Следующая страница"
                  disabled={!data?.next_cursor}
                  onClick={goNext}
                >
                  <ChevronRightIcon />
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-ddc-text-muted">
                {report.dataUpdatedAt > 0 && (
                  <span className="tabular-nums">На момент {formatTimeUtc(report.dataUpdatedAt)}</span>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Обновить"
                  title="Обновить"
                  loading={report.isFetching && !report.isPending}
                  onClick={() => void report.refetch()}
                >
                  <RefreshCwIcon />
                </Button>
              </div>
            </div>
          </div>
        )}

        {state.request && !unsupported && (
          <RequestCard
            id={state.request}
            record={record}
            loading={single.isPending}
            error={single.error instanceof Error ? single.error : null}
            onRetry={() => void single.refetch()}
            prevId={index > 0 ? rows[index - 1].id : null}
            nextId={index >= 0 && index < rows.length - 1 ? rows[index + 1].id : null}
            onNavigate={(id) => patch({ request: id })}
            onClose={() => patch({ request: "" })}
          />
        )}
      </div>
    </Page>
  );
}
