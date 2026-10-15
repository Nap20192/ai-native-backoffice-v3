import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutcomeView, TranscriptBlock } from "../../lib/session-stats";
import { ClampedContent, GradingBlock, OutcomeDefinedBlock } from "./OutcomeBlock";

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const outcome: OutcomeView = {
  outcomeId: "outcome-1",
  eventId: "out-1",
  description: "Отчёт, который отвечает на вопрос пользователя.",
  rubric: { type: "text", content: "- Отчёт отвечает на вопрос.\n- Каждая ссылка проверена.\n- Есть выводы." },
  maxIterations: 3,
  definedAtMs: 1_000,
  evaluations: [],
};

const definedBlock: Block<"outcome_defined"> = {
  kind: "outcome_defined",
  id: "out-1",
  atMs: 1_000,
  eventIds: ["out-1"],
  eventId: "out-1",
  outcome,
};

function gradingBlock(overrides: Partial<Block<"grading">> = {}, result = "needs_revision"): Block<"grading"> {
  return {
    kind: "grading",
    id: "start-1",
    atMs: 2_000,
    eventIds: ["start-1", "end-1"],
    eventId: "end-1",
    outcomeId: "outcome-1",
    evaluation: {
      iteration: 1,
      result,
      explanation: "Независимый оценщик нашёл **два** недочёта.",
      startEventId: "start-1",
      endEventId: "end-1",
      atMs: 2_000,
      usage: ZERO,
    },
    index: 1,
    count: 3,
    ...overrides,
  };
}

function mockHeight(height: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
}

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
});

describe("OutcomeDefinedBlock", () => {
  it("пишет «Задан результат», описание, «Критерии» и пункты критериев", () => {
    const { container } = render(
      <OutcomeDefinedBlock block={definedBlock} onSelect={vi.fn()} selected={false} />,
    );

    const root = container.querySelector<HTMLElement>("[data-block-id]")!;
    expect(root).toHaveAttribute("data-block-id", "out-1");
    expect(within(root).getByText("Задан результат")).toBeInTheDocument();
    expect(within(root).getByText("Отчёт, который отвечает на вопрос пользователя.")).toBeInTheDocument();
    expect(within(root).getByText("Критерии")).toBeInTheDocument();
    const items = within(root).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["Отчёт отвечает на вопрос.", "Каждая ссылка проверена.", "Есть выводы."]);
  });

  it("не рисует подпись «Критерии» без критериев", () => {
    const empty = { ...definedBlock, outcome: { ...outcome, rubric: { type: "text" as const, content: "  " } } };
    render(<OutcomeDefinedBlock block={empty} onSelect={vi.fn()} selected={false} />);

    expect(screen.queryByText("Критерии")).not.toBeInTheDocument();
  });

  it("для критериев из файла показывает идентификатор файла", () => {
    const file = { ...definedBlock, outcome: { ...outcome, rubric: { type: "file" as const, fileId: "file_abc" } } };
    render(<OutcomeDefinedBlock block={file} onSelect={vi.fn()} selected={false} />);

    expect(screen.getByText("Критерии")).toBeInTheDocument();
    expect(screen.getByText("file_abc")).toBeInTheDocument();
  });

  it("клик выбирает блок, выбранный блок помечен", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container, rerender } = render(
      <OutcomeDefinedBlock block={definedBlock} onSelect={onSelect} selected={false} />,
    );
    const root = container.querySelector<HTMLElement>("[data-block-id]")!;
    expect(root).toHaveAttribute("data-selected", "false");

    await user.click(within(root).getByText("Отчёт, который отвечает на вопрос пользователя."));
    expect(onSelect).toHaveBeenCalledTimes(1);

    rerender(<OutcomeDefinedBlock block={definedBlock} onSelect={onSelect} selected />);
    expect(root).toHaveAttribute("data-selected", "true");
  });
});

