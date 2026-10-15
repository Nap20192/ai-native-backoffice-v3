import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectCanonicalChatTurns,
  type CanonicalChatTurn,
  type WireSessionEvent,
} from "@openma/common/session-events/managed";
import type { EventSelection } from "../../lib/session-stats";
import { formatGapRu } from "./format-ru";
import {
  findSearchMatches,
  JumpToBottomButton,
  ManagedSessionConversation,
  type ManagedSessionConversationProps,
} from "./ManagedSessionConversation";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const text = (value: string) => [{ type: "text", text: value }];
const DAY_GAP_S = 14 * 3600;

/** Два хода с промежутком 14 часов. В первом три совпадения «цитир». */
function sessionEvents(): WireSessionEvent[] {
  return [
    { type: "user.message", id: "u1", content: text("Нужны цитирования источников"), processed_at: at(0) },
    { type: "session.status_running", id: "s1", processed_at: at(1) },
    { type: "span.model_request_start", id: "r1", processed_at: at(2) },
    { type: "agent.message", id: "m1", content: text("Цитирование: без цитирования отчёт слаб."), processed_at: at(4) },
    { type: "agent.tool_use", id: "t1", name: "bash", input: { command: "ls /mnt" }, processed_at: at(5) },
    { type: "agent.tool_result", id: "t1r", tool_use_id: "t1", content: text("a.txt"), processed_at: at(6) },
    { type: "span.model_request_end", id: "r1e", model_request_start_id: "r1", processed_at: at(7) },
    { type: "session.status_idle", id: "s2", processed_at: at(8) },
    { type: "user.message", id: "u2", content: text("Привет"), processed_at: at(DAY_GAP_S) },
    { type: "span.model_request_start", id: "r3", processed_at: at(DAY_GAP_S + 1) },
    { type: "agent.message", id: "m3", content: text("Здравствуйте"), processed_at: at(DAY_GAP_S + 3) },
    { type: "span.model_request_end", id: "r3e", model_request_start_id: "r3", processed_at: at(DAY_GAP_S + 4) },
    { type: "session.status_idle", id: "s3", processed_at: at(DAY_GAP_S + 5) },
  ];
}

function turnsFrom(events: WireSessionEvent[]): CanonicalChatTurn[] {
  return projectCanonicalChatTurns(events);
}

const NO_SELECTION: EventSelection = { eventId: null, source: "url", seq: 0 };

function setup(overrides: Partial<ManagedSessionConversationProps> = {}) {
  const props: ManagedSessionConversationProps = {
    composer: <button type="button">Send</button>,
    sessionId: "session-1",
    turns: turnsFrom(sessionEvents()),
    agentName: "Deep researcher",
    running: false,
    selection: NO_SELECTION,
    onSelectEvent: vi.fn(),
    ...overrides,
  };
  const view = render(
    <MemoryRouter>
      <ManagedSessionConversation {...props} />
    </MemoryRouter>,
  );
  const rerender = (next: Partial<ManagedSessionConversationProps>) =>
    view.rerender(
      <MemoryRouter>
        <ManagedSessionConversation {...props} {...next} />
      </MemoryRouter>,
    );
  return { ...view, props, rerender };
}

