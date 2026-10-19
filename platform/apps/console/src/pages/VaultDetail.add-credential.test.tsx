import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

// План cleanup, шаг 1, пункт 3.1: вкладки «CLI» в окне учётных данных нет.
// Она писала учётку cap_cli в старую таблицу через /v1/oma/vaults, а сессии
// /v1 эту таблицу не читают.

const managed = vi.hoisted(() => ({
  vaults: { credentials: { create: vi.fn() } },
}));
const current = vi.hoisted(() => ({
  vault: {
    id: "vault_1",
    type: "vault",
    display_name: "Рабочие ключи",
    archived_at: null,
    metadata: {},
    created_at: "2026-10-14T10:00:00.000Z",
    updated_at: "2026-10-14T10:00:00.000Z",
  },
}));

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

beforeEach(() => {
  managed.vaults.credentials.create.mockReset().mockResolvedValue({ id: "vcrd_1" });
});

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/vaults/vault_1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/vaults/:id" element={<VaultDetail />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openAddDialog() {
  renderPage();
  const [addButton] = await screen.findAllByRole("button", { name: "Добавить" });
  await userEvent.click(addButton!);
  return await screen.findByRole("dialog", { name: "Добавить учётные данные" });
}

describe("VaultDetail: окно добавления учётных данных", () => {
  it("пустой список зовёт подключить MCP-сервер и не обещает токен CLI", async () => {
    renderPage();

    expect(await screen.findByText("Подключите MCP-сервер.")).toBeInTheDocument();
    expect(screen.queryByText(/CLI/)).toBeNull();
  });

  it("показывает форму MCP-сервера без вкладок, вкладки «CLI» нет", async () => {
    const dialog = await openAddDialog();

    expect(within(dialog).queryByRole("tablist")).toBeNull();
    expect(within(dialog).queryByRole("tab", { name: "CLI" })).toBeNull();
    expect(within(dialog).queryByText(/CLI/)).toBeNull();
    expect(within(dialog).getByRole("textbox", { name: "Название (необязательно)" })).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "MCP-сервер" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Подключить" })).toBeDisabled();
  });

  it("Bearer-токен сохраняется через клиент /v1", async () => {
    const dialog = await openAddDialog();

    await userEvent.click(within(dialog).getByRole("button", { name: "Bearer-токен" }));
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "MCP-сервер" }),
      "https://mcp.example.com/mcp",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /^Токен доступа/ }));
    await userEvent.type(within(dialog).getByLabelText("Токен доступа"), "secret-token");
    await userEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));

    await waitFor(() => expect(managed.vaults.credentials.create).toHaveBeenCalledOnce());
    expect(managed.vaults.credentials.create).toHaveBeenCalledWith("vault_1", {
      display_name: "MCP-сервер",
      auth: {
        type: "static_bearer",
        token: "secret-token",
        mcp_server_url: "https://mcp.example.com/mcp",
      },
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Добавить учётные данные" })).toBeNull(),
    );
  });
});
