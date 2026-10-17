import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { VaultsList } from "./VaultsList";

const managed = vi.hoisted(() => ({
  vaults: { create: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn() },
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
    id: "vault_1",
    display_name: "Рабочие ключи",
    type: "vault",
    metadata: {},
    created_at: "2026-10-14T10:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };
let operations: string[];

beforeEach(() => {
  feed.items = [store()];
  feed.params = [];
  dependencies = { blocking: [], affected: [], truncated: false };
  operations = [];
  managed.vaults.archive.mockReset().mockResolvedValue({});
  managed.vaults.unarchive.mockReset().mockResolvedValue({});
  managed.vaults.delete.mockReset().mockResolvedValue({});
  server.use(
    http.get("*/v1/oma/dependencies/vault/:id", ({ request }) => {
      operations.push(new URL(request.url).searchParams.get("operation") ?? "");
      return HttpResponse.json(dependencies);
    }),
  );
});

async function openMenu(item: string, showArchived = false) {
  render(
    <MemoryRouter>
      <I18nProvider>
        <VaultsList />
      </I18nProvider>
    </MemoryRouter>,
  );
  if (showArchived) {
    const chips = await screen.findAllByTestId("filter-chip");
    await userEvent.click(within(chips.find((chip) => /Статус/.test(chip.textContent ?? ""))!).getAllByRole("button")[0]);
    await userEvent.click(await screen.findByRole("option", { name: "В архиве" }));
  }
  await waitFor(() => {
    fireEvent.contextMenu(screen.getByText("Рабочие ключи"));
    expect(screen.getByRole("menuitem", { name: item })).toBeInTheDocument();
  });
  return screen.getByRole("menuitem", { name: item });
}

describe("VaultsList: архив и удаление", () => {
  it("архив показывает «Мешает» с деплойментом и выключает кнопку", async () => {
    dependencies = {
      blocking: [{ kind: "deployment", id: "depl_1", name: "Утренний отчёт", status: "active", note: null }],
      affected: [],
      truncated: false,
    };
    await userEvent.click(await openMenu("В архив"));

    const dialog = await screen.findByRole("dialog", { name: "Отправить хранилище в архив?" });
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "В архив" })).toBeDisabled();
    expect(operations).toEqual(["archive"]);
    expect(managed.vaults.archive).not.toHaveBeenCalled();
  });

  it("архив без зависимостей без If-Match: у хранилищ секретов ревизии нет", async () => {
    await userEvent.click(await openMenu("В архив"));
    const dialog = await screen.findByRole("dialog", { name: "Отправить хранилище в архив?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));
    await waitFor(() =>
      expect(managed.vaults.archive).toHaveBeenCalledWith("vault_1", {}),
    );
  });

  it("удаление говорит «Это нельзя отменить» и «учётные данные удалятся вместе с хранилищем»", async () => {
    dependencies = {
      blocking: [],
      affected: [{ kind: "credential", id: "cred_1", name: "GitHub", status: null, note: "удалится вместе с хранилищем" }],
      truncated: false,
    };
    await userEvent.click(await openMenu("Удалить"));

    const dialog = await screen.findByRole("dialog", { name: "Удалить хранилище «Рабочие ключи»?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Затронет")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await waitFor(() =>
      expect(managed.vaults.delete).toHaveBeenCalledWith("vault_1", {}),
    );
  });

  it("ответ 409 при удалении показывает список из ответа", async () => {
    managed.vaults.delete.mockRejectedValue(
      Object.assign(new Error("x"), {
        status: 409,
        dependencies: {
          blocking: [{ kind: "session", id: "sesn_9", name: "Сессия", status: "running", note: null }],
          affected: [],
          truncated: false,
        },
      }),
    );
    await userEvent.click(await openMenu("Удалить"));
    const dialog = await screen.findByRole("dialog", { name: "Удалить хранилище «Рабочие ключи»?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("у архивного хранилища есть «Вернуть из архива»", async () => {
    feed.items = [store({ archived_at: "2026-10-15T00:00:00.000Z" })];
    await userEvent.click(await openMenu("Вернуть из архива", true));
    await waitFor(() => expect(managed.vaults.unarchive).toHaveBeenCalledWith("vault_1"));
  });
});
