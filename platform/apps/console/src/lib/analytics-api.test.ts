import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createElement, type PropsWithChildren } from "react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";

import { server } from "../mocks/server";
import {
  ANALYTICS_BASE,
  downloadAnalyticsCsv,
  filenameFromDisposition,
  isAnalyticsUnsupported,
  toAnalyticsQuery,
  useAnalyticsFacets,
  useCacheReport,
  useLimitDetail,
  useLimitsReport,
  useModelCall,
  useModelCalls,
  useUpdateCardLimits,
  useUsageReport,
} from "./analytics-api";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("toAnalyticsQuery", () => {
  it("склеивает списки через запятую и отбрасывает пустое", () => {
    expect(
      toAnalyticsQuery({
        from: "2026-10-01",
        to: undefined,
        agent_id: ["a", "b"],
        model: [],
        group_by: "model",
        q: "",
      }),
    ).toEqual({ from: "2026-10-01", agent_id: "a,b", group_by: "model" });
  });
});

describe("клиент аналитики", () => {
  it("useUsageReport передаёт период, группу и списки фильтров", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(`*${ANALYTICS_BASE}/usage`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ marker: "usage" });
      }),
    );

    const { result } = renderHook(
      () =>
        useUsageReport({
          from: "2026-10-01",
          to: "2026-10-16",
          bucket: "day",
          group_by: "model",
          agent_id: ["a", "b"],
          model: [],
        }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.data).toEqual({ marker: "usage" }));
    expect(seen).not.toBeNull();
    const url = seen as unknown as URL;
    expect(url.pathname).toBe("/v1/oma/analytics/usage");
    expect(url.searchParams.get("from")).toBe("2026-10-01");
    expect(url.searchParams.get("to")).toBe("2026-10-16");
    expect(url.searchParams.get("bucket")).toBe("day");
    expect(url.searchParams.get("group_by")).toBe("model");
    expect(url.searchParams.get("agent_id")).toBe("a,b");
    expect(url.searchParams.has("model")).toBe(false);
  });

  it("useCacheReport ходит на /cache с группой и фильтрами", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(`*${ANALYTICS_BASE}/cache`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ marker: "cache" });
      }),
    );
    const { result } = renderHook(
      () => useCacheReport({ group_by: "agent", model: ["m1"], agent_id: [] }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toEqual({ marker: "cache" }));
    const url = seen as unknown as URL;
    expect(url.searchParams.get("group_by")).toBe("agent");
    expect(url.searchParams.get("model")).toBe("m1");
    expect(url.searchParams.has("agent_id")).toBe(false);
  });

  it("useModelCalls добавляет курсор и размер страницы", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(`*${ANALYTICS_BASE}/model_calls`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ data: [], next_cursor: null, latest_ended_at: null });
      }),
    );
    const { result } = renderHook(
      () =>
        useModelCalls(
          { from: "2026-10-01", to: "2026-10-16", status: "error", session_id: "sesn_1", limit: 20 },
          "CURSOR1",
        ),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    const url = seen as unknown as URL;
    expect(url.searchParams.get("cursor")).toBe("CURSOR1");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("status")).toBe("error");
    expect(url.searchParams.get("session_id")).toBe("sesn_1");
  });

  it("useModelCall грузит одну запись и ничего не просит без ID", async () => {
    let calls = 0;
    server.use(
      http.get(`*${ANALYTICS_BASE}/model_calls/sevt_1`, () => {
        calls += 1;
        return HttpResponse.json({ id: "sevt_1" });
      }),
    );
    const idle = renderHook(() => useModelCall(""), { wrapper: wrapper() });
    expect(idle.result.current.fetchStatus).toBe("idle");

    const { result } = renderHook(() => useModelCall("sevt_1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toEqual({ id: "sevt_1" }));
    expect(calls).toBe(1);
  });

  it("useLimitDetail собирает путь карточки, метрику и разрез", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(`*${ANALYTICS_BASE}/limits/mc_01`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ card_id: "mc_01" });
      }),
    );
    const { result } = renderHook(() => useLimitDetail("mc_01", "itpm", "agent"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).toEqual({ card_id: "mc_01" }));
    const url = seen as unknown as URL;
    expect(url.searchParams.get("metric")).toBe("itpm");
    expect(url.searchParams.get("by")).toBe("agent");

    const idle = renderHook(() => useLimitDetail(null, "itpm", "agent"), { wrapper: wrapper() });
    expect(idle.result.current.fetchStatus).toBe("idle");
  });

  it("useAnalyticsFacets просит значения фильтров за период", async () => {
    let seen: URL | null = null;
    server.use(
      http.get(`*${ANALYTICS_BASE}/facets`, ({ request }) => {
        seen = new URL(request.url);
        return HttpResponse.json({ agents: [] });
      }),
    );
    const { result } = renderHook(() => useAnalyticsFacets("2026-09-17", "2026-10-16"), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const url = seen as unknown as URL;
    expect(url.searchParams.get("from")).toBe("2026-09-17");
    expect(url.searchParams.get("to")).toBe("2026-10-16");
  });

  it("useUpdateCardLimits шлёт PUT и после успеха перезапрашивает лимиты", async () => {
    let gets = 0;
    let body: unknown = null;
    server.use(
      http.get(`*${ANALYTICS_BASE}/limits`, () => {
        gets += 1;
        return HttpResponse.json({ cards: [], uncarded: [] });
      }),
      http.put(`*${ANALYTICS_BASE}/limits/mc_01`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ card_id: "mc_01" });
      }),
    );
    const { result } = renderHook(
      () => ({ report: useLimitsReport(), update: useUpdateCardLimits() }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.report.data).toBeDefined());
    expect(gets).toBe(1);

    await act(async () => {
      await result.current.update.mutateAsync({
        cardId: "mc_01",
        limits: {
          requests_per_minute: 50,
          input_tokens_per_minute: 30000,
          output_tokens_per_minute: null,
        },
      });
    });

    expect(body).toEqual({
      requests_per_minute: 50,
      input_tokens_per_minute: 30000,
      output_tokens_per_minute: null,
    });
    await waitFor(() => expect(gets).toBe(2));
  });

  it("501 помечается как «аналитика не ведётся» и не даёт тоста", async () => {
    const toastError = vi.spyOn(toast, "error");
    server.use(
      http.get(`*${ANALYTICS_BASE}/limits`, () =>
        HttpResponse.json(
          { type: "error", error: { type: "api_error", message: "На MySQL аналитика не ведётся." } },
          { status: 501 },
        ),
      ),
    );
    const { result } = renderHook(() => useLimitsReport(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(isAnalyticsUnsupported(result.current.error)).toBe(true);
    expect(isAnalyticsUnsupported(new Error("x"))).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
    toastError.mockRestore();
  });
});

