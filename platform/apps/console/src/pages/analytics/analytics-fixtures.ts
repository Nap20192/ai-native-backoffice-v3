import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createElement, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { I18nProvider } from "../../i18n";
import type {
  AnalyticsFacets,
  CacheReport,
  CacheSeriesPoint,
  CostParts,
  LimitDetail,
  LimitMetric,
  LimitsReport,
  ModelCallRecord,
  ModelCallsPage,
  Quota,
  UsageGroup,
  UsageReport,
  UsageSeriesPoint,
  UsageTotals,
} from "../../lib/analytics-api";
import { server } from "../../mocks/server";

/**
 * Ответы API аналитики по разделу 5 контракта для тестов страниц и подмена
 * сервера на MSW. В боевую сборку файл не попадает: его не импортирует ни
 * одна страница.
 */

export const NOW_ISO = "2026-10-16T09:15:00.000Z";
export const LATEST_ISO = "2026-10-16T09:12:03.120Z";

/** Замораживает только `Date`, таймеры остаются настоящими (MSW и waitFor). */
export function freezeNow(iso: string = NOW_ISO): void {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
}

// ── Использование и стоимость ────────────────────────────────────────────

interface BaseRow {
  day: string;
  hour: string;
  model: string;
  requests: number;
  errors: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  parts: CostParts;
  unpriced: number;
}

/**
 * Три дня и две модели. Первая считается по цене карточки, вторая без цены.
 * Итоги: 17 запросов, 1 ошибка, вход без кэша 2320, выход 490, чтение кэша
 * 2500, запись кэша 420, стоимость 7335 микродолларов, 8 запросов без цены.
 */
const BASE_ROWS: BaseRow[] = [
  {
    day: "2026-10-14", hour: "2026-10-14T09:00:00.000Z", model: "verify-fake",
    requests: 4, errors: 0, input: 400, output: 100, cache_read: 2000, cache_write: 300,
    parts: { input: 1200, output: 1500, cache_read: 600, cache_write: 1125 }, unpriced: 0,
  },
  {
    day: "2026-10-15", hour: "2026-10-15T09:00:00.000Z", model: "verify-fake",
    requests: 2, errors: 1, input: 220, output: 50, cache_read: 0, cache_write: 0,
    parts: { input: 660, output: 750, cache_read: 0, cache_write: 0 }, unpriced: 0,
  },
  {
    day: "2026-10-15", hour: "2026-10-15T10:00:00.000Z", model: "custom-model",
    requests: 5, errors: 0, input: 1000, output: 200, cache_read: 0, cache_write: 0,
    parts: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, unpriced: 5,
  },
  {
    day: "2026-10-16", hour: "2026-10-16T09:00:00.000Z", model: "verify-fake",
    requests: 3, errors: 0, input: 100, output: 40, cache_read: 500, cache_write: 120,
    parts: { input: 300, output: 600, cache_read: 150, cache_write: 450 }, unpriced: 0,
  },
  {
    day: "2026-10-16", hour: "2026-10-16T10:00:00.000Z", model: "custom-model",
    requests: 3, errors: 0, input: 600, output: 100, cache_read: 0, cache_write: 0,
    parts: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, unpriced: 3,
  },
];

const sumParts = (rows: BaseRow[]): CostParts => ({
  input: rows.reduce((s, r) => s + r.parts.input, 0),
  output: rows.reduce((s, r) => s + r.parts.output, 0),
  cache_read: rows.reduce((s, r) => s + r.parts.cache_read, 0),
  cache_write: rows.reduce((s, r) => s + r.parts.cache_write, 0),
});

const costOf = (parts: CostParts) => parts.input + parts.output + parts.cache_read + parts.cache_write;

function aggregate(rows: BaseRow[]) {
  const parts = sumParts(rows);
  return {
    requests: rows.reduce((s, r) => s + r.requests, 0),
    errors: rows.reduce((s, r) => s + r.errors, 0),
    input_tokens: rows.reduce((s, r) => s + r.input, 0),
    output_tokens: rows.reduce((s, r) => s + r.output, 0),
    cache_read_tokens: rows.reduce((s, r) => s + r.cache_read, 0),
    cache_write_tokens: rows.reduce((s, r) => s + r.cache_write, 0),
    cost_usd_micros: costOf(parts),
    cost_parts_usd_micros: parts,
    unpriced_requests: rows.reduce((s, r) => s + r.unpriced, 0),
  };
}

