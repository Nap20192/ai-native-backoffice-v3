import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { AgentsList } from "./AgentsList";

const managed = vi.hoisted(() => ({
  agents: { list: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn() },
  skills: { list: vi.fn() },
}));
const feed = vi.hoisted(() => ({
  items: [] as unknown[],
  params: [] as Array<Record<string, unknown> | undefined>,
  refresh: vi.fn(),
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
      refresh: feed.refresh,
    };
  },
}));
vi.mock("./agents/AgentFormDialog", () => ({ AgentFormDialog: () => null }));
vi.mock("../components/assistant/AssistantProvider", () => ({ useOptionalAssistant: () => null }));

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

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    name: "Юрист",
    model: "qwen",
    version: 3,
    created_at: "2026-10-01T10:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };
let operations: string[];

beforeEach(() => {
  feed.items = [agent()];
  feed.params = [];
  feed.refresh.mockReset();
  dependencies = { blocking: [], affected: [], truncated: false };
  operations = [];
  managed.agents.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.agents.archive.mockReset().mockResolvedValue({});
  managed.agents.unarchive.mockReset().mockResolvedValue({});
  managed.agents.delete.mockReset().mockResolvedValue({ id: "agent-1", type: "agent_deleted" });
  managed.skills.list.mockReset().mockResolvedValue({ data: [] });
  server.use(
    http.get("*/v1/oma/model_cards", () => HttpResponse.json({ data: [] })),
    http.get("*/v1/oma/dependencies/agent/:id", ({ request }) => {
      operations.push(new URL(request.url).searchParams.get("operation") ?? "");
      return HttpResponse.json(dependencies);
    }),
  );
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

async function openMenu(item: string, showArchived = false) {
  render(
    <MemoryRouter initialEntries={["/agents"]}>
      <I18nProvider>
        <Routes>
          <Route path="/agents" element={<AgentsList />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
  if (showArchived) {
    const chips = await screen.findAllByTestId("filter-chip");
    await userEvent.click(within(chips.find((chip) => /Статус/.test(chip.textContent ?? ""))!).getAllByRole("button")[0]);
    await userEvent.click(await screen.findByRole("option", { name: "В архиве" }));
  }
  await waitFor(() => {
    fireEvent.contextMenu(screen.getByText("Юрист"));
    expect(screen.getByRole("menuitem", { name: item })).toBeInTheDocument();
  });
  return screen.getByRole("menuitem", { name: item });
}

describe("AgentsList: архив, удаление, восстановление", () => {
  it("архив шлёт If-Match с версией агента", async () => {
    await userEvent.click(await openMenu("В архив"));
    const dialog = await screen.findByRole("dialog", { name: "Отправить агента в архив?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));
    await waitFor(() => expect(managed.agents.archive).toHaveBeenCalledWith("agent-1", { ifMatch: '"3"' }));
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled());
  });

  it("удаление: живой деплоймент мешает, кнопка выключена", async () => {
    dependencies = {
      blocking: [{ kind: "deployment", id: "depl_1", name: "Утренний отчёт", status: "active", note: "запуски упадут" }],
      affected: [],
      truncated: false,
    };
    await userEvent.click(await openMenu("Удалить"));

    const dialog = await screen.findByRole("dialog", { name: "Удалить агента «Юрист»?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByText("запуски упадут")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
    expect(operations).toEqual(["delete"]);
  });

  it("удаление без зависимостей шлёт DELETE с If-Match", async () => {
    await userEvent.click(await openMenu("Удалить"));
    const dialog = await screen.findByRole("dialog", { name: "Удалить агента «Юрист»?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(managed.agents.delete).toHaveBeenCalledWith("agent-1", { ifMatch: '"3"' }));
  });

  it("ответ 412 просит обновить страницу", async () => {
    managed.agents.delete.mockRejectedValue(Object.assign(new Error("x"), { status: 412 }));
    await userEvent.click(await openMenu("Удалить"));
    const dialog = await screen.findByRole("dialog", { name: "Удалить агента «Юрист»?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    expect(await within(dialog).findByText("Объект изменили, обновите страницу.")).toBeInTheDocument();
  });

  it("у архивного агента есть «Вернуть из архива»", async () => {
    feed.items = [agent({ archived_at: "2026-10-05T00:00:00Z" })];
    await userEvent.click(await openMenu("Вернуть из архива", true));
    await waitFor(() => expect(managed.agents.unarchive).toHaveBeenCalledWith("agent-1", { ifMatch: '"3"' }));
  });

  it("пункт «Создать деплоймент» ведёт на форму с агентом", async () => {
    await userEvent.click(await openMenu("Создать деплоймент"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deployments/new?agent=agent-1"));
  });
});