describe("GradingBlock", () => {
  it("пишет «Оценка», номер итерации на единицу больше и плашку итога", () => {
    const { container } = render(
      <GradingBlock block={gradingBlock()} onJumpToRubric={vi.fn()} onSelect={vi.fn()} selected={false} />,
    );

    const root = container.querySelector<HTMLElement>("[data-block-id]")!;
    expect(root).toHaveAttribute("data-block-id", "start-1");
    expect(within(root).getByText("Оценка")).toBeInTheDocument();
    expect(within(root).getByText("Итерация 2")).toBeInTheDocument();
    expect(within(root).getByText("Нужна доработка")).toBeInTheDocument();
  });

  it.each([
    ["satisfied", "Выполнено", "ddc-tone-success"],
    ["needs_revision", "Нужна доработка", "ddc-tone-warning"],
    ["max_iterations_reached", "Итерации исчерпаны", "ddc-tone-neutral"],
    ["failed", "Оценка не удалась", "ddc-tone-danger"],
    ["interrupted", "Прервано", "ddc-tone-neutral"],
  ])("итог %s: плашка «%s» цвета %s", (result, label, tone) => {
    render(
      <GradingBlock block={gradingBlock({}, result)} onJumpToRubric={vi.fn()} onSelect={vi.fn()} selected={false} />,
    );

    expect(screen.getByText(label).className).toContain(tone);
  });

  it("неизвестный итог показывает как есть", () => {
    render(
      <GradingBlock block={gradingBlock({}, "weird")} onJumpToRubric={vi.fn()} onSelect={vi.fn()} selected={false} />,
    );

    expect(screen.getByText("weird")).toBeInTheDocument();
  });

  it("показывает разбор оценщика как Markdown", () => {
    render(
      <GradingBlock block={gradingBlock()} onJumpToRubric={vi.fn()} onSelect={vi.fn()} selected={false} />,
    );

    expect(screen.getByText("два").tagName).toBe("STRONG");
  });

  it("«Критерии» прокручивает к блоку результата", async () => {
    const user = userEvent.setup();
    const onJumpToRubric = vi.fn();
    const onSelect = vi.fn();
    render(
      <GradingBlock block={gradingBlock()} onJumpToRubric={onJumpToRubric} onSelect={onSelect} selected={false} />,
    );

    await user.click(screen.getByRole("button", { name: "Критерии" }));

    expect(onJumpToRubric).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("«Назад» и «Далее» ведут к соседним оценкам", async () => {
    const user = userEvent.setup();
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <GradingBlock
        block={gradingBlock()}
        onJumpToRubric={vi.fn()}
        onNext={onNext}
        onPrev={onPrev}
        onSelect={vi.fn()}
        selected={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Назад" }));
    await user.click(screen.getByRole("button", { name: "Далее" }));

    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("на первой оценке «Назад» неактивна, на последней «Далее» неактивна", () => {
    const { rerender } = render(
      <GradingBlock
        block={gradingBlock({ index: 0, count: 3 })}
        onJumpToRubric={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onSelect={vi.fn()}
        selected={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Назад" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Далее" })).toBeEnabled();

    rerender(
      <GradingBlock
        block={gradingBlock({ index: 2, count: 3 })}
        onJumpToRubric={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
        onSelect={vi.fn()}
        selected={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Назад" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Далее" })).toBeDisabled();
  });

  it("без обработчиков «Назад» и «Далее» неактивны", () => {
    render(
      <GradingBlock block={gradingBlock()} onJumpToRubric={vi.fn()} onSelect={vi.fn()} selected={false} />,
    );

    expect(screen.getByRole("button", { name: "Назад" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Далее" })).toBeDisabled();
  });

  it("клик по карточке выбирает блок, выбранный блок помечен", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = render(
      <GradingBlock block={gradingBlock()} onJumpToRubric={vi.fn()} onSelect={onSelect} selected />,
    );
    const root = container.querySelector<HTMLElement>("[data-block-id]")!;
    expect(root).toHaveAttribute("data-selected", "true");

    await user.click(screen.getByText("два"));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("длинный разбор сворачивается с кнопкой «Читать дальше»", async () => {
    mockHeight(900);
    const user = userEvent.setup();
    const { container } = render(
      <GradingBlock block={gradingBlock()} onJumpToRubric={vi.fn()} onSelect={vi.fn()} selected={false} />,
    );

    const clamp = container.querySelector<HTMLElement>("[data-session-clamp]")!;
    expect(clamp).toHaveAttribute("data-clamp-state", "collapsed");
    await user.click(screen.getByRole("button", { name: "Читать дальше" }));
    expect(clamp).toHaveAttribute("data-clamp-state", "expanded");
    await user.click(screen.getByRole("button", { name: "Свернуть" }));
    expect(clamp).toHaveAttribute("data-clamp-state", "collapsed");
  });
});

describe("ClampedContent", () => {
  it("короткий текст не получает кнопок", () => {
    mockHeight(100);
    const { container } = render(<ClampedContent>Коротко</ClampedContent>);

    expect(container.querySelector("[data-session-clamp]")).toHaveAttribute("data-clamp-state", "none");
    expect(screen.queryByRole("button", { name: "Читать дальше" })).not.toBeInTheDocument();
  });

  it("высокий текст ограничен, «Читать дальше» раскрывает, «Свернуть» возвращает", async () => {
    mockHeight(900);
    const user = userEvent.setup();
    const { container } = render(<ClampedContent>Длинный текст</ClampedContent>);
    const clamp = container.querySelector<HTMLElement>("[data-session-clamp]")!;

    expect(clamp).toHaveAttribute("data-clamp-state", "collapsed");
    expect(screen.queryByRole("button", { name: "Свернуть" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Читать дальше" }));
    expect(clamp).toHaveAttribute("data-clamp-state", "expanded");
    expect(screen.queryByRole("button", { name: "Читать дальше" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Свернуть" }));
    expect(clamp).toHaveAttribute("data-clamp-state", "collapsed");
  });

  it("раскрывается по событию session-clamp-expand от поиска", () => {
    mockHeight(900);
    const { container } = render(<ClampedContent>Длинный текст</ClampedContent>);
    const clamp = container.querySelector<HTMLElement>("[data-session-clamp]")!;

    clamp.dispatchEvent(new CustomEvent("session-clamp-expand", { bubbles: false }));

    return vi.waitFor(() => expect(clamp).toHaveAttribute("data-clamp-state", "expanded"));
  });
});