const DAY_BUCKETS = ["2026-10-14T00:00:00.000Z", "2026-10-15T00:00:00.000Z", "2026-10-16T00:00:00.000Z"];
const HOUR_BUCKETS = Array.from({ length: 24 }, (_, h) => `2026-10-15T${String(h).padStart(2, "0")}:00:00.000Z`);

export interface UsageFixtureOptions {
  bucket?: "day" | "hour";
  groupBy?: UsageReport["group_by"];
  /** Пустой период: ни одного вызова. */
  empty?: boolean;
}

export function usageReport({ bucket = "day", groupBy = "model", empty = false }: UsageFixtureOptions = {}): UsageReport {
  const rows = empty ? [] : bucket === "hour" ? BASE_ROWS.filter((r) => r.day === "2026-10-15") : BASE_ROWS;
  const keyOf = (r: BaseRow) => (groupBy === "none" ? "all" : r.model);
  const bucketOf = (r: BaseRow) => (bucket === "hour" ? r.hour : `${r.day}T00:00:00.000Z`);

  const keys = [...new Set(rows.map(keyOf))];
  const groups: UsageGroup[] = keys
    .map((key) => ({
      key,
      label: key === "all" ? "Всё" : key,
      ...aggregate(rows.filter((r) => keyOf(r) === key)),
    }))
    .sort(
      (a, b) =>
        b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens -
          (a.input_tokens + a.output_tokens + a.cache_read_tokens + a.cache_write_tokens) ||
        a.key.localeCompare(b.key),
    );

  const series: UsageSeriesPoint[] = [];
  for (const key of keys) {
    for (const b of bucket === "hour" ? HOUR_BUCKETS : DAY_BUCKETS) {
      const inBucket = rows.filter((r) => keyOf(r) === key && bucketOf(r) === b);
      if (inBucket.length === 0) continue;
      series.push({ bucket_start: b, key, ...aggregate(inBucket) });
    }
  }

  const totals: UsageTotals = { ...aggregate(rows), usage_missing_requests: 0 };
  return {
    from: bucket === "hour" ? "2026-10-15" : "2026-10-14",
    to: bucket === "hour" ? "2026-10-15" : "2026-10-16",
    bucket,
    group_by: groupBy,
    currency: "USD",
    filters: { agent_id: [], model: [], harness: [], card_id: [] },
    buckets: bucket === "hour" ? HOUR_BUCKETS : DAY_BUCKETS,
    totals,
    groups,
    series,
    latest_ended_at: empty ? null : LATEST_ISO,
    generated_at: NOW_ISO,
  };
}

// ── Кэширование ──────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const CACHE_TO_HOUR = "2026-10-16T09:00:00.000Z";

export interface CacheFixtureOptions {
  groupBy?: "model" | "agent";
  /** Кэш не используется совсем: чтение и запись равны нулю. */
  noCache?: boolean;
  empty?: boolean;
}

/**
 * 336 часов ряда. Модель verify-fake читает кэш каждый час (1000 токенов
 * против 20 без кэша и 50 записанных), модель other-model раз в сутки и без
 * кэша.
 */
