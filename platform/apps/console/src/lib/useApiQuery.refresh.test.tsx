import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();

vi.mock("./api", () => ({
  useApi: () => ({ api }),
}));

import { useInfiniteApiQuery } from "./useApiQuery";

function createWrapper() {
  // staleTime как в консоли: без сброса кэш другого фильтра живёт 30 с.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("refresh списка после архива и возврата из архива", () => {
  beforeEach(() => {
    api.mockReset();
  });

  it("refresh сбрасывает и списки с другими фильтрами: после возврата из архива «Активные» читаются заново", async () => {
    let archived = true;
    api.mockImplementation(async (url: string) => {
      const includeArchived = url.includes("include_archived=true");
      if (!includeArchived) return { data: archived ? [] : [{ id: "agent_1", archived_at: null }], next_page: null };
      return { data: [{ id: "agent_1", archived_at: archived ? "2026-10-17T00:00:00Z" : null }], next_page: null };
    });

    const { result, rerender } = renderHook(
      ({ params }: { params: Record<string, string> }) => useInfiniteApiQuery<{ id: string }>("/v1/agents", { limit: 20, params }),
      { wrapper: createWrapper(), initialProps: { params: {} as Record<string, string> } },
    );
    // Фильтр «Активные»: агент в архиве, список пуст.
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(result.current.items).toEqual([]);

    // Фильтр «В архиве», возврат из архива и refresh.
    rerender({ params: { include_archived: "true" } });
    await waitFor(() => expect(result.current.items).toEqual([{ id: "agent_1", archived_at: "2026-10-17T00:00:00Z" }]));
    archived = false;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.items).toEqual([{ id: "agent_1", archived_at: null }]));

    // Снова «Активные»: список читается с сервера, а не из кэша до возврата.
    rerender({ params: {} });
    await waitFor(() => expect(result.current.items).toEqual([{ id: "agent_1", archived_at: null }]));
  });
});
