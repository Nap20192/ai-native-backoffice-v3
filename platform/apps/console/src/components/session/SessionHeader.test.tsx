import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionTotals } from "../../lib/session-stats";
import { formatEventDateTimeRu } from "./format-ru";

const api = vi.hoisted(() => ({
  agents: { retrieve: vi.fn() },
}));

vi.mock("../../lib/useManagedApi", () => ({ useManagedApi: () => api }));

import { SessionHeader, type SessionHeaderProps } from "./SessionHeader";
import type { SessionCost } from "./useSessionCost";

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

const NOW = Date.parse("2026-10-16T02:00:00.000Z");
const CREATED = Date.parse("2026-10-15T11:39:27.000Z");
const LAST = Date.parse("2026-10-16T01:41:27.000Z");

const session = {
  id: "sesn_01S5djPEW6yAoLr9mcr7RBiv",
  type: "session",
  title: "Исследование реакторов",
  status: "idle",
  archived_at: null,
  created_at: new Date(CREATED).toISOString(),
  updated_at: new Date(LAST).toISOString(),
  environment_id: "env_01ZXCVBNM",
  agent: {
    id: "agent_01ABCDEFGH",
    name: "Глубокий исследователь",
    version: 1,
    description: null,
    model: { id: "claude-opus-5" },
  },
  budget: null,
  metadata: {},
  resources: [],
  vault_ids: [],
  outcome_evaluations: [],
  usage: {},
  stats: {},
} as unknown as NonNullable<SessionHeaderProps["session"]>;

const environment = {
  id: "env_01ZXCVBNM",
  name: "qwe",
  scope: "organization",
  config: { type: "cloud" },
  created_at: new Date(CREATED).toISOString(),
} as unknown as NonNullable<SessionHeaderProps["environment"]>;

const totals: SessionTotals = {
  usage: { input: 76, output: 20_100, cacheRead: 328_600, cacheWrite: 82_400 },
  requestCount: 12,
  erroredRequestCount: 0,
  evaluationUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  activeMs: 310_000,
  firstEventMs: CREATED,
  lastEventMs: LAST,
};

const cost: SessionCost = {
  source: "card",
  totalMicros: 890_000,
  budgetCents: 500,
  series: null,
  priceForModel: () => null,
};

function props(overrides: Partial<SessionHeaderProps> = {}): SessionHeaderProps {
  return {
    session,
    environment,
    status: "idle",
    totals,
    cost,
    lastActivityMs: LAST,
    onRename: vi.fn().mockResolvedValue(undefined),
    onInterrupt: vi.fn(),
    onDefineOutcome: vi.fn(),
    onEditBudget: vi.fn(),
    onArchive: vi.fn(),
    onCopyEvents: vi.fn(),
    onDownloadEvents: vi.fn(),
    onShowTrajectory: vi.fn(),
    onShowShortcuts: vi.fn(),
    ...overrides,
  };
}

function renderHeader(overrides: Partial<SessionHeaderProps> = {}) {
  const p = props(overrides);
  const view = render(
    <MemoryRouter>
      <SessionHeader {...p} />
    </MemoryRouter>,
  );
  return { ...view, props: p };
}

/** Кнопка внутри заголовка: подпись совпадает с видимым названием. */
function titleButton() {
  return within(screen.getByRole("heading", { level: 1 })).getByRole("button");
}

