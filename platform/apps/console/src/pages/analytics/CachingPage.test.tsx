import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CachingPage } from "./CachingPage";
import { cacheReport, errorResponse, freezeNow, mockAnalytics, renderAnalyticsPage } from "./analytics-fixtures";

const ROUTE = "/analytics/caching";

beforeEach(() => freezeNow());
afterEach(() => vi.useRealTimers());

const renderCaching = (route = ROUTE) => renderAnalyticsPage(<CachingPage />, route);
const location = () => screen.getByTestId("location").textContent;
const plain = (value: string | null) => (value ?? "").replace(/[  ]/g, " ");

async function ready() {
  await screen.findByRole("region", { name: "Разбивка кэша" });
  await screen.findByRole("img", { name: "Состав входа по часам" });
}

describe("CachingPage", () => {
  it("шапка, липкая панель фильтров и подпись «Данные на»", async () => {
    mockAnalytics();
    renderCaching();
    expect(screen.getByRole("heading", { level: 1, name: "Кэширование" })).toBeInTheDocument();
    expect(screen.getByText(/Последние 7 дней, даты в UTC/)).toBeInTheDocument();
    await ready();

    const bar = screen.getByRole("group", { name: "Фильтры" });
    expect(bar.parentElement).toHaveClass("sticky", "top-0");
    expect(within(bar).getByRole("button", { name: "Модель: Все" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Агент: Все" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Период: 7 дней" })).toBeDisabled();
    expect(within(bar).getByRole("button", { name: "Группировать по: Модель" })).toBeInTheDocument();
    expect(within(bar).getByText("Данные на 16 окт., 09:12 UTC")).toBeInTheDocument();
    expect(within(bar).queryByRole("button", { name: "Сбросить" })).toBeNull();
  });

  it("плитки: вход без кэша, чтение из кэша и доля чтения, у каждой подсказка", async () => {
    mockAnalytics();
    renderCaching();
    await ready();
    const uncached = screen.getByRole("group", { name: "Вход без кэша" });
    expect(plain(within(uncached).getByText(/тыс\./).textContent)).toBe("6,9 тыс.");
    expect(within(uncached).getByRole("button", { name: /Вход без кэша/ })).toHaveAccessibleDescription(
      /не попали в кэш/,
    );
    const read = screen.getByRole("group", { name: "Чтение из кэша" });
    expect(plain(within(read).getByText(/тыс\./).textContent)).toBe("168 тыс.");
    const ratio = screen.getByRole("group", { name: "Доля чтения из кэша" });
    expect(plain(within(ratio).getByText(/%/).textContent)).toBe("91,7 %");
    expect(within(ratio).getByRole("button", { name: /Доля чтения/ })).toBeInTheDocument();
  });

  it("агенты с низкой долей кэша: таблица из ответа сервера", async () => {
    mockAnalytics();
    renderCaching();
    await ready();
    const card = screen.getByRole("region", { name: "Агенты с низкой долей кэша" });
    expect(within(card).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Агент",
      "Модель",
      "Вход",
      "Доля чтения",
    ]);
    const row = within(card).getAllByRole("row")[1];
    expect(within(row).getAllByRole("cell").map((c) => plain(c.textContent))).toEqual([
      "other-model",
      "12 тыс.",
      "10 %",
    ]);
    expect(within(row).getByRole("rowheader")).toHaveTextContent("reviewer");
  });

  it("если всё читается из кэша, карточка говорит об этом", async () => {
    mockAnalytics({ cache: { ...cacheReport(), low_cache_agents: [] } });
    renderCaching();
    await ready();
    expect(
      screen.getByText("Все агенты с заметным входом читают из кэша больше половины."),
    ).toBeInTheDocument();
  });

  it("если кэш не используется совсем, пишет об этом вместо таблицы", async () => {
    mockAnalytics({ cache: cacheReport({ noCache: true }) });
    renderCaching();
    await screen.findByRole("region", { name: "Агенты с низкой долей кэша" });
    expect(
      await screen.findByText("Кэш не используется: токены чтения и записи равны нулю."),
    ).toBeInTheDocument();
  });

  it("разбивка кэша: итого сверху, сортировка по входу меняет порядок строк", async () => {
    mockAnalytics();
    renderCaching();
    await ready();
    const card = screen.getByRole("region", { name: "Разбивка кэша" });
    const head = within(card).getAllByRole("columnheader").map((h) => h.textContent ?? "");
    expect(head.slice(0, 4)).toEqual(["Модель", "Вход", "Состав входа", "Доля чтения"]);
    expect(head[4]).toMatch(/^Окупаемость записи/);
    expect(
      within(card.querySelector("thead") as HTMLElement).getByRole("button", { name: /Пояснение: Окупаемость записи/ }),
    ).toHaveAccessibleDescription(/прочитано из кэша на один записанный/);

    const names = () =>
      within(card)
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getByRole("rowheader").textContent);
    expect(names()).toEqual(["Итого", "verify-fake", "other-model"]);

    await userEvent.click(within(card).getByRole("button", { name: /Вход/ }));
    expect(names()).toEqual(["Итого", "other-model", "verify-fake"]);
    await userEvent.click(within(card).getByRole("button", { name: /Вход/ }));
    expect(names()).toEqual(["Итого", "verify-fake", "other-model"]);

    const verify = within(card).getAllByRole("row")[2];
    const cells = within(verify).getAllByRole("cell");
    expect(plain(cells[0].textContent)).toBe("179 760");
    expect(plain(cells[2].textContent)).toBe("93,5 %");
    expect(plain(cells[3].textContent)).toBe("20×");
    expect(within(verify).getByRole("img", { name: /Состав входа/ })).toBeInTheDocument();
    // У модели без записи в кэш окупаемости нет.
    const other = within(card).getAllByRole("row")[3];
    expect(plain(within(other).getAllByRole("cell")[3].textContent)).toBe("нет");
    // Легенда состава под таблицей.
    expect(within(card).getByRole("list", { name: "Легенда" })).toBeInTheDocument();
  });

  it("три графика с описаниями и окнами по умолчанию 6 ч и 24 ч", async () => {
    mockAnalytics();
    renderCaching();
    await ready();
    const composition = screen.getByRole("region", { name: "Состав входа" });
    expect(within(composition).getByText(/Чем меньше входа без кэша, тем дешевле/)).toBeInTheDocument();
    const ratio = screen.getByRole("region", { name: "Доля чтения из кэша" });
    expect(within(ratio).getByRole("button", { name: "Окно: 6 ч" })).toBeInTheDocument();
    const amort = screen.getByRole("region", { name: "Окупаемость записи" });
    expect(within(amort).getByRole("button", { name: "Окно: 24 ч" })).toBeInTheDocument();
  });

  it("состав входа: столбцы по часам за 7 суток и таблица по часам", async () => {
    mockAnalytics();
    renderCaching();
    await ready();
    const card = screen.getByRole("region", { name: "Состав входа" });
    const chart = within(card).getByRole("img", { name: "Состав входа по часам" });
    expect(chart.querySelectorAll("[data-bucket-index]")).toHaveLength(168);

    await userEvent.click(within(card).getByRole("button", { name: "Таблица" }));
    const table = within(card).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Время (UTC)",
      "Чтение кэша",
      "Запись кэша",
      "Вход без кэша",
      "Итого",
    ]);
    expect(within(table).getAllByRole("row")).toHaveLength(169);
    expect(within(within(table).getAllByRole("row")[1]).getByRole("rowheader")).toHaveTextContent(
      "9 окт., 10:00 UTC",
    );
  });

  it("выбор модели в составе входа оставляет её одну", async () => {
    mockAnalytics();
    renderCaching();
    await ready();
    const card = screen.getByRole("region", { name: "Состав входа" });
    await userEvent.click(within(card).getByRole("button", { name: "Модель: Все" }));
    await userEvent.click(screen.getByRole("option", { name: "other-model" }));
    expect(within(card).getByRole("button", { name: "Модель: other-model" })).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Таблица" }));
    // other-model живёт в двух часах из 168 по 500 токенов без кэша.
    const rows = within(within(card).getByRole("table")).getAllByRole("row").slice(1);
    const withInput = rows.filter((r) => plain(within(r).getAllByRole("cell")[2].textContent) !== "0");
    expect(withInput).toHaveLength(7);
  });

  it("окно 24 ч у доли чтения пересчитывает линии и подсказку", async () => {
    mockAnalytics();
    const { container } = renderCaching();
    await ready();
    const card = screen.getByRole("region", { name: "Доля чтения из кэша" });
    const chart = within(card).getByRole("img", { name: "Доля чтения из кэша по часам" });
    expect(chart.querySelectorAll("[data-bucket-index]")).toHaveLength(168);
    await userEvent.hover(chart.querySelector('[data-bucket-index="100"]') as Element);
    const tip = await screen.findByRole("tooltip");
    expect(within(tip).getByText("verify-fake")).toBeInTheDocument();
    expect(plain(within(tip).getAllByText(/%/)[0].textContent)).toBe("93,5 %");
    expect(container).toBeTruthy();

    await userEvent.click(within(card).getByRole("button", { name: "Окно: 6 ч" }));
    await userEvent.click(screen.getByRole("option", { name: "24 ч" }));
    expect(within(card).getByRole("button", { name: "Окно: 24 ч" })).toBeInTheDocument();
  });

  it("окупаемость записи: логарифмическая ось и значение 20×", async () => {
    mockAnalytics();
    renderCaching();
    await ready();
    const card = screen.getByRole("region", { name: "Окупаемость записи" });
    const chart = within(card).getByRole("img", { name: "Окупаемость записи по часам" });
    const labels = Array.from(chart.querySelectorAll("text")).map((t) => plain(t.textContent));
    expect(labels).toEqual(expect.arrayContaining(["10×", "20×", "50×"]));
    await userEvent.hover(chart.querySelector('[data-bucket-index="50"]') as Element);
    const tip = await screen.findByRole("tooltip");
    expect(plain(within(tip).getByText(/×/).textContent)).toBe("20×");
  });

  it("фильтры идут в адрес и в запрос, «Сбросить» чистит их", async () => {
    const api = mockAnalytics();
    renderCaching();
    await ready();
    expect(api.last("cache").searchParams.get("group_by")).toBe("model");

    const bar = screen.getByRole("group", { name: "Фильтры" });
    await userEvent.click(within(bar).getByRole("button", { name: "Модель: Все" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "custom-model" }));
    await waitFor(() => expect(location()).toBe(`${ROUTE}?model=verify-fake`));
    await waitFor(() => expect(api.last("cache").searchParams.get("model")).toBe("verify-fake"));

    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Группировать по: Модель" }));
    await userEvent.click(screen.getByRole("option", { name: "Агент" }));
    await waitFor(() => expect(api.last("cache").searchParams.get("group_by")).toBe("agent"));
    expect(location()).toContain("group_by=agent");

    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    await waitFor(() => expect(location()).toBe(ROUTE));
  });

  it("пусто, ошибка и 501", async () => {
    mockAnalytics({ cache: cacheReport({ empty: true }) });
    const first = renderCaching();
    expect(await screen.findByText("За период нет вызовов модели. Запустите сессию агента.")).toBeInTheDocument();
    first.unmount();

    mockAnalytics({ cache: () => errorResponse(500, "Не удалось получить аналитику.") });
    const second = renderCaching();
    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
    second.unmount();

    mockAnalytics({ cache: () => errorResponse(501, "На MySQL аналитика не ведётся.") });
    renderCaching();
    expect(await screen.findByText("На этой базе данных аналитика не ведётся.")).toBeInTheDocument();
  });

  it("при загрузке плитки в скелетонах, графики серой плитой", () => {
    mockAnalytics({ cache: () => new Promise(() => {}) as unknown as Response });
    renderCaching();
    expect(screen.getByTestId("stat-tiles")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByText("Загрузка данных графика").length).toBeGreaterThan(0);
  });
});
