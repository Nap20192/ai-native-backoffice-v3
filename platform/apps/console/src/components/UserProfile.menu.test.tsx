import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { I18nProvider } from "../i18n";
import { UserProfile } from "./UserProfile";

// План cleanup, шаг 1, пункт 3.2: пункта «Документация» в меню нет. Он вёл
// на сайт OpenMA, а своей документации у консоли нет.
// План cleanup, шаг 3, пункт 5.4: выбора языка в меню нет, консоль только русская.

vi.mock("../lib/auth", () => ({
  useAuth: () => ({ user: { id: "user_1", name: "Анна Петрова", email: "anna@example.com" } }),
}));
vi.mock("../lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
// useTheme читает matchMedia, которого в jsdom нет.
vi.mock("../lib/theme", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));

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
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

async function openMenu() {
  render(
    <I18nProvider>
      <UserProfile />
    </I18nProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Меню учётной записи" }));
  return await screen.findByRole("menuitem", { name: "Выйти" });
}

describe("UserProfile: меню учётной записи", () => {
  it("не показывает пункт «Документация» и ссылку на docs.openma.dev", async () => {
    await openMenu();

    expect(screen.queryByRole("menuitem", { name: /Документация/ })).toBeNull();
    expect(screen.queryByText("Документация")).toBeNull();
    expect(document.querySelector('a[href*="docs.openma"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("оставляет три темы и выход, выбора языка нет", async () => {
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Светлая" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Тёмная" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Системная" })).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(3 + 1);
    expect(screen.queryByText("Язык")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Русский|English|简体中文/ })).toBeNull();
  });
});
