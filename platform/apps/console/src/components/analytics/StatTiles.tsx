import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { Skeleton } from "../Skeleton";
import { InfoHint } from "./InfoHint";

export interface StatTile {
  id: string;
  label: string;
  /** Готовая строка значения: «1 611 100», «$0,0127». */
  value: string;
  /** Строка пояснения под значением. */
  note?: ReactNode;
  /** Подсказка у значка «i». */
  hint?: string;
  /** За период нет данных: в углу плитки подпись «Нет данных». */
  empty?: boolean;
}

/**
 * Плитки показателей (`.kpi` DDC). Сетка на 3 или 4 колонки, на телефоне одна.
 * Плитка без кнопки: заголовок, значение 30 px, пояснение, значок «i».
 */
export function StatTiles({
  tiles,
  loading = false,
  columns = 3,
}: {
  tiles: StatTile[];
  loading?: boolean;
  columns?: 3 | 4;
}) {
  return (
    <div
      data-testid="stat-tiles"
      aria-busy={loading || undefined}
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2",
        columns === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3",
      )}
    >
      {tiles.map((tile) => (
        <div key={tile.id} role="group" aria-label={tile.label} className="kpi">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <span className="kpi-label">{tile.label}</span>
              {tile.hint && <InfoHint subject={tile.label}>{tile.hint}</InfoHint>}
            </div>
            {!loading && tile.empty && (
              <span className="shrink-0 text-xs text-ddc-text-muted">Нет данных</span>
            )}
          </div>
          {loading ? (
            <>
              <Skeleton className="h-9 w-32" />
              <Skeleton className="h-4 w-40" />
            </>
          ) : (
            <>
              <div
                title={tile.value}
                className="truncate text-3xl leading-9 font-bold tracking-tight tabular-nums text-ddc-heading"
              >
                {tile.value}
              </div>
              {tile.note ? (
                <div className="text-xs text-ddc-text-muted tabular-nums">{tile.note}</div>
              ) : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
