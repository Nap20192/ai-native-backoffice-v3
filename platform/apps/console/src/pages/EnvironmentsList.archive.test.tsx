import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { SANDBOX_CATALOG_PATH } from "../lib/sandbox-catalog";
import { server } from "../mocks/server";
import { sandboxCatalogFixture } from "../test/sandbox-catalog-fixture";
import { EnvironmentsList } from "./EnvironmentsList";

const managed = vi.hoisted(() => ({
  environments: { create: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn() },
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
      error: null,
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

function environment(overrides: Record<string, unknown> = {}) {
  return {
    id: "env_1",
    type: "environment",
    name: "Рабочее",
    description: "",
    config: { type: "cloud" },
    metadata: {},
    created_at: "2026-10-14T10:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };
let operations: string[];

beforeEach(() => {
  feed.items = [environment()];
  feed.params = [];
  feed.refresh.mockReset();
  dependencies = { blocking: [], affected: [], truncated: false };
  operations = [];
  managed.environments.archive.mockReset().mockResolvedValue({});
  managed.environments.unarchive.mockReset().mockResolvedValue({});
  managed.environments.delete.mockReset().mockResolvedValue({});
  server.use(
    http.get(`*${SANDBOX_CATALOG_PATH}`, () => HttpResponse.json(sandboxCatalogFixture as never)),
    http.get("*/v1/oma/dependencies/environment/:id", ({ request }) => {
      operations.push(new URL(request.url).searchParams.get("operation") ?? "");
      return HttpResponse.json(dependencies);
    }),
    http.get("*/v1/environments/:id", () => HttpResponse.json(environment(), { headers: { ETag: '"6"' } })),
  );
});

async function openMenu(item: string, showArchived = false) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <I18nProvider>
          <EnvironmentsList />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  if (showArchived) {
    const chips = await screen.findAllByTestId("filter-chip");
    await userEvent.click(within(chips.find((chip) => /Статус/.test(chip.textContent ?? ""))!).getAllByRole("button")[0]);
    await userEvent.click(await screen.findByRole("option", { name: "В архиве" }));
  }
  await waitFor(() => {
    fireEvent.contextMenu(screen.getByText("Рабочее"));
    expect(screen.getByRole("menuitem", { name: item })).toBeInTheDocument();
  });
  return screen.getByRole("menuitem", { name: item });
}

describe("EnvironmentsList: архив и удаление", () => {
  it("архив: активный деплоймент мешает, кнопка выключена", async () => {
    dependencies = {
      blocking: [{ kind: "deployment", id: "depl_1", name: "Отчёт", status: "active", note: null }],
      affected: [],
      truncated: false,
    };
    await userEvent.click(await openMenu("В архив"));

    const dialog = await screen.findByRole("dialog", { name: "Отправить окружение в архив?" });
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "В архив" })).toBeDisabled();
    expect(operations).toEqual(["archive"]);
  });

  it("архив без зависимостей шлёт If-Match из ETag", async () => {
    await userEvent.click(await openMenu("В архив"));
    const dialog = await screen.findByRole("dialog", { name: "Отправить окружение в архив?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));
    await waitFor(() =>
      expect(managed.environments.archive).toHaveBeenCalledWith("env_1", { ifMatch: '"6"' }),
    );
    await waitFor(() => expect(feed.refresh).toHaveBeenCalled());
  });

  it("удаление: «Это нельзя отменить», задание окружения мешает", async () => {
    dependencies = {
      blocking: [{ kind: "environment_work", id: "work_1", name: null, status: "open", note: null }],
      affected: [],
      truncated: false,
    };
    await userEvent.click(await openMenu("Удалить"));

    const dialog = await screen.findByRole("dialog", { name: "Удалить окружение «Рабочее»?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("ответ 409 при удалении показывает список из ответа", async () => {
    managed.environments.delete.mockRejectedValue(
      Object.assign(new Error("x"), {
        status: 409,
        dependencies: {
          blocking: [{ kind: "session", id: "sesn_7", name: "Живая", status: "running", note: null }],
          affected: [],
          truncated: false,
        },
      }),
    );
    await userEvent.click(await openMenu("Удалить"));
    const dialog = await screen.findByRole("dialog", { name: "Удалить окружение «Рабочее»?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("у архивного окружения есть «Вернуть из архива»", async () => {
    feed.items = [environment({ archived_at: "2026-10-15T00:00:00.000Z" })];
    await userEvent.click(await openMenu("Вернуть из архива", true));
    await waitFor(() => expect(managed.environments.unarchive).toHaveBeenCalledWith("env_1"));
  });
});
