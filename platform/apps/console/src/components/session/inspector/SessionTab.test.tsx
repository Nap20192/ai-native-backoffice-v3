import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutcomeView, SessionTotals } from "../../../lib/session-stats";
import { EMPTY_VALUE, formatEventDateTimeRu } from "../format-ru";

const api = vi.hoisted(() => ({ agents: { retrieve: vi.fn() } }));
vi.mock("../../../lib/useManagedApi", () => ({ useManagedApi: () => api }));

import * as sessionTabModule from "./SessionTab";
import { SessionTab, type SessionTabProps } from "./SessionTab";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  api.agents.retrieve.mockReset().mockResolvedValue({ created_at: "2026-10-15T11:39:27.000Z" });
});

const CREATED = Date.parse("2026-10-15T11:39:27.000Z");
const UPDATED = Date.parse("2026-10-16T01:42:10.000Z");

const session = {
  id: "sesn_01S5djPEW6yAoLr9mcr7RBiv",
  type: "session",
  title: null,
  status: "idle",
  archived_at: null,
  created_at: new Date(CREATED).toISOString(),
  updated_at: new Date(UPDATED).toISOString(),
  environment_id: "env_01ZXCVBNM",
  deployment_id: null,
  agent: { id: "agent_01ABCDEFGH", name: "Исследователь", version: 1, description: null, model: { id: "m1" } },
  // Сервер отдаёт бюджет и расход, вкладка их не рисует.
  budget: { type: "limit", max_list_cost: { amount: "500", currency: "USD" } },
  metadata: {},
  resources: [],
  vault_ids: [],
  outcome_evaluations: [],
  usage: { input_tokens: 76, output_tokens: 20_100, cache_read_input_tokens: 328_600 },
  stats: {},
} as unknown as SessionTabProps["session"];

const environment = {
  id: "env_01ZXCVBNM",
  name: "qwe",
  scope: "organization",
  config: { type: "cloud" },
  created_at: "2026-10-15T00:00:00.000Z",
} as unknown as SessionTabProps["environment"];

const totals: SessionTotals = {
  requestCount: 12,
  erroredRequestCount: 0,
  activeMs: 310_000,
  firstEventMs: CREATED,
  lastEventMs: UPDATED,
};

const outcome: OutcomeView = {
  outcomeId: "outc_1",
  eventId: "evt_outcome",
  description: "Отчёт с цитатами по источникам",
  rubric: { type: "text", content: "Каждая цитата с источником" },
  maxIterations: 3,
  definedAtMs: CREATED,
  evaluations: [
    {
      iteration: 0,
      result: "needs_revision",
      explanation: "Нет ссылок на источники.",
      startEventId: "s0",
      endEventId: "e0",
      startMs: null,
      atMs: UPDATED - 60_000,
    },
    {
      iteration: 2,
      result: "max_iterations_reached",
      explanation: "Три круга доработки не закрыли критерии.",
      startEventId: "s2",
      endEventId: "e2",
      startMs: null,
      atMs: UPDATED,
    },
  ],
};

function props(overrides: Partial<SessionTabProps> = {}): SessionTabProps {
  return {
    session,
    environment,
    vaults: [],
    status: "idle",
    totals,
    outcomes: [],
    ...overrides,
  };
}

function renderTab(overrides: Partial<SessionTabProps> = {}) {
  const p = props(overrides);
  const view = render(
    <MemoryRouter>
      <SessionTab {...p} />
    </MemoryRouter>,
  );
  return { ...view, props: p };
}

function row(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: "dt" });
  return term.parentElement as HTMLElement;
}

describe("SessionTab: свойства", () => {
  it("ID моноширинным шрифтом с копированием", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderTab();

    expect(within(row("ID")).getByTitle(session.id)).toHaveClass("font-mono");
    expect(within(row("ID")).getByTitle(session.id)).toHaveTextContent(session.id);
    await userEvent.click(within(row("ID")).getByRole("button", { name: "Копировать ID" }));
    expect(writeText).toHaveBeenCalledWith(session.id);
  });

  it("статус, даты создания и обновления с днём недели", () => {
    renderTab();

    expect(within(row("Статус")).getByText("Ожидает")).toBeInTheDocument();
    expect(within(row("Создана")).getByText(formatEventDateTimeRu(CREATED))).toBeInTheDocument();
    expect(within(row("Обновлена")).getByText(formatEventDateTimeRu(UPDATED))).toBeInTheDocument();
  });

  it("агент и окружение чипами со ссылками", () => {
    renderTab();

    expect(within(row("Агент")).getByRole("link", { name: /Исследователь/ })).toHaveAttribute(
      "href",
      "/agents/agent_01ABCDEFGH",
    );
    expect(within(row("Окружение")).getByRole("link", { name: /qwe/ })).toHaveAttribute(
      "href",
      "/environments/env_01ZXCVBNM",
    );
  });

  it("хранилища и деплоймент без значений дают прочерк", () => {
    renderTab();

    expect(within(row("Хранилища")).getByText(EMPTY_VALUE)).toBeInTheDocument();
    expect(within(row("Деплоймент")).getByText(EMPTY_VALUE)).toBeInTheDocument();
  });

  it("хранилища рисуются чипами, деплоймент идентификатором", () => {
    renderTab({
      vaults: [{ id: "vlt_1", name: "Ключи" }],
      session: { ...session, deployment_id: "dep_1" } as SessionTabProps["session"],
    });

    expect(within(row("Хранилища")).getByRole("link", { name: /Ключи/ })).toHaveAttribute("href", "/vaults/vlt_1");
    expect(within(row("Деплоймент")).getByText("dep_1")).toHaveClass("font-mono");
  });

  it("строки «Источник» от страницы встают в таблицу свойств", () => {
    renderTab({
      sources: (
        <div>
          <dt>Источник</dt>
          <dd>Linear, задача ABC-1</dd>
        </div>
      ),
    });

    expect(within(row("Источник")).getByText("Linear, задача ABC-1")).toBeInTheDocument();
  });
});