export function cacheReport({ groupBy = "model", noCache = false, empty = false }: CacheFixtureOptions = {}): CacheReport {
  const toMs = Date.parse(CACHE_TO_HOUR);
  const fromMs = toMs - 167 * HOUR_MS;
  const seriesFromMs = fromMs - 168 * HOUR_MS;

  const series: CacheSeriesPoint[] = [];
  if (!empty) {
    for (let t = seriesFromMs; t <= toMs; t += HOUR_MS) {
      const hour = new Date(t).toISOString();
      series.push({
        hour_start: hour,
        key: "verify-fake",
        requests: 1,
        uncached_input_tokens: 20,
        cache_read_tokens: noCache ? 0 : 1000,
        cache_write_tokens: noCache ? 0 : 50,
      });
      if (((t - seriesFromMs) / HOUR_MS) % 24 === 0) {
        series.push({
          hour_start: hour,
          key: "other-model",
          requests: 1,
          uncached_input_tokens: 500,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        });
      }
    }
  }

  const inWindow = series.filter((p) => Date.parse(p.hour_start) >= fromMs);
  const summarize = (points: CacheSeriesPoint[]) => {
    const uncached = points.reduce((s, p) => s + p.uncached_input_tokens, 0);
    const read = points.reduce((s, p) => s + p.cache_read_tokens, 0);
    const write = points.reduce((s, p) => s + p.cache_write_tokens, 0);
    const total = uncached + read + write;
    return {
      requests: points.reduce((s, p) => s + p.requests, 0),
      uncached_input_tokens: uncached,
      cache_read_tokens: read,
      cache_write_tokens: write,
      total_input_tokens: total,
      read_ratio: total === 0 ? null : Math.round((read / total) * 10_000) / 10_000,
      write_amortization: write === 0 ? null : Math.round((read / write) * 10_000) / 10_000,
    };
  };

  const keys = [...new Set(inWindow.map((p) => p.key))];
  const rows = keys
    .map((key) => ({ key, label: key, ...summarize(inWindow.filter((p) => p.key === key)) }))
    .sort((a, b) => b.total_input_tokens - a.total_input_tokens || a.key.localeCompare(b.key));

  return {
    from_hour: new Date(fromMs).toISOString(),
    to_hour: CACHE_TO_HOUR,
    series_from_hour: new Date(seriesFromMs).toISOString(),
    group_by: groupBy,
    filters: { model: [], agent_id: [] },
    totals: summarize(inWindow),
    rows,
    series,
    low_cache_agents: empty
      ? []
      : [
          {
            agent_id: "agent_02",
            agent_name: "reviewer",
            model: "other-model",
            total_input_tokens: 12_000,
            read_ratio: 0.1,
          },
        ],
    latest_ended_at: empty ? null : LATEST_ISO,
    generated_at: NOW_ISO,
  };
}

// ── Лимиты ───────────────────────────────────────────────────────────────

function quota(metric: LimitMetric, limit: number | null, peak: number): Quota {
  return {
    metric,
    unit: metric === "rpm" ? "requests_per_minute" : "tokens_per_minute",
    limit,
    peak,
    peak_at: peak > 0 ? "2026-10-16T08:41:00.000Z" : null,
    utilization: limit === null || limit === 0 ? null : Math.round((peak / limit) * 10_000) / 10_000,
  };
}

export function limitsReport(): LimitsReport {
  return {
    window_from: "2026-10-15T09:15:00.000Z",
    window_to: NOW_ISO,
    cards: [
      {
        card_id: "mc_01",
        model: "verify-fake",
        label: "Claude Sonnet 4.6",
        provider: "anthropic",
        wire_model: "claude-sonnet-4-6",
        is_default: true,
        limits_updated_at: "2026-10-16T08:00:00.000Z",
        quotas: [quota("itpm", 30_000, 1200), quota("otpm", 8000, 300), quota("rpm", null, 3)],
      },
      {
        card_id: "mc_02",
        model: "gpt-x",
        label: "GPT X",
        provider: "openai",
        wire_model: "gpt-x-2",
        is_default: false,
        limits_updated_at: null,
        quotas: [quota("itpm", null, 0), quota("otpm", null, 0), quota("rpm", null, 0)],
      },
    ],
    uncarded: [
      {
        model: "claude-haiku-4-5",
        model_source: "builtin",
        label: "Claude Haiku 4.5",
        quotas: [quota("itpm", null, 500), quota("otpm", null, 90), quota("rpm", null, 1)],
      },
    ],
    generated_at: NOW_ISO,
  };
}

export function limitDetail(metric: LimitMetric = "itpm", by: "agent" | "session" = "agent"): LimitDetail {
  const limit = metric === "itpm" ? 30_000 : metric === "otpm" ? 8000 : null;
  const peak = metric === "itpm" ? 1200 : metric === "otpm" ? 300 : 3;
  const first = Date.parse("2026-10-09T10:00:00.000Z");
  const rows =
    by === "agent"
      ? [
          { key: "agent_01", label: "verify-agent", value: Math.round(peak * 0.75), share: 0.75, utilization: limit ? (peak * 0.75) / limit : null },
          { key: "agent_02", label: "reviewer", value: Math.round(peak * 0.25), share: 0.25, utilization: limit ? (peak * 0.25) / limit : null },
        ]
      : [
          { key: "sesn_01", label: "sesn_01", value: peak, share: 1, utilization: limit ? peak / limit : null },
        ];
  return {
    card_id: "mc_01",
    model: "verify-fake",
    label: "Claude Sonnet 4.6",
    metric,
    unit: metric === "rpm" ? "requests_per_minute" : "tokens_per_minute",
    limit,
    peak_24h: { value: peak, at: "2026-10-16T08:41:00.000Z", utilization: limit ? peak / limit : null },
    breakdown: { by, rows, total: peak },
    series: Array.from({ length: 168 }, (_, i) => ({
      hour_start: new Date(first + i * HOUR_MS).toISOString(),
      peak: i === 166 ? peak : 0,
    })),
    generated_at: NOW_ISO,
  };
}

