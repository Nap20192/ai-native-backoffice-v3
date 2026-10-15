import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { formatCompact, formatDayUtc, formatAxisDay } from "./analytics-format";
import { StackedBarChart, type BarSeries } from "./StackedBarChart";
import { SERIES_PALETTE } from "./series-colors";

const buckets = [
  "2026-10-14T00:00:00.000Z",
  "2026-10-15T00:00:00.000Z",
  "2026-10-16T00:00:00.000Z",
];

const series: BarSeries[] = [
  { key: "a", label: "claude-sonnet", color: SERIES_PALETTE[0], values: [1_000_000, 0, 400_000] },
  { key: "b", label: "verify-fake", color: SERIES_PALETTE[1], values: [450_000, 200_000, 0] },
];

function renderChart(extra: Partial<React.ComponentProps<typeof StackedBarChart>> = {}) {
  const props: React.ComponentProps<typeof StackedBarChart> = {
    buckets,
    series,
    ariaLabel: "Расход токенов по дням",
    formatValue: (v) => formatCompact(v),
    formatAxis: formatCompact,
    formatTitle: formatDayUtc,
    formatLabel: formatAxisDay,
    ...extra,
  };
  return render(<StackedBarChart {...props} />);
}

describe("StackedBarChart", () => {
  it("рисует SVG с подписью и столбцами по рядам", () => {
    const { container } = renderChart();
    expect(screen.getByRole("img", { name: "Расход токенов по дням" })).toBeInTheDocument();
    // Ряд с нулём в корзине не рисует столбец: 2 + 1 + 1 непустых части.
    expect(container.querySelectorAll("rect[data-series]")).toHaveLength(4);
    expect(container.querySelector('rect[data-series="a"]')).toHaveClass("fill-brand-600");
    expect(container.querySelector('rect[data-series="b"]')).toHaveClass("fill-sky-500");
  });

  it("ось Y с ровными делениями: 0, 500 тыс., 1 млн, 1,5 млн", () => {
    renderChart();
    for (const label of ["0", "500 тыс.", "1 млн", "1,5 млн"]) {
      expect(screen.getAllByText((_, el) => el?.textContent?.replace(/ /g, " ") === label && el.tagName === "text").length).toBeGreaterThan(0);
    }
  });

  it("подписывает ось X днями", () => {
    renderChart();
    expect(screen.getByText("14 окт.")).toBeInTheDocument();
    expect(screen.getByText("16 окт.")).toBeInTheDocument();
  });

  it("при наведении показывает подсказку с рядами и итогом", async () => {
    const user = userEvent.setup();
    const { container } = renderChart();
    expect(screen.queryByRole("tooltip")).toBeNull();
    await user.hover(container.querySelector('[data-bucket-index="0"]') as Element);
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("14 окт. 2026 (UTC)")).toBeInTheDocument();
    expect(within(tip).getByText("claude-sonnet")).toBeInTheDocument();
    expect(within(tip).getByText("verify-fake")).toBeInTheDocument();
    expect(within(tip).getByText("Итого")).toBeInTheDocument();
    expect(within(tip).getByText(/1,5\sмлн/)).toBeInTheDocument();
  });

  it("подсказка уходит, когда курсор покидает столбец", async () => {
    const user = userEvent.setup();
    const { container } = renderChart();
    const hit = container.querySelector('[data-bucket-index="1"]') as Element;
    await user.hover(hit);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    await user.unhover(hit);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("строка под итогом: подпись из footer", async () => {
    const user = userEvent.setup();
    const { container } = renderChart({ footer: (i) => (i === 1 ? "Без цены: 3 запроса" : null) });
    await user.hover(container.querySelector('[data-bucket-index="1"]') as Element);
    expect(within(screen.getByRole("tooltip")).getByText("Без цены: 3 запроса")).toBeInTheDocument();
    await user.hover(container.querySelector('[data-bucket-index="2"]') as Element);
    expect(within(screen.getByRole("tooltip")).queryByText("Без цены: 3 запроса")).toBeNull();
  });

  it("клик по столбцу вызывает onBucketClick с корзиной", async () => {
    const user = userEvent.setup();
    const onBucketClick = vi.fn();
    const { container } = renderChart({ onBucketClick });
    await user.click(container.querySelector('[data-bucket-index="2"]') as Element);
    expect(onBucketClick).toHaveBeenCalledWith("2026-10-16T00:00:00.000Z", 2);
  });

  it("стрелки двигают выбранную корзину, Enter работает как клик", async () => {
    const user = userEvent.setup();
    const onBucketClick = vi.fn();
    renderChart({ onBucketClick });
    const chart = screen.getByRole("img", { name: "Расход токенов по дням" });
    chart.focus();
    await user.keyboard("{ArrowRight}");
    expect(within(screen.getByRole("tooltip")).getByText("14 окт. 2026 (UTC)")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(within(screen.getByRole("tooltip")).getByText("15 окт. 2026 (UTC)")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onBucketClick).toHaveBeenCalledWith("2026-10-15T00:00:00.000Z", 1);
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}");
    expect(within(screen.getByRole("tooltip")).getByText("14 окт. 2026 (UTC)")).toBeInTheDocument();
  });

  it("у графика с кликом есть скрытая подсказка для скринридера", () => {
    renderChart({ onBucketClick: vi.fn() });
    const chart = screen.getByRole("img", { name: "Расход токенов по дням" });
    expect(chart).toHaveAccessibleDescription(/Стрелками.*Enter/);
  });

  it("без клика подсказки о клавишах нет", () => {
    renderChart();
    const chart = screen.getByRole("img", { name: "Расход токенов по дням" });
    expect(chart).not.toHaveAttribute("aria-describedby");
  });

  it("часовой график подписывает полночь UTC в режиме dayStart", () => {
    const start = Date.parse("2026-10-14T22:00:00.000Z");
    const hours = Array.from({ length: 30 }, (_, i) => new Date(start + i * 3_600_000).toISOString());
    renderChart({
      buckets: hours,
      series: [{ key: "a", label: "a", color: SERIES_PALETTE[0], values: hours.map(() => 10) }],
      labelMode: "dayStart",
    });
    expect(screen.getByText("15 окт.")).toBeInTheDocument();
  });

  it("клавиши и клик по пустому графику не падают", () => {
    const { container } = renderChart({ buckets: [], series: [] });
    expect(container.querySelector("svg")).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("img"), { key: "ArrowRight" });
  });
});
