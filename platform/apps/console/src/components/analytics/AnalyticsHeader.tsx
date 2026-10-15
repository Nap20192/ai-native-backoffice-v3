import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { PageHeader } from "../PageHeader";
import { AS_OF_HINT, formatDataAsOf } from "./analytics-format";

/**
 * Шапка страницы аналитики на `PageHeader`: заголовок, подзаголовок со
 * словами «Даты в UTC», справа подпись «Данные на …» по последнему вызову
 * модели и кнопка «Обновить». Подпись и кнопка необязательны: «Кэширование»
 * переносит подпись в панель фильтров, «Журнал» держит «Обновить» внизу.
 */
export function AnalyticsHeader({
  title,
  description,
  latestEndedAt,
  showAsOf = true,
  onRefresh,
  refreshing = false,
}: {
  title: string;
  description: string;
  latestEndedAt?: string | null;
  showAsOf?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const asOf = showAsOf ? formatDataAsOf(latestEndedAt) : "";
  return (
    <PageHeader
      title={title}
      description={description}
      actions={
        asOf || onRefresh ? (
          <>
            {asOf && (
              <span className="text-xs text-ddc-text-muted tabular-nums" title={AS_OF_HINT}>
                Данные на {asOf}
              </span>
            )}
            {onRefresh && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Обновить"
                title="Обновить"
                loading={refreshing}
                onClick={onRefresh}
              >
                <RefreshCwIcon />
              </Button>
            )}
          </>
        ) : undefined
      }
    />
  );
}
