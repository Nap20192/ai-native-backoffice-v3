import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogsPage } from "./LogsPage";
import {
  errorResponse,
  freezeNow,
  makeCall,
  mockAnalytics,
  modelCallsPage,
  renderAnalyticsPage,
} from "./analytics-fixtures";

const ROUTE = "/analytics/logs";

beforeEach(() => freezeNow());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const renderLogs = (route = ROUTE) => renderAnalyticsPage(<LogsPage />, route);
const location = () => screen.getByTestId("location").textContent;
const plain = (value: string | null) => (value ?? "").replace(/[  ]/g, " ");
const row = (id: string) => document.querySelector(`[data-row-id="${id}"]`) as HTMLElement;
const rowIds = () =>
  Array.from(document.querySelectorAll("tbody [data-row-id]")).map((r) => r.getAttribute("data-row-id"));

async function ready(route = ROUTE) {
  const view = renderLogs(route);
  await waitFor(() => expect(row("sevt_01")).toBeTruthy());
  return view;
}

describe("LogsPage", () => {
  it("шапка, фильтры и таблица на 20 строк", async () => {
    mockAnalytics();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "Журнал запросов" })).toBeInTheDocument();
    expect(screen.getByText(/новые сверху/)).toBeInTheDocument();
    const bar = screen.getByRole("group", { name: "Фильтры" });
    for (const name of ["Период: 30 дней", "Агент: Все", "Модель: Все", "Harness: Все", "Карточка: Все", "Статус: Все"]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(bar).getByRole("button", { name: "Скачать CSV" })).toBeInTheDocument();
    expect(rowIds()).toHaveLength(20);
    expect(rowIds()[0]).toBe("sevt_01");
  });

  it("колонки таблицы по контракту", async () => {
    mockAnalytics();
    await ready();
    const head = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent);
    expect(head).toEqual([
      "ID",
      "Статус",
      "Время",
      "Агент",
      "Модель",
      "Вход",
      "Выход",
      "Задержка",
      "Стоимость",
      "Скорость",
    ]);
  });

  it("строка записи: ID, статус, время, агент, модель, токены, задержка, цена, скорость", async () => {
    mockAnalytics();
    await ready();
    const first = row("sevt_01");
    expect(within(first).getByRole("rowheader")).toHaveTextContent("sevt_01");
    const cells = within(first).getAllByRole("cell");
    expect(plain(cells[0].textContent)).toBe("Успешно");
    expect(plain(cells[1].textContent)).toBe("3 минуты назад");
    expect(within(cells[1]).getByText("3 минуты назад").closest("time")).toHaveAttribute(
      "title",
      "16 окт. 2026, 09:11:03 UTC",
    );
    expect(plain(cells.slice(2).map((c) => c.textContent).join("|"))).toBe(
      "verify-agent|verify-fake|26|10|3,02 с|$0,0002|Обычная",
    );
  });

  it("ошибка в строке: красная точка и подпись «Ошибка»", async () => {
    mockAnalytics({
      modelCalls: { data: [makeCall(1, { is_error: true, error_message: "Таймаут" })], next_cursor: null, latest_ended_at: null },
    });
    await ready();
    const status = within(row("sevt_01")).getAllByRole("cell")[0];
    expect(status).toHaveTextContent("Ошибка");
    expect(status.querySelector(".bg-ddc-dot-danger")).not.toBeNull();
  });

  it("первый запрос: 30 дней, 20 записей на странице, без курсора", async () => {
    const api = mockAnalytics();
    await ready();
    const params = api.last("model_calls").searchParams;
    expect(params.get("from")).toBe("2026-09-17");
    expect(params.get("to")).toBe("2026-10-16");
    expect(params.get("limit")).toBe("20");
    expect(params.has("cursor")).toBe(false);
    expect(params.has("status")).toBe(false);
  });

  it("страницы курсора: вперёд и назад, на последней «Следующая» отключена", async () => {
    const api = mockAnalytics();
    await ready();
    const previous = screen.getByRole("button", { name: "Предыдущая страница" });
    const next = screen.getByRole("button", { name: "Следующая страница" });
    expect(previous).toBeDisabled();

    await userEvent.click(next);
    await waitFor(() => expect(rowIds()[0]).toBe("sevt_21"));
    expect(api.last("model_calls").searchParams.get("cursor")).toBe("p2");
    expect(screen.getByRole("button", { name: "Предыдущая страница" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
    await waitFor(() => expect(rowIds()[0]).toBe("sevt_41"));
    expect(rowIds()).toHaveLength(5);
    expect(screen.getByRole("button", { name: "Следующая страница" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Предыдущая страница" }));
    await waitFor(() => expect(rowIds()[0]).toBe("sevt_21"));
    await userEvent.click(screen.getByRole("button", { name: "Предыдущая страница" }));
    await waitFor(() => expect(rowIds()[0]).toBe("sevt_01"));
    expect(location()).toBe(ROUTE);
  });

  it("подпись «На момент» и кнопка «Обновить» внизу", async () => {
    const api = mockAnalytics();
    await ready();
    expect(screen.getByText("На момент 09:15 UTC")).toBeInTheDocument();
    const before = api.to("model_calls").length;
    await userEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await waitFor(() => expect(api.to("model_calls").length).toBeGreaterThan(before));
  });

  it("фильтр «Статус» идёт в адрес и в запрос и возвращает на первую страницу", async () => {
    const api = mockAnalytics();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
    await waitFor(() => expect(rowIds()[0]).toBe("sevt_21"));

    await userEvent.click(screen.getByRole("button", { name: "Статус: Все" }));
    await userEvent.click(screen.getByRole("option", { name: "Ошибка" }));
    await waitFor(() => expect(location()).toBe(`${ROUTE}?status=error`));
    await waitFor(() => expect(api.last("model_calls").searchParams.get("status")).toBe("error"));
    expect(api.last("model_calls").searchParams.has("cursor")).toBe(false);
    await waitFor(() => expect(rowIds()[0]).toBe("sevt_01"));
    expect(screen.getByRole("button", { name: "Сбросить" })).toBeInTheDocument();
  });

  it("фильтр по сессии виден чипом, крестик его снимает", async () => {
    const api = mockAnalytics();
    await ready(`${ROUTE}?session_id=sesn_01`);
    expect(api.last("model_calls").searchParams.get("session_id")).toBe("sesn_01");
    expect(screen.getByText("Сессия: sesn_01")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Убрать фильтр по сессии" }));
    await waitFor(() => expect(location()).toBe(ROUTE));
    expect(screen.queryByText("Сессия: sesn_01")).toBeNull();
  });

  it("клик по строке открывает карточку записи и пишет ?request=", async () => {
    const api = mockAnalytics();
    await ready();
    await userEvent.click(within(row("sevt_03")).getByText("verify-agent"));

    await waitFor(() => expect(location()).toBe(`${ROUTE}?request=sevt_03`));
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    expect(card).toHaveAttribute("aria-modal", "false");
    expect(within(card).getByText("sevt_03")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: "verify-fake" })).toBeInTheDocument();
    expect(row("sevt_03")).toHaveAttribute("aria-selected", "true");
    // Запись есть на странице: отдельный запрос за ней не нужен.
    expect(api.to("model_calls/sevt_03")).toHaveLength(0);
  });

  it("карточка записи: пары «подпись, значение»", async () => {
    mockAnalytics();
    renderLogs(`${ROUTE}?request=sevt_03`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    await within(card).findByText("msg_03");
    const pair = (label: string) => {
      const term = within(card).getByText(label, { selector: "dt" });
      return plain(term.nextElementSibling?.textContent ?? "");
    };
    expect(pair("Модель")).toContain("verify-fake");
    expect(pair("Модель")).toContain("claude-sonnet-4-6");
    expect(pair("Карточка")).toBe("verify-fake");
    expect(pair("Harness")).toBe("Встроенный цикл");
    expect(pair("Агент")).toBe("verify-agent");
    expect(within(card).getByRole("link", { name: "verify-agent" })).toHaveAttribute("href", "/agents/agent_01");
    expect(within(card).getByRole("link", { name: "Открыть сессию" })).toHaveAttribute("href", "/sessions/sesn_01");
    expect(pair("Окружение")).toBe("env_01");
    expect(pair("Скорость")).toBe("Обычная");
    expect(pair("Усилие")).toBe("high");
    expect(pair("Задержка")).toBe("3,020 с");
    expect(pair("Причина остановки")).toBe("stop");
    expect(pair("ID ответа провайдера")).toBe("msg_03");
    expect(pair("Время")).toMatch(/16 окт\. 2026/);
  });

  it("секции токенов и стоимости", async () => {
    mockAnalytics();
    renderLogs(`${ROUTE}?request=sevt_03`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    await within(card).findByText("msg_03");
    const tokens = within(card).getByRole("region", { name: "Токены" });
    const pair = (scope: HTMLElement, label: string) =>
      plain(within(scope).getByText(label, { selector: "dt" }).nextElementSibling?.textContent ?? "");
    expect(pair(tokens, "Вход без кэша")).toBe("20");
    expect(pair(tokens, "Чтение кэша")).toBe("4");
    expect(pair(tokens, "Запись кэша")).toBe("2");
    expect(pair(tokens, "Выход")).toBe("10");
    const cost = within(card).getByRole("region", { name: "Стоимость" });
    expect(pair(cost, "Итого")).toBe("$0,0002");
    expect(pair(cost, "Вход")).toBe("$0,0001");
    expect(pair(cost, "Выход")).toBe("$0,0002");
    expect(within(cost).getByText("Цена из карточки")).toBeInTheDocument();
  });

  it("подсказки у задержки и входа без кэша", async () => {
    mockAnalytics();
    renderLogs(`${ROUTE}?request=sevt_03`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    await within(card).findByText("msg_03");
    expect(within(card).getByRole("button", { name: /Пояснение: Задержка/ })).toHaveAccessibleDescription(
      "Время от начала вызова модели до конца ответа по часам сервера.",
    );
    expect(within(card).getByRole("button", { name: /Пояснение: Вход без кэша/ })).toHaveAccessibleDescription(
      "Входные токены, которые не прочитаны из кэша и не записаны в него.",
    );
  });

  it("ошибка вызова, пустой usage и запись без цены", async () => {
    mockAnalytics({
      modelCalls: {
        data: [
          makeCall(1, {
            is_error: true,
            error_message: "Провайдер вернул 529",
            usage_reported: false,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_usd_micros: null,
            cost_parts_usd_micros: null,
            price_source: "none",
            effort: null,
            model_source: "builtin",
            card_id: null,
            latency_ms: null,
            started_at: null,
          }),
        ],
        next_cursor: null,
        latest_ended_at: null,
      },
    });
    renderLogs(`${ROUTE}?request=sevt_01`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    await within(card).findByText("Провайдер вернул 529");
    expect(card.querySelector(".callout-danger")).toHaveTextContent("Провайдер вернул 529");
    expect(within(card).getByText("Harness не прислал токены этого вызова.")).toBeInTheDocument();
    expect(within(card).getByText("Цена не задана")).toBeInTheDocument();
    const pair = (label: string) =>
      plain(within(card).getByText(label, { selector: "dt" }).nextElementSibling?.textContent ?? "");
    expect(pair("Карточка")).toBe("Ключ сервера");
    expect(pair("Усилие")).toBe("По умолчанию");
    expect(pair("Задержка")).toBe("нет");
  });

  it("цена из каталога Pi подписана отдельно", async () => {
    mockAnalytics({
      modelCalls: { data: [makeCall(1, { price_source: "catalog" })], next_cursor: null, latest_ended_at: null },
    });
    renderLogs(`${ROUTE}?request=sevt_01`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    expect(await within(card).findByText("Цена из каталога Pi")).toBeInTheDocument();
  });

  it("«Следующая» и «Предыдущая» двигаются по строкам страницы", async () => {
    mockAnalytics();
    await ready(`${ROUTE}?request=sevt_01`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    expect(within(card).getByRole("button", { name: "Предыдущая" })).toBeDisabled();
    await userEvent.click(within(card).getByRole("button", { name: "Следующая" }));
    await waitFor(() => expect(location()).toBe(`${ROUTE}?request=sevt_02`));
    expect(row("sevt_02")).toHaveAttribute("aria-selected", "true");
    expect(row("sevt_01")).toHaveAttribute("aria-selected", "false");
    await userEvent.click(within(card).getByRole("button", { name: "Предыдущая" }));
    await waitFor(() => expect(location()).toBe(`${ROUTE}?request=sevt_01`));
  });

  it("на последней строке страницы «Следующая» отключена", async () => {
    mockAnalytics();
    await ready(`${ROUTE}?request=sevt_20`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    expect(within(card).getByRole("button", { name: "Следующая" })).toBeDisabled();
  });

  it("Escape закрывает карточку, адрес чистый, фокус вернулся на строку", async () => {
    mockAnalytics();
    await ready();
    await userEvent.click(row("sevt_05"));
    await screen.findByRole("dialog", { name: "Запрос" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(location()).toBe(ROUTE);
    expect(row("sevt_05")).toHaveFocus();
  });

  it("записи нет на странице: карточка грузит её отдельным запросом", async () => {
    const api = mockAnalytics();
    renderLogs(`${ROUTE}?request=sevt_77`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    await within(card).findByText("msg_77");
    expect(api.to("model_calls/sevt_77")).toHaveLength(1);
    expect(within(card).getByRole("button", { name: "Предыдущая" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Следующая" })).toBeDisabled();
  });

  it("запись не найдена: карточка говорит об этом", async () => {
    mockAnalytics({ modelCall: () => errorResponse(404, "Запись журнала не найдена") });
    renderLogs(`${ROUTE}?request=sevt_99`);
    const card = await screen.findByRole("dialog", { name: "Запрос" });
    expect(await within(card).findByText("Запись журнала не найдена")).toBeInTheDocument();
  });

  it("копирование ID кладёт его в буфер и не открывает строку", async () => {
    mockAnalytics();
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    const user = userEvent.setup();
    await ready();
    await user.click(within(row("sevt_02")).getByRole("button", { name: "Скопировать sevt_02" }));
    expect(await navigator.clipboard.readText()).toBe("sevt_02");
    expect(success).toHaveBeenCalledWith("Скопировано");
    expect(location()).toBe(ROUTE);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("«Скачать CSV» просит format=csv с теми же фильтрами", async () => {
    const api = mockAnalytics();
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    let savedName = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      savedName = this.download;
    });
    await ready(`${ROUTE}?status=error&range=7d`);
    await userEvent.click(screen.getByRole("button", { name: "Скачать CSV" }));
    await waitFor(() => expect(savedName).toBe("analytics-model-calls-2026-09-17_2026-10-16.csv"));
    const csv = api.requests.find((r) => r.url.searchParams.get("format") === "csv");
    expect(csv?.url.searchParams.get("status")).toBe("error");
    expect(csv?.url.searchParams.get("from")).toBe("2026-10-10");
    expect(csv?.url.searchParams.has("cursor")).toBe(false);
  });

  it("пусто: подсказка вместо таблицы", async () => {
    mockAnalytics({ modelCalls: { data: [], next_cursor: null, latest_ended_at: null } });
    renderLogs();
    expect(await screen.findByText("За период нет вызовов модели. Запустите сессию агента.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("ошибка и 501", async () => {
    mockAnalytics({ modelCalls: () => errorResponse(500, "Не удалось получить аналитику.") });
    const first = renderLogs();
    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
    first.unmount();

    mockAnalytics({ modelCalls: () => errorResponse(501, "На MySQL аналитика не ведётся.") });
    renderLogs();
    expect(await screen.findByText("На этой базе данных аналитика не ведётся.")).toBeInTheDocument();
  });

  it("при загрузке 20 строк скелетона с настоящим заголовком", () => {
    mockAnalytics({ modelCalls: () => new Promise(() => {}) as unknown as Response });
    renderLogs();
    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("aria-busy", "true");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(10);
    expect(table.querySelectorAll('tbody [data-slot="skeleton"]').length).toBeGreaterThanOrEqual(20);
  });

  it("таблица в прокручиваемом контейнере, колонка ID закреплена слева", async () => {
    mockAnalytics();
    await ready();
    const table = screen.getByRole("table");
    expect(table.parentElement).toHaveClass("overflow-x-auto");
    expect(within(table).getAllByRole("columnheader")[0]).toHaveClass("sticky", "left-0");
    expect(within(row("sevt_01")).getByRole("rowheader")).toHaveClass("sticky", "left-0");
  });

  it("страница курсора совпадает с ответом сервера для второй страницы", () => {
    expect(modelCallsPage("p2").data[0].id).toBe("sevt_21");
    expect(modelCallsPage("p3").next_cursor).toBeNull();
  });
});
