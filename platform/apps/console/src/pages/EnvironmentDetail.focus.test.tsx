import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { EnvironmentDetail } from "./EnvironmentDetail";

vi.mock("../lib/api", () => ({
  useApi: () => ({ api: vi.fn() }),
}));

vi.mock("../lib/useApiQuery", () => {
  const data = {
      id: "env-1",
      name: "Development",
      description: "Development environment",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
        packages: {
          type: "packages",
          apt: [],
          cargo: [],
          gem: [],
          go: [],
          npm: [],
          pip: [],
        },
      },
      type: "environment",
      metadata: {},
      archived_at: null,
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:00:00.000Z",
  };

  return {
    useApiQuery: () => ({ data, error: null }),
  };
});

// Страница спрашивает каталог образов у сервера, поэтому ей нужен QueryClient.
// Подставной `api` отвечает пустотой: сервер без каталога, раздела «Образ» нет.
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/environments/env-1"]}>
        <Routes>
          <Route path="/environments/:id" element={<EnvironmentDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EnvironmentDetail focus treatment", () => {
  it("does not override the shared DDC focus ring on switches", async () => {
    renderPage();

    const toggle = await screen.findByRole("switch", {
      name: "Разрешить сетевой доступ MCP-серверам",
    });
    // Переключатель DDC: класс `switch`, а кольцо фокуса рисует общее правило
    // `:focus-visible`. Своих колец и снятия outline на нём быть не должно.
    expect(toggle).toHaveClass("switch");
    expect(toggle.className).not.toContain("focus-visible:ring");
    expect(toggle.className).not.toContain("outline-none");
    expect(toggle.className).not.toContain("focus-visible:ring-brand");
  });

  it("uses the shared settings stack and compact section-card geometry", async () => {
    renderPage();

    expect(await screen.findByTestId("settings-layout")).toHaveClass(
      "console-settings-layout",
    );
    // Пока каталог образов грузится, у раздела «Образ» стоит заглушка: ждём ответа.
    await waitFor(() => expect(screen.getAllByTestId("settings-section")).toHaveLength(3));
    const sections = screen.getAllByTestId("settings-section");
    expect(sections[0]).toHaveClass("console-settings-section");
    expect(screen.getByTestId("settings-actions")).toHaveClass(
      "console-settings-actions",
    );
  });

  it("shows Russian section titles and keeps the switch state in aria-checked", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByTestId("settings-section")).toHaveLength(3));
    const titles = screen
      .getAllByTestId("settings-section")
      .map((section) => section.querySelector("h2")?.textContent);
    expect(titles).toEqual(["Сеть", "Пакеты", "Метаданные"]);

    const toggle = screen.getByRole("switch", {
      name: "Разрешить сетевой доступ менеджерам пакетов",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("labels icon-only buttons and form rows in Russian", async () => {
    renderPage();

    await screen.findByTestId("settings-layout");
    fireEvent.click(screen.getByRole("button", { name: "Добавить пакет" }));
    expect(screen.getByRole("button", { name: "Удалить строку пакетов" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Добавить метку" }));
    expect(screen.getByRole("button", { name: "Удалить строку метаданных" })).toBeInTheDocument();
  });
});
