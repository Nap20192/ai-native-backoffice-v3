import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { formatAmortization, formatHourUtc, formatPercent } from "./analytics-format";
import { LineChart, type LineSeries } from "./LineChart";
import { SERIES_PALETTE } from "./series-colors";

const hours = Array.from({ length: 6 }, (_, i) =>
  new Date(Date.parse("2026-10-16T04:00:00.000Z") + i * 3_600_000).toISOString(),
);

const series: LineSeries[] = [
  { key: "a", label: "claude-sonnet", color: SERIES_PALETTE[0], points: [0.5, 0.6, null, 0.8, 0.9, 0.95] },
  { key: "b", label: "verify-fake", color: SERIES_PALETTE[1], points: [null, null, 0.3, null, null, null] },
];

function renderChart(extra: Partial<React.ComponentProps<typeof LineChart>> = {}) {
  return render(
    <LineChart
      buckets={hours}
      series={series}
      ariaLabel="Доля чтения из кэша"
      formatValue={(v) => formatPercent(v)}
      formatAxis={(v) => formatPercent(v, 0)}
      formatTitle={formatHourUtc}
      {...extra}
    />,
  );
}

describe("LineChart", () => {
  it("рисует линию на ряд, пропуск значения рвёт линию", () => {
    const { container } = renderChart();
    const a = container.querySelector('path[data-series="a"]') as SVGPathElement;
    expect(a).not.toBeNull();
    expect(a.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(a).toHaveClass("stroke-brand-600");
    expect(a).toHaveAttribute("fill", "none");
  });

  it("одна точка рисуется кружком, а не линией", () => {
    const { container } = renderChart();
    expect(container.querySelector('path[data-series="b"]')).toBeNull();
    const dot = container.querySelector('circle[data-series="b"]');
    expect(dot).not.toBeNull();
    expect(dot).toHaveClass("fill-sky-500");
  });

  it("пунктирная линия лимита с подписью", () => {
    const { container } = renderChart({ limit: { value: 1, label: "Лимит карточки" } });
    const line = container.querySelector('[data-testid="limit-line"]') as SVGLineElement;
    expect(line).not.toBeNull();
    expect(line.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(screen.getByText("Лимит карточки")).toBeInTheDocument();
  });

  it("логарифмическая ось: 0,5×, 1×, 2×, 5×, 10×", () => {
    renderChart({
      scale: "log",
      series: [
        { key: "a", label: "claude-sonnet", color: SERIES_PALETTE[0], points: [0.8, 2, 3, 7.2, 4, 1] },
      ],
      formatValue: formatAmortization,
      formatAxis: formatAmortization,
    });
    for (const label of ["0,5×", "1×", "2×", "5×", "10×"]) {
      expect(
        screen.getAllByText((_, el) => el?.tagName === "text" && el.textContent === label).length,
      ).toBeGreaterThan(0);
    }
  });

  it("подсказка: время и значение каждой линии в этом часе", async () => {
    const user = userEvent.setup();
    const { container } = renderChart();
    await user.hover(container.querySelector('[data-bucket-index="3"]') as Element);
    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("16 окт., 07:00 UTC")).toBeInTheDocument();
    expect(within(tip).getByText("claude-sonnet")).toBeInTheDocument();
    expect(within(tip).getByText(/80\s%/)).toBeInTheDocument();
    // У verify-fake в этом часу значения нет: строки в подсказке тоже нет.
    expect(within(tip).queryByText("verify-fake")).toBeNull();
  });

  it("стрелки двигают выбранный час", async () => {
    const user = userEvent.setup();
    renderChart();
    screen.getByRole("img", { name: "Доля чтения из кэша" }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(within(screen.getByRole("tooltip")).getByText("16 окт., 05:00 UTC")).toBeInTheDocument();
  });

  it("без значений оставляет пустую ось и не падает", () => {
    const { container } = renderChart({
      series: [{ key: "a", label: "a", color: SERIES_PALETTE[0], points: [null, null, null, null, null, null] }],
    });
    expect(container.querySelector("path[data-series]")).toBeNull();
    expect(container.querySelector("circle[data-series]")).toBeNull();
  });
});
