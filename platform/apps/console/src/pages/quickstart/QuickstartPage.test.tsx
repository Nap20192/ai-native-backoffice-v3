import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { I18nProvider } from "../../i18n";
import { QuickstartPage } from "./QuickstartPage";

vi.mock("./TemplateDialog", () => ({
  BuilderTemplateDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Конструктор" /> : null),
}));

function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">
      {location.pathname}
      {location.search}|{JSON.stringify(location.state)}
    </output>
  );
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/quickstart"]}>
      <I18nProvider>
        <Routes>
          <Route path="/quickstart" element={<QuickstartPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("страница «Быстрый старт»", () => {
  it("называет страницу и спрашивает, что построить", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Быстрый старт" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Что хотите построить?" })).toBeInTheDocument();
  });

  it("«Сгенерировать» открывает мастер и несёт текст в состоянии маршрута, не в адресе", async () => {
    renderPage();
    await userEvent.type(screen.getByRole("textbox"), "Сводка заявок");
    await userEvent.click(screen.getByRole("button", { name: "Сгенерировать" }));
    const where = screen.getByTestId("where");
    expect(where).toHaveTextContent('/quickstart/new|{"prompt":"Сводка заявок"}');
    expect(where.textContent).not.toContain("?");
  });

  it("карточка «Конструктор» с меткой открывает диалог шаблона", async () => {
    renderPage();
    const card = screen.getByRole("article", { name: "Конструктор" });
    expect(card).toHaveTextContent("Управляет платформой");
    await userEvent.click(screen.getByRole("button", { name: "Открыть шаблон «Конструктор»" }));
    expect(screen.getByRole("dialog", { name: "Конструктор" })).toBeInTheDocument();
  });

  it("другие шаблоны ведут на вкладку «Шаблон» страницы нового агента", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("link", { name: "Другие шаблоны" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/agents/new?start=template");
  });
});
