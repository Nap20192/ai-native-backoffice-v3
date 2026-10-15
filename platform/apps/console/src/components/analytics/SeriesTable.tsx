import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import type { SeriesColor } from "./series-colors";

/** Заголовок колонки аналитики: тише базового (без заглавных и разрядки), высота по тексту. */
export const TABLE_HEAD =
  "h-auto px-3 py-2 text-xs font-medium tracking-normal text-ddc-text-muted normal-case";

/** Ячейка-заголовок строки: обычный текст, а не заголовок колонки. */
export const ROW_HEAD =
  "h-auto px-3 py-2.5 text-sm font-normal tracking-normal text-ddc-text normal-case";

export interface SeriesTableColumn {
  key: string;
  label: string;
  color?: SeriesColor;
}

export interface SeriesTableRow {
  key: string;
  /** Первая колонка: дата или время (UTC). */
  label: string;
  /** Значения по колонкам. `null` значит «нет значения» (линия рвётся). */
  values: Array<number | null>;
}

/**
 * Таблица-двойник графика: «Дата (UTC)» или «Время (UTC)», по колонке на ряд
 * и «Итого». Числа справа, нули показаны, сортировки нет. Контейнер 300 px
 * прокручивается, у нижнего края затухание. Первая колонка закреплена, чтобы
 * на телефоне дата оставалась на месте при горизонтальной прокрутке.
 */
export function SeriesTable({
  firstColumnLabel,
  columns,
  rows,
  formatValue,
  emptyLabel = "нет",
  totalLabel = "Итого",
  showTotal = true,
  caption,
}: {
  firstColumnLabel: string;
  columns: SeriesTableColumn[];
  rows: SeriesTableRow[];
  formatValue: (value: number) => string;
  /** Подпись пустой ячейки. */
  emptyLabel?: string;
  totalLabel?: string;
  showTotal?: boolean;
  caption: string;
}) {
  return (
    <div className="relative">
      <div className="max-h-[300px] overflow-auto rounded-xl border border-ddc-divider">
        <Table container={false} className="w-full min-w-max border-collapse tabular-nums">
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader className="sticky top-0 z-10 bg-ddc-surface">
            <TableRow className="hover:bg-transparent">
              <TableHead scope="col" className={cn(TABLE_HEAD, "sticky left-0 bg-ddc-surface")}>
                {firstColumnLabel}
              </TableHead>
              {columns.map((column) => (
                <TableHead key={column.key} scope="col" className={cn(TABLE_HEAD, "text-right")}>
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {column.color && (
                      <span aria-hidden="true" className={cn("size-2 rounded-sm", column.color.bg)} />
                    )}
                    {column.label}
                  </span>
                </TableHead>
              ))}
              {showTotal && (
                <TableHead scope="col" className={cn(TABLE_HEAD, "text-right font-semibold text-ddc-text")}>
                  {totalLabel}
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key} className="hover:bg-ddc-surface-muted">
                <TableHead scope="row" className={cn(ROW_HEAD, "sticky left-0 bg-ddc-surface whitespace-nowrap")}>
                  {row.label}
                </TableHead>
                {row.values.map((value, i) => (
                  <TableCell key={columns[i]?.key ?? i} className="text-right">
                    {value === null ? (
                      <span className="text-ddc-text-muted">{emptyLabel}</span>
                    ) : (
                      formatValue(value)
                    )}
                  </TableCell>
                ))}
                {showTotal && (
                  <TableCell className="text-right font-semibold text-ddc-heading">
                    {formatValue(row.values.reduce<number>((sum, v) => sum + (v ?? 0), 0))}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-px bottom-px h-8 rounded-b-xl bg-linear-to-t from-ddc-surface to-transparent"
      />
    </div>
  );
}
