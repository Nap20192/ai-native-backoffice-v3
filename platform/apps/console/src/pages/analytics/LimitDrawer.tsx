import { PencilIcon } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { LoadError } from "../../components/LoadError";
import { Skeleton } from "../../components/Skeleton";
import {
  formatAxisDay,
  formatCompact,
  formatHourUtc,
  formatPercent,
  formatTokens,
} from "../../components/analytics/analytics-format";
import { LineChart } from "../../components/analytics/LineChart";
import { RowInspector } from "../../components/analytics/RowInspector";
import { SERIES_PALETTE } from "../../components/analytics/series-colors";
import { SeriesTable } from "../../components/analytics/SeriesTable";
import { UsageMeter } from "../../components/analytics/UsageMeter";
import { ViewToggle, type ChartView } from "../../components/analytics/ViewToggle";
import {
  useLimitDetail,
  useUpdateCardLimits,
  type CardLimitsInput,
  type LimitBreakdownBy,
  type LimitCard,
  type LimitDetail,
  type LimitMetric,
} from "../../lib/analytics-api";
import { METRIC_LABELS, METRIC_UNIT_LABELS, TEXT } from "./analytics-text";

const MAX_LIMIT = 1_000_000_000;

const FIELDS: Array<{
  key: keyof CardLimitsInput;
  label: string;
  metric: LimitMetric;
  error: string;
}> = [
  {
    key: "requests_per_minute",
    label: "Запросов в минуту",
    metric: "rpm",
    error: "Лимит запросов в минуту: целое число от 1 до 1 000 000 000 или пусто.",
  },
  {
    key: "input_tokens_per_minute",
    label: "Токенов на входе в минуту",
    metric: "itpm",
    error: "Лимит токенов на входе в минуту: целое число от 1 до 1 000 000 000 или пусто.",
  },
  {
    key: "output_tokens_per_minute",
    label: "Токенов на выходе в минуту",
    metric: "otpm",
    error: "Лимит токенов на выходе в минуту: целое число от 1 до 1 000 000 000 или пусто.",
  },
];

type FormValues = Record<keyof CardLimitsInput, string>;

/** Разбор поля: пусто снимает лимит, иначе целое от 1 до 1 000 000 000. */
export function parseLimitInput(raw: string): { value: number | null } | { error: true } {
  const text = raw.trim().replace(/\s+/g, "");
  if (text === "") return { value: null };
  if (!/^\d+$/.test(text)) return { error: true };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) return { error: true };
  return { value };
}

function limitOf(card: LimitCard, metric: LimitMetric): number | null {
  return card.quotas.find((q) => q.metric === metric)?.limit ?? null;
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="text-sm font-semibold text-ddc-heading">{children}</h3>;
}

