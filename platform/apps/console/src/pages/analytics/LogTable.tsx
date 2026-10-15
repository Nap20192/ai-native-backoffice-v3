import type { KeyboardEvent } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { ROW_HEAD, TABLE_HEAD } from "../../components/analytics/SeriesTable";
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
    <Table aria-busy={loading || undefined} aria-label="Журнал запросов" className="min-w-[920px] border-collapse">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {COLUMNS.map((column, i) => (
            <TableHead
              key={column.label}
              scope="col"
              className={cn(
                TABLE_HEAD,
                column.align === "right" ? "text-right" : "text-left",
                i === 0 && "sticky left-0 z-10 bg-ddc-surface",
              )}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading
          ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <TableRow key={i} className="hover:bg-transparent">
                {COLUMNS.map((column, c) => (
                  <TableCell key={column.label} className={cn(c === 0 && "sticky left-0 bg-ddc-surface")}>
                    <Skeleton className={cn("h-4", c === 0 ? "w-36" : "w-16", column.align === "right" && "ml-auto")} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : rows.map((call) => {
              const selected = call.id === selectedId;
              return (
                <TableRow
                  key={call.id}
                  data-row-id={call.id}
                  data-state={selected ? "selected" : undefined}
                  tabIndex={0}
                  aria-selected={selected}
                  onClick={() => onSelect(call.id)}
                  onKeyDown={(e) => onKey(e, call.id)}
                  className="group/row cursor-pointer hover:bg-ddc-surface-muted data-[state=selected]:hover:bg-ddc-selected-bg"
                >
                  <TableHead
                    scope="row"
                    className={cn(
                      ROW_HEAD,
                      "sticky left-0 z-[1] max-w-56",
                      selected ? "bg-ddc-selected-bg" : "bg-ddc-surface group-hover/row:bg-ddc-surface-muted",
                    )}
                  >
                    <CopyableId id={call.id} />
                  </TableHead>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={cn("size-2 rounded-full", call.is_error ? "bg-ddc-dot-danger" : "bg-ddc-dot-success")}
                      />
                      {call.is_error ? "Ошибка" : "Успешно"}
                    </span>
                  </TableCell>
                  <TableCell className="text-ddc-text-muted">
                    <time dateTime={call.ended_at} title={formatExactUtc(call.ended_at)}>
                      {formatRelative(call.ended_at, now)}
                    </time>
                  </TableCell>
                  <TableCell className="max-w-48 truncate" title={call.agent.name}>
                    {call.agent.name}
                  </TableCell>
                  <TableCell className="max-w-56 truncate" title={call.model}>
                    {call.model}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatTokens(inputTokens(call))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatTokens(call.output_tokens)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatLatency(call.latency_ms)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(call.cost_usd_micros)}</TableCell>
                  <TableCell>{SPEED_LABELS[call.speed]}</TableCell>
                </TableRow>
              );
            })}
      </TableBody>
    </Table>
  );
}
