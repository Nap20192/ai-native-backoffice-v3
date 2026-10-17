import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { catalogTemplates, fallbackTemplates } from "../../lib/environment-templates";
import { catalogWithUnbuiltOffice, sandboxCatalogFixture } from "../../test/sandbox-catalog-fixture";
import { TemplatePicker } from "./TemplatePicker";

function show(props: Partial<React.ComponentProps<typeof TemplatePicker>> = {}) {
  const onChange = vi.fn();
  const view = render(
    <>
      <div id="picker-label">Шаблон</div>
      <TemplatePicker
        labelId="picker-label"
        templates={catalogTemplates(sandboxCatalogFixture())}
        value="empty"
        onChange={onChange}
        {...props}
      />
    </>,
  );
  return { onChange, ...view };
}

describe("TemplatePicker", () => {
  it("рисует карточку на каждый шаблон и подписывает группу", () => {
    show();

    const group = screen.getByRole("radiogroup", { name: "Шаблон" });
    expect(within(group).getAllByRole("radio")).toHaveLength(5);
    for (const label of ["Пустое", "Базовое", "Документы и офис", "Данные", "Веб"]) {
      expect(within(group).getByRole("radio", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("называет радиокнопку по шаблону, а описание и чипы отдаёт в описание", () => {
    show();

    const documents = screen.getByRole("radio", { name: "Документы и офис" });

    expect(documents).toHaveAccessibleName("Документы и офис");
    expect(documents).toHaveAccessibleDescription(
      "Презентации, Word, Excel и PDF. Конвертация и проверка результата картинкой. LibreOffice Ограниченный",
    );
  });

  it("у выключенного шаблона описание называет причину", () => {
    show({ templates: catalogTemplates(catalogWithUnbuiltOffice()) });

    expect(screen.getByRole("radio", { name: "Документы и офис" })).toHaveAccessibleDescription(
      /Образ не собран/,
    );
  });

  it("отмечает выбранный шаблон", () => {
    show({ value: "data" });

    expect(screen.getByRole("radio", { name: /Данные/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Пустое/ })).not.toBeChecked();
  });

  it("сообщает о выборе по клику на карточку", async () => {
    const user = userEvent.setup();
    const { onChange } = show();

    await user.click(screen.getByRole("radio", { name: /Документы и офис/ }));

    expect(onChange).toHaveBeenCalledWith("documents");
  });

  it("показывает на карточке назначение и чипы образа и сети", () => {
    show();

    const documents = screen.getByRole("radio", { name: /Документы и офис/ });
    const card = documents.closest("label")!;
    expect(card).toHaveTextContent("Презентации, Word, Excel и PDF");
    expect(within(card).getByText("LibreOffice")).toHaveClass("chip");
    expect(within(card).getByText("Ограниченный")).toHaveClass("chip");

    const web = screen.getByRole("radio", { name: /Веб/ }).closest("label")!;
    expect(within(web).getByText("Без ограничений")).toHaveClass("chip");
  });

  it("выключает шаблон с несобранным образом и пишет «Образ не собран»", async () => {
    const user = userEvent.setup();
    const { onChange } = show({ templates: catalogTemplates(catalogWithUnbuiltOffice()) });

    const documents = screen.getByRole("radio", { name: /Документы и офис/ });
    expect(documents).toBeDisabled();
    expect(within(documents.closest("label")!).getByText("Образ не собран")).toBeInTheDocument();

    await user.click(documents);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: /Базовое/ })).toBeEnabled();
  });

  it("показывает под рядом карточек, что даёт выбранный шаблон", () => {
    const { rerender } = show({ value: "data" });

    const summary = screen.getByRole("group", { name: "Что даёт шаблон «Данные»" });
    expect(within(summary).getByText("Образ")).toBeInTheDocument();
    expect(within(summary).getByText("Рабочее место агента")).toBeInTheDocument();
    expect(within(summary).getByText("Сеть")).toBeInTheDocument();
    expect(within(summary).getByText("Ограниченный: менеджеры пакетов и MCP-серверы")).toBeInTheDocument();
    expect(within(summary).getByText("Пакеты")).toBeInTheDocument();
    expect(within(summary).getByText("pip: duckdb, pyarrow, scipy")).toBeInTheDocument();

    rerender(
      <>
        <div id="picker-label">Шаблон</div>
        <TemplatePicker
          labelId="picker-label"
          templates={catalogTemplates(sandboxCatalogFixture())}
          value="basic"
          onChange={() => {}}
        />
      </>,
    );
    const basic = screen.getByRole("group", { name: "Что даёт шаблон «Базовое»" });
    expect(within(basic).getByText("Только то, что есть в образе")).toBeInTheDocument();
  });

  it("не рисует строку «Образ» в сводке, пока каталога нет", () => {
    show({ templates: fallbackTemplates(), value: "documents" });

    const summary = screen.getByRole("group", { name: "Что даёт шаблон «Документы»" });
    expect(within(summary).queryByText("Образ")).not.toBeInTheDocument();
    expect(within(summary).getByText(/python-docx/)).toBeInTheDocument();
  });

  it("пока каталог грузится, рядом с «Пустым» видны заглушки", () => {
    show({ templates: [catalogTemplates(sandboxCatalogFixture())[0]!], loading: true });

    const group = screen.getByRole("radiogroup", { name: "Шаблон" });
    expect(group).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем шаблоны");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });
});
