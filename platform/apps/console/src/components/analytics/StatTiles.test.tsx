import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatTiles, type StatTile } from "./StatTiles";

const tiles: StatTile[] = [
  { id: "in", label: "Токены на входе", value: "1 611 100", note: "из них из кэша: 1 400 000" },
  {
    id: "out",
    label: "Токены на выходе",
    value: "300",
    hint: "Токены, которые модель выдала в ответах.",
  },
  { id: "req", label: "Запросы к модели", value: "0", empty: true },
];

describe("StatTiles", () => {
  it("рисует подпись, значение и пояснение каждой плитки", () => {
    render(<StatTiles tiles={tiles} />);
    const first = screen.getByRole("group", { name: "Токены на входе" });
    expect(within(first).getByText("1 611 100")).toBeInTheDocument();
    expect(within(first).getByText("из них из кэша: 1 400 000")).toBeInTheDocument();
  });

  it("значок подсказки несёт доступное имя и текст подсказки", () => {
    render(<StatTiles tiles={tiles} />);
    const tile = screen.getByRole("group", { name: "Токены на выходе" });
    const hint = within(tile).getByRole("button", { name: /Токены на выходе/ });
    expect(hint).toHaveAccessibleDescription("Токены, которые модель выдала в ответах.");
  });

  it("плитка без данных подписана «Нет данных»", () => {
    render(<StatTiles tiles={tiles} />);
    const empty = screen.getByRole("group", { name: "Запросы к модели" });
    expect(within(empty).getByText("Нет данных")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Токены на входе" })).queryByText("Нет данных")).toBeNull();
  });

  it("при загрузке показывает скелетоны вместо значений", () => {
    const { container } = render(<StatTiles tiles={tiles} loading />);
    expect(screen.getByTestId("stat-tiles")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("1 611 100")).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText("Токены на входе")).toBeInTheDocument();
  });

  it("сетка: одна колонка на телефоне, три или четыре на широком экране", () => {
    const { rerender } = render(<StatTiles tiles={tiles} />);
    const grid = screen.getByTestId("stat-tiles");
    expect(grid).toHaveClass("grid-cols-1", "lg:grid-cols-3");
    rerender(<StatTiles tiles={tiles} columns={4} />);
    expect(screen.getByTestId("stat-tiles")).toHaveClass("grid-cols-1", "lg:grid-cols-4");
  });
});