describe("SessionTab: результат", () => {
  it("без результата раздела нет", () => {
    renderTab();

    expect(screen.queryByRole("heading", { name: "Результат" })).toBeNull();
  });

  it("показывает итог, номер итерации с единицы, время, описание и пояснение", () => {
    renderTab({ outcomes: [outcome] });

    expect(screen.getByRole("heading", { name: "Результат" })).toBeInTheDocument();
    expect(within(row("Итог")).getByText("Итерации исчерпаны")).toBeInTheDocument();
    expect(within(row("Итерация")).getByText("3")).toBeInTheDocument();
    expect(within(row("Завершено")).getByText(formatEventDateTimeRu(UPDATED))).toBeInTheDocument();
    expect(within(row("Описание")).getByText("Отчёт с цитатами по источникам")).toBeInTheDocument();
    expect(within(row("Пояснение")).getByText("Три круга доработки не закрыли критерии.")).toBeInTheDocument();
  });

  it.each([
    ["satisfied", "Выполнено"],
    ["needs_revision", "Нужна доработка"],
    ["max_iterations_reached", "Итерации исчерпаны"],
    ["failed", "Оценка не удалась"],
    ["interrupted", "Прервано"],
  ])("итог %s называется «%s»", (result, label) => {
    renderTab({
      outcomes: [{ ...outcome, evaluations: [{ ...outcome.evaluations[1]!, result }] }],
    });

    expect(within(row("Итог")).getByText(label)).toBeInTheDocument();
  });

  it("результат без оценок: итог «Идёт оценка», итерации и разбора нет", () => {
    renderTab({ outcomes: [{ ...outcome, evaluations: [] }] });

    expect(within(row("Итог")).getByText("Ожидает оценки")).toBeInTheDocument();
    expect(screen.queryByText("Итерация", { selector: "dt" })).toBeNull();
    expect(screen.queryByText("Пояснение", { selector: "dt" })).toBeNull();
    expect(within(row("Описание")).getByText("Отчёт с цитатами по источникам")).toBeInTheDocument();
  });

  it("если события ещё не пришли, берёт итог из снимка сессии", () => {
    renderTab({
      session: {
        ...session,
        outcome_evaluations: [
          {
            type: "outcome_evaluation",
            outcome_id: "outc_9",
            description: "Из снимка",
            result: "satisfied",
            iteration: 1,
            explanation: "Все критерии закрыты.",
            completed_at: new Date(UPDATED).toISOString(),
          },
        ],
      } as unknown as SessionTabProps["session"],
    });

    expect(within(row("Итог")).getByText("Выполнено")).toBeInTheDocument();
    expect(within(row("Итерация")).getByText("2")).toBeInTheDocument();
    expect(within(row("Описание")).getByText("Из снимка")).toBeInTheDocument();
  });
});

describe("SessionTab: без токенов, стоимости и бюджета", () => {
  it("раздела «Стоимость», графика и кнопки бюджета нет, хотя сессия несёт бюджет", () => {
    const { container } = renderTab();

    expect(screen.queryByRole("region", { name: "Стоимость" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Стоимость" })).toBeNull();
    expect(screen.queryByRole("img", { name: "График стоимости" })).toBeNull();
    expect(container.querySelector("[data-chart-plot]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить бюджет" })).toBeNull();
    expect(container).not.toHaveTextContent(/токен|стоимост|бюджет|нет цены|кэш|\$/i);
  });

  it("график по времени убран из модуля, он рисовал только стоимость и контекст в токенах", () => {
    for (const name of ["TimeChart", "niceCeil", "niceTimeTicks"]) {
      expect(sessionTabModule).not.toHaveProperty(name);
    }
  });
});

describe("SessionTab: использование и метаданные", () => {
  it("таблица «Итого по сессии» держит только активное время", () => {
    renderTab();

    const table = screen.getByRole("table", { name: "Использование" });
    expect(within(table).getByRole("columnheader", { name: "Итого по сессии" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getAllByRole("cell")[0]).toHaveTextContent("Активное время");
    expect(within(rows[1]!).getAllByRole("cell")[1]).toHaveTextContent("5 мин 10 с");
  });

  it("нулевое активное время даёт прочерк, а не «<1 мс»", () => {
    renderTab({ totals: { ...totals, activeMs: 0 } });

    const table = screen.getByRole("table", { name: "Использование" });
    const cells = within(within(table).getByRole("row", { name: /^Активное время/ })).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent(EMPTY_VALUE);
  });

  it("метаданные: ключ моноширинным, значение рядом", () => {
    renderTab({
      session: { ...session, metadata: { console_quickstart: "v2" } } as unknown as SessionTabProps["session"],
    });

    expect(screen.getByRole("heading", { name: "Метаданные" })).toBeInTheDocument();
    expect(screen.getByText("console_quickstart")).toHaveClass("font-mono");
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("без метаданных раздела нет, ключи linear и slack уходят в «Источник»", () => {
    const { rerender, props: p } = renderTab();
    expect(screen.queryByRole("heading", { name: "Метаданные" })).toBeNull();

    rerender(
      <MemoryRouter>
        <SessionTab
          {...p}
          sources={<div><dt>Источник</dt><dd>Slack</dd></div>}
          session={{ ...session, metadata: { slack: "{}", linear: "{}" } } as unknown as SessionTabProps["session"]}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("heading", { name: "Метаданные" })).toBeNull();
  });
});