// ── Журнал ───────────────────────────────────────────────────────────────

/** Запись журнала номер `n`: чем больше номер, тем она старше. */
export function makeCall(n: number, overrides: Partial<ModelCallRecord> = {}): ModelCallRecord {
  const ended = Date.parse(LATEST_ISO) - n * 60_000;
  const id = `sevt_${String(n).padStart(2, "0")}`;
  return {
    id,
    session_id: "sesn_01",
    thread_id: "sthr_primary",
    agent: { id: "agent_01", version: 3, name: "verify-agent" },
    environment_id: "env_01",
    harness: "pi",
    model: "verify-fake",
    card_id: "mc_01",
    provider: "anthropic",
    wire_model: "claude-sonnet-4-6",
    model_source: "card",
    effort: "high",
    speed: "standard",
    provider_response_id: `msg_${String(n).padStart(2, "0")}`,
    started_at: new Date(ended - 3020).toISOString(),
    ended_at: new Date(ended).toISOString(),
    latency_ms: 3020,
    usage_reported: true,
    input_tokens: 20,
    output_tokens: 10,
    cache_read_tokens: 4,
    cache_write_tokens: 2,
    is_error: false,
    finish_reason: "stop",
    error_message: null,
    cost_usd_micros: 210,
    cost_parts_usd_micros: { input: 60, output: 150, cache_read: 0, cache_write: 0 },
    price_source: "card",
    ...overrides,
  };
}

/** 45 записей, страницы по 20: курсор `p2` и `p3`. */
export const CALL_COUNT = 45;

export function modelCallsPage(cursor: string | null, limit = 20): ModelCallsPage {
  const page = cursor === "p3" ? 3 : cursor === "p2" ? 2 : 1;
  const start = (page - 1) * limit;
  const data = Array.from({ length: Math.max(0, Math.min(limit, CALL_COUNT - start)) }, (_, i) =>
    makeCall(start + i + 1),
  );
  const hasNext = start + limit < CALL_COUNT;
  return {
    data,
    next_cursor: hasNext ? `p${page + 1}` : null,
    latest_ended_at: LATEST_ISO,
  };
}

export function facets(): AnalyticsFacets {
  return {
    from: "2026-09-17",
    to: "2026-10-16",
    agents: [
      { id: "agent_01", name: "verify-agent" },
      { id: "agent_02", name: "reviewer" },
    ],
    models: [{ key: "custom-model" }, { key: "verify-fake" }],
    harnesses: [{ key: "claude-acp" }, { key: "pi" }],
    cards: [{ id: "mc_01", model: "verify-fake" }],
  };
}

// ── Подмена сервера ──────────────────────────────────────────────────────

type Reply = ((url: URL) => unknown) | object;

export interface AnalyticsMocks {
  usage?: Reply;
  cache?: Reply;
  limits?: Reply;
  limitDetail?: Reply;
  modelCalls?: Reply;
  modelCall?: Reply;
  facets?: Reply;
  putLimits?: Reply;
}

export interface LoggedRequest {
  method: string;
  url: URL;
  body?: unknown;
}

async function answer(reply: Reply, url: URL): Promise<Response> {
  const value = typeof reply === "function" ? await (reply as (u: URL) => unknown)(url) : reply;
  return value instanceof Response ? value : HttpResponse.json(value as never);
}

export function errorResponse(status: number, message: string): Response {
  const type = status === 501 ? "api_error" : status === 404 ? "not_found_error" : "api_error";
  return HttpResponse.json({ type: "error", error: { type, message } }, { status });
}

/**
 * Ставит ответы аналитики. По умолчанию это ответы из этого файла. Журнал
 * запросов (`requests`) нужен, чтобы проверить параметры, с которыми страница
 * ходила на сервер.
 */
