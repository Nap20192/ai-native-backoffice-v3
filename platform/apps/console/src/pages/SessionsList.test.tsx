import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { SessionsList } from "./SessionsList";

const managed = vi.hoisted(() => ({
  agents: { list: vi.fn(), retrieve: vi.fn() },
  environments: { list: vi.fn() },
  vaults: { list: vi.fn() },
  files: { list: vi.fn() },
  memoryStores: { list: vi.fn() },
  sessions: { create: vi.fn(), archive: vi.fn(), delete: vi.fn() },
}));

vi.mock("../lib/useManagedApi", () => ({
  useManagedApi: () => managed,
}));

vi.mock("../lib/useApiQuery", () => ({
  useInfiniteApiQuery: () => ({
    items: [],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// Выпадающий список ходит в API через useApi и TanStack Query. Здесь важна
// только форма вокруг него, поэтому подставляем кнопку с подсказкой.
vi.mock("../components/Combobox", () => ({
  Combobox: ({ placeholder }: { placeholder?: string }) => (
    <button type="button">{placeholder}</button>
  ),
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
});

beforeEach(() => {
  managed.agents.list.mockReset().mockResolvedValue({
    data: [{ id: "agent-1", name: "Юрист" }],
    next_page: null,
  });
  managed.agents.retrieve.mockReset().mockResolvedValue({ id: "agent-1", mcp_servers: [] });
  managed.environments.list.mockReset().mockResolvedValue({
    data: [{ id: "env-1", name: "Основное" }],
    next_page: null,
  });
  managed.vaults.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.files.list.mockReset().mockResolvedValue({
    data: [],
    has_more: false,
    first_id: null,
    last_id: null,
  });
  managed.memoryStores.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.sessions.create.mockReset().mockResolvedValue({ id: "session-new" });
});

async function openCreateDialog() {
  render(
    <MemoryRouter>
      <I18nProvider>
        <SessionsList />
      </I18nProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(managed.environments.list).toHaveBeenCalled());
  await waitFor(() => expect(managed.agents.list).toHaveBeenCalled());
  const triggers = await screen.findAllByRole("button", { name: /Новая сессия/ });
  await userEvent.click(triggers[0]);
  return screen.findByRole("dialog", { name: "Новая сессия" });
}

describe("SessionsList: окно «Новая сессия»", () => {
  it("отправляет введённое название сессии на сервер", async () => {
    const dialog = await openCreateDialog();

    const title = within(dialog).getByRole("textbox", { name: /Название/ });
    await userEvent.type(title, "Разбор заявки на отпуск");
    expect(title).toHaveValue("Разбор заявки на отпуск");

    await userEvent.click(within(dialog).getByRole("button", { name: "Создать" }));

    await waitFor(() => expect(managed.sessions.create).toHaveBeenCalledOnce());
    expect(managed.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "agent-1",
        environment_id: "env-1",
        title: "Разбор заявки на отпуск",
      }),
    );
  });

  it("не отправляет название, если поле пустое", async () => {
    const dialog = await openCreateDialog();

    await userEvent.click(within(dialog).getByRole("button", { name: "Создать" }));

    await waitFor(() => expect(managed.sessions.create).toHaveBeenCalledOnce());
    expect(managed.sessions.create.mock.calls[0]?.[0]).toMatchObject({ title: undefined });
  });

  it("подсказка пути файла по-русски, без английского file_id", async () => {
    const dialog = await openCreateDialog();

    await userEvent.click(within(dialog).getByRole("button", { name: /Файл/ }));

    const mount = within(dialog).getByPlaceholderText(/^\/mnt\/session\/uploads\//);
    expect(mount.getAttribute("placeholder")).not.toContain("file_id");
    expect(mount.getAttribute("placeholder")).toContain("по умолчанию");
  });
});
