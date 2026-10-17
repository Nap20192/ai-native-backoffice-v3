import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { SANDBOX_CATALOG_PATH } from "../lib/sandbox-catalog";
import { server } from "../mocks/server";
import { sandboxCatalogFixture } from "../test/sandbox-catalog-fixture";
import { EnvironmentDetail } from "./EnvironmentDetail";

const managed = vi.hoisted(() => ({
  environments: { update: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn() },
}));
const current = vi.hoisted(() => ({ env: null as unknown }));

vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({ data: current.env, error: null }),
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
    id: "env-1",
    type: "environment",
    name: "Development",
    description: "",
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
      packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    },
    metadata: {},
    archived_at: null,
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };

beforeEach(() => {
  current.env = environment();
  dependencies = { blocking: [], affected: [], truncated: false };
  managed.environments.archive.mockReset().mockResolvedValue({});
  managed.environments.unarchive.mockReset().mockResolvedValue(environment());
  managed.environments.delete.mockReset().mockResolvedValue({});
  server.use(
    http.get(`*${SANDBOX_CATALOG_PATH}`, () => HttpResponse.json(sandboxCatalogFixture as never)),
    http.get("*/v1/oma/dependencies/environment/:id", () => HttpResponse.json(dependencies)),
    http.get("*/v1/environments/:id", () => HttpResponse.json(environment(), { headers: { ETag: '"6"' } })),
  );
});

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/environments/env-1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/environments/:id" element={<EnvironmentDetail />} />
            <Route path="/environments" element={<p>Список окружений</p>} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EnvironmentDetail: архив и удаление", () => {
  it("архив шлёт If-Match из ETag и ведёт к списку", async () => {
    dependencies = {
      blocking: [],
      affected: [{ kind: "session", id: "sesn_1", name: null, status: "idle", note: "потеряет окружение" }],
      truncated: false,
    };
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "В архив" }));
    const dialog = await screen.findByRole("dialog", { name: "Отправить окружение в архив?" });
    expect(await within(dialog).findByText("Затронет")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "В архив" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "В архив" }));

    await waitFor(() => expect(managed.environments.archive).toHaveBeenCalledWith("env-1", { ifMatch: '"6"' }));
    expect(await screen.findByText("Список окружений")).toBeInTheDocument();
  });

  it("удаление: блокирующий деплоймент выключает кнопку", async () => {
    dependencies = {
      blocking: [{ kind: "deployment", id: "depl_1", name: "Отчёт", status: "active", note: null }],
      affected: [],
      truncated: false,
    };
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Удалить окружение" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить окружение?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("архивное окружение возвращается кнопкой «Вернуть из архива»", async () => {
    current.env = environment({ archived_at: "2026-10-15T00:00:00.000Z" });
    renderPage();

    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Вернуть из архива" }));

    await waitFor(() => expect(managed.environments.unarchive).toHaveBeenCalledWith("env-1"));
  });
});
