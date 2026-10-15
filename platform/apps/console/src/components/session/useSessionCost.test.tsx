import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "../../mocks/server";
import type { ModelRequest } from "../../lib/session-stats";
import { useSessionCost } from "./useSessionCost";

function request(id: string, atMs: number, usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 }): ModelRequest {
  return {
    id: `${id}-start`,
    startEventId: `${id}-start`,
    endEventId: id,
    threadId: "sthr_primary",
    startMs: atMs - 1000,
    endMs: atMs,
    durationMs: 1000,
    usage,
    isError: false,
  };
}

const requests = [request("e1", 1_000_000), request("e2", 2_000_000)];

const budget = { type: "limit", max_list_cost: { amount: "500", currency: "USD" } };

function totals(overrides: Record<string, number> = {}) {
  return {
    requests: 2,
    errors: 0,
    input_tokens: 40,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd_micros: 890_000,
    cost_parts_usd_micros: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    unpriced_requests: 0,
    usage_missing_requests: 0,
    ...overrides,
  };
}

function analyticsOk(overrides: Record<string, number> = {}) {
  server.use(
    http.get("*/v1/oma/analytics/sessions/s1", () =>
      HttpResponse.json({
        session_id: "s1",
        totals: totals(overrides),
        models: ["m1"],
        harnesses: ["pi"],
        first_started_at: null,
        last_ended_at: null,
      }),
    ),
    http.get("*/v1/oma/analytics/model_calls", () =>
      HttpResponse.json({
        data: [
          { id: "e1", cost_usd_micros: 300_000 },
          { id: "e2", cost_usd_micros: 590_000 },
        ],
        next_cursor: null,
        latest_ended_at: null,
      }),
    ),
  );
}

function analyticsMissing() {
  server.use(
    http.get("*/v1/oma/analytics/sessions/s1", () =>
      HttpResponse.json({ error: { type: "not_found_error", message: "no" } }, { status: 404 }),
    ),
  );
}

function cards(list: unknown[]) {
  server.use(http.get("*/v1/oma/model_cards", () => HttpResponse.json({ data: list })));
}

const priced = { id: "c1", model_id: "m1", pi_config: { cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } } };

function render(overrides: Partial<Parameters<typeof useSessionCost>[0]> = {}) {
  return renderHook(
    (props: Parameters<typeof useSessionCost>[0]) => useSessionCost(props),
    {
      initialProps: {
        sessionId: "s1",
        modelId: "m1",
        budget,
        requests,
        status: "idle",
        ...overrides,
      },
    },
  );
}

describe("useSessionCost: аналитика отвечает", () => {
  it("берёт итог из аналитики, а ряд из журнала запросов по id события", async () => {
    analyticsOk();
    cards([]);

    const { result } = render();

    await waitFor(() => expect(result.current.source).toBe("analytics"));
    expect(result.current.totalMicros).toBe(890_000);
    expect(result.current.budgetCents).toBe(500);
    expect(result.current.series).toEqual([
      { atMs: 1_000_000, eventId: "e1", stepMicros: 300_000, cumulativeMicros: 300_000 },
      { atMs: 2_000_000, eventId: "e2", stepMicros: 590_000, cumulativeMicros: 890_000 },
    ]);
  });

  it("запрашивает журнал по сессии с лимитом 200", async () => {
    analyticsOk();
    cards([]);
    let seen: URL | null = null;
    server.use(
      http.get("*/v1/oma/analytics/model_calls", ({ request: req }) => {
        seen = new URL(req.url);
        return HttpResponse.json({ data: [], next_cursor: null, latest_ended_at: null });
      }),
    );

    render();

    await waitFor(() => expect(seen).not.toBeNull());
    const url = seen as unknown as URL;
    expect(url.searchParams.get("session_id")).toBe("s1");
    expect(url.searchParams.get("limit")).toBe("200");
  });

  it("если в журнале нет строки запроса, ряда нет, а итог остаётся", async () => {
    analyticsOk();
    cards([]);
    server.use(
      http.get("*/v1/oma/analytics/model_calls", () =>
        HttpResponse.json({ data: [{ id: "e1", cost_usd_micros: 300_000 }], next_cursor: null, latest_ended_at: null }),
      ),
    );

    const { result } = render();

    await waitFor(() => expect(result.current.source).toBe("analytics"));
    expect(result.current.totalMicros).toBe(890_000);
    expect(result.current.series).toBeNull();
  });

  it("запросы без цены в аналитике отдают место карточке модели", async () => {
    analyticsOk({ unpriced_requests: 2, cost_usd_micros: 0 });
    cards([priced]);

    const { result } = render();

    await waitFor(() => expect(result.current.source).toBe("card"));
    expect(result.current.totalMicros).toBe(420);
  });
});

