import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  errorResponse,
  freezeNow,
  mockAnalytics,
  renderAnalyticsPage,
  usageReport,
} from "./analytics-fixtures";
import { UsagePage } from "./UsagePage";

const ROUTE = "/analytics/usage";

beforeEach(() => freezeNow());
afterEach(() => vi.useRealTimers());

function renderUsage(route = ROUTE) {
  return renderAnalyticsPage(<UsagePage />, route);
}

const location = () => screen.getByTestId("location").textContent;
/** Intl ставит неразрывные пробелы, в проверках сравниваем с обычными. */
const plain = (value: string | null) => (value ?? "").replace(/[\u00a0\u202f]/g, " ");

describe("UsagePage", () => {
  it("рисует шапку, плитки с итогами, график и легенду", async () => {
    mockAnalytics();
    renderUsage();

    expect(screen.getByRole("heading", { level: 1, name: "Использование" })).toBeInTheDocument();
    expect(screen.getByText(/Даты в UTC/)).toBeInTheDocument();

    await screen.findByRole("img", { name: "Расход токенов по дням" });
    const input = screen.getByRole("group", { name: "Токены на входе" });
    expect(within(input).getByText("5 240")).toBeInTheDocument();
    expect(within(input).getByText("из них из кэша: 2 500")).toBeInTheDocument();
    const output = screen.getByRole("group", { name: "Токены на выходе" });
    expect(within(output).getByText("490")).toBeInTheDocument();
    const requests = screen.getByRole("group", { name: "Запросы к модели" });
    expect(within(requests).getByText("17")).toBeInTheDocument();
    expect(within(requests).getByText("из них с ошибкой: 1")).toBeInTheDocument();

    expect(await screen.findByRole("img", { name: "Расход токенов по дням" })).toBeInTheDocument();
    const legend = screen.getByRole("list", { name: "Легенда" });
    expect(within(legend).getByText("verify-fake")).toBeInTheDocument();
    expect(within(legend).getByText("custom-model")).toBeInTheDocument();
    expect(screen.getByText("Данные на 16 окт., 09:12 UTC")).toBeInTheDocument();
  });

  it("просит у сервера 30 дней по UTC, группу по модели и ничего лишнего", async () => {
    const api = mockAnalytics();
    renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });

    const params = api.last("usage").searchParams;
    expect(params.get("from")).toBe("2026-09-17");
    expect(params.get("to")).toBe("2026-10-16");
    expect(params.get("bucket")).toBe("day");
    expect(params.get("group_by")).toBe("model");
    expect(params.has("agent_id")).toBe(false);
    expect(params.has("model")).toBe(false);
    expect(location()).toBe(ROUTE);
  });

  it("во время загрузки показывает скелетоны вместо значений", () => {
    mockAnalytics({ usage: () => new Promise(() => {}) as unknown as Response });
    renderUsage();
    expect(screen.getByTestId("stat-tiles")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Загрузка данных графика")).toBeInTheDocument();
  });

  it("режим «Таблица» показывает дни, ряды и итого", async () => {
    mockAnalytics();
    renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });
    await userEvent.click(screen.getByRole("button", { name: "Таблица" }));

    const table = screen.getByRole("table");
    const head = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(head).toEqual(["Дата (UTC)", "verify-fake", "custom-model", "Итого"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const first = within(rows[0]).getAllByRole("cell").map((c) => plain(c.textContent));
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent("14 окт. 2026 (UTC)");
    expect(first).toEqual(["2 800", "0", "2 800"]);
    expect(within(rows[1]).getAllByRole("cell").map((c) => plain(c.textContent))).toEqual(["270", "1 200", "1 470"]);
    expect(screen.queryByRole("img", { name: "Расход токенов по дням" })).toBeNull();
    // Легенда остаётся под таблицей.
    expect(screen.getByRole("list", { name: "Легенда" })).toBeInTheDocument();
  });

  it("фильтр «Агент» попадает в адрес и в запрос", async () => {
    const api = mockAnalytics();
    renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });

    await userEvent.click(screen.getByRole("button", { name: "Агент: Все" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "verify-agent" }));

    await waitFor(() => expect(location()).toBe(`${ROUTE}?agent_id=agent_02`));
    await waitFor(() => expect(api.last("usage").searchParams.get("agent_id")).toBe("agent_02"));
    expect(screen.getByRole("button", { name: "Агент: reviewer" })).toBeInTheDocument();
  });

  it("группа «Тип токена» просит none и рисует четыре типа токенов", async () => {
    const api = mockAnalytics();
    renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });

    await userEvent.click(screen.getByRole("button", { name: "Группировать по: Модель" }));
    await userEvent.click(screen.getByRole("option", { name: "Тип токена" }));

    await waitFor(() => expect(location()).toBe(`${ROUTE}?group_by=token_type`));
    await waitFor(() => expect(api.last("usage").searchParams.get("group_by")).toBe("none"));
    const legend = await waitFor(() => {
      const list = screen.getByRole("list", { name: "Легенда" });
      expect(within(list).getByText("Чтение кэша")).toBeInTheDocument();
      return list;
    });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Чтение кэша",
      "Запись кэша",
      "Выход",
      "Вход без кэша",
    ]);
  });

  it("период «7 дней» меняет адрес и границы запроса", async () => {
    const api = mockAnalytics();
    renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });

    await userEvent.click(screen.getByRole("button", { name: "Период: 30 дней" }));
    await userEvent.click(screen.getByRole("option", { name: "7 дней" }));

    await waitFor(() => expect(location()).toBe(`${ROUTE}?range=7d`));
    await waitFor(() => expect(api.last("usage").searchParams.get("from")).toBe("2026-10-10"));
    expect(api.last("usage").searchParams.get("to")).toBe("2026-10-16");
  });

  it("«Сбросить» появляется после фильтра и возвращает чистый адрес", async () => {
    mockAnalytics();
    renderUsage(`${ROUTE}?range=7d&group_by=agent`);
    await screen.findByRole("img", { name: "Расход токенов по дням" });

    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    await waitFor(() => expect(location()).toBe(ROUTE));
    expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
  });

  it("без отличий от умолчаний кнопки «Сбросить» нет", async () => {
    mockAnalytics();
    renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });
    expect(screen.queryByRole("button", { name: "Сбросить" })).toBeNull();
  });

  it("клик по столбцу приближает график до суток и показывает «Сбросить»", async () => {
    const api = mockAnalytics();
    const { container } = renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });

    await userEvent.click(container.querySelector('[data-bucket-index="1"]') as Element);

    await waitFor(() => expect(location()).toBe(`${ROUTE}?from=2026-10-15&to=2026-10-15`));
    await waitFor(() => expect(api.last("usage").searchParams.get("bucket")).toBe("hour"));
    expect(await screen.findByRole("img", { name: "Расход токенов по часам" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сбросить" })).toBeInTheDocument();
  });

  it("подсказка столбца: день, ряды и итого", async () => {
    mockAnalytics();
    const { container } = renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });
    await userEvent.hover(container.querySelector('[data-bucket-index="1"]') as Element);
    const tip = await screen.findByRole("tooltip");
    expect(within(tip).getByText("15 окт. 2026 (UTC)")).toBeInTheDocument();
    expect(within(tip).getByText("Итого")).toBeInTheDocument();
    expect(within(tip).getByText("1 470")).toBeInTheDocument();
  });

  it("пустой период: подсказка вместо графика и подпись «Нет данных» в плитках", async () => {
    mockAnalytics({ usage: usageReport({ empty: true }) });
    renderUsage();

    expect(
      await screen.findByText("За период нет вызовов модели. Запустите сессию агента."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Расход токенов/ })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Запросы к модели" })).getByText("Нет данных")).toBeInTheDocument();
  });

  it("ошибка сервера: блок с текстом и кнопка «Повторить»", async () => {
    let fail = true;
    mockAnalytics({
      usage: (url) =>
        fail
          ? errorResponse(500, "Не удалось получить аналитику.")
          : usageReport({ bucket: (url.searchParams.get("bucket") as "day") ?? "day" }),
    });
    renderUsage();

    expect(await screen.findByText("Не удалось загрузить данные")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/Ошибка сервера|Не удалось/);
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("img", { name: "Расход токенов по дням" })).toBeInTheDocument();
  });

  it("база без аналитики (501): выноска вместо содержимого", async () => {
    mockAnalytics({ usage: () => errorResponse(501, "На MySQL аналитика не ведётся.") });
    renderUsage();
    const note = await screen.findByText("На этой базе данных аналитика не ведётся.");
    expect(note.closest(".callout-warning")).not.toBeNull();
    expect(screen.queryByRole("group", { name: "Токены на входе" })).toBeNull();
  });

  it("кнопка «Обновить» перезапрашивает отчёт", async () => {
    const api = mockAnalytics();
    renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });
    const before = api.to("usage").length;
    await userEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(api.to("usage").length).toBeGreaterThan(before));
  });

  it("«Скачать CSV» просит format=csv с теми же фильтрами и сохраняет файл", async () => {
    const api = mockAnalytics();
    const created = vi.fn(() => "blob:csv");
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    let savedName = "";
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        savedName = this.download;
      });

    renderUsage(`${ROUTE}?range=7d&model=verify-fake`);
    await screen.findByRole("img", { name: "Расход токенов по дням" });
    await userEvent.click(screen.getByRole("button", { name: "Скачать CSV" }));

    await waitFor(() => expect(savedName).toBe("analytics-usage-2026-09-17_2026-10-16.csv"));
    const csv = api.requests.find((r) => r.url.searchParams.get("format") === "csv");
    expect(csv?.url.searchParams.get("from")).toBe("2026-10-10");
    expect(csv?.url.searchParams.get("model")).toBe("verify-fake");
    expect(csv?.url.searchParams.get("group_by")).toBe("model");
    expect(created).toHaveBeenCalledOnce();
    click.mockRestore();
  });

  it("на узком экране фильтры переносятся рядами, плитки идут в один столбец", async () => {
    mockAnalytics();
    renderUsage();
    await screen.findByRole("img", { name: "Расход токенов по дням" });
    expect(screen.getByRole("group", { name: "Фильтры" })).toHaveClass("flex-wrap");
    expect(screen.getByTestId("stat-tiles")).toHaveClass("grid-cols-1");
  });
});
