import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_FILTER, type TraceFilter } from "../../../lib/trace-tree";
import { TraceToolbar, type TraceToolbarProps } from "./TraceToolbar";

function props(over: Partial<TraceToolbarProps> = {}): TraceToolbarProps {
  return {
    query: "",
    onQueryChange: vi.fn(),
    matchCount: 0,
    currentMatch: -1,
    onNextMatch: vi.fn(),
    onPrevMatch: vi.fn(),
    searchProgress: null,
    filter: NO_FILTER,
    onFilterChange: vi.fn(),
    onCollapseAll: vi.fn(),
    onExpandAll: vi.fn(),
    zoomIndex: 0,
    zoomSteps: 5,
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    hasWindow: false,
    canFitTurn: false,
    onFitTurn: vi.fn(),
    onResetWindow: vi.fn(),
    showFollow: false,
    follow: true,
    onFollowChange: vi.fn(),
    compact: false,
    ...over,
  };
}

describe("TraceToolbar: поиск", () => {
  it("поле поиска передаёт текст, Enter идёт к следующему, Shift Enter к предыдущему", () => {
    const p = props({ query: "bash", matchCount: 3, currentMatch: 0 });
    render(<TraceToolbar {...p} />);
    const input = screen.getByRole("searchbox", { name: "Найти в трейсе" });
    fireEvent.change(input, { target: { value: "bashx" } });
    expect(p.onQueryChange).toHaveBeenCalledWith("bashx");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onNextMatch).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(p.onPrevMatch).toHaveBeenCalledTimes(1);
  });

  it("Escape очищает поиск, а на пустом поле снимает фокус", () => {
    const p = props({ query: "bash" });
    const { rerender } = render(<TraceToolbar {...p} />);
    const input = screen.getByRole("searchbox", { name: "Найти в трейсе" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(p.onQueryChange).toHaveBeenCalledWith("");
    rerender(<TraceToolbar {...p} query="" />);
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
  });

  it("считает совпадения «3/12» и «0/0», кнопки без совпадений недоступны", () => {
    const { rerender } = render(<TraceToolbar {...props({ query: "bash", matchCount: 12, currentMatch: 2 })} />);
    expect(screen.getByTestId("match-counter")).toHaveTextContent("3/12");
    expect(screen.getByRole("button", { name: "Назад" })).toBeEnabled();
    rerender(<TraceToolbar {...props({ query: "bash", matchCount: 0, currentMatch: -1 })} />);
    expect(screen.getByTestId("match-counter")).toHaveTextContent("0/0");
    expect(screen.getByRole("button", { name: "Назад" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Далее" })).toBeDisabled();
  });

  it("до первого перехода счётчик стоит на нуле", () => {
    render(<TraceToolbar {...props({ query: "bash", matchCount: 12, currentMatch: -1 })} />);
    expect(screen.getByTestId("match-counter")).toHaveTextContent("0/12");
  });

  it("пока сервер достраивает ходы, показывает «ищу: 120 из 1000 ходов»", () => {
    render(<TraceToolbar {...props({ query: "bash", searchProgress: { remainingTurns: 880, totalTurns: 1000 } })} />);
    expect(screen.getByText("ищу: 120 из 1000 ходов")).toBeInTheDocument();
  });

  it("когда достраивать нечего, подписи о поиске нет", () => {
    render(<TraceToolbar {...props({ query: "bash", searchProgress: { remainingTurns: 0, totalTurns: 1000 } })} />);
    expect(screen.queryByText(/ищу:/)).toBeNull();
  });

  it("кнопка очистки сбрасывает запрос", () => {
    const p = props({ query: "bash" });
    render(<TraceToolbar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Очистить поиск" }));
    expect(p.onQueryChange).toHaveBeenCalledWith("");
  });
});

describe("TraceToolbar: фильтр", () => {
  it("даёт чипы по группам и переключатель «Только ошибки»", () => {
    render(<TraceToolbar {...props()} />);
    for (const name of ["Ход", "Модель", "Инструмент", "Сабагент", "Песочница", "Ожидание", "Только ошибки"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("включает и выключает группу и отмечает её нажатой", () => {
    const p = props();
    const { rerender } = render(<TraceToolbar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Инструмент" }));
    const next = (p.onFilterChange as ReturnType<typeof vi.fn>).mock.calls[0]![0] as TraceFilter;
    expect([...next.groups]).toEqual(["tool"]);
    expect(next.errorsOnly).toBe(false);

    rerender(<TraceToolbar {...p} filter={next} />);
    expect(screen.getByRole("button", { name: "Инструмент" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Модель" }));
    const both = (p.onFilterChange as ReturnType<typeof vi.fn>).mock.calls[1]![0] as TraceFilter;
    expect([...both.groups].sort()).toEqual(["model", "tool"]);
    fireEvent.click(screen.getByRole("button", { name: "Инструмент" }));
    const without = (p.onFilterChange as ReturnType<typeof vi.fn>).mock.calls[2]![0] as TraceFilter;
    expect([...without.groups]).toEqual([]);
  });

  it("«Только ошибки» меняет только свой флаг", () => {
    const p = props({ filter: { groups: new Set(["tool"]), errorsOnly: false } });
    render(<TraceToolbar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Только ошибки" }));
    const next = (p.onFilterChange as ReturnType<typeof vi.fn>).mock.calls[0]![0] as TraceFilter;
    expect(next.errorsOnly).toBe(true);
    expect([...next.groups]).toEqual(["tool"]);
  });

  it("при включённом фильтре есть кнопка «Сбросить фильтр»", () => {
    const p = props({ filter: { groups: new Set(["tool"]), errorsOnly: true } });
    render(<TraceToolbar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтр" }));
    const next = (p.onFilterChange as ReturnType<typeof vi.fn>).mock.calls[0]![0] as TraceFilter;
    expect(next.groups.size).toBe(0);
    expect(next.errorsOnly).toBe(false);
  });
});

describe("TraceToolbar: свёртка, масштаб, слежение", () => {
  it("«Свернуть всё» и «Развернуть всё»", () => {
    const p = props();
    render(<TraceToolbar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Свернуть всё" }));
    fireEvent.click(screen.getByRole("button", { name: "Развернуть всё" }));
    expect(p.onCollapseAll).toHaveBeenCalledTimes(1);
    expect(p.onExpandAll).toHaveBeenCalledTimes(1);
  });

  it("«Мельче» недоступна на минимальном масштабе, «Крупнее» на максимальном", () => {
    const { rerender } = render(<TraceToolbar {...props({ zoomIndex: 0, zoomSteps: 5 })} />);
    expect(screen.getByRole("button", { name: "Мельче" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Крупнее" })).toBeEnabled();
    rerender(<TraceToolbar {...props({ zoomIndex: 4, zoomSteps: 5 })} />);
    expect(screen.getByRole("button", { name: "Мельче" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Крупнее" })).toBeDisabled();
  });

  it("масштаб вызывает свои обработчики", () => {
    const p = props({ zoomIndex: 2 });
    render(<TraceToolbar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Мельче" }));
    fireEvent.click(screen.getByRole("button", { name: "Крупнее" }));
    expect(p.onZoomOut).toHaveBeenCalledTimes(1);
    expect(p.onZoomIn).toHaveBeenCalledTimes(1);
  });

  it("«Весь ход» доступна при выбранном узле, «Весь трейс» появляется при окне", () => {
    const p = props({ canFitTurn: true });
    const { rerender } = render(<TraceToolbar {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Весь ход" }));
    expect(p.onFitTurn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Весь трейс" })).toBeNull();
    rerender(<TraceToolbar {...p} hasWindow />);
    fireEvent.click(screen.getByRole("button", { name: "Весь трейс" }));
    expect(p.onResetWindow).toHaveBeenCalledTimes(1);
    rerender(<TraceToolbar {...props({ canFitTurn: false })} />);
    expect(screen.getByRole("button", { name: "Весь ход" })).toBeDisabled();
  });

  it("«Следить за ходом» показан только пока идёт ход", () => {
    const { rerender } = render(<TraceToolbar {...props({ showFollow: false })} />);
    expect(screen.queryByRole("button", { name: "Следить за ходом" })).toBeNull();
    const p = props({ showFollow: true, follow: true });
    rerender(<TraceToolbar {...p} />);
    const toggle = screen.getByRole("button", { name: "Следить за ходом" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(p.onFollowChange).toHaveBeenCalledWith(false);
  });
});

describe("TraceToolbar: телефон", () => {
  it("без водопада масштаб не нужен: кнопок масштаба и окна нет, поиск и фильтр остались", () => {
    render(<TraceToolbar {...props({ compact: true, hasWindow: true, canFitTurn: true })} />);
    for (const name of ["Мельче", "Крупнее", "Весь ход", "Весь трейс"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByRole("searchbox", { name: "Найти в трейсе" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Только ошибки" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Свернуть всё" })).toBeInTheDocument();
  });
});
