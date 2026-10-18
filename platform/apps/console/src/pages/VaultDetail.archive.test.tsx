import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { VaultDetail } from "./VaultDetail";

const managed = vi.hoisted(() => ({
  vaults: { archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn(), credentials: { delete: vi.fn() } },
}));
const current = vi.hoisted(() => ({ vault: null as unknown }));

vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));
vi.mock("../lib/useApiQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/useApiQuery")>()),
  useApiQuery: (path: string | null) =>
    path === "/v1/vaults/vault_1"
      ? { data: current.vault, error: null }
      : { data: { data: [] }, isLoading: false, refetch: vi.fn() },
  useInfiniteApiQuery: () => ({
    items: [],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    error: null,
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

function vault(overrides: Record<string, unknown> = {}) {
  return {
    id: "vault_1",
    type: "vault",
    display_name: "Рабочие ключи",
    archived_at: null,
    metadata: {},
    created_at: "2026-10-14T10:00:00.000Z",
    updated_at: "2026-10-14T10:00:00.000Z",
    ...overrides,
  };
}

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };

beforeEach(() => {
  current.vault = vault();
  dependencies = { blocking: [], affected: [], truncated: false };
  managed.vaults.archive.mockReset().mockResolvedValue({});
  managed.vaults.unarchive.mockReset().mockResolvedValue(vault());
  managed.vaults.delete.mockReset().mockResolvedValue({});
  server.use(
    http.get("*/v1/oma/dependencies/vault/:id", () => HttpResponse.json(dependencies)),
    http.get("*/v1/vaults/:id", () => HttpResponse.json(vault(), { headers: { ETag: '"3"' } })),
  );
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/vaults/vault_1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/vaults/:id" element={<VaultDetail />} />
            <Route path="/vaults" element={<p>Список хранилищ</p>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("VaultDetail: архив и удаление", () => {
  it("архив показывает «Затронет», шлёт If-Match из ETag и ведёт к списку", async () => {
    dependencies = {
      blocking: [],
      affected: [{ kind: "session", id: "sesn_1", name: null, status: "idle", note: "потеряет доступ" }],
      truncated: false,
    };
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "В архив" }));
    const dialog = await screen.findByRole("dialog", { name: "Отправить хранилище в архив?" });
    expect(await within(dialog).findByText("Затронет")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => expect(managed.vaults.archive).toHaveBeenCalledWith("vault_1", { ifMatch: '"3"' }));
    expect(await screen.findByText("Список хранилищ")).toBeInTheDocument();
  });

  it("удаление с блокирующим деплойментом: кнопка выключена", async () => {
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

  it("удаление шлёт If-Match из ETag и ведёт к списку", async () => {
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить хранилище?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(managed.vaults.delete).toHaveBeenCalledWith("vault_1", { ifMatch: '"3"' }));
    expect(await screen.findByText("Список хранилищ")).toBeInTheDocument();
  });

  it("архивное хранилище возвращается кнопкой «Вернуть из архива»", async () => {
    current.vault = vault({ archived_at: "2026-10-15T00:00:00.000Z" });
    renderPage();

    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Вернуть из архива" }));

    await waitFor(() => expect(managed.vaults.unarchive).toHaveBeenCalledWith("vault_1"));
  });
});
