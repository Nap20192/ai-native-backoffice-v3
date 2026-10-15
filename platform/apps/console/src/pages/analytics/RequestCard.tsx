import type { ReactNode } from "react";
import { Link } from "react-router";

import { LoadError } from "../../components/LoadError";
import { Skeleton } from "../../components/Skeleton";
import {
  formatExactUtc,
  formatLatency,
  formatTokens,
  formatUsd,
} from "../../components/analytics/analytics-format";
import { InfoHint } from "../../components/analytics/InfoHint";
import { RowInspector } from "../../components/analytics/RowInspector";
import type { ModelCallRecord } from "../../lib/analytics-api";
import { SPEED_LABELS, TEXT, harnessLabel } from "./analytics-text";

const PRICE_SOURCE_LABELS = {
  card: "Цена из карточки",
  catalog: "Цена из каталога Pi",
  none: "Цена не задана",
} as const;

function Pair({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-1 py-1.5 text-sm max-[420px]:grid-cols-1">
      <dt className="flex items-center gap-1 text-ddc-text-muted">
        {label}
        {hint && <InfoHint subject={label}>{hint}</InfoHint>}
      </dt>
      <dd className="min-w-0 break-words text-ddc-text">{children}</dd>
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

function cardLabel(call: ModelCallRecord): string {
  if (call.card_id) return call.model;
  return call.model_source === "builtin" ? "Ключ сервера" : "нет";
}

/**
 * Карточка записи журнала в правой панели: время, модель, harness, агент,
 * сессия, токены и стоимость. Тел запроса и ответа в журнале нет.
 */
export function RequestCard({
  id,
  record,
  loading,
  error,
  onRetry,
  prevId,
  nextId,
  onNavigate,
  onClose,
}: {
  id: string;
  record: ModelCallRecord | null;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  prevId: string | null;
  nextId: string | null;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <RowInspector
      title="Запрос"
      subtitle={id}
      width="request"
      onClose={onClose}
      onPrev={prevId ? () => onNavigate(prevId) : undefined}
      onNext={nextId ? () => onNavigate(nextId) : undefined}
      prevDisabled={!prevId}
      nextDisabled={!nextId}
      returnFocusSelector={`[data-row-id="${id}"]`}
    >
      {record ? (
        <Details call={record} />
      ) : error ? (
        <LoadError
          size="sm"
          title="Не удалось загрузить запись"
          message={error.message}
          onRetry={onRetry}
        />
      ) : loading ? (
        <div aria-busy="true" className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}
    </RowInspector>
  );
}

function Details({ call }: { call: ModelCallRecord }) {
  const parts = call.cost_parts_usd_micros;
  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-ddc-heading">{call.model}</h2>

      {call.is_error && (
        <div className="callout-danger" role="alert">
          <span className="min-w-0 break-words">{call.error_message ?? "Вызов модели завершился ошибкой."}</span>
        </div>
      )}

      <dl className="divide-y divide-ddc-divider">
        <Pair label="Время">
          <time dateTime={call.ended_at}>{formatExactUtc(call.ended_at)}</time>
        </Pair>
        <Pair label="Модель">
          <div>{call.model}</div>
          {call.wire_model && <div className="text-xs text-ddc-text-muted">{call.wire_model}</div>}
        </Pair>
        <Pair label="Карточка">{cardLabel(call)}</Pair>
        <Pair label="Harness">{harnessLabel(call.harness)}</Pair>
        <Pair label="Агент">
          <Link to={`/agents/${encodeURIComponent(call.agent.id)}`} className="link">
            {call.agent.name}
          </Link>
        </Pair>
        <Pair label="Сессия">
          <Link to={`/sessions/${encodeURIComponent(call.session_id)}`} className="link">
            Открыть сессию
          </Link>
        </Pair>
        <Pair label="Окружение">{call.environment_id ? <Mono>{call.environment_id}</Mono> : "нет"}</Pair>
        <Pair label="Скорость">{SPEED_LABELS[call.speed]}</Pair>
        <Pair label="Усилие">{call.effort ?? "По умолчанию"}</Pair>
        <Pair label="Задержка" hint="Время от начала вызова модели до конца ответа по часам сервера.">
          {formatLatency(call.latency_ms, 3)}
        </Pair>
        <Pair label="Причина остановки">{call.finish_reason ?? "нет"}</Pair>
        <Pair label="ID ответа провайдера">
          {call.provider_response_id ? <Mono>{call.provider_response_id}</Mono> : "нет"}
        </Pair>
      </dl>

      <section aria-labelledby="request-tokens">
        <h3 id="request-tokens" className="mb-1 text-sm font-semibold text-ddc-heading">
          Токены
        </h3>
        {!call.usage_reported && (
          <div className="callout my-2">
            <span>Harness не прислал токены этого вызова.</span>
          </div>
        )}
        <dl className="divide-y divide-ddc-divider tabular-nums">
          <Pair label="Вход без кэша" hint="Входные токены, которые не прочитаны из кэша и не записаны в него.">
            {formatTokens(call.input_tokens)}
          </Pair>
          <Pair label="Чтение кэша">{formatTokens(call.cache_read_tokens)}</Pair>
          <Pair label="Запись кэша">{formatTokens(call.cache_write_tokens)}</Pair>
          <Pair label="Выход">{formatTokens(call.output_tokens)}</Pair>
        </dl>
      </section>

      <section aria-labelledby="request-cost">
        <h3 id="request-cost" className="mb-1 text-sm font-semibold text-ddc-heading">
          {TEXT.cost.title}
        </h3>
        <dl className="divide-y divide-ddc-divider tabular-nums">
          <Pair label={TEXT.common.total}>{formatUsd(call.cost_usd_micros)}</Pair>
          {parts && (
            <>
              <Pair label="Вход">{formatUsd(parts.input)}</Pair>
              <Pair label="Выход">{formatUsd(parts.output)}</Pair>
              <Pair label="Чтение кэша">{formatUsd(parts.cache_read)}</Pair>
              <Pair label="Запись кэша">{formatUsd(parts.cache_write)}</Pair>
            </>
          )}
        </dl>
        <p className="mt-2 text-xs text-ddc-text-muted">{PRICE_SOURCE_LABELS[call.price_source]}</p>
      </section>
    </div>
  );
}