function LimitForm({
  card,
  onDone,
}: {
  card: LimitCard;
  onDone: () => void;
}) {
  const update = useUpdateCardLimits();
  const [values, setValues] = useState<FormValues>(() => ({
    requests_per_minute: String(limitOf(card, "rpm") ?? ""),
    input_tokens_per_minute: String(limitOf(card, "itpm") ?? ""),
    output_tokens_per_minute: String(limitOf(card, "otpm") ?? ""),
  }));
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed: Partial<CardLimitsInput> = {};
    for (const field of FIELDS) {
      const result = parseLimitInput(values[field.key]);
      if ("error" in result) {
        setError(field.error);
        return;
      }
      parsed[field.key] = result.value;
    }
    setError(null);
    try {
      await update.mutateAsync({ cardId: card.card_id, limits: parsed as CardLimitsInput });
      toast.success("Лимиты сохранены");
      onDone();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Не удалось сохранить лимиты.");
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 space-y-3" noValidate>
      {FIELDS.map((field) => (
        <label key={field.key} className="block">
          <span className="label">{field.label}</span>
          <input
            type="text"
            inputMode="numeric"
            value={values[field.key]}
            placeholder="Без лимита"
            onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
            aria-invalid={error?.startsWith(`Лимит ${field.label.toLowerCase()}`) ? true : undefined}
            className="input input-sm"
          />
        </label>
      ))}
      <p className="text-xs text-ddc-text-muted">Пустое поле значит без лимита. Платформа не останавливает вызовы.</p>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Отмена
        </Button>
        <Button type="submit" size="sm" loading={update.isPending}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}

function BreakdownTable({ detail, by }: { detail: LimitDetail; by: LimitBreakdownBy }) {
  const total = detail.breakdown;
  return (
    <div className="overflow-x-auto">
      <table aria-label="Разбивка на момент пика" className="w-full min-w-[420px] text-sm tabular-nums">
        <thead>
          <tr className="border-b border-ddc-divider text-xs text-ddc-text-muted">
            <th scope="col" className="sticky left-0 bg-ddc-surface px-3 py-2 text-left font-medium">
              {by === "agent" ? "Агент" : "Сессия"}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Пик</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">% лимита</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Доля</th>
          </tr>
        </thead>
        <tbody>
          {total.rows.map((row) => (
            <tr key={row.key} className="border-b border-ddc-divider">
              <th scope="row" className="sticky left-0 max-w-56 truncate bg-ddc-surface px-3 py-2 text-left font-normal">
                {by === "session" ? (
                  <Link to={`/sessions/${encodeURIComponent(row.key)}`} className="link font-mono text-xs">
                    {row.label}
                  </Link>
                ) : (
                  <span title={row.label}>{row.label}</span>
                )}
              </th>
              <td className="px-3 py-2 text-right">{formatTokens(row.value)}</td>
              <td className="px-3 py-2 text-right">{formatPercent(row.utilization, 0)}</td>
              <td className="px-3 py-2 text-right">{formatPercent(row.share, 0)}</td>
            </tr>
          ))}
          <tr className="font-semibold">
            <th scope="row" className="sticky left-0 bg-ddc-surface px-3 py-2 text-left">{TEXT.common.total}</th>
            <td className="px-3 py-2 text-right">{formatTokens(total.total)}</td>
            <td className="px-3 py-2 text-right">{formatPercent(detail.peak_24h.utilization, 0)}</td>
            <td className="px-3 py-2 text-right">{total.rows.length > 0 ? formatPercent(1, 0) : formatPercent(null)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/**
 * Правая панель квоты: лимит карточки с формой правки, пик за 24 часа, линия
 * пиков за семь дней с пунктиром лимита и разбивка на момент пика по агентам
 * или сессиям.
 */
export function LimitDrawer({
  card,
  metric,
  prevId,
  nextId,
  onNavigate,
  onClose,
}: {
  card: LimitCard;
  metric: LimitMetric;
  prevId: string | null;
  nextId: string | null;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  const [by, setBy] = useState<LimitBreakdownBy>("agent");
  const [view, setView] = useState<ChartView>("chart");
  const [editing, setEditing] = useState(false);

  const query = useLimitDetail(card.card_id, metric, by);
  const key = `${card.card_id}:${metric}`;
  const [shown, setShown] = useState<{ key: string; data: LimitDetail } | null>(null);
  useEffect(() => {
    if (query.data) setShown({ key, data: query.data });
  }, [query.data, key]);
  const detail = query.data ?? (shown && shown.key === key ? shown.data : null);

  // Разбивка просит другой разрез, пока приходит ответ: старую таблицу не показываем.
  const breakdownReady = detail !== null && detail.breakdown.by === by;
  const unit = METRIC_UNIT_LABELS[metric];
  const limit = detail?.limit ?? limitOf(card, metric);

  const series = useMemo(
    () =>
      detail
        ? [
            {
              key: "peak",
              label: "Пик за час",
              color: SERIES_PALETTE[0],
              points: detail.series.map((p) => p.peak),
            },
          ]
        : [],
    [detail],
  );

  return (
    <RowInspector
      title="Лимит"
      subtitle="Рабочее пространство"
      width="limit"
      onClose={onClose}
      onPrev={prevId ? () => onNavigate(prevId) : undefined}
      onNext={nextId ? () => onNavigate(nextId) : undefined}
      prevDisabled={!prevId}
      nextDisabled={!nextId}
      returnFocusSelector={`[data-row-id="${key}"]`}
    >
      <div className="space-y-6">
        <header>
          <h2 className="text-base font-semibold text-ddc-heading">
            {card.label} <span className="font-mono text-xs font-normal text-ddc-text-muted">{card.model}</span>
          </h2>
          <p className="text-sm text-ddc-text-muted">{METRIC_LABELS[metric]}</p>
        </header>

        <section className="rounded-xl border border-ddc-divider p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <SectionTitle>Лимит карточки</SectionTitle>
              <p className="mt-1 text-sm tabular-nums" data-testid="limit-value">
                {limit === null ? "не задан" : `${formatTokens(limit)} ${unit}`}
              </p>
            </div>
            {!editing && (
              <Button type="button" variant="outline" size="xs" onClick={() => setEditing(true)}>
                <PencilIcon aria-hidden="true" />
                Изменить
              </Button>
            )}
          </div>
          {editing && <LimitForm card={card} onDone={() => setEditing(false)} />}
        </section>

        {query.isError && !detail ? (
          <LoadError
            size="sm"
            title={TEXT.common.loadErrorTitle}
            message={query.error instanceof Error ? query.error.message : "Повторите попытку."}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : (
          <>
            <section className="space-y-3">
              <SectionTitle>Пик за 24 часа</SectionTitle>
              {detail ? (
                <div data-testid="peak-value">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm tabular-nums">
                    <span>
                      <span className="font-semibold text-ddc-heading">{formatCompact(detail.peak_24h.value)}</span>
                      {" / "}
                      {limit === null ? "не задан" : formatCompact(limit)} {unit}
                    </span>
                    {detail.peak_24h.utilization !== null && (
                      <span className="font-semibold text-ddc-heading">
                        {formatPercent(detail.peak_24h.utilization, 0)}
                      </span>
                    )}
                  </div>
                  {detail.peak_24h.utilization !== null && (
                    <UsageMeter
                      className="mt-2"
                      ratio={detail.peak_24h.utilization}
                      label={`${card.label}, ${METRIC_LABELS[metric]}, пиковая загрузка`}
                    />
                  )}
                </div>
              ) : (
                <Skeleton className="h-10 w-full" />
              )}
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionTitle>Последние 7 дней</SectionTitle>
                <ViewToggle value={view} onChange={setView} />
              </div>
              {!detail ? (
                <Skeleton className="h-[220px] w-full" />
              ) : view === "chart" ? (
                <LineChart
                  buckets={detail.series.map((p) => p.hour_start)}
                  series={series}
                  ariaLabel="Пик загрузки по часам"
                  formatValue={formatTokens}
                  formatAxis={formatCompact}
                  formatTitle={formatHourUtc}
                  formatLabel={formatAxisDay}
                  labelMode="dayStart"
                  limit={detail.limit !== null ? { value: detail.limit, label: "Лимит" } : undefined}
                  height={220}
                />
              ) : (
                <SeriesTable
                  caption="Пик загрузки по часам"
                  firstColumnLabel="Время (UTC)"
                  columns={[
                    { key: "peak", label: "Пик" },
                    { key: "limit", label: "Лимит" },
                  ]}
                  rows={detail.series.map((p) => ({
                    key: p.hour_start,
                    label: formatHourUtc(p.hour_start),
                    values: [p.peak, detail.limit],
                  }))}
                  formatValue={formatTokens}
                  emptyLabel="не задан"
                  showTotal={false}
                />
              )}
            </section>

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <SectionTitle>Разбивка на момент пика</SectionTitle>
                <div role="group" aria-label="Разрез разбивки" className="segmented h-9">
                  {(
                    [
                      ["agent", "По агентам"],
                      ["session", "По сессиям"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={by === id}
                      onClick={() => setBy(id)}
                      className={cn("segmented-item px-3 text-xs")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {breakdownReady && detail ? (
                <BreakdownTable detail={detail} by={by} />
              ) : (
                <Skeleton className="h-24 w-full" />
              )}
            </section>
          </>
        )}
      </div>
    </RowInspector>
  );
}