beforeEach(() => {
  api.agents.retrieve.mockReset().mockResolvedValue({ id: "agent_01ABCDEFGH", created_at: session.created_at });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SessionHeader: загрузка", () => {
  it("пока сессия не пришла, рисует скелетон с подписью для диктора", () => {
    renderHeader({ session: null });

    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Загрузка сессии…");
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("SessionHeader: строка с ID", () => {
  it("показывает ID моноширинным шрифтом", () => {
    renderHeader();

    const id = screen.getByText(session.id, { selector: "span" });
    expect(id).toHaveClass("font-mono");
  });

  it("кнопка копирует ID в буфер обмена", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderHeader();

    await userEvent.click(screen.getByRole("button", { name: "Копировать ID сессии" }));

    expect(writeText).toHaveBeenCalledWith(session.id);
  });
});

describe("SessionHeader: название и статус", () => {
  it("рисует название заголовком и плашку статуса", () => {
    renderHeader({ status: "running" });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Исследование реакторов");
    expect(screen.getByText("Выполняется")).toBeInTheDocument();
  });

  it("пустое название заменяет ID", () => {
    renderHeader({ session: { ...session, title: null } });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(session.id);
  });

  it("рамка наведения выходит за заголовок на отступ и не режет текст многоточием", () => {
    renderHeader({ session: { ...session, title: null } });

    // -mx-2 расширяет кнопку на 1rem, max-w-full обрезал бы последние символы ID.
    expect(titleButton()).toHaveClass("-mx-2", "max-w-[calc(100%+1rem)]");
    expect(titleButton()).not.toHaveClass("max-w-full");
  });

  it("клик превращает заголовок в поле с кнопками «Сохранить» и «Отмена»", async () => {
    renderHeader();

    await userEvent.click(titleButton());

    const field = screen.getByRole("textbox", { name: "Название сессии" });
    expect(field).toHaveValue("Исследование реакторов");
    expect(field).toHaveFocus();
    expect(screen.getByRole("button", { name: "Сохранить название" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отменить" })).toBeInTheDocument();
  });

  it("пустое название открывает пустое поле", async () => {
    renderHeader({ session: { ...session, title: null } });

    await userEvent.click(titleButton());

    expect(screen.getByRole("textbox", { name: "Название сессии" })).toHaveValue("");
  });

  it("галочка сохраняет название без лишних пробелов", async () => {
    const { props: p } = renderHeader();

    await userEvent.click(titleButton());
    const field = screen.getByRole("textbox", { name: "Название сессии" });
    await userEvent.clear(field);
    await userEvent.type(field, "  Новое имя ");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить название" }));

    await waitFor(() => expect(p.onRename).toHaveBeenCalledWith("Новое имя"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Название сессии" })).toBeNull());
  });

  it("Enter сохраняет, Esc отменяет без запроса", async () => {
    const { props: p } = renderHeader();

    await userEvent.click(titleButton());
    await userEvent.type(screen.getByRole("textbox", { name: "Название сессии" }), "!{Enter}");
    await waitFor(() => expect(p.onRename).toHaveBeenCalledWith("Исследование реакторов!"));

    vi.mocked(p.onRename).mockClear();
    await userEvent.click(titleButton());
    await userEvent.type(screen.getByRole("textbox", { name: "Название сессии" }), "x{Escape}");

    expect(p.onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Название сессии" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Исследование реакторов");
  });

  it("крестик отменяет правку", async () => {
    const { props: p } = renderHeader();

    await userEvent.click(titleButton());
    await userEvent.click(screen.getByRole("button", { name: "Отменить" }));

    expect(p.onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Название сессии" })).toBeNull();
  });

  it("если сохранить не удалось, поле остаётся открытым", async () => {
    const onRename = vi.fn().mockRejectedValue(new Error("нет"));
    renderHeader({ onRename });

    await userEvent.click(titleButton());
    await userEvent.click(screen.getByRole("button", { name: "Сохранить название" }));

    await waitFor(() => expect(onRename).toHaveBeenCalled());
    expect(await screen.findByRole("textbox", { name: "Название сессии" })).toBeInTheDocument();
  });
});

describe("SessionHeader: чипы", () => {
  it("агент и окружение стоят ссылками на свои страницы", () => {
    renderHeader();

    expect(screen.getByRole("link", { name: /Глубокий исследователь/ })).toHaveAttribute(
      "href",
      "/agents/agent_01ABCDEFGH",
    );
    expect(screen.getByRole("link", { name: /qwe/ })).toHaveAttribute(
      "href",
      "/environments/env_01ZXCVBNM",
    );
  });

  it("чипы идут тремя группами: агент и окружение, длительность и токены, стоимость и активность", () => {
    const { container } = renderHeader();

    const groups = Array.from(container.querySelectorAll("[data-chip-group]"));
    expect(groups.map((group) => group.getAttribute("data-chip-group"))).toEqual([
      "resources",
      "usage",
      "cost",
    ]);
    expect(within(groups[0] as HTMLElement).getAllByRole("link")).toHaveLength(2);
    expect(groups[1]).toHaveTextContent("14 ч 2 мин");
    expect(groups[1]).toHaveTextContent("411,1 тыс. / 20,1 тыс.");
    expect(groups[2]).toHaveTextContent("$0,89 / $5,00");
  });

  it("каждый чип расхода помечен data-session-chip: по метке его находит проверка скилла", () => {
    const { container } = renderHeader();

    const chip = (name: string) => container.querySelector(`[data-session-chip="${name}"]`);
    expect(chip("duration")).toHaveTextContent("14 ч 2 мин");
    expect(chip("tokens")).toHaveTextContent(/^411,1 тыс\. \/ 20,1 тыс\.$/);
    expect(chip("cost")).toHaveTextContent("$0,89 / $5,00");
    expect(chip("activity")).not.toBeNull();
  });

  it("длительность считает от создания до последней активности", () => {
    renderHeader();

    expect(screen.getByText("14 ч 2 мин")).toBeInTheDocument();
  });

  it("при наведении на длительность сообщает активное время", async () => {
    renderHeader();

    await userEvent.hover(screen.getByText("14 ч 2 мин"));

    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Прошло с создания: 14 ч 2 мин");
    expect(tip).toHaveTextContent("Активное время: 5 мин 10 с");
  });

  it("токены: вход с кэшем и выход, подсказка раскладывает по видам", async () => {
    renderHeader();

    await userEvent.hover(screen.getByText("411,1 тыс. / 20,1 тыс."));

    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Токены вход / выход");
    expect(tip).toHaveTextContent("Чтение кэша 328,6 тыс.");
    expect(tip).toHaveTextContent("Запись кэша 82,4 тыс.");
    expect(tip).toHaveTextContent("Без кэша 76");
    expect(tip).toHaveTextContent("Выход 20,1 тыс.");
  });

  it("стоимость без бюджета не рисует «/ бюджет»", () => {
    renderHeader({ cost: { ...cost, budgetCents: null } });

    expect(screen.getByText("$0,89")).toBeInTheDocument();
    expect(screen.queryByText(/\/ \$5,00/)).toBeNull();
  });

  it("без цены пишет «нет цены», бюджет остаётся", () => {
    renderHeader({ cost: { ...cost, source: "none", totalMicros: null } });

    expect(screen.getByText("нет цены")).toBeInTheDocument();
    expect(screen.getByText("/ $5,00")).toBeInTheDocument();
  });

  it("пока стоимость грузится, вместо «нет цены» стоит многоточие", () => {
    renderHeader({ cost: { ...cost, source: "none", totalMicros: null, loading: true } });

    expect(screen.queryByText("нет цены")).toBeNull();
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("подсказка стоимости говорит про цены и бюджет", async () => {
    renderHeader();

    await userEvent.hover(screen.getByText("$0,89"));

    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent("Стоимость по ценам модели, без скидок.");
    expect(tip).toHaveTextContent("Бюджет $5,00.");
  });

  it("последняя активность показана возрастом, а подсказка точной датой", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    renderHeader();

    const age = screen.getByText("18 мин назад");
    await userEvent.hover(age);

    const tip = await screen.findByRole("tooltip");
    expect(tip).toHaveTextContent(formatEventDateTimeRu(LAST));
  });

  it("возраст активности обновляется на странице", () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
    renderHeader();
    expect(screen.getByText("18 мин назад")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    expect(screen.getByText("23 мин назад")).toBeInTheDocument();
  });

  it("без последней активности чип не рисуется", () => {
    renderHeader({ lastActivityMs: null });

    expect(screen.queryByText(/назад/)).toBeNull();
  });
});

describe("SessionHeader: меню «Действия»", () => {
  it("содержит четыре пункта, архивирование красным", async () => {
    renderHeader({ status: "running" });

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));

    expect(await screen.findByRole("menuitem", { name: "Прервать" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Задать результат…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Изменить бюджет" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Архивировать" })).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    expect(screen.getAllByRole("separator").length).toBeGreaterThanOrEqual(1);
  });

  it("каждый пункт вызывает своё действие", async () => {
    const { props: p } = renderHeader({ status: "running" });

    for (const [label, handler] of [
      ["Прервать", p.onInterrupt],
      ["Задать результат…", p.onDefineOutcome],
      ["Изменить бюджет", p.onEditBudget],
      ["Архивировать", p.onArchive],
    ] as const) {
      await userEvent.click(screen.getByRole("button", { name: "Действия" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: label }));
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  it("«Прервать» недоступно, пока сессия не выполняется", async () => {
    renderHeader({ status: "idle" });

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));

    expect(await screen.findByRole("menuitem", { name: "Прервать" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("в архивной сессии «Архивировать» недоступно", async () => {
    renderHeader({ session: { ...session, archived_at: "2026-10-16T00:00:00.000Z" } });

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));

    expect(await screen.findByRole("menuitem", { name: "Архивировать" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("SessionHeader: меню «⋮»", () => {
  it("копирует и скачивает события, открывает траекторию и горячие клавиши", async () => {
    const { props: p } = renderHeader();

    for (const [label, handler] of [
      ["Копировать все события", p.onCopyEvents],
      ["Скачать все события", p.onDownloadEvents],
      ["Траектория", p.onShowTrajectory],
      ["Горячие клавиши", p.onShowShortcuts],
    ] as const) {
      await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: label }));
      expect(handler).toHaveBeenCalledOnce();
    }
  });
});

describe("SessionHeader: «Спросить помощника»", () => {
  it("заглушка: кнопка есть, подсказка «Скоро», действия нет", async () => {
    const { props: p } = renderHeader();

    const button = screen.getByRole("button", { name: "Спросить помощника" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.hover(button);

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Скоро");
    await userEvent.click(button);
    expect(p.onInterrupt).not.toHaveBeenCalled();
  });
});
