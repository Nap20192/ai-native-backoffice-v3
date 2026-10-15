import type { KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

import { Skeleton } from "../../components/Skeleton";
import {
  formatExactUtc,
  formatLatency,
  formatRelative,
  formatTokens,
  formatUsd,
} from "../../components/analytics/analytics-format";
import { CopyableId } from "../../components/analytics/CopyableId";
import type { ModelCallRecord } from "../../lib/analytics-api";
import { SPEED_LABELS } from "./analytics-text";

const COLUMNS: Array<{ label: string; align: "left" | "right" }> = [
  { label: "ID", align: "left" },
  { label: "Статус", align: "left" },
  { label: "Время", align: "left" },
  { label: "Агент", align: "left" },
  { label: "Модель", align: "left" },
  { label: "Вход", align: "right" },
  { label: "Выход", align: "right" },
  { label: "Задержка", align: "right" },
  { label: "Стоимость", align: "right" },
  { label: "Скорость", align: "left" },
];

const SKELETON_ROWS = 20;

/** Вход записи журнала: без кэша, чтение и запись кэша. */
export function inputTokens(call: ModelCallRecord): number {
  return call.input_tokens + call.cache_read_tokens + call.cache_write_tokens;
}

/**
 * Таблица журнала запросов. Колонка ID закреплена слева, остальные
 * прокручиваются внутри контейнера, поэтому страница на 390 px не получает
 * горизонтальной прокрутки. Строка открывает карточку записи по клику и по
 * Enter.
 */
export function LogTable({
  rows,
  selectedId,
  onSelect,
  loading = false,
  now = new Date(),
}: {
  rows: ModelCallRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
  loading?: boolean;
  now?: Date;
}) {
  const onKey = (event: KeyboardEvent<HTMLTableRowElement>, id: string) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table aria-busy={loading || undefined} aria-label="Журнал запросов" className="w-full min-w-[920px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-ddc-divider text-xs text-ddc-text-muted">
            {COLUMNS.map((column, i) => (
              <th
                key={column.label}
                scope="col"
                className={cn(
                  "px-3 py-2 font-medium whitespace-nowrap",
                  column.align === "right" ? "text-right" : "text-left",
                  i === 0 && "sticky left-0 z-10 bg-ddc-surface",
                )}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <tr key={i} className="border-b border-ddc-divider last:border-b-0">
                  {COLUMNS.map((column, c) => (
                    <td key={column.label} className={cn("px-3 py-2.5", c === 0 && "sticky left-0 bg-ddc-surface")}>
                      <Skeleton className={cn("h-4", c === 0 ? "w-36" : "w-16", column.align === "right" && "ml-auto")} />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((call) => {
                const selected = call.id === selectedId;
                return (
                  <tr
                    key={call.id}
                    data-row-id={call.id}
                    tabIndex={0}
                    aria-selected={selected}
                    onClick={() => onSelect(call.id)}
                    onKeyDown={(e) => onKey(e, call.id)}
                    className={cn(
                      "group/row cursor-pointer border-b border-ddc-divider transition-colors last:border-b-0 hover:bg-ddc-surface-muted",
                      selected && "bg-ddc-selected-bg hover:bg-ddc-selected-bg",
                    )}
                  >
                    <th
                      scope="row"
                      className={cn(
                        "sticky left-0 z-[1] max-w-56 px-3 py-2.5 text-left font-normal",
                        selected ? "bg-ddc-selected-bg" : "bg-ddc-surface group-hover/row:bg-ddc-surface-muted",
                      )}
                    >
                      <CopyableId id={call.id} />
                    </th>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className={cn("size-2 rounded-full", call.is_error ? "bg-ddc-dot-danger" : "bg-ddc-dot-success")}
                        />
                        {call.is_error ? "Ошибка" : "Успешно"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-ddc-text-muted">
                      <time dateTime={call.ended_at} title={formatExactUtc(call.ended_at)}>
                        {formatRelative(call.ended_at, now)}
                      </time>
                    </td>
                    <td className="max-w-48 truncate px-3 py-2.5" title={call.agent.name}>
                      {call.agent.name}
                    </td>
                    <td className="max-w-56 truncate px-3 py-2.5" title={call.model}>
                      {call.model}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatTokens(inputTokens(call))}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatTokens(call.output_tokens)}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                      {formatLatency(call.latency_ms)}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                      {formatUsd(call.cost_usd_micros)}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">{SPEED_LABELS[call.speed]}</td>
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}