/** Блок в ленте. Отрезки мини-карты тоже несут data-block-id, поэтому ищем в колонке. */
const block = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-session-column] [data-block-id="${id}"]`);
const searchField = () => screen.getByRole("searchbox", { name: "Найти в разговоре" });
const counter = () => screen.getByTestId("match-counter");

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
  );
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
});

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("findSearchMatches", () => {
  const texts = [
    { blockId: "a", text: "Цитирование и цитата, ЦИТИРОВАТЬ" },
    { blockId: "b", text: "ничего" },
    { blockId: "c", text: "цитир" },
  ];

  it("находит совпадения без учёта регистра по порядку блоков", () => {
    const matches = findSearchMatches(texts, "цитир");

    expect(matches.map((match) => [match.blockId, match.ordinal, match.start])).toEqual([
      ["a", 0, 0],
      ["a", 1, 22],
      ["c", 0, 0],
    ]);
    expect(matches[0]!.length).toBe(5);
  });

  it("пустой и пробельный запрос не даёт совпадений", () => {
    expect(findSearchMatches(texts, "")).toEqual([]);
    expect(findSearchMatches(texts, "   ")).toEqual([]);
  });

  it("не трактует символы запроса как регулярное выражение", () => {
    const matches = findSearchMatches([{ blockId: "a", text: "a.b axb a.b" }], "a.b");

    expect(matches.map((match) => match.start)).toEqual([0, 8]);
  });

  it("не пересекает совпадения друг с другом", () => {
    const matches = findSearchMatches([{ blockId: "a", text: "aaaa" }], "aa");

    expect(matches.map((match) => match.start)).toEqual([0, 2]);
  });
});

describe("JumpToBottomButton", () => {
  it("круглая кнопка «Вниз»", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<JumpToBottomButton className="absolute" icon={<span>↓</span>} onClick={onClick} />);

    const button = screen.getByRole("button", { name: "Вниз" });
    expect(button).toHaveClass("rounded-full");
    expect(button).toHaveClass("absolute");
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("ManagedSessionConversation: каркас", () => {
  it("отдаёт ленту, прилипание к низу и колонку поля ввода общей оболочке", () => {
    const { container } = setup();

    expect(container.querySelector('[data-chat-surface="console"]')).toBeInTheDocument();
    expect(container.querySelector('[data-chat-column="turns"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-chat-column="composer"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("рисует по одному article на ход, в блоках разговора, а не в Backchat", () => {
    const { container } = setup();

    expect(container.querySelectorAll("article[data-turn-id]")).toHaveLength(2);
    expect(container.querySelector("[data-session-process-state]")).toBeNull();
    expect(block(container, "r1")).toHaveAttribute("data-block-kind", "request");
  });

  it("держит колонку карточек не шире 720 px по центру", () => {
    const { container } = setup();

    const column = container.querySelector<HTMLElement>("[data-session-column]")!;
    expect(column.className).toContain("max-w-[752px]");
    expect(column.className).toContain("mx-auto");
    expect(column.querySelector('[data-chat-column="turns"]')).not.toBeNull();
  });

  it("ставит после ходов то, что передала страница", () => {
    const { container } = setup({ afterTurns: <p>Агент работает…</p> });

    const turns = container.querySelector('[data-chat-column="turns"]')!;
    const after = screen.getByText("Агент работает…");
    expect(turns.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("без ходов показывает заглушку, поле ввода остаётся", () => {
    setup({ turns: [], empty: <p>Пока пусто</p> });

    expect(screen.getByText("Пока пусто")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("без ходов подсказывает отправить сообщение", () => {
    setup({ turns: [] });

    expect(screen.getByText("Отправьте сообщение, чтобы начать сессию.")).toBeInTheDocument();
  });

  it("ставит место для кнопки «Инспектор» справа от лупы", () => {
    setup({ toolbarTrailing: <span data-testid="inspector-slot">Инспектор</span> });

    const zoomIn = screen.getByRole("button", { name: "Крупнее" });
    expect(
      zoomIn.compareDocumentPosition(screen.getByTestId("inspector-slot")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("между ходами с простоем рисует плашку с датой и длительностью", () => {
    const { container } = setup();

    const gap = container.querySelector("[data-block-kind='gap']")!;
    expect(gap).toHaveTextContent(formatGapRu(T0 + DAY_GAP_S * 1000, (DAY_GAP_S - 8) * 1000));
  });
});

describe("ManagedSessionConversation: мини-карта", () => {
  it("рисует отрезки по блокам всех ходов", () => {
    const { container } = setup();

    const segments = Array.from(container.querySelectorAll<HTMLElement>("[data-minimap-segment]"));
    expect(segments.map((segment) => segment.dataset.blockId)).toEqual(["u1", "r1", "u2", "r3"]);
  });

  it("без отрезков мини-карты нет", () => {
    const { container } = setup({ turns: [] });

    expect(container.querySelector("[data-session-minimap]")).toBeNull();
  });

  it("клик по отрезку выбирает событие из мини-карты", async () => {
    const user = userEvent.setup();
    const { props, container } = setup();

    await user.click(container.querySelector<HTMLElement>('[data-minimap-segment][data-block-id="r1"]')!);

    expect(props.onSelectEvent).toHaveBeenCalledWith("r1", "minimap");
  });

  it("наведение на отрезок подсвечивает блок в ленте", async () => {
    const user = userEvent.setup();
    const { container } = setup();
    const segment = container.querySelector<HTMLElement>('[data-minimap-segment][data-block-id="r1"]')!;

    await user.hover(segment);
    expect(block(container, "r1")).toHaveAttribute("data-hovered", "true");

    await user.unhover(segment);
    expect(block(container, "r1")).toHaveAttribute("data-hovered", "false");
  });

  it("выбранный блок подсвечен на мини-карте", () => {
    const { container } = setup({ selection: { eventId: "t1r", source: "events", seq: 1 } });

    expect(
      container.querySelector('[data-minimap-segment][data-block-id="r1"]'),
    ).toHaveAttribute("data-selected", "true");
  });

  it("«Крупнее» расширяет дорожку, «Мельче» возвращает", async () => {
    const user = userEvent.setup();
    const { container } = setup();
    const track = () => container.querySelector<HTMLElement>("[data-minimap-track]")!;
    const base = Number.parseFloat(track().style.width);

    await user.click(screen.getByRole("button", { name: "Крупнее" }));
    expect(Number.parseFloat(track().style.width)).toBeCloseTo(base * 2, 3);

    await user.click(screen.getByRole("button", { name: "Мельче" }));
    expect(Number.parseFloat(track().style.width)).toBeCloseTo(base, 3);
  });

  it("рамка на дорожке показывает блоки, видимые в ленте", () => {
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("chat-scrollbar")) return rect(0, 500);
      const id = (this as HTMLElement).dataset?.blockId;
      if (id === "r1") return rect(100, 300);
      if (id === "u1") return rect(-200, -10);
      return rect(900, 1000);
    });
    const { container } = setup();
    const scroller = container.querySelector<HTMLElement>(".chat-scrollbar")!;

    act(() => {
      fireEvent.scroll(scroller);
    });

    const frame = container.querySelector<HTMLElement>("[data-minimap-window]");
    expect(frame).not.toBeNull();
    const r1 = container.querySelector<HTMLElement>('[data-minimap-segment][data-block-id="r1"]')!;
    expect(Number.parseFloat(frame!.style.left)).toBeCloseTo(Number.parseFloat(r1.style.left), 3);
  });
});

describe("ManagedSessionConversation: поиск", () => {
  it("считает совпадения по блокам и показывает «1/3»", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(searchField(), "цитир");

    expect(counter()).toHaveTextContent("1/3");
  });

  it("Enter идёт вперёд по кругу, Shift Enter назад", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(searchField(), "цитир");

    await user.keyboard("{Enter}");
    expect(counter()).toHaveTextContent("2/3");
    await user.keyboard("{Enter}");
    expect(counter()).toHaveTextContent("3/3");
    await user.keyboard("{Enter}");
    expect(counter()).toHaveTextContent("1/3");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(counter()).toHaveTextContent("3/3");
  });

  it("стрелки «Далее» и «Назад» листают то же самое", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(searchField(), "цитир");

    await user.click(screen.getByRole("button", { name: "Далее" }));
    expect(counter()).toHaveTextContent("2/3");
    await user.click(screen.getByRole("button", { name: "Назад" }));
    expect(counter()).toHaveTextContent("1/3");
  });

  it("не считает подписи и время: «Пользователь» не находится", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(searchField(), "Пользователь");

    expect(counter()).toHaveTextContent("0/0");
  });

  it("находит текст строк вызовов", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(searchField(), "ls /mnt");

    expect(counter()).toHaveTextContent("1/1");
  });

  it("отмечает блоки с совпадениями на мини-карте", async () => {
    const user = userEvent.setup();
    const { container } = setup();

    await user.type(searchField(), "цитир");

    const marks = Array.from(container.querySelectorAll<HTMLElement>("[data-minimap-match]"));
    expect(marks.map((mark) => mark.dataset.blockId)).toEqual(["u1", "r1"]);
  });

  it("прокручивает ленту к блоку с текущим совпадением и обводит его рамкой", async () => {
    const user = userEvent.setup();
    const { container } = setup();

    await user.type(searchField(), "цитир");
    await user.keyboard("{Enter}");

    const target = block(container, "r1")!;
    expect(target).toHaveAttribute("data-selected", "true");
    expect(scrollIntoView).toHaveBeenCalled();
    const lastScrolled = scrollIntoView.mock.contexts.at(-1) as HTMLElement;
    expect(target.contains(lastScrolled)).toBe(true);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center", behavior: "smooth" });
  });

  it("блоки без совпадений остаются на месте", async () => {
    const user = userEvent.setup();
    const { container } = setup();

    await user.type(searchField(), "цитир");

    expect(block(container, "u2")).not.toBeNull();
    expect(block(container, "r3")).not.toBeNull();
  });

  it("раскрывает свёрнутый текст, где лежит совпадение", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 900 });
    const user = userEvent.setup();
    const { container } = setup();
    const clamp = block(container, "r1")!.querySelector<HTMLElement>("[data-session-clamp]")!;
    expect(clamp).toHaveAttribute("data-clamp-state", "collapsed");

    await user.type(searchField(), "без цитир");

    expect(clamp).toHaveAttribute("data-clamp-state", "expanded");
  });

  it("очистка запроса убирает счётчик и метки", async () => {
    const user = userEvent.setup();
    const { container } = setup();
    await user.type(searchField(), "цитир");

    await user.click(screen.getByRole("button", { name: "Очистить поиск" }));

    expect(screen.queryByTestId("match-counter")).not.toBeInTheDocument();
    expect(container.querySelector("[data-minimap-match]")).toBeNull();
  });

  describe("подсветка через CSS Custom Highlight API", () => {
    class FakeHighlight {
      ranges: Range[] = [];
      add(range: Range) {
        this.ranges.push(range);
        return this;
      }
    }
    let registry: Map<string, FakeHighlight>;

    beforeEach(() => {
      registry = new Map();
      vi.stubGlobal("Highlight", FakeHighlight);
      vi.stubGlobal("CSS", { highlights: registry });
    });

    it("подсвечивает все совпадения, текущее отдельно, DOM не меняется", async () => {
      const user = userEvent.setup();
      const { container } = setup();
      const before = block(container, "r1")!.textContent;

      await user.type(searchField(), "цитир");

      expect(registry.get("session-search")?.ranges).toHaveLength(3);
      expect(registry.get("session-search-current")?.ranges).toHaveLength(1);
      expect(
        registry
          .get("session-search")!
          .ranges.map((range) => range.toString().toLowerCase()),
      ).toEqual(["цитир", "цитир", "цитир"]);
      expect(container.querySelector("mark")).toBeNull();
      expect(block(container, "r1")!.textContent).toBe(before);

      await user.keyboard("{Enter}");
      expect(registry.get("session-search-current")!.ranges[0]!.startContainer.textContent).toContain(
        "Цитирование",
      );
    });

    it("убирает подсветку при очистке запроса и при размонтировании", async () => {
      const user = userEvent.setup();
      const { unmount } = setup();
      await user.type(searchField(), "цитир");

      await user.clear(searchField());
      expect(registry.has("session-search")).toBe(false);

      await user.type(searchField(), "цитир");
      expect(registry.has("session-search")).toBe(true);
      unmount();
      expect(registry.has("session-search")).toBe(false);
      expect(registry.has("session-search-current")).toBe(false);
    });
  });
});

describe("ManagedSessionConversation: выбор события снаружи", () => {
  const callRow = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-event-id="t1"]')!;
  const rowButton = (container: HTMLElement) =>
    within(callRow(container)).getByRole("button", { name: /bash/ });

  it("из вкладки «События» прокручивает к вызову и раскрывает его", () => {
    const { container } = setup({ selection: { eventId: "t1", source: "events", seq: 1 } });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(callRow(container));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(rowButton(container)).toHaveAttribute("aria-expanded", "true");
  });

  it("результат вызова ведёт к той же строке вызова", () => {
    const { container } = setup({ selection: { eventId: "t1r", source: "events", seq: 1 } });

    expect(scrollIntoView.mock.contexts[0]).toBe(callRow(container));
    expect(rowButton(container)).toHaveAttribute("aria-expanded", "true");
  });

  it("событие без строки ведёт к блоку", () => {
    const { container } = setup({ selection: { eventId: "m1", source: "events", seq: 1 } });

    expect(scrollIntoView.mock.contexts[0]).toBe(block(container, "r1"));
    expect(block(container, "r1")).toHaveAttribute("data-selected", "true");
  });

  it("из «Инструментов» прокручивает, но не раскрывает", () => {
    const { container } = setup({ selection: { eventId: "t1", source: "tools", seq: 1 } });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(rowButton(container)).toHaveAttribute("aria-expanded", "false");
    expect(callRow(container)).toHaveAttribute("data-selected", "true");
  });

  it("с мини-карты прокручивает, но не раскрывает", () => {
    const { container } = setup({ selection: { eventId: "t1", source: "minimap", seq: 1 } });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(rowButton(container)).toHaveAttribute("aria-expanded", "false");
  });

  it("клик в самой ленте раскрывает, но не прокручивает", () => {
    const { container } = setup({ selection: { eventId: "t1", source: "transcript", seq: 1 } });

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(rowButton(container)).toHaveAttribute("aria-expanded", "true");
  });

  it("выбор из адреса при загрузке прокручивает к событию", () => {
    setup({ selection: { eventId: "t1", source: "url", seq: 0 } });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("повторный выбор того же события снова прокручивает (растёт seq)", () => {
    const { rerender } = setup({ selection: { eventId: "t1", source: "events", seq: 1 } });

    rerender({ selection: { eventId: "t1", source: "events", seq: 2 } });

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("без выбора ничего не прокручивает", () => {
    setup();

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("ждёт появления блока: выбор из адреса до загрузки истории", () => {
    const { rerender } = setup({ turns: [], selection: { eventId: "t1", source: "url", seq: 0 } });
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender({ turns: turnsFrom(sessionEvents()), selection: { eventId: "t1", source: "url", seq: 0 } });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("клик по блоку в ленте сообщает выбор с источником «transcript»", async () => {
    const user = userEvent.setup();
    const { props, container } = setup();

    await user.click(within(callRow(container)).getByRole("button"));

    expect(props.onSelectEvent).toHaveBeenCalledWith("t1", "transcript");
  });

  it("клик по реплике сообщает её событие", async () => {
    const user = userEvent.setup();
    const { props, container } = setup();

    await user.click(container.querySelector("[data-session-turn-prompt]")!);

    expect(props.onSelectEvent).toHaveBeenCalledWith("u1", "transcript");
  });

  it("«Критерии» и соседние оценки прокручивают ленту к блоку", async () => {
    const user = userEvent.setup();
    const events: WireSessionEvent[] = [
      { type: "user.message", id: "u1", content: text("Сделай отчёт"), processed_at: at(0) },
      {
        type: "user.define_outcome",
        id: "o1",
        outcome_id: "out",
        description: "Отчёт",
        rubric: { type: "text", content: "- Критерий" },
        processed_at: at(1),
      },
      { type: "span.outcome_evaluation_start", id: "es0", outcome_id: "out", iteration: 0, processed_at: at(2) },
      { type: "span.outcome_evaluation_end", id: "ee0", outcome_id: "out", iteration: 0, result: "needs_revision", explanation: "Нет ссылок", processed_at: at(3) },
      { type: "session.status_idle", id: "s", processed_at: at(4) },
    ];
    const { container } = setup({ turns: turnsFrom(events) });

    await user.click(within(block(container, "es0")!).getByRole("button", { name: "Критерии" }));

    expect(scrollIntoView.mock.contexts.at(-1)).toBe(block(container, "o1"));
  });
});

describe("ManagedSessionConversation: клавиши", () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      fireEvent.keyDown(document.body, { key, ...init });
    });

  it("Esc снимает выбор", () => {
    const { props } = setup({ selection: { eventId: "t1", source: "events", seq: 1 } });

    press("Escape");

    expect(props.onSelectEvent).toHaveBeenCalledWith(null, "transcript");
  });

  it("Esc без выбора ничего не делает", () => {
    const { props } = setup();

    press("Escape");

    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("«/» переводит фокус в поле поиска", () => {
    setup();

    press("/");

    expect(searchField()).toHaveFocus();
  });

  it("клавиши не работают, пока фокус в поле ввода", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(searchField());
    await user.keyboard("j");

    expect(props.onSelectEvent).not.toHaveBeenCalled();
    expect(searchField()).toHaveValue("j");
  });

  it("клавиши не работают с Ctrl, Alt и Cmd", () => {
    const { props } = setup();

    press("j", { ctrlKey: true });
    press("j", { metaKey: true });
    press("j", { altKey: true });

    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("клавиши не срабатывают, когда открыто окно", () => {
    const { props } = setup();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);

    press("j");
    press("Escape");
    dialog.remove();

    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("J без выбора берёт первое событие, K последнее", () => {
    const { props } = setup();

    press("j");
    press("k");

    expect(props.onSelectEvent).toHaveBeenNthCalledWith(1, "u1", "transcript");
    expect(props.onSelectEvent).toHaveBeenNthCalledWith(2, "r3", "transcript");
  });

  it("J и ↓ идут к следующему событию: реплика, карточка, вызов, реплика", () => {
    const { props, rerender } = setup({ selection: { eventId: "u1", source: "transcript", seq: 1 } });

    press("j");
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("r1", "transcript");

    rerender({ selection: { eventId: "r1", source: "transcript", seq: 2 } });
    press("ArrowDown");
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("t1", "transcript");

    rerender({ selection: { eventId: "t1", source: "transcript", seq: 3 } });
    press("j");
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("u2", "transcript");
  });

  it("K и ↑ идут к предыдущему событию, на краю остаются на месте", () => {
    const { props, rerender } = setup({ selection: { eventId: "u2", source: "transcript", seq: 1 } });

    press("k");
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("t1", "transcript");

    rerender({ selection: { eventId: "u1", source: "transcript", seq: 2 } });
    press("ArrowUp");
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("u1", "transcript");
  });

  it("результат вызова считается этим же вызовом при переходе", () => {
    const { props } = setup({ selection: { eventId: "t1r", source: "events", seq: 1 } });

    press("j");

    expect(props.onSelectEvent).toHaveBeenLastCalledWith("u2", "transcript");
  });

  it("↑ и ↓ без выбора не трогают прокрутку страницы", () => {
    const { props } = setup();
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });

    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(props.onSelectEvent).not.toHaveBeenCalled();
  });

  it("← сворачивает раскрытый вызов, → раскрывает снова", () => {
    const { container } = setup({ selection: { eventId: "t1", source: "events", seq: 1 } });
    const button = () => within(container.querySelector<HTMLElement>('[data-event-id="t1"]')!).getByRole("button", { name: /bash/ });
    expect(button()).toHaveAttribute("aria-expanded", "true");

    press("ArrowLeft");
    expect(button()).toHaveAttribute("aria-expanded", "false");

    press("ArrowRight");
    expect(button()).toHaveAttribute("aria-expanded", "true");
  });

  it("→ раскрывает вызов, выбранный из «Инструментов», через выбор в ленте", () => {
    const { props } = setup({ selection: { eventId: "t1", source: "tools", seq: 1 } });

    press("ArrowRight");

    expect(props.onSelectEvent).toHaveBeenCalledWith("t1", "transcript");
  });

  it("новый выбор снимает ручное сворачивание", () => {
    const { container, rerender } = setup({ selection: { eventId: "t1", source: "events", seq: 1 } });
    press("ArrowLeft");

    rerender({ selection: { eventId: "t1", source: "events", seq: 2 } });

    expect(
      within(container.querySelector<HTMLElement>('[data-event-id="t1"]')!).getByRole("button", { name: /bash/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

describe("ManagedSessionConversation: время", () => {
  it("открытый запрос растёт до «сейчас», пока сессия идёт", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 60_000);
    const events: WireSessionEvent[] = [
      { type: "user.message", id: "u1", content: text("Привет"), processed_at: at(0) },
      { type: "span.model_request_start", id: "r1", processed_at: at(10) },
    ];
    const { container } = setup({ turns: turnsFrom(events), running: true });

    const segment = container.querySelector<HTMLElement>('[data-minimap-segment][data-block-id="r1"]')!;
    expect(Number.parseFloat(segment.style.width)).toBeGreaterThan(2);
    vi.useRealTimers();
  });
});
