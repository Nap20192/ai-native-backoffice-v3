import { useEffect, useMemo, useRef, useState } from "react";

import { useApi } from "../../lib/api";
import type { ModelCallsPage, SessionAnalytics } from "../../lib/analytics-api";
import {
  ZERO_USAGE,
  budgetCents as readBudgetCents,
  buildCostSeries,
  priceFromModelCard,
  usageCostMicros,
  type CostPoint,
  type ModelRequest,
  type UsdPerMillion,
} from "../../lib/session-stats";

/**
 * Стоимость сессии. Правило из docs/plans/session-page.md, раздел 2:
 *
 *  1. Аналитика ответила: итог берём из неё, ряд для графика из журнала
 *     запросов (строка журнала и событие span.model_request_end делят один id).
 *  2. Иначе считаем по цене из карточки модели: вход, выход и кэш на цену
 *     за миллион токенов, результат в миллионных долях доллара.
 *  3. Иначе цены нет: итога и графика нет.
 *
 * Запросы идут с `quiet`, чтобы 404 аналитики не давал лишний тост.
 */

export type CostSource = "analytics" | "card" | "none";

export interface SessionCost {
  source: CostSource;
  /** null: «нет цены». */
  totalMicros: number | null;
  budgetCents: number | null;
  series: CostPoint[] | null;
  /** Цена карточки по handle модели, для потоков с другой моделью. */
  priceForModel(modelId: string | null): UsdPerMillion | null;
  /** Ответы ещё идут: итог может измениться. */
  loading?: boolean;
}

export interface UseSessionCostInput {
  sessionId: string;
  modelId: string | null;
  budget: unknown;
  requests: readonly ModelRequest[];
  /** Перезапрос аналитики при переходе в idle. */
  status: string;
  /** Модель потока по его id, если она отличается от модели сессии. */
  threadModelIds?: ReadonlyMap<string, string | null>;
}

interface ModelCardLite {
  model_id: string;
  pi_config?: Record<string, unknown>;
}

type AnalyticsState =
  | { phase: "loading" }
  | { phase: "unavailable" }
  | { phase: "ready"; totalMicros: number; costById: ReadonlyMap<string, number | null> };

interface CardsPage {
  data?: ModelCardLite[];
  next_cursor?: string | null;
}

type CardsState = { phase: "loading" } | { phase: "ready"; cards: ModelCardLite[] };

const CARD_PAGE_LIMIT = 100;
const CARD_MAX_PAGES = 5;

function settled(status: string): boolean {
  return status === "idle" || status === "terminated";
}

export function useSessionCost({
  sessionId,
  modelId,
  budget,
  requests,
  status,
  threadModelIds,
}: UseSessionCostInput): SessionCost {
  const { api } = useApi();
  const [analytics, setAnalytics] = useState<AnalyticsState>({ phase: "loading" });
  const [cards, setCards] = useState<CardsState>({ phase: "loading" });

  // Сессия перешла в покой: журнал дописан, итог перезапрашиваем.
  const [refreshKey, setRefreshKey] = useState(0);
  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current !== status && settled(status)) setRefreshKey((key) => key + 1);
    previousStatus.current = status;
  }, [status]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const abort = new AbortController();
    const id = encodeURIComponent(sessionId);
    void (async () => {
      try {
        const summary = await api<SessionAnalytics>(`/v1/oma/analytics/sessions/${id}`, {
          quiet: true,
          signal: abort.signal,
        });
        const { totals } = summary;
        // Все запросы без цены: итог аналитики нулевой не потому, что сессия бесплатна.
        if (totals.requests > 0 && totals.unpriced_requests >= totals.requests) {
          if (!cancelled) setAnalytics({ phase: "unavailable" });
          return;
        }
        const calls = await api<ModelCallsPage>(
          `/v1/oma/analytics/model_calls?session_id=${id}&limit=200`,
          { quiet: true, signal: abort.signal },
        ).catch(() => null);
        if (cancelled) return;
        const costById = new Map<string, number | null>();
        for (const row of calls?.data ?? []) costById.set(row.id, row.cost_usd_micros);
        setAnalytics({ phase: "ready", totalMicros: totals.cost_usd_micros, costById });
      } catch {
        if (!cancelled) setAnalytics((previous) => (previous.phase === "ready" ? previous : { phase: "unavailable" }));
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [api, sessionId, refreshKey]);

  // Сессия другая: прошлый итог к ней не относится.
  useEffect(() => {
    setAnalytics({ phase: "loading" });
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found: ModelCardLite[] = [];
      try {
        let cursor: string | null = null;
        for (let page = 0; page < CARD_MAX_PAGES; page++) {
          const query: string = `limit=${CARD_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
          const res: CardsPage = await api<CardsPage>(`/v1/oma/model_cards?${query}`, { quiet: true });
          found.push(...(res.data ?? []));
          cursor = res.next_cursor ?? null;
          if (!cursor) break;
        }
      } catch {
        // Карточек нет: цену посчитать нечем.
      }
      if (!cancelled) setCards({ phase: "ready", cards: found });
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const priceByModel = useMemo(() => {
    const prices = new Map<string, UsdPerMillion>();
    if (cards.phase !== "ready") return prices;
    for (const card of cards.cards) {
      if (prices.has(card.model_id)) continue;
      const price = priceFromModelCard(card);
      if (price) prices.set(card.model_id, price);
    }
    return prices;
  }, [cards]);

  const priceForModel = useMemo(
    () => (id: string | null) => (id ? (priceByModel.get(id) ?? null) : null),
    [priceByModel],
  );

  const cardCosts = useMemo(() => {
    const costs = new Map<string, number | null>();
    for (const request of requests) {
      if (request.endEventId === null) continue;
      const price = priceForModel(threadModelIds?.get(request.threadId) ?? modelId);
      costs.set(
        request.endEventId,
        price ? usageCostMicros(request.usage ?? ZERO_USAGE, price) : null,
      );
    }
    return costs;
  }, [requests, priceForModel, threadModelIds, modelId]);

  return useMemo<SessionCost>(() => {
    const budgetCents = readBudgetCents(budget);
    const analyticsReady = analytics.phase === "ready";
    const cardTotal = (() => {
      let sum = 0;
      for (const cost of cardCosts.values()) {
        if (cost === null) return null;
        sum += cost;
      }
      return cardCosts.size === 0 && !priceForModel(modelId) ? null : sum;
    })();
    const loading =
      analytics.phase === "loading" || (!analyticsReady && cards.phase === "loading");

    if (analyticsReady) {
      return {
        source: "analytics",
        totalMicros: analytics.totalMicros,
        budgetCents,
        series: buildCostSeries(requests, (request) => analytics.costById.get(request.endEventId ?? request.id) ?? null),
        priceForModel,
        loading,
      };
    }
    if (cardTotal !== null) {
      return {
        source: "card",
        totalMicros: cardTotal,
        budgetCents,
        series: buildCostSeries(requests, (request) => cardCosts.get(request.endEventId ?? request.id) ?? null),
        priceForModel,
        loading,
      };
    }
    return { source: "none", totalMicros: null, budgetCents, series: null, priceForModel, loading };
  }, [analytics, cards.phase, budget, cardCosts, modelId, priceForModel, requests]);
}
