import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import type { ModelCard } from "@open-managed-agents/api-types";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { ModelCardsList } from "./ModelCardsList";

const feed = vi.hoisted(() => ({
  items: [] as unknown[],
  params: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock("../lib/useApiQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/useApiQuery")>()),
  useOmaInfiniteApiQuery: (_path: string, opts?: { params?: Record<string, unknown> }) => {
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

function card(overrides: Partial<ModelCard> = {}): ModelCard {
  return {
    id: "mc_1",
    model_id: "claude-prod",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    api_key_preview: "abcd",
    created_at: "2026-10-14T10:00:00.000Z",
    updated_at: "2026-10-16T11:00:00.000Z",
    ...overrides,
  };
}

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };
let operations: string[];
let archives: Array<string | null>;
let unarchives: Array<string | null>;
let deletes: Array<string | null>;

beforeEach(() => {
  feed.items = [card()];
  feed.params = [];
  dependencies = { blocking: [], affected: [], truncated: false };
  operations = [];
  archives = [];
  unarchives = [];
  deletes = [];
  server.use(
    http.get("*/v1/oma/dependencies/model_card/:id", ({ request }) => {
      operations.push(new URL(request.url).searchParams.get("operation") ?? "");
      return HttpResponse.json(dependencies);
    }),
    http.post("*/v1/oma/model_cards/:id/archive", ({ request }) => {
      archives.push(request.headers.get("if-match"));
      return HttpResponse.json(card({ archived_at: "2026-10-17T00:00:00.000Z" }));
    }),
    http.post("*/v1/oma/model_cards/:id/unarchive", ({ request }) => {
      unarchives.push(request.headers.get("if-match"));
      return HttpResponse.json(card());
    }),
    http.delete("*/v1/oma/model_cards/:id", ({ request }) => {
      deletes.push(request.headers.get("if-match"));
      return HttpResponse.json({ type: "model_card_deleted", id: "mc_1" });
    }),
  );
});

function renderList() {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <ModelCardsList />
      </I18nProvider>
    </MemoryRouter>,
  );
}

async function openRowMenu(item: string) {
  renderList();
  const row = await screen.findByText("claude-prod");
  fireEvent.contextMenu(row);
  return await screen.findByRole("menuitem", { name: item });
}

describe("ModelCardsList: архив и удаление", () => {
  it("архив: окно показывает «Затронет» и шлёт If-Match с updated_at", async () => {
    dependencies = {
      blocking: [],
      affected: [{ kind: "agent", id: "agent_old", name: "Старый бот", status: null, note: "в архиве" }],
      truncated: false,
    };
    await userEvent.click(await openRowMenu("В архив"));

    const dialog = await screen.findByRole("dialog", { name: "Отправить карточку модели в архив?" });
    expect(await within(dialog).findByText("Затронет")).toBeInTheDocument();
    expect(operations).toEqual(["archive"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => expect(archives).toEqual(["2026-10-16T11:00:00.000Z"]));
  });

  it("архив без правок берёт created_at как ревизию", async () => {
    feed.items = [card({ updated_at: undefined })];
    await userEvent.click(await openRowMenu("В архив"));
    const dialog = await screen.findByRole("dialog", { name: "Отправить карточку модели в архив?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));
    await waitFor(() => expect(archives).toEqual(["2026-10-14T10:00:00.000Z"]));
  });

  it("удаление: агент мешает, кнопка выключена, есть «Это нельзя отменить»", async () => {
    dependencies = {
      blocking: [{ kind: "agent", id: "agent_1", name: "Юрист", status: null, note: null }],
      affected: [],
      truncated: false,
    };
    await userEvent.click(await openRowMenu("Удалить"));

    const dialog = await screen.findByRole("dialog", { name: "Удалить карточку модели?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
    expect(operations).toEqual(["delete"]);
  });

  it("удаление без зависимостей шлёт DELETE с If-Match", async () => {
    await userEvent.click(await openRowMenu("Удалить"));
    const dialog = await screen.findByRole("dialog", { name: "Удалить карточку модели?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(deletes).toEqual(["2026-10-16T11:00:00.000Z"]));
  });

  it("ответ 409 при удалении показывает список из ответа", async () => {
    server.use(
      http.delete("*/v1/oma/model_cards/:id", () =>
        HttpResponse.json(
          {
            type: "error",
            error: {
              type: "dependency_conflict_error",
              message: "x",
              dependencies: {
                blocking: [{ kind: "agent", id: "agent_9", name: "Новый бот", status: null, note: null }],
                affected: [],
                truncated: false,
              },
            },
          },
          { status: 409 },
        ),
      ),
    );
    await userEvent.click(await openRowMenu("Удалить"));
    const dialog = await screen.findByRole("dialog", { name: "Удалить карточку модели?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    expect(await within(dialog).findByText("Новый бот", { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("у архивной карточки есть «Вернуть из архива»", async () => {
    feed.items = [card({ archived_at: "2026-10-15T00:00:00.000Z" })];
    renderList();
    fireEvent.contextMenu(await screen.findByText("claude-prod"));
    expect(screen.queryByRole("menuitem", { name: "В архив" })).toBeNull();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Вернуть из архива" }));
    await waitFor(() => expect(unarchives).toEqual(["2026-10-16T11:00:00.000Z"]));
  });

  it("фильтр «В архиве» просит у сервера архивные карточки", async () => {
    renderList();
    await userEvent.click(await screen.findByRole("button", { name: /Статус/ }));
    await userEvent.click(await screen.findByRole("option", { name: "В архиве" }));
    await waitFor(() =>
      expect(feed.params.some((params) => params?.include_archived === "true")).toBe(true),
    );
  });
});
