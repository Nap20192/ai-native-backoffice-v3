import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { SessionsList } from "./SessionsList";

const managed = vi.hoisted(() => ({
  agents: { list: vi.fn(), retrieve: vi.fn() },
  environments: { list: vi.fn() },
  vaults: { list: vi.fn() },
  files: { list: vi.fn() },
  memoryStores: { list: vi.fn() },
  sessions: { create: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn() },
}));

const feed = vi.hoisted(() => ({
  items: [] as unknown[],
  params: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));

vi.mock("../lib/useApiQuery", () => ({
  useInfiniteApiQuery: (_path: string, opts?: { params?: Record<string, unknown> }) => {
    feed.params.push(opts?.params);
    return {
      items: feed.items,
      isLoading: false,
      hasMore: false,
      isLoadingMore: false,
      loadMore: vi.fn(),
      refresh: vi.fn(),
    };
  },
}));

vi.mock("../components/Combobox", () => ({
  Combobox: ({ placeholder }: { placeholder?: string }) => <button type="button">{placeholder}</button>,
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

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "sesn_1",
    title: "Разбор заявки",
    status: "idle",
    agent: { id: "agent_1", name: "Юрист" },
    created_at: "2026-10-14T10:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };
let operations: string[];

beforeEach(() => {
  feed.items = [session()];
  feed.params = [];
  dependencies = { blocking: [], affected: [], truncated: false };
  operations = [];
  managed.agents.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.environments.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.vaults.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.files.list.mockReset().mockResolvedValue({ data: [], has_more: false });
  managed.memoryStores.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.sessions.archive.mockReset().mockResolvedValue({});
  managed.sessions.unarchive.mockReset().mockResolvedValue({});
  managed.sessions.delete.mockReset().mockResolvedValue({});
  server.use(
    http.get("*/v1/oma/dependencies/session/:id", ({ request }) => {
      operations.push(new URL(request.url).searchParams.get("operation") ?? "");
      return HttpResponse.json(dependencies);
    }),
    http.get("*/v1/sessions/:id", () => HttpResponse.json(session(), { headers: { ETag: '"7"' } })),
  );
});

async function openMenu(item: string) {
  render(
    <MemoryRouter>
      <I18nProvider>
        <SessionsList />
      </I18nProvider>
    </MemoryRouter>,
  );
  // Список перерисовывается, пока догружаются агенты и окружения, поэтому
  // строку ищем заново, пока меню не откроется.
  await waitFor(() => {
    fireEvent.contextMenu(screen.getByText("Разбор заявки"));
    expect(screen.getByRole("menuitem", { name: item })).toBeInTheDocument();
  });
  return await screen.findByRole("menuitem", { name: item });
}

describe("SessionsList: архив и удаление", () => {
  it("архив открывает окно со списком «Затронет» и шлёт If-Match из ETag", async () => {
    dependencies = {
      blocking: [],
      affected: [{ kind: "session", id: "sesn_1", name: null, status: "running", note: "ход остановится" }],
      truncated: false,
    };
    await userEvent.click(await openMenu("В архив"));

    const dialog = await screen.findByRole("dialog", { name: "Отправить сессию в архив?" });
    expect(await within(dialog).findByText("Затронет")).toBeInTheDocument();
    expect(within(dialog).getByText(/Можно вернуть из архива/)).toBeInTheDocument();
    expect(operations).toEqual(["archive"]);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => expect(managed.sessions.archive).toHaveBeenCalledWith("sesn_1", { ifMatch: '"7"' }));
  });

  it("удаление: текст «Это нельзя отменить», DELETE с If-Match", async () => {
    await userEvent.click(await openMenu("Удалить"));

    const dialog = await screen.findByRole("dialog", { name: "Удалить сессию «Разбор заявки»?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(operations).toEqual(["delete"]);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(managed.sessions.delete).toHaveBeenCalledWith("sesn_1", { ifMatch: '"7"' }));
  });

  it("ответ 409 при архиве показывает список из ответа", async () => {
    managed.sessions.archive.mockRejectedValue(
      Object.assign(new Error("Есть зависимости"), {
        status: 409,
        dependencies: {
          blocking: [{ kind: "deployment", id: "depl_1", name: "Отчёт", status: "active", note: null }],
          affected: [],
          truncated: false,
        },
      }),
    );
    await userEvent.click(await openMenu("В архив"));
    const dialog = await screen.findByRole("dialog", { name: "Отправить сессию в архив?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "В архив" })).toBeDisabled();
  });

  it("у архивной сессии есть «Вернуть из архива»", async () => {
    feed.items = [session({ archived_at: "2026-10-15T00:00:00.000Z" })];
    await userEvent.click(await openMenu("Вернуть из архива"));
    await waitFor(() => expect(managed.sessions.unarchive).toHaveBeenCalledWith("sesn_1"));
  });

  it("фильтр «В архиве» просит у сервера архивные сессии", async () => {
    render(
      <MemoryRouter>
        <I18nProvider>
          <SessionsList />
        </I18nProvider>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /Статус/ }));
    await userEvent.click(await screen.findByRole("option", { name: "В архиве" }));
    await waitFor(() =>
      expect(feed.params.some((params) => params?.include_archived === "true")).toBe(true),
    );
  });
});
