import { SearchIcon, TimerIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo, type KeyboardEvent } from "react";
import { Link } from "react-router";

import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { EmptyState } from "../../components/EmptyState";
import { LoadError } from "../../components/LoadError";
import { Page } from "../../components/Page";
import { SkeletonRows } from "../../components/Skeleton";
import { formatCompact, formatPercent } from "../../components/analytics/analytics-format";
import { AnalyticsHeader } from "../../components/analytics/AnalyticsHeader";
import { FilterBar } from "../../components/analytics/FilterBar";
import { InfoHint } from "../../components/analytics/InfoHint";
import { ROW_HEAD, TABLE_HEAD } from "../../components/analytics/SeriesTable";
import { UsageMeter } from "../../components/analytics/UsageMeter";
import { useAnalyticsParams } from "../../components/analytics/use-analytics-params";
import {
  isAnalyticsUnsupported,
  useLimitsReport,
  type LimitCard,
  type LimitMetric,
  type LimitsReport,
  type Quota,
  type UncardedModel,
} from "../../lib/analytics-api";
import { LimitDrawer } from "./LimitDrawer";
import { METRIC_LABELS, METRIC_ORDER, NO_CARD_LABEL, TEXT } from "./analytics-text";

const UNCARDED_HINT = "Лимит задаётся в карточке модели, у встроенной модели карточки нет.";

interface Group {
  id: string;
  /** Карточка группы или `null` для модели без карточки. */
  card: LimitCard | null;
  title: string;
  handle: string;
  quotas: Quota[];
}

function orderedQuotas(quotas: Quota[]): Quota[] {
  return METRIC_ORDER.map((metric) => quotas.find((q) => q.metric === metric)).filter(
    (q): q is Quota => q !== undefined,
  );
}

function groupsOf(report: LimitsReport): { cards: Group[]; uncarded: Group[] } {
  return {
    cards: report.cards.map((card) => ({
      id: card.card_id,
      card,
      title: card.label,
      handle: card.model,
      quotas: orderedQuotas(card.quotas),
    })),
    uncarded: report.uncarded.map((model: UncardedModel) => ({
      id: `uncarded:${model.model}`,
      card: null,
      title: model.label,
      handle: model.model,
      quotas: orderedQuotas(model.quotas),
    })),
  };
}

/** Строки группы по поиску: группа подошла, видны все строки, иначе только подошедшие по названию квоты. */
function filterGroup(group: Group, extra: string[], needle: string): Group | null {
  if (!needle) return group;
  const haystack = [group.title, group.handle, ...extra].join(" ").toLowerCase();
  if (haystack.includes(needle)) return group;
  const quotas = group.quotas.filter((q) => METRIC_LABELS[q.metric].toLowerCase().includes(needle));
  return quotas.length > 0 ? { ...group, quotas } : null;
}