describe("выгрузка CSV", () => {
  it("имя файла берётся из Content-Disposition", () => {
    expect(
      filenameFromDisposition('attachment; filename="analytics-usage-2026-10-01_2026-10-16.csv"', "x.csv"),
    ).toBe("analytics-usage-2026-10-01_2026-10-16.csv");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.csv", "x.csv")).toBe(
      "отчёт.csv",
    );
    expect(filenameFromDisposition(null, "x.csv")).toBe("x.csv");
    expect(filenameFromDisposition("attachment", "x.csv")).toBe("x.csv");
  });

  it("просит format=csv с фильтрами, сохраняет файл и сообщает об усечении", async () => {
    const apiRaw = vi.fn(
      async (_path: string) =>
        new Response("id\r\n1\r\n", {
          headers: {
            "content-disposition": 'attachment; filename="f.csv"',
            "x-analytics-truncated": "10000",
          },
        }),
    );
    const save = vi.fn();

    const result = await downloadAnalyticsCsv(
      apiRaw,
      `${ANALYTICS_BASE}/model_calls`,
      { from: "2026-10-01", status: "error", agent_id: ["a", "b"] },
      "fallback.csv",
      save,
    );

    expect(result).toEqual({ filename: "f.csv", truncated: true });
    const path = apiRaw.mock.calls[0][0];
    const url = new URL(path, "http://localhost");
    expect(url.pathname).toBe("/v1/oma/analytics/model_calls");
    expect(url.searchParams.get("format")).toBe("csv");
    expect(url.searchParams.get("agent_id")).toBe("a,b");
    expect(url.searchParams.get("status")).toBe("error");
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1]).toBe("f.csv");
    // Response.blob() в jsdom даёт Blob из другого окружения, поэтому читаем тело.
    expect(await (save.mock.calls[0][0] as Blob).text()).toBe("id\r\n1\r\n");
  });

  it("без заголовков берёт запасное имя и не говорит об усечении", async () => {
    const apiRaw = vi.fn(async (_path: string) => new Response("a\r\n"));
    const save = vi.fn();
    const result = await downloadAnalyticsCsv(apiRaw, `${ANALYTICS_BASE}/usage`, {}, "fallback.csv", save);
    expect(result).toEqual({ filename: "fallback.csv", truncated: false });
  });
});
