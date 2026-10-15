import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { ApiError, useApi } from "./api";
import { buildUrl } from "./useApiQuery";

/**
 * Клиент аналитики. Типы ответов повторяют раздел 5 контракта
 * docs/plans/analytics.md один в один. Страницы сами рисуют состояние
 * ошибки, поэтому все запросы идут с `quiet`: второй сигнал о том же сбое
 * в виде тоста только шумит.
 */

export const ANALYTICS_BASE = "/v1/oma/analytics";

// ── Типы ответов ─────────────────────────────────────────────────────────

export interface CostParts {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export type UsageGroupBy =
  | "model"
  | "agent"
  | "harness"
  | "card"
  | "environment"
  | "speed"
  | "none";

export interface UsageFilters {
  agent_id: string[];
  model: string[];
  harness: string[];
  card_id: string[];
}

export interface UsageTotals {
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd_micros: number;
  cost_parts_usd_micros: CostParts;
  unpriced_requests: number;
  usage_missing_requests: number;
}

export interface UsageGroup {
  key: string;
  label: string;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd_micros: number;
  cost_parts_usd_micros: CostParts;
  unpriced_requests: number;
}

export interface UsageSeriesPoint {
  bucket_start: string;
  key: string;
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd_micros: number;
  cost_parts_usd_micros: CostParts;
  unpriced_requests: number;
}

export interface UsageReport {
  from: string;
  to: string;
  bucket: "day" | "hour";
  group_by: UsageGroupBy;
  currency: "USD";
  filters: UsageFilters;
  buckets: string[];
  totals: UsageTotals;
  groups: UsageGroup[];
  series: UsageSeriesPoint[];
  latest_ended_at: string | null;
  generated_at: string;
}

export interface CacheTotals {
  requests: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_input_tokens: number;
  read_ratio: number | null;
  write_amortization: number | null;
}

export interface CacheRow extends CacheTotals {
  key: string;
  label: string;
}

export interface CacheSeriesPoint {
  hour_start: string;
  key: string;
  requests: number;
  uncached_input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface LowCacheAgent {
  agent_id: string;
  agent_name: string;
  model: string;
  total_input_tokens: number;
  read_ratio: number | null;
}

export interface CacheReport {
  from_hour: string;
  to_hour: string;
  series_from_hour: string;
  group_by: "model" | "agent";
  filters: { model: string[]; agent_id: string[] };
  totals: CacheTotals;
  rows: CacheRow[];
  series: CacheSeriesPoint[];
  low_cache_agents: LowCacheAgent[];
  latest_ended_at: string | null;
  generated_at: string;
}

export type LimitMetric = "itpm" | "otpm" | "rpm";
export type LimitUnit = "tokens_per_minute" | "requests_per_minute";

export interface Quota {
  metric: LimitMetric;
  unit: LimitUnit;
  limit: number | null;
  peak: number;
  peak_at: string | null;
  utilization: number | null;
}

export interface LimitCard {
  card_id: string;
  model: string;
  label: string;
  provider: string;
  wire_model: string;
  is_default: boolean;
  limits_updated_at: string | null;
  quotas: Quota[];
}

export interface UncardedModel {
  model: string;
  model_source: string;
  label: string;
  quotas: Quota[];
}

export interface LimitsReport {
  window_from: string;
  window_to: string;
  cards: LimitCard[];
  uncarded: UncardedModel[];
  generated_at: string;
}

export type LimitBreakdownBy = "agent" | "session";

export interface LimitBreakdownRow {
  key: string;
  label: string;
  value: number;
  share: number | null;
  utilization: number | null;
}

export interface LimitDetail {
  card_id: string;
  model: string;
  label: string;
  metric: LimitMetric;
  unit: LimitUnit;
  limit: number | null;
  peak_24h: { value: number; at: string | null; utilization: number | null };
  breakdown: { by: LimitBreakdownBy; rows: LimitBreakdownRow[]; total: number };
  series: Array<{ hour_start: string; peak: number }>;
  generated_at: string;
}

export interface CardLimitsInput {
  requests_per_minute: number | null;
  input_tokens_per_minute: number | null;
  output_tokens_per_minute: number | null;
}

export interface CardLimitsSaved extends CardLimitsInput {
  card_id: string;
  updated_at: string;
}

export interface ModelCallRecord {
  id: string;
  session_id: string;
  thread_id: string;
  agent: { id: string; version: number | null; name: string };
  environment_id: string | null;
  harness: string;
  model: string;
  card_id: string | null;
  provider: string | null;
  wire_model: string | null;
  model_source: "card" | "builtin" | "unknown";
  effort: string | null;
  speed: "standard" | "fast";
  provider_response_id: string | null;
  started_at: string | null;
  ended_at: string;
  latency_ms: number | null;
  usage_reported: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  is_error: boolean;
  finish_reason: string | null;
  error_message: string | null;
  cost_usd_micros: number | null;
  cost_parts_usd_micros: CostParts | null;
  price_source: "card" | "catalog" | "none";
}

export interface ModelCallsPage {
  data: ModelCallRecord[];
  next_cursor: string | null;
  latest_ended_at: string | null;
}

export interface SessionAnalytics {
  session_id: string;
  totals: UsageTotals;
  models: string[];
  harnesses: string[];
  first_started_at: string | null;
  last_ended_at: string | null;
}

export interface AnalyticsFacets {
  from: string;
  to: string;
  agents: Array<{ id: string; name: string }>;
  models: Array<{ key: string }>;
  harnesses: Array<{ key: string }>;
  cards: Array<{ id: string; model: string }>;
}

// ── Запрос ───────────────────────────────────────────────────────────────

type QueryValue = string | number | boolean | readonly string[] | null | undefined;
export type AnalyticsQueryInput = Record<string, QueryValue>;

/** Строки запроса: списки склеиваются запятой, пустое отбрасывается. */
export function toAnalyticsQuery(params: AnalyticsQueryInput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) out[key] = value.join(",");
      continue;
    }
    const text = String(value);
    if (text !== "") out[key] = text;
  }
  return out;
}

