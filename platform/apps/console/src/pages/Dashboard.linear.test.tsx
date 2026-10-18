import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { Dashboard } from "./Dashboard";

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string) =>
    path === "/v1/oma/stats"
      ? {
          data: {
            agents: 1,
            sessions: 2,
            environments: 3,
            vaults: 4,
            skills: 5,
            model_cards: 6,
            api_keys: 7,
          },
          isLoading: false,
        }
      : { data: { data: [] }, isLoading: false },
}));

describe("Dashboard Linear density", () => {
  it("keeps four primary KPI cards and moves secondary counts into activity content", () => {
    render(
      <MemoryRouter>
        <I18nProvider>
          <Dashboard />
        </I18nProvider>
      </MemoryRouter>,
    );

    const primary = screen.getByTestId("dashboard-primary-kpis");
    expect(within(primary).getAllByRole("button")).toHaveLength(4);
    expect(screen.getByTestId("dashboard-secondary-stats")).toHaveTextContent("5");
    expect(screen.getByTestId("dashboard-secondary-stats")).toHaveTextContent("6");
  });

  it("shows the dashboard in Russian with icon KPI tiles and numbered steps", () => {
    const { container } = render(
      <MemoryRouter>
        <I18nProvider>
          <Dashboard />
        </I18nProvider>
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { name: "Начало работы" }),
    ).toBeInTheDocument();
    const primary = screen.getByTestId("dashboard-primary-kpis");
    expect(within(primary).getByRole("button", { name: "Агенты: 1" })).toBeInTheDocument();
    expect(within(primary).getByRole("button", { name: "Сессии: 2" })).toBeInTheDocument();
    expect(screen.getByText("Шаг 1")).toBeInTheDocument();
    expect(screen.getByText("Шаг 3")).toBeInTheDocument();
    // The CLI quickstart was removed with the oma CLI on 2026-10-19.
    // The steps now lead to the console's own pages.
    expect(screen.getByRole("button", { name: "Быстрый старт" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Новый агент" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Окружения" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сессии" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/CLI|@openma\/cli/);
    expect(screen.getByText("Сессий пока нет")).toBeInTheDocument();
  });
});
