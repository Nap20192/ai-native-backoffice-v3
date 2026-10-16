import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("../assistant/SuggestOutcomeButton", () => ({
  SuggestOutcomeButton: ({
    sessionId,
    onSuggested,
  }: {
    sessionId: string;
    onSuggested: (value: { description: string; rubric: string; maxIterations: number | null }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSuggested({ description: "План миграции", rubric: "Есть откат", maxIterations: 5 })}
    >
      Предложить результат ({sessionId})
    </button>
  ),
}));

import * as dialogs from "./SessionDialogs";
import { DefineOutcomeDialog, SHORTCUT_ROWS, ShortcutsDialog } from "./SessionDialogs";

describe("SessionDialogs: состав", () => {
  it("в модуле остались окна результата и горячих клавиш, окна бюджета нет", () => {
    for (const name of ["EditBudgetDialog", "parseBudgetInput"]) {
      expect(dialogs).not.toHaveProperty(name);
    }
    expect(dialogs).toHaveProperty("DefineOutcomeDialog");
    expect(dialogs).toHaveProperty("ShortcutsDialog");
  });
});

describe("DefineOutcomeDialog: предложение ассистента", () => {
  it("без sessionId кнопки «Предложить результат» нет", () => {
    render(<DefineOutcomeDialog open onClose={() => {}} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Предложить результат/ })).toBeNull();
  });

  it("подставляет описание, критерии и итерации, но не отправляет сам", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<DefineOutcomeDialog open onClose={() => {}} onSubmit={onSubmit} sessionId="sesn_1" />);

    await userEvent.click(screen.getByRole("button", { name: "Предложить результат (sesn_1)" }));

    expect(screen.getByRole("textbox", { name: "Описание" })).toHaveValue("План миграции");
    expect(screen.getByRole("textbox", { name: "Критерии" })).toHaveValue("Есть откат");
    expect(screen.getByRole("spinbutton", { name: /Максимум итераций/ })).toHaveValue(5);
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Задать результат" }));
    expect(onSubmit).toHaveBeenCalledWith({
      type: "user.define_outcome",
      description: "План миграции",
      rubric: { type: "text", content: "Есть откат" },
      max_iterations: 5,
    });
  });
});

describe("DefineOutcomeDialog", () => {
  function open() {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<DefineOutcomeDialog open onClose={onClose} onSubmit={onSubmit} />);
    return { onSubmit, onClose };
  }

  it("ставит фокус в «Описание» и показывает подсказки полей", () => {
    open();

    expect(screen.getByRole("dialog", { name: "Задать результат" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Описание" })).toHaveFocus();
    expect(screen.getByText("Что должна выдать сессия.")).toBeInTheDocument();
    expect(screen.getByText("По каким критериям оценивать результат.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Сколько раз оценщик проверит работу и вернёт её на доработку, прежде чем признает результат невыполненным. По умолчанию 3, не больше 20.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /Максимум итераций/ })).toHaveAttribute(
      "placeholder",
      "3",
    );
  });

  it("кнопка недоступна, пока описание или критерии пусты", async () => {
    open();

    const submit = screen.getByRole("button", { name: "Задать результат" });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "Описание" }), "План миграции");
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "Критерии" }), "- у каждой фазы есть откат");
    expect(submit).toBeEnabled();
  });

  it("отправляет user.define_outcome с текстовым критерием и числом итераций", async () => {
    const { onSubmit, onClose } = open();

    await userEvent.type(screen.getByRole("textbox", { name: "Описание" }), "  План миграции  ");
    await userEvent.type(screen.getByRole("textbox", { name: "Критерии" }), "- откат на каждой фазе");
    await userEvent.type(screen.getByRole("spinbutton", { name: /Максимум итераций/ }), "5");
    await userEvent.click(screen.getByRole("button", { name: "Задать результат" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        type: "user.define_outcome",
        description: "План миграции",
        rubric: { type: "text", content: "- откат на каждой фазе" },
        max_iterations: 5,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("без числа итераций поле max_iterations не отправляется", async () => {
    const { onSubmit } = open();

    await userEvent.type(screen.getByRole("textbox", { name: "Описание" }), "Отчёт");
    await userEvent.type(screen.getByRole("textbox", { name: "Критерии" }), "Есть выводы");
    await userEvent.click(screen.getByRole("button", { name: "Задать результат" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty("max_iterations");
  });

  it("число итераций вне 1..20 отклоняется подсказкой", async () => {
    const { onSubmit } = open();

    await userEvent.type(screen.getByRole("textbox", { name: "Описание" }), "Отчёт");
    await userEvent.type(screen.getByRole("textbox", { name: "Критерии" }), "Есть выводы");
    await userEvent.type(screen.getByRole("spinbutton", { name: /Максимум итераций/ }), "21");
    await userEvent.click(screen.getByRole("button", { name: "Задать результат" }));

    expect(await screen.findByText("Укажите число от 1 до 20.")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Предложить результат не показывается: нужен сервер", () => {
    open();

    expect(screen.queryByRole("button", { name: /Предложить/ })).toBeNull();
  });
});

describe("ShortcutsDialog", () => {
  it("перечисляет клавиши страницы сессии с подписями по-русски", () => {
    render(<ShortcutsDialog open onClose={() => {}} />);

    const dialog = screen.getByRole("dialog", { name: "Горячие клавиши" });
    for (const label of [
      "Предыдущее или следующее событие",
      "Раскрыть или свернуть вызов",
      "Найти в разговоре",
      "Следующее или предыдущее совпадение (в поле поиска)",
      "Показать или скрыть инспектор",
      "Переключить разговор и трейс",
      "Свернуть вызов, затем снять выбор",
      "Показать это окно",
      "Открыть или закрыть ассистента",
    ]) {
      expect(dialog).toHaveTextContent(label);
    }
    expect(SHORTCUT_ROWS).toHaveLength(9);
  });

  it("клавиши рисуются плашками kbd", () => {
    render(<ShortcutsDialog open onClose={() => {}} />);

    const keys = Array.from(document.querySelectorAll("kbd")).map((node) => node.textContent);
    for (const key of ["↑", "↓", "K", "J", "←", "→", "/", "Enter", "Shift", "D", "T", "Esc", "?", "Ctrl", "I"]) {
      expect(keys).toContain(key);
    }
  });
});