export interface UsageParams extends Partial<UsageFilters> {
  from: string;
  to: string;
  bucket: "day" | "hour";
  group_by: UsageGroupBy;
}

export interface CacheParams {
  group_by: "model" | "agent";
  model?: string[];
  agent_id?: string[];
}

export interface ModelCallsParams extends Partial<UsageFilters> {
  from?: string;
  to?: string;
  session_id?: string;
  status?: "" | "ok" | "error";
  q?: string;
  limit?: number;
}

/** Код 501 означает, что база не MySQL-совместима с аналитикой. */
export function isAnalyticsUnsupported(error: unknown): boolean {
  return error instanceof ApiError && error.status === 501;
}

// ── Запросы ──────────────────────────────────────────────────────────────

function useAnalyticsQuery<T>(
  queryKey: readonly unknown[],
  path: string,
  query: Record<string, string>,
  { enabled = true, keepPrevious = true }: { enabled?: boolean; keepPrevious?: boolean } = {},
) {
  const { api } = useApi();
  return useQuery<T>({
    queryKey: ["analytics", ...queryKey],
    queryFn: ({ signal }) => api<T>(buildUrl(path, query), { signal, quiet: true }),
    enabled,
    // Повтор ничего не меняет: страница показывает «Повторить» сама.
    retry: false,
    // Пока грузятся новые фильтры, на экране остаются прошлые данные. Карточки
    // одной записи или квоты прошлые данные не показывают: это чужая запись.
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });
}

export function useUsageReport(params: UsageParams) {
  const query = toAnalyticsQuery({ ...params });
  return useAnalyticsQuery<UsageReport>(["usage", query], `${ANALYTICS_BASE}/usage`, query);
}

export function useCacheReport(params: CacheParams) {
  const query = toAnalyticsQuery({ ...params });
  return useAnalyticsQuery<CacheReport>(["cache", query], `${ANALYTICS_BASE}/cache`, query);
}

