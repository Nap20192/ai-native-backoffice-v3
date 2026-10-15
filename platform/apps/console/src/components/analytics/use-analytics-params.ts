import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";

import {
  parseAnalyticsParams,
  resetFilters,
  resolveRange,
  serializeAnalyticsParams,
  type AnalyticsState,
  type DateRange,
} from "./analytics-params";

/**
 * Состояние фильтров аналитики из адреса страницы. Каждая правка пишет адрес
 * с `replace: true`, чтобы шаги по фильтрам не засоряли историю браузера.
 * Значения по умолчанию в адрес не попадают.
 */
export function useAnalyticsParams() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseAnalyticsParams(searchParams), [searchParams]);

  // Границы периода зависят только от строк адреса и сегодняшнего дня.
  const todayKey = new Date().toISOString().slice(0, 10);
  const range = useMemo<DateRange>(
    () => resolveRange(state.range, new Date(`${todayKey}T12:00:00.000Z`)),
    [state.range, todayKey],
  );

  const patch = useCallback(
    (changes: Partial<AnalyticsState>) => {
      setSearchParams(
        (prev) => serializeAnalyticsParams({ ...parseAnalyticsParams(prev), ...changes }),
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const reset = useCallback(() => {
    setSearchParams((prev) => serializeAnalyticsParams(resetFilters(parseAnalyticsParams(prev))), {
      replace: true,
    });
  }, [setSearchParams]);

  return { state, range, patch, reset };
}