export function mockAnalytics(mocks: AnalyticsMocks = {}) {
  const requests: LoggedRequest[] = [];
  const log = (method: string, request: Request, body?: unknown) => {
    requests.push({ method, url: new URL(request.url), body });
  };
  const base = "*/v1/oma/analytics";

  server.use(
    http.get(`${base}/usage`, ({ request }) => {
      log("GET", request);
      const url = new URL(request.url);
      const reply: Reply =
        mocks.usage ??
        ((u: URL) =>
          usageReport({
            bucket: (u.searchParams.get("bucket") as "day" | "hour") ?? "day",
            groupBy: (u.searchParams.get("group_by") as UsageReport["group_by"]) ?? "model",
          }));
      return answer(reply, url);
    }),
    http.get(`${base}/cache`, ({ request }) => {
      log("GET", request);
      const url = new URL(request.url);
      return answer(
        mocks.cache ?? ((u: URL) => cacheReport({ groupBy: (u.searchParams.get("group_by") as "model" | "agent") ?? "model" })),
        url,
      );
    }),
    http.get(`${base}/limits`, ({ request }) => {
      log("GET", request);
      return answer(mocks.limits ?? limitsReport(), new URL(request.url));
    }),
    http.get(`${base}/limits/:cardId`, ({ request }) => {
      log("GET", request);
      const url = new URL(request.url);
      return answer(
        mocks.limitDetail ??
          ((u: URL) =>
            limitDetail(
              (u.searchParams.get("metric") as LimitMetric) ?? "itpm",
              (u.searchParams.get("by") as "agent" | "session") ?? "agent",
            )),
        url,
      );
    }),
    http.put(`${base}/limits/:cardId`, async ({ request, params }) => {
      const body = await request.json();
      log("PUT", request, body);
      return answer(
        mocks.putLimits ?? { card_id: params.cardId, ...(body as object), updated_at: NOW_ISO },
        new URL(request.url),
      );
    }),
    http.get(`${base}/model_calls`, ({ request }) => {
      log("GET", request);
      const url = new URL(request.url);
      if (url.searchParams.get("format") === "csv") {
        return new Response("id\r\nsevt_01\r\n", {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="analytics-model-calls-2026-09-17_2026-10-16.csv"',
          },
        });
      }
      return answer(
        mocks.modelCalls ?? ((u: URL) => modelCallsPage(u.searchParams.get("cursor"), Number(u.searchParams.get("limit") ?? 20))),
        url,
      );
    }),
    http.get(`${base}/model_calls/:id`, ({ request, params }) => {
      log("GET", request);
      const n = Number(String(params.id).replace("sevt_", ""));
      return answer(mocks.modelCall ?? makeCall(Number.isFinite(n) ? n : 1), new URL(request.url));
    }),
    http.get(`${base}/facets`, ({ request }) => {
      log("GET", request);
      return answer(mocks.facets ?? facets(), new URL(request.url));
    }),
  );

  // Выгрузка CSV отчёта использования идёт на тот же маршрут с format=csv.
  server.use(
    http.get(`${base}/usage`, ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("format") !== "csv") return undefined;
      requests.push({ method: "GET", url });
      return new Response("bucket_start\r\n", {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="analytics-usage-2026-09-17_2026-10-16.csv"',
        },
      });
    }),
  );

  return {
    requests,
    /** Запросы к маршруту, без выгрузки CSV. */
    to(path: string): LoggedRequest[] {
      return requests.filter(
        (r) => r.url.pathname === `/v1/oma/analytics/${path}` && r.url.searchParams.get("format") !== "csv",
      );
    },
    last(path: string): URL {
      const found = this.to(path);
      return found[found.length - 1]?.url as URL;
    },
  };
}

// ── Отрисовка страницы ───────────────────────────────────────────────────

function LocationProbe() {
  const location = useLocation();
  return createElement("output", { "data-testid": "location" }, `${location.pathname}${location.search}`);
}

/**
 * Страница в роутере, клиенте запросов, языке и подсказках. Адрес виден в
 * элементе `data-testid="location"`.
 */
export function renderAnalyticsPage(ui: ReactElement, route: string) {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pathname = route.split("?")[0];
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: [route] },
        createElement(
          I18nProvider,
          null,
          createElement(
            TooltipProvider,
            null,
            createElement(
              Routes,
              null,
              createElement(Route, { path: pathname, element: ui }),
              createElement(Route, { path: "*", element: createElement("div", null, "другая страница") }),
            ),
            createElement(LocationProbe),
          ),
        ),
      ),
    ),
  );
}
