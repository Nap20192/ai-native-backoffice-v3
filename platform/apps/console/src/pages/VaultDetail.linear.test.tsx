import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { VaultDetail } from "./VaultDetail";

const vault = {
  id: "vault-1",
  display_name: "Team credentials",
  type: "vault",
  archived_at: null,
  metadata: {},
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T11:00:00.000Z",
};

vi.mock("../lib/api", () => ({ useApi: () => ({ api: vi.fn() }) }));
vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string | null) =>
    path === "/v1/vaults/vault-1"
      ? { data: vault, error: null }
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
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

describe("VaultDetail Linear rail", () => {
  it("keeps the resource title in the page header, metadata in the rail, and credentials wireless", async () => {
    render(
      <MemoryRouter initialEntries={["/vaults/vault-1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/vaults/:id" element={<VaultDetail />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>,
    );

    const title = await screen.findByRole("heading", { level: 1, name: "Team credentials" });
    expect(screen.getByTestId("detail-body")).not.toContainElement(title);
    expect(screen.getByTestId("detail-layout")).toHaveAttribute("data-detail-layout", "rail");
    const rail = screen.getByTestId("detail-rail");
    expect(within(rail).getByText("Свойства")).toBeInTheDocument();
    expect(within(rail).getByText("ID")).toBeInTheDocument();
    expect(within(rail).getByText("vault-1")).toBeInTheDocument();
    expect(within(rail).getByText("Статус")).toBeInTheDocument();
    expect(within(rail).getByText("Активно")).toBeInTheDocument();

    const surface = screen.getByTestId("credential-list-surface");
    expect(surface).toHaveClass("console-detail-table-wrap");
    // Список учётных данных лежит в карточке DDC с заголовком секции.
    expect(screen.getByRole("heading", { level: 2, name: /Учётные данные/ }))
      .toBeInTheDocument();
    expect(within(surface).getByText("Учётных данных пока нет")).toBeInTheDocument();
    // Кнопка «Добавить» есть в шапке секции и в пустом состоянии.
    expect(screen.getAllByRole("button", { name: "Добавить" })).toHaveLength(2);
  });
});
