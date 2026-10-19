import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { Login } from "./Login";

const socialSignIn = vi.hoisted(() => vi.fn());

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    isAuthenticated: false,
  }),
}));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    signIn: {
      social: socialSignIn,
    },
  },
}));

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: () => ({
    data: {
      providers: ["email", "email-otp", "google", "github"],
    },
    error: null,
    isLoading: false,
  }),
}));

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <I18nProvider>
        <Login />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("Login OAuth and layout", () => {
  beforeEach(() => {
    socialSignIn.mockReset();
  });

  it("offers configured Google and GitHub sign-in through Better Auth", async () => {
    const user = userEvent.setup();
    renderLogin();

    const signInOptions = screen.getByRole("group", {
      name: "Способы входа",
    });
    const google = within(signInOptions).getByRole("button", {
      name: "Продолжить через Google",
    });
    const github = within(signInOptions).getByRole("button", {
      name: "Продолжить через GitHub",
    });

    await user.click(google);
    expect(socialSignIn).toHaveBeenLastCalledWith({
      provider: "google",
      callbackURL: "/",
    });

    await user.click(github);
    expect(socialSignIn).toHaveBeenLastCalledWith({
      provider: "github",
      callbackURL: "/",
    });
  });

  it("reveals the email form only after the user chooses email", async () => {
    const user = userEvent.setup();
    const { container } = renderLogin();

    expect(
      screen.getByRole("heading", { name: "Вход в консоль агентов" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Почта")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "О платформе" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Продолжить с почтой" }),
    );

    expect(
      screen.getByRole("heading", { name: "Вход по почте" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Почта")).toBeInTheDocument();

    const passwordField = container.querySelector(
      '[data-login-field="password"]',
    );
    expect(passwordField).not.toBeNull();
    expect(
      within(passwordField as HTMLElement).getByText("Пароль").parentElement,
    ).toContainElement(
      within(passwordField as HTMLElement).getByRole("button", {
        name: "Забыли пароль?",
      }),
    );

    const actions = screen.getByRole("group", { name: "Действия входа" });
    expect(within(actions).getByRole("button", { name: "Войти" })).toBeInTheDocument();
    expect(
      within(actions).getByRole("button", {
        name: "Войти по коду из письма",
      }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: "К способам входа" }),
    ).toBeInTheDocument();
  });

  it("opens account creation from the quiet chooser footer", async () => {
    const user = userEvent.setup();
    renderLogin();

    const footer = screen.getByRole("group", { name: "Параметры учётной записи" });
    expect(within(footer).getByText("Нет учётной записи?")).toBeInTheDocument();

    await user.click(within(footer).getByRole("button", { name: "Зарегистрироваться" }));

    expect(
      screen.getByRole("heading", { name: "Создание учётной записи" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Имя")).toBeInTheDocument();
  });

  it("names the product without OpenMA marks on the sign-in page", () => {
    const { container } = renderLogin();

    expect(container.textContent).not.toMatch(/openma/i);
    expect(screen.queryByRole("img", { name: /openma/i })).toBeNull();
    expect(container.querySelector("svg[viewBox='240 244 548 454']")).toBeNull();
    // Название стоит на панели слева, знака рядом нет.
    const panel = screen.getByRole("region", { name: "О платформе" });
    expect(within(panel).getByText("Консоль агентов")).toBeInTheDocument();
  });

  it("words the account creation and email sign-in steps without the product name", async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole("button", { name: "Продолжить с почтой" }));
    expect(screen.getByText("Впервые здесь?")).toBeInTheDocument();
    expect(screen.queryByText(/Впервые в /)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Зарегистрироваться" }));
    expect(screen.getByRole("heading", { name: "Создание учётной записи" })).toBeInTheDocument();
    expect(screen.getByText("Регистрация")).toBeInTheDocument();
    expect(screen.queryByText(/Начните работу/)).toBeNull();
  });
});