describe("useSessionCost: аналитика недоступна", () => {
  it("считает по карточке модели: 20 вх. по $3 и 10 вых. по $15 дают 210 на запрос", async () => {
    analyticsMissing();
    cards([priced]);

    const { result } = render();

    await waitFor(() => expect(result.current.source).toBe("card"));
    expect(result.current.totalMicros).toBe(420);
    expect(result.current.series).toEqual([
      { atMs: 1_000_000, eventId: "e1", stepMicros: 210, cumulativeMicros: 210 },
      { atMs: 2_000_000, eventId: "e2", stepMicros: 210, cumulativeMicros: 420 },
    ]);
    expect(result.current.priceForModel("m1")).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(result.current.priceForModel("другая")).toBeNull();
  });

  it("без карточки модели пишет «нет цены», графика нет", async () => {
    analyticsMissing();
    cards([{ id: "c2", model_id: "другая", pi_config: { cost: { input: 1, output: 1 } } }]);

    const { result } = render();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("none");
    expect(result.current.totalMicros).toBeNull();
    expect(result.current.series).toBeNull();
    expect(result.current.budgetCents).toBe(500);
  });

  it("карточка без цены тоже даёт «нет цены»", async () => {
    analyticsMissing();
    cards([{ id: "c1", model_id: "m1", pi_config: {} }]);

    const { result } = render();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("none");
    expect(result.current.totalMicros).toBeNull();
  });

  it("если нет и карточек, не падает", async () => {
    analyticsMissing();
    server.use(
      http.get("*/v1/oma/model_cards", () => HttpResponse.json({ error: { message: "x" } }, { status: 500 })),
    );

    const { result } = render();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("none");
  });

  it("находит карточку на второй странице списка", async () => {
    analyticsMissing();
    server.use(
      http.get("*/v1/oma/model_cards", ({ request: req }) => {
        const cursor = new URL(req.url).searchParams.get("cursor");
        return cursor
          ? HttpResponse.json({ data: [priced] })
          : HttpResponse.json({ data: [{ id: "c0", model_id: "x" }], next_cursor: "PAGE2" });
      }),
    );

    const { result } = render();

    await waitFor(() => expect(result.current.source).toBe("card"));
    expect(result.current.totalMicros).toBe(420);
  });

  it("запросы потока с другой моделью считаются по цене её карточки", async () => {
    analyticsMissing();
    cards([priced, { id: "c2", model_id: "m2", pi_config: { cost: { input: 30, output: 150 } } }]);
    const mixed = [request("e1", 1_000_000), { ...request("e2", 2_000_000), threadId: "sthr_2" }];

    const { result } = render({
      requests: mixed,
      threadModelIds: new Map([["sthr_2", "m2"]]),
    });

    await waitFor(() => expect(result.current.source).toBe("card"));
    expect(result.current.totalMicros).toBe(210 + 2100);
  });

  it("запрос без завершения не входит в сумму", async () => {
    analyticsMissing();
    cards([priced]);
    const running: ModelRequest = {
      ...request("e3", 3_000_000),
      endEventId: null,
      endMs: null,
      usage: null,
    };

    const { result } = render({ requests: [requests[0]!, running] });

    await waitFor(() => expect(result.current.source).toBe("card"));
    expect(result.current.totalMicros).toBe(210);
  });
});

describe("useSessionCost: загрузка и обновление", () => {
  it("пока ответов нет, loading истинно", async () => {
    server.use(
      http.get("*/v1/oma/analytics/sessions/s1", () => new Promise(() => {})),
      http.get("*/v1/oma/model_cards", () => new Promise(() => {})),
    );

    const { result } = render();

    expect(result.current.loading).toBe(true);
    expect(result.current.source).toBe("none");
  });

  it("бюджет без суммы даёт null", async () => {
    analyticsMissing();
    cards([]);

    const { result } = render({ budget: null });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.budgetCents).toBeNull();
  });

  it("повторно просит аналитику, когда сессия переходит в idle", async () => {
    let calls = 0;
    server.use(
      http.get("*/v1/oma/analytics/sessions/s1", () => {
        calls += 1;
        return HttpResponse.json({
          session_id: "s1",
          totals: totals({ cost_usd_micros: calls * 1000 }),
          models: [],
          harnesses: [],
          first_started_at: null,
          last_ended_at: null,
        });
      }),
      http.get("*/v1/oma/analytics/model_calls", () =>
        HttpResponse.json({ data: [], next_cursor: null, latest_ended_at: null }),
      ),
    );
    cards([]);

    const { result, rerender } = render({ status: "running" });
    await waitFor(() => expect(result.current.totalMicros).toBe(1000));

    rerender({ sessionId: "s1", modelId: "m1", budget, requests, status: "running" });
    expect(calls).toBe(1);

    rerender({ sessionId: "s1", modelId: "m1", budget, requests, status: "idle" });
    await waitFor(() => expect(result.current.totalMicros).toBe(2000));
    expect(calls).toBe(2);
  });
});
