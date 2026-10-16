import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

import { I18nProvider } from "../../i18n";
import { AgentNewPage } from "./AgentNewPage";

vi.mock("../../components/assistant/describe/DescribeAgent", () => ({
  DescribeAgent: ({ onCancel }: { onCancel?: () => void }) => (
    <div data-testid="describe">
      Описание агента
      <button type="button" onClick={onCancel}>
        stub-cancel
      </button>
    </div>
  ),
}));
vi.mock("../quickstart/TemplateDialog", () => ({
  BuilderTemplateDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Конструктор" /> : null),
}));
vi.mock("./AgentFormDialog", () => ({
  AgentFormDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Форма агента" /> : null),
}));

function renderPage(entry = "/agents/new") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <I18nProvider>
        <AgentNewPage />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("страница «Новый агент»", () => {
  it("называет страницу и предлагает две отправные точки", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Новый агент" })).toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Отправная точка" });
    expect(tabs).toHaveTextContent("Описать агента");
    expect(tabs).toHaveTextContent("Шаблон");
  });

  it("по умолчанию открыта вкладка «Описать агента»", () => {
    renderPage();
    expect(screen.getByRole("tab", { name: "Описать агента" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("describe")).toBeInTheDocument();
  });

  it("вкладка «Шаблон» показывает «Конструктор» с меткой «Управляет платформой»", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "Шаблон" }));
    expect(screen.queryByTestId("describe")).toBeNull();
    const card = screen.getByRole("article", { name: "Конструктор" });
    expect(card).toHaveTextContent("Управляет платформой");
    await userEvent.click(screen.getByRole("button", { name: "Открыть шаблон «Конструктор»" }));
    expect(screen.getByRole("dialog", { name: "Конструктор" })).toBeInTheDocument();
  });

  it("обычные шаблоны открываются в форме агента", async () => {
    renderPage("/agents/new?start=template");
    expect(screen.getByRole("tab", { name: "Шаблон" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("button", { name: "Выбрать другой шаблон" }));
    expect(screen.getByRole("dialog", { name: "Форма агента" })).toBeInTheDocument();
  });
});