function QuotaCells({ quota, group }: { quota: Quota; group: Group }) {
  const label = METRIC_LABELS[quota.metric];
  return (
    <>
      <TableHead scope="row" className={cn(ROW_HEAD, "whitespace-normal")}>
        {label}
      </TableHead>
      <TableCell>
        {quota.utilization !== null && (
          <div className="flex items-center gap-3">
            <UsageMeter
              ratio={quota.utilization}
              label={`${group.title}, ${label}, пиковая загрузка`}
              className="max-w-[334px] min-w-24"
            />
            <span className="w-10 shrink-0 text-right text-sm tabular-nums">
              {formatPercent(quota.utilization, 0)}
            </span>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="font-semibold text-ddc-heading">{formatCompact(quota.peak)}</span>
        {" / "}
        <span>{quota.limit === null ? "не задан" : formatCompact(quota.limit)}</span>
      </TableCell>
    </>
  );
}

/** Страница «Лимиты»: пиковая загрузка квот карточек за 24 часа. */
export function LimitsPage() {
  const { state, patch, reset } = useAnalyticsParams();
  const report = useLimitsReport();
  const data = report.data;

  const needle = state.q.trim().toLowerCase();
  const { cards, uncarded } = useMemo(() => {
    if (!data) return { cards: [] as Group[], uncarded: [] as Group[] };
    const all = groupsOf(data);
    const cardGroups = all.cards
      .map((g) => filterGroup(g, [g.card?.wire_model ?? "", g.card?.provider ?? ""], needle))
      .filter((g): g is Group => g !== null);
    // Название группы «Без карточки» тоже находится поиском.
    const uncardedMatches = NO_CARD_LABEL.toLowerCase().includes(needle);
    const uncardedGroups = all.uncarded
      .map((g) => (uncardedMatches ? g : filterGroup(g, [], needle)))
      .filter((g): g is Group => g !== null);
    return { cards: cardGroups, uncarded: uncardedGroups };
  }, [data, needle]);

  const clickableIds = useMemo(
    () => cards.flatMap((g) => g.quotas.map((q) => `${g.id}:${q.metric}`)),
    [cards],
  );

  const sep = state.focus.lastIndexOf(":");
  const focusCardId = sep > 0 ? state.focus.slice(0, sep) : "";
  const focusMetric = (sep > 0 ? state.focus.slice(sep + 1) : "") as LimitMetric;
  const focusCard = data?.cards.find((c) => c.card_id === focusCardId);
  const focusValid = Boolean(focusCard && METRIC_ORDER.includes(focusMetric));
  const focusIndex = focusValid ? clickableIds.indexOf(state.focus) : -1;

  const unsupported = isAnalyticsUnsupported(report.error);
  const failed = report.isError && !data;
  const nothing = Boolean(data && data.cards.length === 0 && data.uncarded.length === 0);
  const noMatch = Boolean(data && !nothing && cards.length === 0 && uncarded.length === 0);

  const open = (id: string) => patch({ focus: id });
  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open(id);
    }
  };

  return (
    <Page
      header={
        <AnalyticsHeader
          title={TEXT.limits.title}
          description={TEXT.limits.description}
          latestEndedAt={data?.generated_at}
          onRefresh={() => void report.refetch()}
          refreshing={report.isFetching}
        />
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        {!unsupported && (
          <FilterBar sticky showReset={state.q !== ""} onReset={reset}>
            <div className="relative">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ddc-icon-muted"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label="Найти квоту"
                placeholder="Найти квоту"
                value={state.q}
                onChange={(e) => patch({ q: e.target.value })}
                className="h-8 w-52 rounded-lg py-[7px] pr-2.5 pl-8 text-xs leading-4"
              />
            </div>
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
        ) : report.isPending ? (
          <div data-testid="limits-loading" aria-busy="true" className="card p-2">
            <SkeletonRows count={9} height={36} />
          </div>
        ) : nothing ? (
          <EmptyState
            icon={<TimerIcon />}
            title="Карточек моделей нет. Добавьте карточку, чтобы задать лимиты."
            action={
              <Link to="/model-cards" className="btn-outline btn-sm">
                Открыть карточки моделей
              </Link>
            }
          />
        ) : noMatch ? (
          <EmptyState icon={<SearchIcon />} size="sm" title="Квоты по запросу не найдены." />
        ) : (
          <div className="card min-w-0 p-2">
            <Table className="min-w-[640px] border-collapse">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className={cn(TABLE_HEAD, "sticky left-0 z-10 w-[42%] bg-ddc-surface")}>
                    Квота
                  </TableHead>
                  <TableHead scope="col" className={cn(TABLE_HEAD, "w-[34%]")}>
                    <span className="inline-flex items-center gap-1">
                      Пиковая загрузка
                      <InfoHint subject="Пиковая загрузка">
                        Наибольшая загрузка одной минуты за 24 часа, делённая на лимит карточки.
                      </InfoHint>
                    </span>
                  </TableHead>
                  <TableHead scope="col" className={cn(TABLE_HEAD, "w-[24%] text-right")}>
                    Использовано / лимит
                  </TableHead>
                </TableRow>
              </TableHeader>
              {cards.map((group) => (
                <TableBody key={group.id} className="border-b border-ddc-divider last:border-b-0">
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableHead scope="rowgroup" colSpan={3} className="h-auto pt-4 pb-1.5 normal-case tracking-normal">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-semibold text-ddc-heading">{group.title}</span>
                        <span className="font-mono text-xs font-normal text-ddc-text-muted">{group.handle}</span>
                        {group.card?.is_default && <span className="chip tone-brand">По умолчанию</span>}
                      </div>
                    </TableHead>
                  </TableRow>
                  {group.quotas.map((quota) => {
                    const id = `${group.id}:${quota.metric}`;
                    const selected = state.focus === id;
                    return (
                      <TableRow
                        key={id}
                        data-row-id={id}
                        data-state={selected ? "selected" : undefined}
                        tabIndex={0}
                        aria-selected={selected}
                        onClick={() => open(id)}
                        onKeyDown={(e) => onRowKey(e, id)}
                        className="cursor-pointer border-0 hover:bg-ddc-surface-muted data-[state=selected]:hover:bg-ddc-selected-bg"
                      >
                        <QuotaCells quota={quota} group={group} />
                      </TableRow>
                    );
                  })}
                </TableBody>
              ))}
              {uncarded.length > 0 && (
                <TableBody data-uncarded>
                  <TableRow className="border-0 hover:bg-transparent">
                    <TableHead scope="rowgroup" colSpan={3} className="h-auto pt-5 pb-1 normal-case tracking-normal">
                      <span className="inline-flex items-center gap-1 text-sm font-semibold text-ddc-heading">
                        {NO_CARD_LABEL}
                        <InfoHint subject={NO_CARD_LABEL}>{UNCARDED_HINT}</InfoHint>
                      </span>
                    </TableHead>
                  </TableRow>
                  {uncarded.map((group) => (
                    <UncardedGroup key={group.id} group={group} />
                  ))}
                </TableBody>
              )}
            </Table>
          </div>
        )}

        {focusValid && focusCard && (
          <LimitDrawer
            card={focusCard}
            metric={focusMetric}
            prevId={focusIndex > 0 ? clickableIds[focusIndex - 1] : null}
            nextId={focusIndex >= 0 && focusIndex < clickableIds.length - 1 ? clickableIds[focusIndex + 1] : null}
            onNavigate={open}
            onClose={() => patch({ focus: "" })}
          />
        )}
      </div>
    </Page>
  );
}

function UncardedGroup({ group }: { group: Group }) {
  return (
    <>
      <TableRow className="border-0 hover:bg-transparent">
        <TableHead scope="rowgroup" colSpan={3} className="h-auto pt-3 pb-1 normal-case tracking-normal">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-medium text-ddc-heading">{group.title}</span>
            <span className="font-mono text-xs font-normal text-ddc-text-muted">{group.handle}</span>
          </div>
        </TableHead>
      </TableRow>
      {group.quotas.map((quota) => (
        <TableRow key={`${group.id}:${quota.metric}`} className="border-0 hover:bg-transparent">
          <QuotaCells quota={quota} group={group} />
        </TableRow>
      ))}
    </>
  );
}
