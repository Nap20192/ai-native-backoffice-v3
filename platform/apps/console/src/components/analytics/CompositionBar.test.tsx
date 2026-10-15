import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CompositionBar, type CompositionSegment } from "./CompositionBar";
import { TOKEN_TYPE_COLORS } from "./series-colors";

const segments: CompositionSegment[] = [
  { key: "cache_read", label: "Чтение кэша", value: 700, color: TOKEN_TYPE_COLORS.cache_read },
  { key: "cache_write", label: "Запись кэша", value: 100, color: TOKEN_TYPE_COLORS.cache_write },
  { key: "input", label: "Вход без кэша", value: 200, color: TOKEN_TYPE_COLORS.input },
];

describe("CompositionBar", () => {
  it("делит полосу по долям и подписывает её целиком", () => {
    render(<CompositionBar segments={segments} />);
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).toContain("Чтение кэша");
    expect(bar.getAttribute("aria-label")).toContain("70");
    const parts = bar.querySelectorAll("[data-segment]");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveStyle({ width: "70%" });
    expect(parts[1]).toHaveStyle({ width: "10%" });
    expect(parts[2]).toHaveStyle({ width: "20%" });
  });

  it("красит сегменты закреплёнными цветами типов токенов", () => {
    render(<CompositionBar segments={segments} />);
    const parts = screen.getByRole("img").querySelectorAll("[data-segment]");
    expect(parts[0]).toHaveClass("bg-sky-500");
    expect(parts[1]).toHaveClass("bg-amber-500");
    expect(parts[2]).toHaveClass("bg-ink-400");
  });

  it("подсказка сегмента: название, объём, доля", () => {
    render(<CompositionBar segments={segments} />);
    const first = screen.getByRole("img").querySelector("[data-segment]") as HTMLElement;
    expect(first.getAttribute("title")).toMatch(/^Чтение кэша: 700 \(70\s%\)$/);
  });

  it("сегмент с нулём не рисуется, полоса скруглена и 8 px высотой", () => {
    render(
      <CompositionBar
        segments={[...segments.slice(0, 2), { ...segments[2], value: 0 }]}
      />,
    );
    const bar = screen.getByRole("img");
    expect(bar.querySelectorAll("[data-segment]")).toHaveLength(2);
    expect(bar).toHaveClass("h-2", "rounded-full");
  });

  it("без входа остаётся пустая дорожка", () => {
    render(<CompositionBar segments={segments.map((s) => ({ ...s, value: 0 }))} />);
    const bar = screen.getByRole("img");
    expect(bar.querySelectorAll("[data-segment]")).toHaveLength(0);
    expect(bar.getAttribute("aria-label")).toMatch(/нет данных/i);
  });
});
