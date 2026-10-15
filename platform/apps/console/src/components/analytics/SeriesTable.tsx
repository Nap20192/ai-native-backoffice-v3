import { cn } from "@/lib/utils";

import type { SeriesColor } from "./series-colors";

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
        <table className="w-full min-w-max border-collapse text-sm tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-10 bg-ddc-surface">
            <tr className="border-b border-ddc-divider text-xs text-ddc-text-muted">
              <th scope="col" className="sticky left-0 bg-ddc-surface px-3 py-2 text-left font-medium">
                {firstColumnLabel}
              </th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {column.color && (
                      <span aria-hidden="true" className={cn("size-2 rounded-sm", column.color.bg)} />
                    )}
                    {column.label}
                  </span>
                </th>
              ))}
              {showTotal && (
                <th scope="col" className="px-3 py-2 text-right font-semibold text-ddc-text">
                  {totalLabel}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-ddc-divider last:border-b-0">
                <th
                  scope="row"
                  className="sticky left-0 whitespace-nowrap bg-ddc-surface px-3 py-2 text-left font-normal"
                >
                  {row.label}
                </th>
                {row.values.map((value, i) => (
                  <td key={columns[i]?.key ?? i} className="px-3 py-2 text-right">
                    {value === null ? (
                      <span className="text-ddc-text-muted">{emptyLabel}</span>
                    ) : (
                      formatValue(value)
                    )}
                  </td>
                ))}
                {showTotal && (
                  <td className="px-3 py-2 text-right font-semibold text-ddc-heading">
                    {formatValue(row.values.reduce<number>((sum, v) => sum + (v ?? 0), 0))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-px bottom-px h-8 rounded-b-xl bg-linear-to-t from-ddc-surface to-transparent"
      />
    </div>
  );
}
