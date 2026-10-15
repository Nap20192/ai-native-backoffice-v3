import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LimitsPage } from "./LimitsPage";
import {
  errorResponse,
  freezeNow,
  limitDetail,
  limitsReport,
  mockAnalytics,
  renderAnalyticsPage,
} from "./analytics-fixtures";

const ROUTE = "/analytics/limits";

beforeEach(() => freezeNow());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const renderLimits = (route = ROUTE) => renderAnalyticsPage(<LimitsPage />, route);
const location = () => screen.getByTestId("location").textContent;
const plain = (value: string | null) => (value ?? "").replace(/[  ]/g, " ");

async function ready(route = ROUTE) {
  const view = renderLimits(route);
  await screen.findByText("Claude Sonnet 4.6");
  return view;
}

const row = (id: string) => document.querySelector(`[data-row-id="${id}"]`) as HTMLElement;

describe("LimitsPage", () => {
  it("шапка и заголовки таблицы", async () => {
    mockAnalytics();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "Лимиты" })).toBeInTheDocument();
    expect(screen.getByText(/Платформа не останавливает вызовы при превышении/)).toBeInTheDocument();
    const table = screen.getByRole("table");
    const head = within(table).getAllByRole("columnheader").map((h) => h.textContent ?? "");
    expect(head[0]).toBe("Квота");
    expect(head[1]).toMatch(/^Пиковая загрузка/);
    expect(head[2]).toBe("Использовано / лимит");
    expect(within(table).getByRole("button", { name: /Пояснение: Пиковая загрузка/ })).toHaveAccessibleDescription(
      "Наибольшая загрузка одной минуты за 24 часа, делённая на лимит карточки.",
    );
  });

  it("группа карточки: название модели, handle и три строки квот", async () => {
    mockAnalytics();
    await ready();
    expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    expect(screen.getByText("verify-fake")).toBeInTheDocument();
    for (const label of [
      "Токены на входе в минуту (без чтения кэша)",
      "Токены на выходе в минуту",
      "Запросы в минуту",
    ]) {
      expect(within(row("mc_01:" + (label.startsWith("Токены на входе") ? "itpm" : label.startsWith("Токены на выходе") ? "otpm" : "rpm"))).getByText(label)).toBeInTheDocument();
    }
  });

  it("строка с лимитом: индикатор, процент и «использовано / лимит»", async () => {
    mockAnalytics();
    await ready();
    const itpm = row("mc_01:itpm");
    const meter = within(itpm).getByRole("meter", { name: /Claude Sonnet 4\.6.*пиковая загрузка/ });
    expect(meter).toHaveAttribute("aria-valuenow", "4");
    expect(plain(itpm.textContent)).toContain("4 %");
    expect(plain(itpm.textContent)).toContain("1,2 тыс. / 30 тыс.");
    const otpm = row("mc_01:otpm");
    expect(plain(otpm.textContent)).toContain("300 / 8 тыс.");
  });

  it("без лимита индикатора нет, а справа «не задан»", async () => {
    mockAnalytics();
    await ready();
    const rpm = row("mc_01:rpm");
    expect(within(rpm).queryByRole("meter")).toBeNull();
    expect(plain(rpm.textContent)).toContain("3 / не задан");
  });

  it("группа «Без карточки»: строки без индикатора и без перехода", async () => {
    mockAnalytics();
    await ready();
    expect(screen.getByText("Без карточки")).toBeInTheDocument();
    expect(screen.getByText("Claude Haiku 4.5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Пояснение: Без карточки/ })).toHaveAccessibleDescription(
      "Лимит задаётся в карточке модели, у встроенной модели карточки нет.",
    );
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("meter")).toHaveLength(2);
    const haikuRow = within(table).getByText("Токены на входе в минуту (без чтения кэша)", {
      selector: "[data-uncarded] *",
    });
    await userEvent.click(haikuRow);
    expect(location()).toBe(ROUTE);
  });

  it("поиск фильтрует сразу, пишет ?q= и показывает «Сбросить»", async () => {
    mockAnalytics();
    await ready();
    await userEvent.type(screen.getByRole("searchbox", { name: "Найти квоту" }), "haiku");
    await waitFor(() => expect(location()).toBe(`${ROUTE}?q=haiku`));
    expect(screen.queryByText("Claude Sonnet 4.6")).toBeNull();
    expect(screen.getByText("Claude Haiku 4.5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сбросить" })).toBeInTheDocument();
  });

  it("поиск по названию квоты оставляет только подходящие строки каждой группы", async () => {
    mockAnalytics();
    await ready(`${ROUTE}?q=запросы`);
    expect(within(screen.getByRole("table")).getAllByText("Запросы в минуту")).toHaveLength(3);
    expect(screen.queryByText("Токены на выходе в минуту")).toBeNull();
  });

  it("пустой поиск: «Квоты по запросу не найдены.»", async () => {
    mockAnalytics();
    renderLimits(`${ROUTE}?q=zzz`);
    expect(await screen.findByText("Квоты по запросу не найдены.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    await waitFor(() => expect(location()).toBe(ROUTE));
    expect(await screen.findByText("Claude Sonnet 4.6")).toBeInTheDocument();
  });

  it("нет карточек и вызовов: подсказка и ссылка на карточки моделей", async () => {
    mockAnalytics({ limits: { ...limitsReport(), cards: [], uncarded: [] } });
    renderLimits();
    expect(
      await screen.findByText("Карточек моделей нет. Добавьте карточку, чтобы задать лимиты."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /карточки моделей/i })).toHaveAttribute("href", "/model-cards");
  });

  it("клик по строке карточки открывает правую панель квоты и пишет ?focus=", async () => {
    const api = mockAnalytics();
    await ready();
    await userEvent.click(row("mc_01:itpm"));

    await waitFor(() => expect(location()).toBe(`${ROUTE}?focus=mc_01%3Aitpm`));
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    expect(drawer).toHaveAttribute("aria-modal", "false");
    expect(within(drawer).getByRole("heading", { name: /Claude Sonnet 4\.6/ })).toBeInTheDocument();
    expect(within(drawer).getByText("Токены на входе в минуту (без чтения кэша)")).toBeInTheDocument();
    await within(drawer).findByText("Разбивка на момент пика");
    const params = api.last("limits/mc_01").searchParams;
    expect(params.get("metric")).toBe("itpm");
    expect(params.get("by")).toBe("agent");
    expect(row("mc_01:itpm")).toHaveAttribute("aria-selected", "true");
  });

  it("панель открывается по ссылке с ?focus= сразу", async () => {
    mockAnalytics();
    renderLimits(`${ROUTE}?focus=mc_01:otpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    expect(within(drawer).getByText("Токены на выходе в минуту")).toBeInTheDocument();
  });

  it("блоки панели: лимит, пик за 24 часа, семь дней и разбивка", async () => {
    mockAnalytics();
    renderLimits(`${ROUTE}?focus=mc_01:itpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");

    expect(within(drawer).getByText("Лимит карточки")).toBeInTheDocument();
    expect(plain(within(drawer).getByTestId("limit-value").textContent)).toBe("30 000 токенов в минуту");
    expect(within(drawer).getByText("Пик за 24 часа")).toBeInTheDocument();
    expect(plain(within(drawer).getByTestId("peak-value").textContent)).toContain("1,2 тыс. / 30 тыс. токенов в минуту");
    expect(plain(within(drawer).getByTestId("peak-value").textContent)).toContain("4 %");
    expect(within(drawer).getByRole("meter")).toHaveAttribute("aria-valuenow", "4");

    expect(within(drawer).getByText("Последние 7 дней")).toBeInTheDocument();
    expect(within(drawer).getByRole("img", { name: "Пик загрузки по часам" })).toBeInTheDocument();

    const breakdown = within(drawer).getByRole("table", { name: "Разбивка на момент пика" });
    expect(within(breakdown).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Агент",
      "Пик",
      "% лимита",
      "Доля",
    ]);
    const rows = within(breakdown).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual([
      "verify-agent",
      "reviewer",
      "Итого",
    ]);
    expect(within(rows[0]).getAllByRole("cell").map((c) => plain(c.textContent))).toEqual(["900", "3 %", "75 %"]);
    expect(within(rows[2]).getAllByRole("cell").map((c) => plain(c.textContent))).toEqual(["1 200", "4 %", "100 %"]);
  });

  it("таблица последних семи дней: время, пик и лимит", async () => {
    mockAnalytics();
    renderLimits(`${ROUTE}?focus=mc_01:itpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");
    await userEvent.click(within(drawer).getByRole("button", { name: "Таблица" }));
    const table = within(drawer).getByRole("table", { name: "Пик загрузки по часам" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Время (UTC)",
      "Пик",
      "Лимит",
    ]);
    expect(within(table).getAllByRole("row")).toHaveLength(169);
  });

  it("переключатель «По сессиям» просит by=session и меняет колонку", async () => {
    const api = mockAnalytics();
    renderLimits(`${ROUTE}?focus=mc_01:itpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");
    await userEvent.click(within(drawer).getByRole("button", { name: "По сессиям" }));
    await waitFor(() => expect(api.last("limits/mc_01").searchParams.get("by")).toBe("session"));
    const breakdown = await within(drawer).findByRole("table", { name: "Разбивка на момент пика" });
    await waitFor(() =>
      expect(within(breakdown).getAllByRole("columnheader")[0]).toHaveTextContent("Сессия"),
    );
    expect(within(breakdown).getByRole("link", { name: "sesn_01" })).toHaveAttribute("href", "/sessions/sesn_01");
  });

  it("«Изменить» открывает форму с текущими лимитами, «Сохранить» шлёт PUT", async () => {
    const api = mockAnalytics();
    const success = vi.spyOn(toast, "success").mockImplementation(() => "");
    renderLimits(`${ROUTE}?focus=mc_01:itpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");
    const before = api.to("limits").length;

    await userEvent.click(within(drawer).getByRole("button", { name: "Изменить" }));
    const requests = within(drawer).getByLabelText("Запросов в минуту");
    const input = within(drawer).getByLabelText("Токенов на входе в минуту");
    const output = within(drawer).getByLabelText("Токенов на выходе в минуту");
    expect(requests).toHaveValue("");
    expect(input).toHaveValue("30000");
    expect(output).toHaveValue("8000");

    await userEvent.type(requests, "50");
    await userEvent.clear(output);
    await userEvent.click(within(drawer).getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(api.requests.some((r) => r.method === "PUT")).toBe(true));
    const put = api.requests.find((r) => r.method === "PUT");
    expect(put?.url.pathname).toBe("/v1/oma/analytics/limits/mc_01");
    expect(put?.body).toEqual({
      requests_per_minute: 50,
      input_tokens_per_minute: 30000,
      output_tokens_per_minute: null,
    });
    await waitFor(() => expect(success).toHaveBeenCalledWith("Лимиты сохранены"));
    await waitFor(() => expect(api.to("limits").length).toBeGreaterThan(before));
    await waitFor(() => expect(within(drawer).queryByLabelText("Запросов в минуту")).toBeNull());
  });

  it("неверное значение не уходит на сервер, а текст ошибки по-русски", async () => {
    const api = mockAnalytics();
    renderLimits(`${ROUTE}?focus=mc_01:itpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");
    await userEvent.click(within(drawer).getByRole("button", { name: "Изменить" }));
    await userEvent.type(within(drawer).getByLabelText("Запросов в минуту"), "0");
    await userEvent.click(within(drawer).getByRole("button", { name: "Сохранить" }));

    expect(await within(drawer).findByRole("alert")).toHaveTextContent(
      "Лимит запросов в минуту: целое число от 1 до 1 000 000 000 или пусто.",
    );
    expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("«Отмена» закрывает форму без запроса", async () => {
    const api = mockAnalytics();
    renderLimits(`${ROUTE}?focus=mc_01:itpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");
    await userEvent.click(within(drawer).getByRole("button", { name: "Изменить" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "Отмена" }));
    expect(within(drawer).queryByLabelText("Запросов в минуту")).toBeNull();
    expect(api.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("ответ 400 сервера показан в форме", async () => {
    mockAnalytics({
      putLimits: () => errorResponse(400, "Лимит токенов на входе в минуту: целое число от 1 до 1 000 000 000 или пусто."),
    });
    renderLimits(`${ROUTE}?focus=mc_01:itpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");
    await userEvent.click(within(drawer).getByRole("button", { name: "Изменить" }));
    await userEvent.click(within(drawer).getByRole("button", { name: "Сохранить" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent(/Лимит токенов на входе в минуту/);
  });

  it("«Следующая» и «Предыдущая» переходят к соседней квоте списка", async () => {
    const api = mockAnalytics();
    renderLimits(`${ROUTE}?focus=mc_01:rpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");
    await userEvent.click(within(drawer).getByRole("button", { name: "Следующая" }));
    await waitFor(() => expect(location()).toBe(`${ROUTE}?focus=mc_02%3Aitpm`));
    await waitFor(() => expect(api.last("limits/mc_02")).toBeDefined());
    expect(within(drawer).getByRole("heading", { name: /GPT X/ })).toBeInTheDocument();
    await userEvent.click(within(drawer).getByRole("button", { name: "Предыдущая" }));
    await waitFor(() => expect(location()).toBe(`${ROUTE}?focus=mc_01%3Arpm`));
  });

  it("на краях списка кнопки соседних квот отключены", async () => {
    mockAnalytics();
    renderLimits(`${ROUTE}?focus=mc_01:itpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    expect(within(drawer).getByRole("button", { name: "Предыдущая" })).toBeDisabled();
  });

  it("Escape закрывает панель, адрес чистый, фокус вернулся на строку", async () => {
    mockAnalytics();
    await ready();
    const target = row("mc_01:otpm");
    await userEvent.click(target);
    await screen.findByRole("dialog", { name: "Лимит" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(location()).toBe(ROUTE);
    expect(row("mc_01:otpm")).toHaveFocus();
  });

  it("Enter на строке открывает панель с клавиатуры", async () => {
    mockAnalytics();
    await ready();
    row("mc_01:itpm").focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Лимит" })).toBeInTheDocument();
  });

  it("ошибка и 501", async () => {
    mockAnalytics({ limits: () => errorResponse(500, "Не удалось получить аналитику.") });
    const first = renderLimits();
    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
    first.unmount();

    mockAnalytics({ limits: () => errorResponse(501, "На MySQL аналитика не ведётся.") });
    renderLimits();
    expect(await screen.findByText("На этой базе данных аналитика не ведётся.")).toBeInTheDocument();
  });

  it("при загрузке строк нет, показаны скелетоны", () => {
    mockAnalytics({ limits: () => new Promise(() => {}) as unknown as Response });
    renderLimits();
    expect(screen.getByTestId("limits-loading")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("таблица лежит в прокручиваемом контейнере, первая колонка закреплена", async () => {
    mockAnalytics();
    await ready();
    const table = screen.getByRole("table");
    expect(table.parentElement).toHaveClass("overflow-x-auto");
    expect(within(table).getAllByRole("columnheader")[0]).toHaveClass("sticky", "left-0");
  });

  it("ответ детали берётся для выбранной метрики: otpm даёт лимит 8 000", async () => {
    mockAnalytics({ limitDetail: (url) => limitDetail((url.searchParams.get("metric") as "otpm") ?? "itpm") });
    renderLimits(`${ROUTE}?focus=mc_01:otpm`);
    const drawer = await screen.findByRole("dialog", { name: "Лимит" });
    await within(drawer).findByText("Разбивка на момент пика");
    expect(plain(within(drawer).getByTestId("limit-value").textContent)).toBe("8 000 токенов в минуту");
  });
});
