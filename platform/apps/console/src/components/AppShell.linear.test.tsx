import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { I18nProvider } from "../i18n";
import { AppShell } from "./AppShell";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock("./AppSidebar", () => ({
  AppSidebar: () => (
    <aside aria-label="Workspace navigation" data-sidebar="sidebar">
      Navigation
      <button
        type="button"
        aria-label="Sidebar portal menu"
        aria-expanded="false"
        data-sidebar-overlay-trigger
        onClick={(event) => event.currentTarget.setAttribute("aria-expanded", "true")}
      >
        Menu
      </button>
    </aside>
  ),
}));

vi.mock("./AppBreadcrumb", () => ({
  AppBreadcrumb: () => <nav aria-label="Breadcrumb">Agents</nav>,
}));

vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./NavigationProgress", () => ({ NavigationProgress: () => null }));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

function renderShell() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/agents"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="agents" element={<div>Agent list</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("AppShell DDC composition", () => {
  it("starts at the DDC portal's 256px desktop navigation width", () => {
    renderShell();

    expect(document.querySelector("[data-console-shell]")).toHaveStyle({
      "--shell-sidebar-current-w": "256px",
    });
  });

  it("gives the tenant and breadcrumb track a shared 64px header rhythm", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/styles/console-tokens.css"), "utf8");
    const bridge = readFileSync(resolve(process.cwd(), "src/styles/ddc-bridge.css"), "utf8");
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(tokens).toContain("--shell-top-h: calc(var(--density-unit) * 44);");
    expect(bridge).toContain("--shell-top-h: 64px;");
    expect(shell).toContain("height: var(--shell-top-h);");
    expect(shell).toContain("flex: 0 0 var(--shell-top-h);");
    expect(shell).toMatch(
      /\.console-sidebar-tenant\s*\{[^}]*height: var\(--shell-top-h\);[^}]*flex: 0 0 var\(--shell-top-h\);/,
    );
  });

  it("gives breadcrumb text a distinct 14px header hierarchy", () => {
    const breadcrumb = readFileSync(resolve(process.cwd(), "src/components/ui/breadcrumb.tsx"), "utf8");
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(breadcrumb).toContain("gap-1.5 text-base");
    expect(breadcrumb).toContain('cn("font-medium text-foreground"');
    expect(shell).toMatch(
      /\.console-breadcrumb \[data-slot="breadcrumb-list"\]\s*\{[^}]*font-size: 0\.875rem;/,
    );
    expect(shell).toMatch(
      /\.console-breadcrumb \[data-slot="breadcrumb-page"\]\s*\{[^}]*font-weight: 600;/,
    );
  });

  it("places the breadcrumb on the shell header above the route surface", () => {
    renderShell();

    const surface = screen.getByTestId("console-route-surface");
    const workspace = surface.parentElement;
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(workspace).toHaveAttribute("data-shell-slot", "workspace");
    expect(screen.getByRole("complementary", { name: "Workspace navigation" }).closest("[data-shell-slot]"))
      .toHaveAttribute("data-shell-slot", "sidebar");
    expect(breadcrumb.closest(".console-topbar")?.parentElement).toBe(workspace);
    expect(surface.contains(breadcrumb)).toBe(false);
    expect(
      breadcrumb.closest(".console-topbar")?.compareDocumentPosition(surface) ?? 0,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(surface).getByText("Agent list")).toBeInTheDocument();
  });

  it("reveals one external restore control after the sidebar is hidden", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByRole("button", { name: "Показать меню" })).not.toBeInTheDocument();
    await user.keyboard("{Control>}\\{/Control}");

    expect(screen.getByRole("button", { name: "Показать меню" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Показать меню" })).toHaveLength(1);
  });

  it("keeps the hover preview open while a portaled sidebar menu is expanded", async () => {
    const user = userEvent.setup();
    renderShell();

    const shell = document.querySelector("[data-console-shell]");
    await user.keyboard("{Control>}\\{/Control}");
    await user.hover(document.querySelector(".console-sidebar-hover-zone") as HTMLElement);
    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");

    await user.click(screen.getByRole("button", { name: "Sidebar portal menu" }));
    fireEvent.mouseLeave(document.querySelector(".console-sidebar-rail") as HTMLElement);

    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");
  });

  it("latches the hover preview while a tenant trigger is opening its portaled menu", async () => {
    const user = userEvent.setup();
    renderShell();

    const shell = document.querySelector("[data-console-shell]");
    const rail = document.querySelector(".console-sidebar-rail") as HTMLElement;
    const trigger = screen.getByRole("button", { name: "Sidebar portal menu" });

    await user.keyboard("{Control>}\\{/Control}");
    await user.hover(document.querySelector(".console-sidebar-hover-zone") as HTMLElement);
    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");

    fireEvent.pointerDown(trigger);
    fireEvent.mouseLeave(rail);
    await user.click(trigger);

    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");
  });

  it("opens the folded sidebar from the left segment of the route topbar", async () => {
    const user = userEvent.setup();
    renderShell();

    const shell = document.querySelector("[data-console-shell]");
    await user.keyboard("{Control>}\\{/Control}");
    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-hidden");

    fireEvent.pointerMove(document.querySelector("[data-top-row]") as HTMLElement, {
      clientX: 100,
    });

    expect(shell).toHaveAttribute("data-sidebar-state", "desktop-preview");
  });

  it("dims the workspace behind an open hover preview", async () => {
    const user = userEvent.setup();
    renderShell();

    const scrim = screen.getByTestId("sidebar-preview-scrim");
    expect(scrim).toHaveAttribute("data-open", "false");

    await user.keyboard("{Control>}\\{/Control}");
    await user.hover(document.querySelector(".console-sidebar-hover-zone") as HTMLElement);

    expect(scrim).toHaveAttribute("aria-hidden", "true");
    expect(scrim).toHaveAttribute("data-open", "true");
  });

  it("closes the phone drawer after navigating to another section", async () => {
    const user = userEvent.setup();
    const desktopWidth = window.innerWidth;
    window.innerWidth = 390;
    try {
      render(
        <I18nProvider>
          <MemoryRouter initialEntries={["/agents"]}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="agents" element={<Link to="/sessions">To sessions</Link>} />
                <Route path="sessions" element={<div>Sessions page</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </I18nProvider>,
      );

      const shell = document.querySelector("[data-console-shell]");
      expect(shell).toHaveAttribute("data-sidebar-state", "mobile-hidden");

      await user.click(screen.getByRole("button", { name: "Показать меню" }));
      expect(shell).toHaveAttribute("data-sidebar-state", "mobile-drawer");

      await user.click(screen.getByRole("link", { name: "To sessions" }));
      expect(screen.getByText("Sessions page")).toBeInTheDocument();
      expect(shell).toHaveAttribute("data-sidebar-state", "mobile-hidden");
    } finally {
      window.innerWidth = desktopWidth;
    }
  });

  it("dims the whole page behind the phone drawer and closes it on a tap", async () => {
    const user = userEvent.setup();
    const desktopWidth = window.innerWidth;
    window.innerWidth = 390;
    try {
      renderShell();
      const shell = document.querySelector("[data-console-shell]");
      await user.click(screen.getByRole("button", { name: "Показать меню" }));
      expect(shell).toHaveAttribute("data-sidebar-state", "mobile-drawer");

      const scrim = document.querySelector(".console-sidebar-scrim") as HTMLElement;
      expect(scrim).not.toBeNull();
      // Затемнение не Button: у кнопки есть высота h-10, и оно закрывало бы
      // только верхние 40px страницы.
      expect(scrim.className).toBe("console-sidebar-scrim");
      const css = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");
      expect(css).toMatch(
        /\.console-sidebar-scrim\s*\{[^}]*position: fixed;[^}]*inset: 0;[^}]*width: 100%;[^}]*height: 100%;/,
      );

      await user.click(scrim);
      expect(shell).toHaveAttribute("data-sidebar-state", "mobile-hidden");
    } finally {
      window.innerWidth = desktopWidth;
    }
  });

  it("lays the sidebar out as a full-height DDC column with a right border", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(shell).toMatch(
      /\.console-sidebar-rail\s*\{[^}]*border-right: 1px solid var\(--ddc-divider\);[^}]*background: var\(--ddc-surface\);/,
    );
    expect(shell).toContain("grid-template-rows: minmax(0, 1fr)");
    expect(shell).toContain("grid-template-columns: var(--shell-sidebar-current-w) minmax(0, 1fr)");
    expect(shell).toMatch(
      /\.console-topbar\s*\{[^}]*border-bottom: 1px solid var\(--ddc-divider\);[^}]*background: var\(--ddc-surface\);/,
    );
    expect(shell).not.toContain("border-left: 1px solid var(--border-chrome)");
    expect(shell).not.toContain("padding-block: var(--shell-stage-gap)");
  });

  it("slides the hidden and mobile sidebar in full height with a 288px phone drawer", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(shell).toContain("inset: 0 auto 0 0;");
    expect(shell).toContain("transform: translateX(-100%);");
    expect(shell).toContain("visibility: hidden;");
    expect(shell).toMatch(
      /data-sidebar-state\^="mobile-"\] \.console-sidebar-rail\s*\{[^}]*width: 288px;/,
    );
    expect(shell).toMatch(/\.console-sidebar-scrim\s*\{[^}]*background: var\(--ddc-overlay\);/);
  });

  it("preserves horizontal browser history gestures across the route and data grid", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");
    const list = readFileSync(resolve(process.cwd(), "src/styles/console-list.css"), "utf8");

    expect(shell).not.toContain("overscroll-behavior: contain;");
    expect(list).not.toContain("overscroll-behavior: contain;");
    expect(shell).toContain("overscroll-behavior-y: contain;");
    expect(list).toContain("overscroll-behavior-y: contain;");
  });

  it("keeps a thin visible scrollbar with a stable gutter on the route canvas", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(shell).toMatch(
      /\.console-route-main\s*\{[^}]*overflow-y: auto;[^}]*scrollbar-gutter: stable;/,
    );
    expect(shell).not.toMatch(/\.console-route-main\s*\{[^}]*scrollbar-width: none;/);
    expect(shell).not.toContain(".console-route-main::-webkit-scrollbar");
  });

  it("does not follow the system reduced-motion setting, like the DDC portal", () => {
    const shell = readFileSync(resolve(process.cwd(), "src/styles/console-shell.css"), "utf8");

    expect(shell).not.toContain("prefers-reduced-motion");
  });
});
