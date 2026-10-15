import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CostPage } from "./CostPage";
import {
  errorResponse,
  freezeNow,
  mockAnalytics,
  renderAnalyticsPage,
  usageReport,
} from "./analytics-fixtures";

const ROUTE = "/analytics/cost";

beforeEach(() => freezeNow());
afterEach(() => vi.useRealTimers());

const renderCost = (route = ROUTE) => renderAnalyticsPage(<CostPage />, route);
const location = () => screen.getByTestId("location").textContent;
const chartName = "Стоимость по дням";

describe("CostPage", () => {
  it("рисует шапку и четыре плитки со стоимостью", async () => {
    mockAnalytics();
    renderCost();
    expect(screen.getByRole("heading", { level: 1, name: "Стоимость" })).toBeInTheDocument();
    expect(screen.getByText(/по ценам карточек и каталога Pi/)).toBeInTheDocument();

    await screen.findByRole("img", { name: chartName });
    const total = screen.getByRole("group", { name: "Общая стоимость" });
    expect(within(total).getByText("$0,0073")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Вход и выход" })).getByText("$0,0050")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Кэш" })).getByText("$0,0023")).toBeInTheDocument();
    const unpriced = screen.getByRole("group", { name: "Запросы без цены" });
    expect(within(unpriced).getByText("8")).toBeInTheDocument();
  });

  it("у плиток общей стоимости и запросов без цены есть подсказки", async () => {
    mockAnalytics();
    renderCost();
    const total = await screen.findByRole("group", { name: "Общая стоимость" });
    expect(within(total).getByRole("button", { name: /Общая стоимость/ })).toHaveAccessibleDescription(
      "Сумма по вызовам с известной ценой.",
    );
    const unpriced = screen.getByRole("group", { name: "Запросы без цены" });
    expect(within(unpriced).getByRole("button", { name: /Запросы без цены/ })).toHaveAccessibleDescription(
      "Задайте цену в карточке модели.",
    );
  });

  it("график стоимости по дням: ось в долларах и легенда по моделям", async () => {
    mockAnalytics();
    renderCost();
    const chart = await screen.findByRole("img", { name: chartName });
    expect(chart).toBeInTheDocument();
    const axisTexts = Array.from(chart.querySelectorAll("text")).map((t) => t.textContent);
    expect(axisTexts).toContain("$0");
    expect(axisTexts).toContain("$0,005");
    const legend = screen.getByRole("list", { name: "Легенда" });
    expect(within(legend).getByText("verify-fake")).toBeInTheDocument();
  });

  it("подсказка столбца показывает запросы без цены", async () => {
    mockAnalytics();
    const { container } = renderCost();
    await screen.findByRole("img", { name: chartName });
    await userEvent.hover(container.querySelector('[data-bucket-index="1"]') as Element);
    const tip = await screen.findByRole("tooltip");
    expect(within(tip).getByText("15 окт. 2026 (UTC)")).toBeInTheDocument();
    // Вторая модель без цены в этот день, поэтому сумма равна строке первой.
    expect(within(tip).getAllByText("$0,0014")).toHaveLength(2);
    expect(within(tip).getByText("Без цены: 5 запросов")).toBeInTheDocument();

    await userEvent.hover(container.querySelector('[data-bucket-index="0"]') as Element);
    expect(within(await screen.findByRole("tooltip")).queryByText(/Без цены/)).toBeNull();
  });

  it("таблица: даты, ряды в долларах и итого", async () => {
    mockAnalytics();
    renderCost();
    await screen.findByRole("img", { name: chartName });
    await userEvent.click(screen.getByRole("button", { name: "Таблица" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Дата (UTC)",
      "verify-fake",
      "custom-model",
      "Итого",
    ]);
    const first = within(table).getAllByRole("row")[1];
    expect(within(first).getByRole("rowheader")).toHaveTextContent("14 окт. 2026 (UTC)");
    expect(within(first).getAllByRole("cell").map((c) => c.textContent)).toEqual(["$0,0044", "$0", "$0,0044"]);
  });

  it("группа «Тип токена» берёт четыре части стоимости", async () => {
    const api = mockAnalytics();
    renderCost();
    await screen.findByRole("img", { name: chartName });
    await userEvent.click(screen.getByRole("button", { name: "Группировать по: Модель" }));
    await userEvent.click(screen.getByRole("option", { name: "Тип токена" }));
    await waitFor(() => expect(location()).toBe(`${ROUTE}?group_by=token_type`));
    await waitFor(() => expect(api.last("usage").searchParams.get("group_by")).toBe("none"));

    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Легенда" })).getAllByRole("listitem").map((li) => li.textContent),
      ).toEqual(["Чтение кэша", "Запись кэша", "Выход", "Вход без кэша"]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Таблица" }));
    const first = within(screen.getByRole("table")).getAllByRole("row")[1];
    expect(within(first).getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "$0,0006",
      "$0,0011",
      "$0,0015",
      "$0,0012",
      "$0,0044",
    ]);
  });

  it("фильтры идут в адрес и запрос, период по умолчанию 30 дней", async () => {
    const api = mockAnalytics();
    renderCost();
    await screen.findByRole("img", { name: chartName });
    expect(api.last("usage").searchParams.get("from")).toBe("2026-09-17");

    await userEvent.click(screen.getByRole("button", { name: "Harness: Все" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Встроенный цикл" }));
    await waitFor(() => expect(location()).toBe(`${ROUTE}?harness=claude-acp`));
    await waitFor(() => expect(api.last("usage").searchParams.get("harness")).toBe("claude-acp"));
  });

  it("клик по столбцу переключает на часы", async () => {
    const api = mockAnalytics();
    const { container } = renderCost();
    await screen.findByRole("img", { name: chartName });
    await userEvent.click(container.querySelector('[data-bucket-index="2"]') as Element);
    await waitFor(() => expect(api.last("usage").searchParams.get("bucket")).toBe("hour"));
    expect(await screen.findByRole("img", { name: "Стоимость по часам" })).toBeInTheDocument();
  });

  it("пусто, ошибка и 501", async () => {
    mockAnalytics({ usage: usageReport({ empty: true }) });
    const { unmount } = renderCost();
    expect(await screen.findByText("За период нет вызовов модели. Запустите сессию агента.")).toBeInTheDocument();
    unmount();

    mockAnalytics({ usage: () => errorResponse(500, "Не удалось получить аналитику.") });
    const second = renderCost();
    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
    second.unmount();

    mockAnalytics({ usage: () => errorResponse(501, "На MySQL аналитика не ведётся.") });
    renderCost();
    expect(await screen.findByText("На этой базе данных аналитика не ведётся.")).toBeInTheDocument();
  });

  it("кнопка CSV есть и на странице стоимости", async () => {
    mockAnalytics();
    renderCost();
    await screen.findByRole("img", { name: chartName });
    expect(screen.getByRole("button", { name: "Скачать CSV" })).toBeInTheDocument();
  });
});
