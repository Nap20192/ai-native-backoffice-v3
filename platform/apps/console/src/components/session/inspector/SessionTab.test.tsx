import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutcomeView, SessionTotals } from "../../../lib/session-stats";
import { EMPTY_VALUE, formatEventDateTimeRu } from "../format-ru";
import type { SessionCost } from "../useSessionCost";

const api = vi.hoisted(() => ({ agents: { retrieve: vi.fn() } }));
vi.mock("../../../lib/useManagedApi", () => ({ useManagedApi: () => api }));

import {
  SessionTab,
  TimeChart,
  niceCeil,
  niceTimeTicks,
  type SessionTabProps,
} from "./SessionTab";

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
  budget: null,
  metadata: {},
  resources: [],
  vault_ids: [],
  outcome_evaluations: [],
  usage: {},
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
  usage: { input: 76, output: 20_100, cacheRead: 328_600, cacheWrite: 82_400 },
  requestCount: 12,
  erroredRequestCount: 0,
  evaluationUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  activeMs: 310_000,
  firstEventMs: CREATED,
  lastEventMs: UPDATED,
};

const cost: SessionCost = {
  source: "card",
  totalMicros: 890_000,
  budgetCents: 500,
  series: null,
  priceForModel: () => null,
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
      atMs: UPDATED - 60_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      iteration: 2,
      result: "max_iterations_reached",
      explanation: "Три круга доработки не закрыли критерии.",
      startEventId: "s2",
      endEventId: "e2",
      atMs: UPDATED,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
    cost,
    onEditBudget: vi.fn(),
    onHoverTime: vi.fn(),
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

describe("SessionTab: стоимость", () => {
  it("рисует расход и бюджет, карандаш открывает правку бюджета", async () => {
    const { props: p } = renderTab();

    const section = screen.getByRole("region", { name: "Стоимость" });
    expect(within(section).getByText("$0,89")).toBeInTheDocument();
    expect(within(section).getByText("/ $5,00")).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Изменить бюджет" }));
    expect(p.onEditBudget).toHaveBeenCalledOnce();
  });

  it("без цены пишет «нет цены» и объясняет, что графика не будет", () => {
    renderTab({ cost: { ...cost, source: "none", totalMicros: null } });

    const section = screen.getByRole("region", { name: "Стоимость" });
    expect(within(section).getByText("нет цены")).toBeInTheDocument();
    expect(within(section).getByText(/график не построить/)).toBeInTheDocument();
    expect(within(section).queryByRole("img")).toBeNull();
  });

  it("с рядом рисует график с подписями осей и точкой на конце", () => {
    const series = [
      { atMs: CREATED + 3_600_000, eventId: "a", stepMicros: 300_000, cumulativeMicros: 300_000 },
      { atMs: CREATED + 7_200_000, eventId: "b", stepMicros: 590_000, cumulativeMicros: 890_000 },
    ];
    const { container } = renderTab({ cost: { ...cost, series } });

    const chart = screen.getByRole("img", { name: "График стоимости" });
    expect(chart).toBeInTheDocument();
    for (const label of ["$0", "$0,50", "$1,00"]) expect(within(chart).getByText(label)).toBeInTheDocument();
    expect(container.querySelector("[data-chart-end]")).not.toBeNull();
  });
});

describe("SessionTab: использование и метаданные", () => {
  it("таблица «Итого по сессии» с токенами и активным временем", () => {
    renderTab();

    const table = screen.getByRole("table", { name: "Использование" });
    expect(within(table).getByRole("columnheader", { name: "Итого по сессии" })).toBeInTheDocument();
    const cells = (label: string) =>
      within(within(table).getByRole("row", { name: new RegExp(`^${label}`) })).getAllByRole("cell");
    expect(cells("Входные токены")[1]).toHaveTextContent("76");
    expect(cells("Выходные токены")[1]).toHaveTextContent("20,1 тыс.");
    expect(cells("Чтение кэша")[1]).toHaveTextContent("328,6 тыс.");
    expect(cells("Запись кэша")[1]).toHaveTextContent("82,4 тыс.");
    expect(cells("Активное время")[1]).toHaveTextContent("5 мин 10 с");
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

describe("TimeChart", () => {
  const stubRect = (width: number) =>
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: width,
      bottom: 100,
      width,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

  const start = new Date(2026, 9, 15, 12, 0, 0).getTime();
  const end = new Date(2026, 9, 16, 0, 0, 0).getTime();

  it("метки времени идут через три часа, полночь подписана датой", () => {
    render(
      <TimeChart
        label="График"
        points={[{ atMs: start + 3_600_000, value: 5 }]}
        startMs={start}
        endMs={end}
        formatValue={(value) => String(value)}
      />,
    );

    for (const label of ["12:00", "15:00", "18:00", "21:00", "16 окт."]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("наведение показывает курсор и подсказку по последней точке слева и сообщает время", () => {
    stubRect(200);
    const onHoverTime = vi.fn();
    const { container } = render(
      <TimeChart
        label="График"
        points={[
          { atMs: start + 3_600_000, value: 2 },
          { atMs: start + 7_200_000, value: 8 },
        ]}
        startMs={start}
        endMs={end}
        formatValue={(value) => `v${value}`}
        renderTooltip={(point) => <span>значение {point.value}</span>}
        onHoverTime={onHoverTime}
      />,
    );

    const plot = container.querySelector("[data-chart-plot]") as HTMLElement;
    // Ширина 200 px на 12 часов: курсор в 100 px это шесть часов, последняя точка слева уже вторая.
    fireEvent.pointerMove(plot, { clientX: 100 });

    expect(onHoverTime).toHaveBeenLastCalledWith(start + 6 * 3_600_000);
    expect(screen.getByText("значение 8")).toBeInTheDocument();
    expect(container.querySelector("[data-chart-cursor]")).not.toBeNull();

    fireEvent.pointerLeave(plot);
    expect(onHoverTime).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText("значение 8")).toBeNull();
    expect(container.querySelector("[data-chart-cursor]")).toBeNull();
  });

  it("до первой точки подсказки нет", () => {
    stubRect(200);
    const { container } = render(
      <TimeChart
        label="График"
        points={[{ atMs: start + 6 * 3_600_000, value: 3 }]}
        startMs={start}
        endMs={end}
        formatValue={String}
        renderTooltip={(point) => <span>значение {point.value}</span>}
      />,
    );

    fireEvent.pointerMove(container.querySelector("[data-chart-plot]") as HTMLElement, { clientX: 20 });

    expect(screen.queryByText(/значение/)).toBeNull();
    expect(container.querySelector("[data-chart-cursor]")).not.toBeNull();
  });
});

describe("niceCeil и niceTimeTicks", () => {
  it("округляют вверх до 1, 2, 2,5, 5 и 10 на порядок", () => {
    expect(niceCeil(890_000)).toBe(1_000_000);
    expect(niceCeil(26_900)).toBe(50_000);
    expect(niceCeil(0.3)).toBeCloseTo(0.5);
    expect(niceCeil(0)).toBe(1);
  });

  it("метки времени не выходят за границы", () => {
    const start = new Date(2026, 9, 15, 12, 0, 0).getTime();
    const end = new Date(2026, 9, 16, 0, 0, 0).getTime();
    const ticks = niceTimeTicks(start, end);

    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(6);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(start);
      expect(tick).toBeLessThanOrEqual(end);
    }
  });
});
