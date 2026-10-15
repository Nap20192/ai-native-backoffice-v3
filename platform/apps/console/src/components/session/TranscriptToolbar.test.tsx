import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TranscriptToolbar, type TranscriptToolbarProps } from "./TranscriptToolbar";

function setup(overrides: Partial<TranscriptToolbarProps> = {}) {
  const props: TranscriptToolbarProps = {
    query: "",
    onQueryChange: vi.fn(),
    matchCount: 0,
    currentMatch: -1,
    onNextMatch: vi.fn(),
    onPrevMatch: vi.fn(),
    zoom: 1,
    onZoomChange: vi.fn(),
    ...overrides,
  };
  const view = render(<TranscriptToolbar {...props} />);
  return { props, ...view };
}

describe("TranscriptToolbar: поле поиска", () => {
  it("называет поле «Найти в разговоре» и показывает подсказку", () => {
    setup();

    const field = screen.getByRole("searchbox", { name: "Найти в разговоре" });
    expect(field).toHaveAttribute("placeholder", "Найти в разговоре");
  });

  it("сообщает набранный текст", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.type(screen.getByRole("searchbox", { name: "Найти в разговоре" }), "a");

    expect(props.onQueryChange).toHaveBeenCalledWith("a");
  });

  it("отдаёт ссылку на поле для клавиши /", () => {
    const inputRef = createRef<HTMLInputElement>();
    setup({ inputRef });

    expect(inputRef.current).toBe(screen.getByRole("searchbox", { name: "Найти в разговоре" }));
  });

  it("при пустом запросе не показывает счётчик, стрелки и крестик", () => {
    setup();

    expect(screen.queryByTestId("match-counter")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Назад" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Далее" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Очистить поиск" })).not.toBeInTheDocument();
  });

  it("пишет счётчик «9/12» по номеру текущего совпадения", () => {
    setup({ query: "citation", matchCount: 12, currentMatch: 8 });

    expect(screen.getByTestId("match-counter")).toHaveTextContent("9/12");
  });

  it("без совпадений пишет «0/0» и отключает стрелки", () => {
    setup({ query: "zzz", matchCount: 0, currentMatch: -1 });

    expect(screen.getByTestId("match-counter")).toHaveTextContent("0/0");
    expect(screen.getByRole("button", { name: "Назад" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Далее" })).toBeDisabled();
  });

  it("стрелки «Назад» и «Далее» листают совпадения", async () => {
    const user = userEvent.setup();
    const { props } = setup({ query: "a", matchCount: 3, currentMatch: 1 });

    await user.click(screen.getByRole("button", { name: "Далее" }));
    await user.click(screen.getByRole("button", { name: "Назад" }));

    expect(props.onNextMatch).toHaveBeenCalledTimes(1);
    expect(props.onPrevMatch).toHaveBeenCalledTimes(1);
  });

  it("Enter идёт к следующему совпадению, Shift Enter к предыдущему", async () => {
    const user = userEvent.setup();
    const { props } = setup({ query: "a", matchCount: 3, currentMatch: 0 });

    await user.click(screen.getByRole("searchbox", { name: "Найти в разговоре" }));
    await user.keyboard("{Enter}");
    await user.keyboard("{Shift>}{Enter}{/Shift}");

    expect(props.onNextMatch).toHaveBeenCalledTimes(1);
    expect(props.onPrevMatch).toHaveBeenCalledTimes(1);
  });

  it("крестик очищает запрос", async () => {
    const user = userEvent.setup();
    const { props } = setup({ query: "citation", matchCount: 2, currentMatch: 0 });

    await user.click(screen.getByRole("button", { name: "Очистить поиск" }));

    expect(props.onQueryChange).toHaveBeenCalledWith("");
  });

  it("Esc в поле очищает непустой запрос", async () => {
    const user = userEvent.setup();
    const { props } = setup({ query: "citation", matchCount: 2, currentMatch: 0 });

    await user.click(screen.getByRole("searchbox", { name: "Найти в разговоре" }));
    await user.keyboard("{Escape}");

    expect(props.onQueryChange).toHaveBeenCalledWith("");
  });

  it("Esc в пустом поле уводит фокус из поля", async () => {
    const user = userEvent.setup();
    setup();
    const field = screen.getByRole("searchbox", { name: "Найти в разговоре" });

    await user.click(field);
    expect(field).toHaveFocus();
    await user.keyboard("{Escape}");

    expect(field).not.toHaveFocus();
  });
});

describe("TranscriptToolbar: масштаб", () => {
  it("«Крупнее» поднимает масштаб на ступень: 1, 2, 4, 8", async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    const { rerender, props } = setup({ onZoomChange });

    await user.click(screen.getByRole("button", { name: "Крупнее" }));
    rerender(<TranscriptToolbar {...props} zoom={2} />);
    await user.click(screen.getByRole("button", { name: "Крупнее" }));
    rerender(<TranscriptToolbar {...props} zoom={4} />);
    await user.click(screen.getByRole("button", { name: "Крупнее" }));

    expect(onZoomChange.mock.calls.map((call) => call[0])).toEqual([2, 4, 8]);
  });

  it("«Мельче» опускает масштаб на ступень", async () => {
    const user = userEvent.setup();
    const { props } = setup({ zoom: 4 });

    await user.click(screen.getByRole("button", { name: "Мельче" }));

    expect(props.onZoomChange).toHaveBeenCalledWith(2);
  });

  it("на краях шкалы кнопки отключены", () => {
    const { rerender, props } = setup({ zoom: 1 });
    expect(screen.getByRole("button", { name: "Мельче" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Крупнее" })).toBeEnabled();

    rerender(<TranscriptToolbar {...props} zoom={8} />);
    expect(screen.getByRole("button", { name: "Мельче" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Крупнее" })).toBeDisabled();
  });

  it("ставит справа от лупы место для кнопки «Инспектор»", () => {
    setup({ trailing: <span data-testid="trailing">Инспектор</span> });

    const zoomIn = screen.getByRole("button", { name: "Крупнее" });
    const trailing = screen.getByTestId("trailing");
    expect(zoomIn.compareDocumentPosition(trailing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
