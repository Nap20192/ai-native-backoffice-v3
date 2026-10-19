import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

// План cleanup, шаг 1, пункт 3.1: вкладки «CLI» в окне учётных данных нет.
// Она писала учётку cap_cli в старую таблицу через /v1/oma/vaults, а сессии
// /v1 эту таблицу не читают.
//
// Тип OAuth не открывает окно /v1/oma/oauth/authorize: на сервере Node такого
// маршрута нет, ответ 404. Без токена доступа окно показывает пометку и держит
// кнопку выключенной.
//
// Токен доступа нужен обоим типам. Поэтому его блок открыт сразу и не помечен
// «Необязательно». Раньше тесты сначала раскрывали этот блок кликом, теперь
// такой клик закрыл бы поле. ID и секрет клиента стоят в блоке токена
// обновления: их читает только учётка mcp_oauth.

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

let openSpy: MockInstance<typeof window.open>;

beforeEach(() => {
  managed.vaults.credentials.create.mockReset().mockResolvedValue({ id: "vcrd_1" });
  openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(() => {
  openSpy.mockRestore();
});

const OAUTH_NOTE =
  "Вход через OAuth на этом сервере пока не работает. Вставьте токен доступа, он нужен для подключения.";

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
    expect(within(dialog).getByRole("button", { name: "Добавить" })).toBeDisabled();
  });

  it("поле токена доступа открыто сразу и не помечено необязательным, полей клиента без токена нет", async () => {
    const dialog = await openAddDialog();

    const trigger = within(dialog).getByRole("button", { name: /^Токен доступа/ });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).not.toHaveTextContent("Необязательно");
    expect(within(dialog).getByLabelText("Токен доступа")).toBeInTheDocument();
    expect(within(dialog).queryByText("Учётные данные OAuth-клиента")).toBeNull();
    expect(within(dialog).queryByLabelText("ID OAuth-клиента")).toBeNull();
  });

  it("Bearer-токен сохраняется через клиент /v1", async () => {
    const dialog = await openAddDialog();

    await userEvent.click(within(dialog).getByRole("button", { name: "Bearer-токен" }));
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "MCP-сервер" }),
      "https://mcp.example.com/mcp",
    );
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

  it("OAuth без токена показывает пометку, кнопка выключена, окно входа не открывается", async () => {
    const dialog = await openAddDialog();

    expect(within(dialog).getByRole("button", { name: "OAuth" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "MCP-сервер" }),
      "https://mcp.example.com/mcp",
    );

    expect(within(dialog).getByRole("note")).toHaveTextContent(OAUTH_NOTE);
    expect(within(dialog).getByRole("button", { name: "Добавить" })).toBeDisabled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(managed.vaults.credentials.create).not.toHaveBeenCalled();
  });

  it("OAuth с токеном доступа сохраняется через клиент /v1", async () => {
    const dialog = await openAddDialog();

    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "MCP-сервер" }),
      "https://mcp.example.com/mcp",
    );
    await userEvent.type(within(dialog).getByLabelText("Токен доступа"), "oauth-access-token");

    expect(within(dialog).queryByRole("note")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));

    await waitFor(() => expect(managed.vaults.credentials.create).toHaveBeenCalledOnce());
    expect(managed.vaults.credentials.create).toHaveBeenCalledWith("vault_1", {
      display_name: "MCP-сервер",
      auth: {
        type: "static_bearer",
        token: "oauth-access-token",
        mcp_server_url: "https://mcp.example.com/mcp",
      },
    });
    expect(openSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Добавить учётные данные" })).toBeNull(),
    );
  });

  it("ID и секрет клиента из блока токена обновления уходят в mcp_oauth", async () => {
    const dialog = await openAddDialog();

    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "MCP-сервер" }),
      "https://mcp.example.com/mcp",
    );
    await userEvent.type(within(dialog).getByLabelText("Токен доступа"), "oauth-access-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /^Токен обновления/ }));
    await userEvent.type(within(dialog).getByLabelText("Токен обновления"), "oauth-refresh-token");
    await userEvent.type(
      within(dialog).getByLabelText("Адрес выдачи токенов (token endpoint)"),
      "https://auth.example.com/oauth/token",
    );
    await userEvent.type(within(dialog).getByLabelText("ID OAuth-клиента"), "client-1");
    await userEvent.type(within(dialog).getByLabelText("Секрет OAuth-клиента"), "client-secret");
    await userEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));

    await waitFor(() => expect(managed.vaults.credentials.create).toHaveBeenCalledOnce());
    expect(managed.vaults.credentials.create).toHaveBeenCalledWith("vault_1", {
      display_name: "MCP-сервер",
      auth: {
        type: "mcp_oauth",
        access_token: "oauth-access-token",
        mcp_server_url: "https://mcp.example.com/mcp",
        refresh: {
          client_id: "client-1",
          refresh_token: "oauth-refresh-token",
          token_endpoint: "https://auth.example.com/oauth/token",
          token_endpoint_auth: { type: "client_secret_post", client_secret: "client-secret" },
        },
      },
    });
  });
});
