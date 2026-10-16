import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../mocks/server";
import {
  HARNESSES_PATH,
  MODEL_OPTIONS_PATH,
  useHarnesses,
  useModelOptions,
  type HarnessesResponse,
  type ModelOptionsResponse,
} from "./catalog-api";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

const modelOptions: ModelOptionsResponse = {
  builtin_available: true,
  data: [
    {
      handle: "verify-fake",
      label: "Claude Sonnet 4.6",
      source: "card",
      card_id: "mc_01",
      is_default: true,
      provider: "anthropic",
      wire_model: "claude-sonnet-4-6",
      api: "anthropic-messages",
      protocols: ["anthropic-messages"],
      context_window: 200000,
      max_output_tokens: 64000,
      effort_levels: ["low", "medium", "high", "max"],
      speed_fast: true,
      harnesses: ["pi", "claude-acp"],
    },
  ],
};

const harnesses: HarnessesResponse = {
  data: [
    {
      id: "pi",
      source: "builtin",
      label: "Pi agent-core",
      status: "ready",
      reason: null,
      runtime_harness: null,
      protocols: ["*"],
      supports: { effort: true, speed: true, platform_tools: true, mcp: true },
      acp: null,
      install: { npm: [], pip: [] },
      install_hint: null,
      allowed_env: null,
      card_id: null,
    },
  ],
};

describe("клиент каталога моделей и harness", () => {
  it("useModelOptions читает ответ GET /v1/oma/model_options как есть", async () => {
    server.use(http.get(`*${MODEL_OPTIONS_PATH}`, () => HttpResponse.json(modelOptions)));

    const { result } = renderHook(() => useModelOptions(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual(modelOptions));
  });

  it("useHarnesses читает ответ GET /v1/oma/harnesses как есть", async () => {
    server.use(http.get(`*${HARNESSES_PATH}`, () => HttpResponse.json(harnesses)));

    const { result } = renderHook(() => useHarnesses(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.data).toEqual(harnesses));
  });

  it("не ходит на сервер, пока запрос выключен", async () => {
    let calls = 0;
    server.use(
      http.get(`*${MODEL_OPTIONS_PATH}`, () => {
        calls += 1;
        return HttpResponse.json(modelOptions);
      }),
      http.get(`*${HARNESSES_PATH}`, () => {
        calls += 1;
        return HttpResponse.json(harnesses);
      }),
    );

    const { result } = renderHook(
      () => ({
        models: useModelOptions({ enabled: false }),
        harness: useHarnesses({ enabled: false }),
      }),
      { wrapper: wrapper() },
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(0);
    expect(result.current.models.data).toBeUndefined();
    expect(result.current.harness.data).toBeUndefined();
  });

  it("отдаёт ошибку без тоста, когда сервер ещё не знает маршрут", async () => {
    server.use(
      http.get(`*${HARNESSES_PATH}`, () =>
        HttpResponse.json({ error: "Маршрут не найден" }, { status: 404 }),
      ),
    );

    const { result } = renderHook(() => useHarnesses(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeUndefined();
  });
});
