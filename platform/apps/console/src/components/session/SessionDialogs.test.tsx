import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  DefineOutcomeDialog,
  EditBudgetDialog,
  SHORTCUT_ROWS,
  ShortcutsDialog,
  parseBudgetInput,
} from "./SessionDialogs";

describe("parseBudgetInput", () => {
  it("читает доллары с точкой или запятой и отдаёт центы", () => {
    expect(parseBudgetInput("5")).toEqual({ ok: true, cents: 500 });
    expect(parseBudgetInput("5.00")).toEqual({ ok: true, cents: 500 });
    expect(parseBudgetInput(" 12,5 ")).toEqual({ ok: true, cents: 1250 });
    expect(parseBudgetInput("0.07")).toEqual({ ok: true, cents: 7 });
    expect(parseBudgetInput("5.005")).toEqual({ ok: false, reason: "decimals" });
  });

  it("пустое поле снимает бюджет", () => {
    expect(parseBudgetInput("")).toEqual({ ok: true, cents: null });
    expect(parseBudgetInput("   ")).toEqual({ ok: true, cents: null });
  });

  it("отклоняет ноль, минус и текст", () => {
    expect(parseBudgetInput("0")).toEqual({ ok: false, reason: "positive" });
    expect(parseBudgetInput("-3")).toEqual({ ok: false, reason: "format" });
    expect(parseBudgetInput("пять")).toEqual({ ok: false, reason: "format" });
    expect(parseBudgetInput("1e3")).toEqual({ ok: false, reason: "format" });
  });
});

describe("EditBudgetDialog", () => {
  function open(props: Partial<Parameters<typeof EditBudgetDialog>[0]> = {}) {
    const onSave = props.onSave ?? vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <EditBudgetDialog
        open
        onClose={onClose}
        budgetCents={500}
        spentMicros={890_000}
        {...props}
        onSave={onSave}
      />,
    );
    return { onSave, onClose };
  }

  it("показывает поле с префиксом $, текущий бюджет и расход", () => {
    open();

    expect(screen.getByRole("dialog", { name: "Изменить бюджет" })).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Бюджет" });
    expect(field).toHaveValue("5,00");
    expect(screen.getByText("$")).toBeInTheDocument();
    expect(
      screen.getByText("Сейчас $5,00. Потрачено $0,89. Если очистить поле, бюджет снимется."),
    ).toBeInTheDocument();
  });

  it("без бюджета пишет об этом и поле пустое", () => {
    open({ budgetCents: null, spentMicros: null });

    expect(screen.getByRole("textbox", { name: "Бюджет" })).toHaveValue("");
    expect(screen.getByText(/Бюджета нет\. Расход посчитать нельзя, цены нет\./)).toBeInTheDocument();
  });

  it("сохраняет бюджет в центах строкой с валютой USD", async () => {
    const { onSave } = open();

    const field = screen.getByRole("textbox", { name: "Бюджет" });
    await userEvent.clear(field);
    await userEvent.type(field, "7,5");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        type: "limit",
        max_list_cost: { amount: "750", currency: "USD" },
      }),
    );
  });

  it("5 долларов уходят как amount «500»", async () => {
    const { onSave } = open({ budgetCents: null, spentMicros: 0 });

    await userEvent.type(screen.getByRole("textbox", { name: "Бюджет" }), "5");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        type: "limit",
        max_list_cost: { amount: "500", currency: "USD" },
      }),
    );
  });

  it("пустое поле снимает бюджет: budget null", async () => {
    const { onSave } = open();

    await userEvent.clear(screen.getByRole("textbox", { name: "Бюджет" }));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it("неверная сумма даёт подсказку и ничего не отправляет", async () => {
    const { onSave } = open();

    const field = screen.getByRole("textbox", { name: "Бюджет" });
    await userEvent.clear(field);
    await userEvent.type(field, "пять");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    expect(await screen.findByText("Введите сумму в долларах, например 5 или 7,50.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("остаётся открытым, если сохранение не удалось", async () => {
    const failing = open({ onSave: vi.fn().mockRejectedValue(new Error("нет")) });

    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(failing.onSave).toHaveBeenCalled());
    expect(failing.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Изменить бюджет" })).toBeInTheDocument();
  });

  it("закрывается после успешного сохранения", async () => {
    const { onClose } = open();

    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
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
      "Свернуть вызов, затем снять выбор",
      "Показать это окно",
    ]) {
      expect(dialog).toHaveTextContent(label);
    }
    expect(SHORTCUT_ROWS).toHaveLength(7);
  });

  it("клавиши рисуются плашками kbd", () => {
    render(<ShortcutsDialog open onClose={() => {}} />);

    const keys = Array.from(document.querySelectorAll("kbd")).map((node) => node.textContent);
    for (const key of ["↑", "↓", "K", "J", "←", "→", "/", "Enter", "Shift", "D", "Esc", "?"]) {
      expect(keys).toContain(key);
    }
  });
});
