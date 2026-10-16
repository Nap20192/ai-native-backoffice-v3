import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { I18nProvider } from "../i18n";
import { AppSidebar } from "./AppSidebar";
import { CommandPalette } from "./CommandPalette";

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({
    data: {
      data: [{ id: "tenant-1", name: "OpenMA Workspace", role: "owner" }],
    },
  }),
}));

vi.mock("./UserProfile", () => ({ UserProfile: () => null }));

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/sessions"]}>
        <I18nProvider>
          <AppSidebar />
          <CommandPalette />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppSidebar tracks", () => {
  it("uses the tenant switcher as the first row without a brand row", async () => {
    const { container } = renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Навигация по рабочему пространству" });

    await waitFor(() => expect(screen.getByRole("button", { name: /Сменить рабочее пространство|Switch workspace|切换工作区/ })).toBeEnabled());
    expect(sidebar.firstElementChild).toHaveClass("console-sidebar-tenant");
    expect(container.querySelector(".console-sidebar-brand")).toBeNull();
  });

  it("keeps search beside the tenant switcher and opens the command palette", async () => {
    const user = userEvent.setup();
    const { container } = renderSidebar();

    const trigger = screen.getByRole("button", { name: /Командная палитра|Command palette|命令面板/ });
    expect(trigger.closest(".console-sidebar-tenant")).not.toBeNull();
    expect(trigger).toHaveAttribute("data-sidebar-search");
    expect(container.querySelector(".console-sidebar-command")).toBeNull();
    expect(trigger.querySelector("kbd")).toBeNull();
    await user.click(trigger);

    expect(screen.getByRole("dialog", { name: /Командная палитра|Command palette|命令面板/ })).toBeInTheDocument();
  });

  it("assigns every sidebar icon and label to the shared two-track grid", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Навигация по рабочему пространству" });
    const trackedRows = [
      screen.getByRole("button", { name: /Сменить рабочее пространство|Switch workspace|切换工作区/ }),
      ...within(sidebar).getAllByRole("link"),
    ];

    for (const row of trackedRows) {
      expect(row.querySelector('[data-sidebar-track="icon"]')).toBeInTheDocument();
      expect(row.querySelector('[data-sidebar-track="label"]')).toBeInTheDocument();
    }
    for (const heading of containerHeadings(sidebar)) {
      expect(heading).toHaveAttribute("data-sidebar-track", "label");
    }
  });

  it("keeps the tenant avatar on the exact shared icon track", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");

    expect(tokens).toContain("--tenant-avatar-optical-x: 0px;");
  });

  it("uses the DDC portal's sidebar rhythm: 64px header, 4px between rows", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(tokens).toContain("--sidebar-pill-gap: var(--density-unit);");
    expect(tokens).toContain("--sidebar-section-gap: var(--console-pad-md);");
    expect(shell).toMatch(
      /\.console-sidebar-nav\s*\{[^}]*padding: 12px 6px 12px 12px;[^}]*scrollbar-gutter: stable;/,
    );
    expect(shell).toMatch(
      /\.console-sidebar-row \+ \.console-sidebar-row,\s*\.console-sidebar-group-label \+ \.console-sidebar-row\s*\{[^}]*margin-top: 4px;/,
    );
    expect(shell).toMatch(
      /\.console-sidebar-group-label\s*\{[^}]*padding: 16px 12px 4px;[^}]*text-transform: uppercase;/,
    );
    expect(shell).toMatch(
      /\.console-sidebar-row\s*\{[^}]*gap: 12px;[^}]*border-radius: 12px;[^}]*padding: 8px 12px;/,
    );
  });

  it("marks the active row with the DDC selected fill and semibold weight", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(shell).toMatch(
      /\.console-sidebar-row\[data-active="true"\],\s*\.console-sidebar-row\[data-active="true"\]:hover\s*\{[^}]*background: var\(--ddc-selected-bg\);[^}]*color: var\(--ddc-selected-text\);[^}]*font-weight: 600;/,
    );
  });

  it("prevents accidental text selection on global app chrome", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(shell).toContain(".console-shell :where(");
    expect(shell).toContain("nav a");
    expect(shell).toMatch(
      /\.console-sidebar,\s*\.console-topbar\s*\{[^}]*-webkit-user-select: none;[^}]*user-select: none;/,
    );
    expect(shell).toContain("-webkit-user-select: none;");
    expect(shell).toContain("user-select: none;");
  });

  it("keeps the primary route flat and labels only the later navigation groups", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Навигация по рабочему пространству" });
    const headings = containerHeadings(sidebar).map((heading) => heading.textContent);

    expect(screen.getByRole("link", { name: /Сводка|Dashboard|仪表盘/ })).toBeInTheDocument();
    expect(headings).not.toContain("Обзор");
    expect(headings).not.toContain("Overview");
    expect(headings).not.toContain("概览");
    expect(headings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Управляемые агенты|Managed Agents|托管智能体/)]),
    );
  });

  it("shows the section names in Russian by default", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Навигация по рабочему пространству" });
    const headings = containerHeadings(sidebar).map((heading) => heading.textContent);
    const links = within(sidebar).getAllByRole("link").map((link) => link.textContent);

    expect(headings).toEqual(["Управляемые агенты", "Инфраструктура", "Конфигурация"]);
    expect(links).toEqual([
      "Сводка",
      "Агенты",
      "Сессии",
      "Файлы",
      "Запуски оценки",
      "Окружения",
      "Хранилища секретов",
      "Навыки",
      "Хранилища памяти",
      "Карточки моделей",
      "Harness",
      "Участники",
      "API-ключи",
      "Локальные среды",
    ]);
  });

  it("ведёт пункт «Harness» на страницу своих harness", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Навигация по рабочему пространству" });
    expect(within(sidebar).getByRole("link", { name: "Harness" })).toHaveAttribute("href", "/harnesses");
  });

  it("не показывает раздел «Аналитика»: модели внутренние, токены не отслеживаем", () => {
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Навигация по рабочему пространству" });
    expect(within(sidebar).queryByText("Аналитика")).toBeNull();
    const analyticsLinks = within(sidebar)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/analytics"));
    expect(analyticsLinks).toEqual([]);
  });

  it("does not offer the integrations group in the sidebar or the command palette", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const sidebar = screen.getByRole("complementary", { name: "Навигация по рабочему пространству" });

    expect(
      within(sidebar)
        .getAllByRole("link")
        .some((link) => link.getAttribute("href")?.startsWith("/integrations")),
    ).toBe(false);
    expect(within(sidebar).queryByText(/Интеграции|Integrations|集成/)).toBeNull();
    for (const brand of ["Linear", "GitHub", "Slack", "Feishu"]) {
      expect(within(sidebar).queryByText(brand)).toBeNull();
    }

    await user.click(screen.getByRole("button", { name: /Командная палитра/ }));
    const dialog = await screen.findByRole("dialog", { name: /Командная палитра/ });
    for (const brand of ["Linear", "GitHub", "Slack", "Feishu"]) {
      expect(within(dialog).queryByText(brand)).toBeNull();
    }
  });

  it("keeps the workspace menu compact instead of rendering tenant IDs as a second line", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(
      screen.getByRole("button", { name: /Сменить рабочее пространство|Switch workspace|切换工作区/ }),
    );

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("OpenMA Workspace")).toBeVisible();
    expect(within(menu).queryByText("tenant-1")).toBeNull();
  });
});

function containerHeadings(sidebar: HTMLElement) {
  return Array.from(sidebar.querySelectorAll(".console-sidebar-group-label"));
}
