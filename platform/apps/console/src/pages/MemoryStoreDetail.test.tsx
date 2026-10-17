import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { MemoryStoreDetail } from "./MemoryStoreDetail";

const managed = vi.hoisted(() => ({
  memoryStores: { archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn() },
}));
const current = vi.hoisted(() => ({ store: null as unknown }));

vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));
vi.mock("../lib/useApiQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/useApiQuery")>()),
  useApiQuery: () => ({ data: current.store, error: null, refetch: vi.fn(), isFetching: false }),
  useInfiniteApiQuery: () => ({
    items: [],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
});

function store(overrides: Record<string, unknown> = {}) {
  return {
    id: "memstore_1",
    type: "memory_store",
    name: "Предпочтения",
    description: null,
    created_at: "2026-10-14T10:00:00.000Z",
    updated_at: "2026-10-14T10:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };

beforeEach(() => {
  current.store = store();
  dependencies = { blocking: [], affected: [], truncated: false };
  managed.memoryStores.archive.mockReset().mockResolvedValue({});
  managed.memoryStores.unarchive.mockReset().mockResolvedValue(store());
  managed.memoryStores.delete.mockReset().mockResolvedValue({});
  server.use(
    http.get("*/v1/oma/dependencies/memory_store/:id", () => HttpResponse.json(dependencies)),
    http.get("*/v1/memory_stores/:id", () => HttpResponse.json(store(), { headers: { ETag: '"4"' } })),
  );
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/memory/memstore_1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/memory/:id" element={<MemoryStoreDetail />} />
            <Route path="/memory" element={<p>Список хранилищ</p>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MemoryStoreDetail: архив и удаление", () => {
  it("архив: зависимости, If-Match из ETag, переход к списку", async () => {
    dependencies = {
      blocking: [],
      affected: [{ kind: "session", id: "sesn_1", name: null, status: "idle", note: "станет только для чтения" }],
      truncated: false,
    };
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "В архив" }));
    const dialog = await screen.findByRole("dialog", { name: "Отправить хранилище памяти в архив?" });
    expect(await within(dialog).findByText("Затронет")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() =>
      expect(managed.memoryStores.archive).toHaveBeenCalledWith("memstore_1", { ifMatch: '"4"' }),
    );
    expect(await screen.findByText("Список хранилищ")).toBeInTheDocument();
  });

  it("удаление с блокирующим деплойментом: кнопка выключена, «Это нельзя отменить»", async () => {
    dependencies = {
      blocking: [{ kind: "deployment", id: "depl_1", name: "Отчёт", status: "active", note: null }],
      affected: [],
      truncated: false,
    };
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить хранилище?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("архивное хранилище возвращается кнопкой «Вернуть из архива»", async () => {
    current.store = store({ archived_at: "2026-10-15T00:00:00.000Z" });
    renderPage();

    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Вернуть из архива" }));

    await waitFor(() => expect(managed.memoryStores.unarchive).toHaveBeenCalledWith("memstore_1"));
  });
});
