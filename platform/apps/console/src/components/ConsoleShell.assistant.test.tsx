import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { CommandPalette } from "./CommandPalette";
import { ConsoleShell } from "./ConsoleShell";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: "user_1" } }),
}));

let phone = false;

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: phone && query.includes("max-width"),
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

function mockEmptyAssistant() {
  server.use(
    http.get("*/v1/oma/platform-mcp/settings", () =>
      HttpResponse.json({ enabled: true, can_change: false, updated_by: null, updated_at: null }),
    ),
    http.get("*/v1/agents", () => HttpResponse.json({ data: [] })),
    http.get("*/v1/environments", () => HttpResponse.json({ data: [] })),
    http.get("*/v1/model_cards", () => HttpResponse.json({ data: [] })),
  );
}

function renderShell(entries = ["/agents"]) {
  mockEmptyAssistant();
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={entries}>
        <CommandPalette />
        <ConsoleShell sidebar={<nav>Меню</nav>} breadcrumb={<span>Агенты</span>}>
          <main>Страница</main>
        </ConsoleShell>
      </MemoryRouter>
    </I18nProvider>,
  );
}

const shell = () => document.querySelector("[data-console-shell]") as HTMLElement;

describe("Оболочка: ассистент", () => {
  it("кнопка «Ассистент» стоит в шапке и подсказывает Ctrl I", () => {
    phone = false;
    renderShell();
    const topbar = document.querySelector(".console-topbar") as HTMLElement;
    const button = within(topbar).getByRole("button", { name: "Ассистент" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("aria-keyshortcuts", "Control+I");
    expect(button.getAttribute("title")).toContain("Ctrl I");
    expect(shell()).toHaveAttribute("data-assistant", "closed");
    expect(screen.queryByRole("complementary", { name: "Ассистент" })).toBeNull();
  });

  it("кнопка открывает панель третьей колонкой и закрывает её", async () => {
    phone = false;
    renderShell();
    const user = userEvent.setup();
    const topbar = document.querySelector(".console-topbar") as HTMLElement;
    const button = within(topbar).getByRole("button", { name: "Ассистент" });

    await user.click(button);
    const panel = screen.getByRole("complementary", { name: "Ассистент" });
    expect(panel.parentElement).toBe(shell());
    expect(shell()).toHaveAttribute("data-assistant", "open");
    expect(button).toHaveAttribute("aria-pressed", "true");

    await user.click(button);
    expect(screen.queryByRole("complementary", { name: "Ассистент" })).toBeNull();
    expect(shell()).toHaveAttribute("data-assistant", "closed");
  });

  it("Ctrl I открывает и закрывает панель на любой странице", async () => {
    phone = false;
    renderShell(["/sessions/sesn_1"]);
    fireEvent.keyDown(window, { key: "i", code: "KeyI", ctrlKey: true });
    expect(await screen.findByRole("complementary", { name: "Ассистент" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "i", code: "KeyI", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Ассистент" })).toBeNull());
  });

  it("палитра показывает строку «Ассистент» с Ctrl I и открывает панель", async () => {
    phone = false;
    renderShell();
    const user = userEvent.setup();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const row = await screen.findByRole("option", { name: /Ассистент/ });
    expect(row).toHaveTextContent("Ctrl I");

    await user.click(row);
    expect(await screen.findByRole("complementary", { name: "Ассистент" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /палитр|команд/i })).toBeNull();
  });

  it("палитра находит ассистента по слову «помощник»", async () => {
    phone = false;
    renderShell();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "помощ" } });
    });
    expect(screen.getAllByRole("option", { name: /Ассистент/ }).length).toBeGreaterThan(0);
  });

  it("на телефоне панель открывается нижним листом, а колонка не занимает места", async () => {
    phone = true;
    renderShell();
    const user = userEvent.setup();
    const topbar = document.querySelector(".console-topbar") as HTMLElement;
    await user.click(within(topbar).getByRole("button", { name: "Ассистент" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(shell()).toHaveAttribute("data-assistant", "sheet");
    phone = false;
  });
});