export function useLimitsReport() {
  return useAnalyticsQuery<LimitsReport>(["limits", "report"], `${ANALYTICS_BASE}/limits`, {});
}

export function useLimitDetail(
  cardId: string | null,
  metric: LimitMetric,
  by: LimitBreakdownBy,
) {
  const query = { metric, by };
  return useAnalyticsQuery<LimitDetail>(
    ["limits", "detail", cardId, query],
    `${ANALYTICS_BASE}/limits/${encodeURIComponent(cardId ?? "")}`,
    query,
    { enabled: Boolean(cardId), keepPrevious: false },
  );
}

export function useUpdateCardLimits() {
  const { api } = useApi();
  const queryClient = useQueryClient();
  return useMutation<CardLimitsSaved, Error, { cardId: string; limits: CardLimitsInput }>({
    mutationFn: ({ cardId, limits }) =>
      api<CardLimitsSaved>(`${ANALYTICS_BASE}/limits/${encodeURIComponent(cardId)}`, {
        method: "PUT",
        body: JSON.stringify(limits),
        quiet: true,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["analytics", "limits"] }),
  });
}

export function useModelCalls(params: ModelCallsParams, cursor?: string | null) {
  const query = toAnalyticsQuery({ ...params, cursor: cursor ?? undefined });
  return useAnalyticsQuery<ModelCallsPage>(
    ["model_calls", query],
    `${ANALYTICS_BASE}/model_calls`,
    query,
  );
}

export function useModelCall(id: string | null | undefined) {
  return useAnalyticsQuery<ModelCallRecord>(
    ["model_call", id],
    `${ANALYTICS_BASE}/model_calls/${encodeURIComponent(id ?? "")}`,
    {},
    { enabled: Boolean(id), keepPrevious: false },
  );
}

export function useAnalyticsFacets(from: string, to: string) {
  const query = { from, to };
  return useAnalyticsQuery<AnalyticsFacets>(["facets", query], `${ANALYTICS_BASE}/facets`, query);
}

// ── CSV ──────────────────────────────────────────────────────────────────

/** Имя файла из `Content-Disposition`; `filename*` сильнее обычного `filename`. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Битая запись: пробуем обычное имя.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const name = plain ? (plain[1] ?? plain[2] ?? "").trim() : "";
  return name || fallback;
}

/** Сохраняет Blob файлом через временную ссылку. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface CsvResult {
  filename: string;
  /** Сервер отрезал выгрузку по лимиту строк (заголовок `X-Analytics-Truncated`). */
  truncated: boolean;
}

export async function downloadAnalyticsCsv(
  apiRaw: (path: string) => Promise<Response>,
  path: string,
  params: AnalyticsQueryInput,
  fallbackName: string,
  save: (blob: Blob, filename: string) => void = saveBlob,
): Promise<CsvResult> {
  const url = buildUrl(path, { ...toAnalyticsQuery(params), format: "csv" });
  const response = await apiRaw(url);
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get("content-disposition"), fallbackName);
  const truncated = response.headers.get("x-analytics-truncated") !== null;
  save(blob, filename);
  return { filename, truncated };
}

export const CSV_TRUNCATED_MESSAGE =
  "В файл попали первые 10 000 строк. Сузьте период или фильтры.";

/** Кнопка «Скачать CSV»: запрос, сохранение файла и тост об усечении. */
export function useAnalyticsCsv() {
  const { apiRaw } = useApi();
  const [pending, setPending] = useState(false);
  const download = useCallback(
    async (path: string, params: AnalyticsQueryInput, fallbackName: string) => {
      setPending(true);
      try {
        const result = await downloadAnalyticsCsv(
          (p) => apiRaw(p, { quiet: true }),
          path,
          params,
          fallbackName,
        );
        if (result.truncated) toast.warning(CSV_TRUNCATED_MESSAGE);
        return result;
      } catch {
        toast.error("Не удалось скачать файл. Повторите попытку.");
        return null;
      } finally {
        setPending(false);
      }
    },
    [apiRaw],
  );
  return { download, pending };
}
