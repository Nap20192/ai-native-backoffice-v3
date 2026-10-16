import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import overviewFixture from "../../../mocks/trace-pi-turn.json";
import { normalizeSpan, normalizeTurn, parseOverview, type TraceTurnSummary } from "../../../lib/trace-api";
import {
  AUTO_COLLAPSE,
  NO_FILTER,
  TraceTree,
  createRowsBuilder,
  expandAll,
  type CollapseState,
  type TraceRow,
} from "../../../lib/trace-tree";
import { TraceWaterfall, type TraceWaterfallProps } from "./TraceWaterfall";

const id = (prefix: string, n: number) => prefix + n.toString(16).padStart(14, "0");
const T0 = 1_792_150_000_000;
const NOW = T0 + 1_700_000;

function fixture() {
  const overview = parseOverview(overviewFixture);
  const tree = new TraceTree();
  for (const turn of overview.turns) tree.upsert(turn.turn);
  for (const span of overview.spans) tree.upsert(span);
  const summaries = new Map<string, TraceTurnSummary>(overview.turns.map((turn) => [turn.turn.span_id, turn]));
  return { tree, summaries, overview };
}

function build(tree: TraceTree, collapse: CollapseState = AUTO_COLLAPSE, unloaded: string[] = ["evt_a1"]): TraceRow[] {
  const last = tree.roots[tree.roots.length - 1]?.span.span_id ?? null;
  return createRowsBuilder()(tree, { collapse, filter: NO_FILTER, lastRootId: last, unloadedTurnIds: new Set(unloaded) });
}

function props(over: Partial<TraceWaterfallProps> = {}): TraceWaterfallProps {
  const { tree, summaries } = fixture();
  return {
    tree,
    revision: tree.revision,
    rows: build(tree),
    window: null,
    zoom: 1,
    now: () => NOW,
    selectedSpanId: null,
    currentMatchId: null,
    matchIds: new Set(),
    turnNumbers: new Map([[id("a1", 1), 1], [id("b1", 1), 2], [id("c1", 1), 3]]),
    summaries,
    loadingSpanIds: new Set(),
    toolInput: () => null,
    phone: false,
    revealRequest: null,
    follow: false,
    onUserScroll: vi.fn(),
    onSelect: vi.fn(),
    onCollapseChange: vi.fn(),
    onCollapseAll: vi.fn(),
    onExpandAll: vi.fn(),
    onWindowChange: vi.fn(),
    onEscape: vi.fn(),
    ...over,
  };
}

/** Высокий экран: все строки фикстуры попадают в окно, ширина остаётся запасной (960 px). */
function tallViewport() {
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(1200);
}

const row = (container: HTMLElement, spanId: string) => container.querySelector<HTMLElement>(`[data-span-id="${spanId}"]`)!;
const barOf = (container: HTMLElement, spanId: string) => row(container, spanId).querySelector<HTMLElement>("[data-trace-bar]")!;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("TraceWaterfall: дерево и подписи", () => {
  it("рисует заголовки колонок и строки в порядке дерева с уровнем вложенности", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    for (const name of ["Операция", "Шкала времени", "Длительность"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    const order = [...container.querySelectorAll<HTMLElement>("[data-trace-row]")].map((el) => el.dataset.spanId);
    expect(order).toEqual([
      id("a1", 1), id("b1", 1), id("c1", 1),
      id("c1", 2), id("c1", 80), id("c1", 16), id("c1", 32), id("c1", 33), id("c1", 48), id("c1", 64), id("c1", 65),
    ]);
    expect(screen.getByRole("treegrid", { name: "Трейс" })).toBeInTheDocument();
    expect(row(container, id("c1", 1))).toHaveAttribute("aria-level", "1");
    expect(row(container, id("c1", 32))).toHaveAttribute("aria-level", "2");
    expect(row(container, id("c1", 33))).toHaveAttribute("aria-level", "3");
  });

  it("подписывает ход номером и агентом, вызов модели моделью, инструмент именем", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    expect(within(row(container, id("b1", 1))).getByText("Ход 2")).toBeInTheDocument();
    expect(within(row(container, id("b1", 1))).getByText("Аналитик отчётов")).toBeInTheDocument();
    expect(within(row(container, id("c1", 16))).getByText("Вызов модели")).toBeInTheDocument();
    expect(within(row(container, id("c1", 16))).getByText("claude-sonnet-4-5")).toBeInTheDocument();
    expect(within(row(container, id("c1", 33))).getByText("Сабагент «researcher»")).toBeInTheDocument();
    expect(within(row(container, id("c1", 80))).getByText("Подключение MCP")).toBeInTheDocument();
    expect(within(row(container, id("c1", 2))).getByText("тёплая")).toBeInTheDocument();
  });

  it("показывает аргумент инструмента серым, если страница его знает", () => {
    const { container } = render(
      <TraceWaterfall {...props({ rows: build(fixture().tree, expandAll()), toolInput: (span) => (span.name === "bash" ? "sleep 0.4" : null) })} />,
    );
    expect(within(row(container, id("b1", 32))).getByText("bash")).toBeInTheDocument();
    expect(within(row(container, id("b1", 32))).getByText("sleep 0.4")).toBeInTheDocument();
  });

  it("у ожидания и выполнения без собственного инструмента подпись берёт имя вызова", () => {
    tallViewport();
    const { container } = render(<TraceWaterfall {...props({ rows: build(fixture().tree, expandAll()) })} />);
    expect(within(row(container, id("b1", 33))).getByText("Выполнение")).toBeInTheDocument();
    expect(within(row(container, id("b1", 33))).getByText("bash")).toBeInTheDocument();
    expect(within(row(container, id("c1", 65))).getByText("write")).toBeInTheDocument();
  });

  it("события сервера (warning, mcp_connection) показаны русскими подписями с иконкой события", () => {
    tallViewport();
    const { container } = render(<TraceWaterfall {...props({ rows: build(fixture().tree, expandAll()) })} />);
    expect(within(row(container, id("b1", 80))).getByText("Предупреждение")).toBeInTheDocument();
    expect(within(row(container, id("b1", 80))).getByText("Вывод команды обрезан")).toBeInTheDocument();
    expect(barOf(container, id("b1", 80)).className).toContain("bg-amber-400");
    expect(within(row(container, id("c1", 80))).getByText("Подключение MCP")).toBeInTheDocument();
  });

  it("ход с потерями получает значок «неполный», ход по событиям отдельного значка не получает", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    const turnC = row(container, id("c1", 1));
    const partial = within(turnC).getByText("неполный");
    expect(partial).toHaveAttribute("title", expect.stringContaining("время до первого токена"));
    expect(within(turnC).queryByText("по событиям")).toBeNull();
    expect(within(row(container, id("b1", 1))).queryByText("неполный")).toBeNull();
  });

  it("свёрнутый ход показывает число ошибок внутри, ждущий ход говорит про подтверждение", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    expect(within(row(container, id("b1", 1))).getByText("ошибок: 2")).toBeInTheDocument();
    expect(within(row(container, id("c1", 1))).getByText("ждёт подтверждения")).toBeInTheDocument();
  });

  it("незагруженный ход можно раскрыть, идущая загрузка показана спиннером", () => {
    const { container, rerender } = render(<TraceWaterfall {...props()} />);
    expect(within(row(container, id("a1", 1))).getByRole("button", { name: "Развернуть" })).toBeInTheDocument();
    rerender(<TraceWaterfall {...props({ loadingSpanIds: new Set([id("a1", 1)]) })} />);
    expect(row(container, id("a1", 1)).querySelector("[data-trace-loading]")).toBeInTheDocument();
  });
});

describe("TraceWaterfall: цвета и статусы", () => {
  it("красит полосу по виду узла", () => {
    tallViewport();
    const { container } = render(<TraceWaterfall {...props({ rows: build(fixture().tree, expandAll()) })} />);
    expect(barOf(container, id("b1", 1)).className).toContain("bg-ink-300");
    expect(barOf(container, id("b1", 2)).className).toContain("bg-ink-400");
    expect(barOf(container, id("b1", 16)).className).toContain("bg-sky-300");
    expect(barOf(container, id("b1", 32)).className).toContain("bg-emerald-300");
    expect(barOf(container, id("c1", 65)).className).toContain("bg-amber-300");
    expect(barOf(container, id("c1", 33)).className).toContain("bg-brand-300");
  });

  it("ошибка любого вида красная: полоса и подпись", () => {
    const { container } = render(<TraceWaterfall {...props({ rows: build(fixture().tree, expandAll()) })} />);
    const failed = row(container, id("b1", 34));
    expect(failed).toHaveAttribute("data-status", "error");
    expect(failed).toHaveAttribute("data-error", "true");
    expect(barOf(container, id("b1", 34)).className).toContain("bg-(--ddc-dot-danger)");
    expect(within(failed).getByText("bash").className).toContain("text-ddc-danger-text");
    expect(within(failed).getByText("ошибка")).toBeInTheDocument();
    expect(row(container, id("b1", 32))).toHaveAttribute("data-error", "false");
  });

  it("отклонённый, прерванный и отменённый узлы серые", () => {
    const { tree } = fixture();
    for (const [n, status] of [[91, "denied"], [92, "interrupted"], [93, "cancelled"]] as const) {
      tree.upsert(normalizeSpan({ span_id: id("c1", n), parent_span_id: id("c1", 1), turn_id: "evt_c1", kind: "tool_call", name: "x", start_ms: T0 + 1_602_600, end_ms: T0 + 1_602_900, status }));
    }
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows: build(tree) })} />);
    for (const n of [91, 92, 93]) expect(barOf(container, id("c1", n)).className).toContain("bg-(--ddc-dot-neutral)");
  });

  it("узел по событиям отмечен знаком ≈ в длительности, измеренный нет", () => {
    const { container } = render(<TraceWaterfall {...props({ rows: build(fixture().tree, expandAll()) })} />);
    expect(row(container, id("c1", 16)).querySelector("[data-trace-duration]")!.textContent).toBe("≈ 2,5 с");
    expect(row(container, id("b1", 16)).querySelector("[data-trace-duration]")!.textContent).toBe("2,6 с");
    expect(row(container, id("c1", 80)).querySelector("[data-trace-duration]")!.textContent).toBe("–");
  });

  it("мгновенный узел рисуется точкой, а не полосой", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    const mark = row(container, id("c1", 80)).querySelector("[data-trace-bar]")!;
    expect(mark).toHaveAttribute("data-point", "true");
  });
});

describe("TraceWaterfall: ожидание и идущие узлы", () => {
  it("ждущий узел тянется до конца последнего хода и несёт «ждёт с ЧЧ:ММ»", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    const waiting = row(container, id("c1", 64));
    expect(barOf(container, id("c1", 64))).toHaveAttribute("data-waiting", "true");
    expect(within(waiting).getByText(/^ждёт с \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(waiting.querySelector("[data-trace-duration]")!.textContent).toBe("ждёт");
    const bar = barOf(container, id("c1", 64));
    const cell = bar.parentElement!;
    const right = parseFloat(bar.style.left) + parseFloat(bar.style.width);
    // Минимальная ширина полосы 2 px может выйти за край шкалы, лишнее срезает ячейка.
    expect(right).toBeLessThanOrEqual(parseFloat(cell.style.width) + 2);
  });

  it("шкала не растёт ради ждущего узла: правый край шкалы равен концу последнего хода", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    const bar = barOf(container, id("c1", 1));
    const cell = bar.parentElement!;
    expect(parseFloat(bar.style.left) + parseFloat(bar.style.width)).toBeCloseTo(parseFloat(cell.style.width), 0);
  });

  it("идущий узел помечен открытым, его ширину ведёт переменная таймера", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { tree } = fixture();
    tree.upsert(normalizeSpan({
      span_id: id("d1", 7), parent_span_id: id("c1", 1), turn_id: "evt_c1", kind: "model_call", name: "m",
      start_ms: NOW - 1_000, end_ms: null, status: "running", version: 1,
    }));
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows: build(tree), now: () => Date.now() })} />);
    const bar = barOf(container, id("d1", 7));
    expect(bar).toHaveAttribute("data-open", "true");
    expect(bar.style.width).toContain("var(--trace-now-x");
    const scroller = container.querySelector<HTMLElement>("[data-trace-scroll]")!;
    act(() => { vi.advanceTimersByTime(260); });
    const first = scroller.style.getPropertyValue("--trace-now-x");
    expect(first).toMatch(/px$/);
    act(() => { vi.setSystemTime(NOW + 2_000); vi.advanceTimersByTime(260); });
    expect(parseFloat(scroller.style.getPropertyValue("--trace-now-x"))).toBeGreaterThan(parseFloat(first));
  });

  it("пока есть идущий узел, раз в две секунды шкала пересчитывается по текущему времени", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { tree } = fixture();
    tree.upsert(normalizeSpan({
      span_id: id("d1", 7), parent_span_id: id("c1", 1), turn_id: "evt_c1", kind: "model_call", name: "m",
      start_ms: NOW - 1_000, end_ms: null, status: "running", version: 1,
    }));
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows: build(tree), now: () => Date.now() })} />);
    const before = barOf(container, id("d1", 7)).style.width;
    act(() => { vi.setSystemTime(NOW + 10_000); vi.advanceTimersByTime(2_100); });
    expect(barOf(container, id("d1", 7)).style.width).not.toBe(before);
  });

  it("без идущих узлов таймер не включается", () => {
    vi.useFakeTimers();
    const { container } = render(<TraceWaterfall {...props()} />);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(container.querySelector<HTMLElement>("[data-trace-scroll]")!.style.getPropertyValue("--trace-now-x")).toBe("");
  });
});

describe("TraceWaterfall: ход без данных", () => {
  it("рисует штрихованный участок «нет данных» там, где у хода уровня 0 нет детей дольше 500 мс", () => {
    const tree = new TraceTree();
    const turn = normalizeSpan({ span_id: id("e1", 1), turn_id: "evt_e", kind: "turn", name: "Молчун", harness: "custom", start_ms: T0, end_ms: T0 + 10_000 });
    tree.upsert(turn);
    tree.upsert(normalizeSpan({ span_id: id("e1", 2), parent_span_id: id("e1", 1), turn_id: "evt_e", kind: "sandbox", name: "attempt_1", start_ms: T0, end_ms: T0 + 900 }));
    const summaries = new Map([[turn.span_id, normalizeTurn({ turn, state: "complete", coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } })]]);
    const rows = build(tree, AUTO_COLLAPSE, []);
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows, summaries, now: () => T0 + 20_000 })} />);
    const gaps = row(container, id("e1", 1)).querySelectorAll("[data-trace-nodata]");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toHaveAttribute("title", "нет данных");
    expect(within(row(container, id("e1", 1))).getByText("нет данных", { selector: "[data-trace-badge]" })).toBeInTheDocument();
  });

  it("участок «нет данных» рисуется поверх полосы хода, а не под ней", () => {
    const tree = new TraceTree();
    const turn = normalizeSpan({ span_id: id("e1", 1), turn_id: "evt_e", kind: "turn", name: "Молчун", harness: "custom", start_ms: T0, end_ms: T0 + 10_000 });
    tree.upsert(turn);
    const summaries = new Map([[turn.span_id, normalizeTurn({ turn, state: "complete", coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } })]]);
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows: build(tree, AUTO_COLLAPSE, []), summaries, now: () => T0 + 20_000 })} />);
    const cell = row(container, id("e1", 1)).querySelector("[data-trace-barcell]")!;
    const order = [...cell.children].map((el) => (el.hasAttribute("data-trace-nodata") ? "nodata" : el.hasAttribute("data-trace-bar") ? "bar" : "other"));
    expect(order.indexOf("nodata")).toBeGreaterThan(order.indexOf("bar"));
  });

  it("harness, который обязан сообщать вызовы, участок «нет данных» не штрихует, а предупреждает значком", () => {
    const tree = new TraceTree();
    const turn = normalizeSpan({ span_id: id("e1", 1), turn_id: "evt_e", kind: "turn", name: "Агент", harness: "pi", start_ms: T0, end_ms: T0 + 10_000 });
    tree.upsert(turn);
    const summaries = new Map([[turn.span_id, normalizeTurn({ turn, state: "complete", coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" } })]]);
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows: build(tree, AUTO_COLLAPSE, []), summaries, now: () => T0 + 20_000 })} />);
    expect(container.querySelector("[data-trace-nodata]")).toBeNull();
    expect(within(row(container, id("e1", 1))).getByText("данные не пришли")).toBeInTheDocument();
  });

  it("у хода с измеренными данными участков «нет данных» нет", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    expect(container.querySelector("[data-trace-nodata]")).toBeNull();
  });
});

describe("TraceWaterfall: шкала", () => {
  it("рисует метки простоев и подписи оси", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    expect(container.querySelectorAll("[data-trace-gap]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-trace-tick]").length).toBeGreaterThan(2);
  });

  it("простой на оси подписан длительностью, подписи рисок не заходят под колонку длительности", () => {
    const { container } = render(<TraceWaterfall {...props()} />);
    const titles = [...container.querySelectorAll("[data-trace-axis-gap]")].map((el) => el.getAttribute("title"));
    expect(titles).toEqual(["Простой 24 мин 55 с", "Простой 1 мин 33 с"]);
    const barWidth = parseFloat(container.querySelector<HTMLElement>("[data-trace-axis-bar]")!.style.width);
    const ticks = [...container.querySelectorAll<HTMLElement>("[data-trace-tick]")];
    expect(ticks.length).toBeGreaterThan(2);
    for (const tick of ticks) expect(parseFloat(tick.style.left)).toBeLessThanOrEqual(barWidth - 64);
  });

  it("ширина колонки подписей зависит от ширины окна: 380, 320 и 240 px", () => {
    const labelWidth = (viewport: number) => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(viewport);
      const { container, unmount } = render(<TraceWaterfall {...props()} />);
      const value = container.querySelector<HTMLElement>("[data-trace-scroll]")!.style.getPropertyValue("--trace-label-w");
      unmount();
      vi.restoreAllMocks();
      return value;
    };
    expect(labelWidth(1100)).toBe("380px");
    expect(labelWidth(800)).toBe("320px");
    expect(labelWidth(700)).toBe("240px");
  });

  it("масштаб растягивает дорожку, а не окно", () => {
    const { container, rerender } = render(<TraceWaterfall {...props({ zoom: 1 })} />);
    const content = container.querySelector<HTMLElement>("[data-trace-content]")!;
    const before = parseFloat(content.style.width);
    rerender(<TraceWaterfall {...props({ zoom: 2 })} />);
    const after = parseFloat(container.querySelector<HTMLElement>("[data-trace-content]")!.style.width);
    expect(after - before).toBeCloseTo(960 - 320 - 72, 0);
  });

  it("окно времени ставит начало выбранного участка у левого края", () => {
    const { container } = render(
      <TraceWaterfall {...props({ rows: build(fixture().tree, expandAll()), window: { fromMs: T0 + 1_500_000, toMs: T0 + 1_509_700 } })} />,
    );
    expect(parseFloat(barOf(container, id("b1", 1)).style.left)).toBeCloseTo(0, 3);
    expect(parseFloat(barOf(container, id("b1", 1)).style.width)).toBeGreaterThan(500);
  });

  it("выделение мышью на оси передаёт участок, короткий клик его не передаёт", () => {
    const onWindowChange = vi.fn();
    const { container } = render(<TraceWaterfall {...props({ onWindowChange })} />);
    const axis = container.querySelector<HTMLElement>("[data-trace-axis-bar]")!;
    vi.spyOn(axis, "getBoundingClientRect").mockReturnValue({ left: 100, right: 668, top: 0, bottom: 28, width: 568, height: 28, x: 100, y: 0, toJSON: () => ({}) });
    fireEvent.mouseDown(axis, { clientX: 200, button: 0 });
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseUp(window, { clientX: 400 });
    expect(onWindowChange).toHaveBeenCalledTimes(1);
    const range = onWindowChange.mock.calls[0]![0] as { fromMs: number; toMs: number };
    expect(range.toMs).toBeGreaterThan(range.fromMs);

    fireEvent.mouseDown(axis, { clientX: 200, button: 0 });
    fireEvent.mouseUp(window, { clientX: 203 });
    expect(onWindowChange).toHaveBeenCalledTimes(1);
  });
});

describe("TraceWaterfall: выбор и клавиши", () => {
  it("клик по строке выбирает её, шеврон сворачивает и не выбирает", () => {
    const p = props();
    const { container } = render(<TraceWaterfall {...p} />);
    fireEvent.click(row(container, id("c1", 16)));
    expect(p.onSelect).toHaveBeenCalledWith(id("c1", 16));
    fireEvent.click(within(row(container, id("c1", 1))).getByRole("button", { name: "Свернуть" }));
    expect(p.onCollapseChange).toHaveBeenCalledWith(id("c1", 1), true);
    expect(p.onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row(container, id("b1", 1))).getByRole("button", { name: "Развернуть" }));
    expect(p.onCollapseChange).toHaveBeenLastCalledWith(id("b1", 1), false);
  });

  it("отмечает выбранную строку aria-selected", () => {
    const { container } = render(<TraceWaterfall {...props({ selectedSpanId: id("c1", 16) })} />);
    expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "true");
    expect(row(container, id("c1", 32))).toHaveAttribute("aria-selected", "false");
  });

  it("стрелки двигают выбор, Enter выбирает текущую строку", () => {
    const p = props({ selectedSpanId: id("c1", 16) });
    render(<TraceWaterfall {...p} />);
    const grid = screen.getByRole("treegrid", { name: "Трейс" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("c1", 32));
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("c1", 80));
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("c1", 16));
  });

  it("клавиши j и k работают как стрелки вниз и вверх", () => {
    const p = props({ selectedSpanId: id("c1", 16) });
    render(<TraceWaterfall {...p} />);
    const grid = screen.getByRole("treegrid", { name: "Трейс" });
    fireEvent.keyDown(grid, { key: "j" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("c1", 32));
    fireEvent.keyDown(grid, { key: "k" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("c1", 80));
  });

  it("Escape сообщает странице", () => {
    const p = props();
    render(<TraceWaterfall {...p} />);
    fireEvent.keyDown(screen.getByRole("treegrid", { name: "Трейс" }), { key: "Escape" });
    expect(p.onEscape).toHaveBeenCalledTimes(1);
  });

  it("полоса подписана названием, длительностью и временем начала", () => {
    const { container } = render(<TraceWaterfall {...props({ rows: build(fixture().tree, expandAll()) })} />);
    const title = barOf(container, id("b1", 16)).getAttribute("title")!;
    expect(title).toMatch(/^Вызов модели, 2,6 с, \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it("без выбора стрелка вниз берёт первую строку, стрелка вверх последнюю", () => {
    const p = props();
    render(<TraceWaterfall {...p} />);
    const grid = screen.getByRole("treegrid", { name: "Трейс" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("a1", 1));
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("c1", 65));
  });

  it("стрелка влево сворачивает раскрытый узел, а у листа уходит к родителю; вправо раскрывает", () => {
    const p = props({ selectedSpanId: id("c1", 1) });
    const { rerender } = render(<TraceWaterfall {...p} />);
    const grid = screen.getByRole("treegrid", { name: "Трейс" });
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(p.onCollapseChange).toHaveBeenLastCalledWith(id("c1", 1), true);

    rerender(<TraceWaterfall {...p} selectedSpanId={id("c1", 16)} />);
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("c1", 1));

    rerender(<TraceWaterfall {...p} selectedSpanId={id("b1", 1)} />);
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(p.onCollapseChange).toHaveBeenLastCalledWith(id("b1", 1), false);

    rerender(<TraceWaterfall {...p} selectedSpanId={id("c1", 1)} />);
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(p.onSelect).toHaveBeenLastCalledWith(id("c1", 2));
  });

  it("клавиши [ ] сворачивают и разворачивают всё, o и p раскрывают и сворачивают текущий узел", () => {
    const p = props({ selectedSpanId: id("b1", 1) });
    render(<TraceWaterfall {...p} />);
    const grid = screen.getByRole("treegrid", { name: "Трейс" });
    fireEvent.keyDown(grid, { key: "[" });
    expect(p.onCollapseAll).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(grid, { key: "]" });
    expect(p.onExpandAll).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(grid, { key: "o" });
    expect(p.onCollapseChange).toHaveBeenLastCalledWith(id("b1", 1), false);
    fireEvent.keyDown(grid, { key: "p" });
    expect(p.onCollapseChange).toHaveBeenLastCalledWith(id("b1", 1), true);
  });
});

describe("TraceWaterfall: поиск и подсветка", () => {
  it("подсвечивает совпадения и текущее совпадение", () => {
    const { container } = render(
      <TraceWaterfall {...props({ matchIds: new Set([id("c1", 16), id("c1", 48)]), currentMatchId: id("c1", 48) })} />,
    );
    expect(row(container, id("c1", 16))).toHaveAttribute("data-match", "true");
    expect(row(container, id("c1", 48))).toHaveAttribute("data-match", "current");
    expect(row(container, id("c1", 32))).not.toHaveAttribute("data-match");
  });

  it("приглушает предков найденных узлов", () => {
    const { tree } = fixture();
    const rows = createRowsBuilder()(tree, {
      collapse: AUTO_COLLAPSE,
      filter: { groups: new Set(["tool"]), errorsOnly: false },
      lastRootId: id("c1", 1),
      unloadedTurnIds: new Set(),
    });
    const { container } = render(<TraceWaterfall {...props({ tree, rows })} />);
    expect(row(container, id("b1", 1))).toHaveAttribute("data-dimmed", "true");
    expect(row(container, id("b1", 32))).toHaveAttribute("data-dimmed", "false");
  });
});

describe("TraceWaterfall: окно строк", () => {
  function bigTree(count: number) {
    const tree = new TraceTree();
    tree.upsert(normalizeSpan({ span_id: "root", turn_id: "evt_big", kind: "turn", name: "Большой", start_ms: T0, end_ms: T0 + count * 10 }));
    for (let i = 0; i < count; i += 1) {
      tree.upsert(normalizeSpan({
        span_id: `s${String(i).padStart(6, "0")}`, parent_span_id: "root", turn_id: "evt_big", kind: i % 3 === 0 ? "model_call" : "tool_call",
        name: i % 3 === 0 ? "claude" : "bash", start_ms: T0 + i * 10, end_ms: T0 + i * 10 + 8,
      }));
    }
    return tree;
  }

  it("10 000 строк рисуются окном: в разметке десятки строк, высота списка полная", () => {
    const tree = bigTree(10_000);
    const rows = build(tree, expandAll(), []);
    expect(rows).toHaveLength(10_001);
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows })} />);
    const rendered = container.querySelectorAll("[data-trace-row]").length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(60);
    expect(container.querySelector<HTMLElement>("[data-trace-body]")!.style.height).toBe(`${10_001 * 24}px`);
    expect(screen.getByRole("treegrid", { name: "Трейс" })).toHaveAttribute("aria-rowcount", "10002");
  });

  it("прокрутка сдвигает окно строк", () => {
    const tree = bigTree(2_000);
    const rows = build(tree, expandAll(), []);
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows })} />);
    const scroller = container.querySelector<HTMLElement>("[data-trace-scroll]")!;
    expect(container.querySelector(`[data-span-id="s001000"]`)).toBeNull();
    Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 24 * 1_000, writable: true });
    fireEvent.scroll(scroller);
    expect(container.querySelector(`[data-span-id="s000995"]`)).not.toBeNull();
    expect(container.querySelector(`[data-span-id="s000010"]`)).toBeNull();
    expect(container.querySelectorAll("[data-trace-row]").length).toBeLessThan(60);
  });

  it("5000 спанов: окно строк держит число узлов в разметке постоянным", () => {
    const tree = bigTree(5_000);
    const rows = build(tree, expandAll(), []);
    const start = performance.now();
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows })} />);
    const elapsed = performance.now() - start;
    expect(container.querySelectorAll("[data-trace-row]").length).toBeLessThan(60);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("запрос показать узел прокручивает его к середине окна", () => {
    const tree = bigTree(2_000);
    const rows = build(tree, expandAll(), []);
    const { container, rerender } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows })} />);
    const scroller = container.querySelector<HTMLElement>("[data-trace-scroll]")!;
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    rerender(<TraceWaterfall {...props({ tree, revision: tree.revision, rows, revealRequest: { spanId: "s001500", seq: 1 } })} />);
    const index = rows.findIndex((r) => r.span.span_id === "s001500");
    expect(top).toBeGreaterThan(index * 24 - 480);
    expect(top).toBeLessThan(index * 24 + 24);
    expect(container.querySelector(`[data-span-id="s001500"]`)).not.toBeNull();
  });

  it("выбранная строка за пределами окна подводится в видимую часть", () => {
    const tree = bigTree(2_000);
    const rows = build(tree, expandAll(), []);
    const { container, rerender } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows })} />);
    const scroller = container.querySelector<HTMLElement>("[data-trace-scroll]")!;
    let top = 0;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    rerender(<TraceWaterfall {...props({ tree, revision: tree.revision, rows, selectedSpanId: "s000900" })} />);
    const index = rows.findIndex((r) => r.span.span_id === "s000900");
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThanOrEqual(index * 24);
  });
});

describe("TraceWaterfall: слежение за последней строкой", () => {
  const offsets = new WeakMap<Element, number>();
  function trackScrollTop() {
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get(this: Element) { return offsets.get(this) ?? 0; },
      set(this: Element, value: number) { offsets.set(this, value); },
    });
  }
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { scrollTop?: number }).scrollTop;
  });

  function manyRows(count: number) {
    const tree = new TraceTree();
    tree.upsert(normalizeSpan({ span_id: "root", turn_id: "evt_f", kind: "turn", name: "Ход", start_ms: T0, end_ms: null, status: "running" }));
    for (let i = 0; i < count; i += 1) {
      tree.upsert(normalizeSpan({ span_id: `f${String(i).padStart(4, "0")}`, parent_span_id: "root", turn_id: "evt_f", kind: "tool_call", name: "bash", start_ms: T0 + i * 10, end_ms: T0 + i * 10 + 5 }));
    }
    return { tree, rows: build(tree, expandAll(), []) };
  }

  it("при слежении прокручивает список к последней строке", () => {
    trackScrollTop();
    const { tree, rows } = manyRows(100);
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows, follow: true })} />);
    const scroller = container.querySelector<HTMLElement>("[data-trace-scroll]")!;
    expect(scroller.scrollTop).toBe(101 * 24 - (480 - 28));
  });

  it("без слежения список остаётся на месте", () => {
    trackScrollTop();
    const { tree, rows } = manyRows(100);
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows, follow: false })} />);
    expect(container.querySelector<HTMLElement>("[data-trace-scroll]")!.scrollTop).toBe(0);
  });

  it("прокрутка колесом вверх отключает слежение, прокрутка вниз нет", () => {
    const { tree, rows } = manyRows(100);
    const onUserScroll = vi.fn();
    const { container } = render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows, follow: true, onUserScroll })} />);
    const scroller = container.querySelector<HTMLElement>("[data-trace-scroll]")!;
    fireEvent.wheel(scroller, { deltaY: 40 });
    expect(onUserScroll).not.toHaveBeenCalled();
    fireEvent.wheel(scroller, { deltaY: -40 });
    expect(onUserScroll).toHaveBeenCalledTimes(1);
  });
});

describe("TraceWaterfall: телефон", () => {
  it("длительность стоит вне группы подписи: длинная подпись обрезается, а время остаётся видно", () => {
    const { container } = render(<TraceWaterfall {...props({ phone: true })} />);
    const call = row(container, id("c1", 1));
    const main = call.querySelector("[data-trace-phone-main]")!;
    expect(main).toBeInTheDocument();
    expect(main.textContent).toContain("Ход 3");
    expect(main.querySelector("[data-trace-duration]")).toBeNull();
    expect(call.querySelector("[data-trace-duration]")!.textContent).toBe("≈ 30,6 с");
  });

  it("без водопада: подпись, длительность и полоса доли от хода, без оси и горизонтальной прокрутки", () => {
    const { container } = render(<TraceWaterfall {...props({ phone: true })} />);
    expect(screen.queryByRole("columnheader", { name: "Шкала времени" })).toBeNull();
    const call = row(container, id("c1", 16));
    expect(call).toHaveAttribute("data-phone", "true");
    expect(call.querySelector("[data-trace-duration]")!.textContent).toBe("≈ 2,5 с");
    const share = call.querySelector<HTMLElement>("[data-trace-share]")!;
    const percent = parseFloat(share.style.width);
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThanOrEqual(100);
    expect(percent).toBeCloseTo((2_500 / 30_600) * 100, 0);
    expect(container.querySelector("[data-trace-bar]")).toBeNull();
    expect(container.querySelector<HTMLElement>("[data-trace-content]")!.style.width).toBe("100%");
  });
});

describe("TraceWaterfall: пустой список", () => {
  it("не падает без строк", () => {
    const tree = new TraceTree();
    render(<TraceWaterfall {...props({ tree, revision: tree.revision, rows: [], summaries: new Map() })} />);
    expect(screen.getByRole("treegrid", { name: "Трейс" })).toBeInTheDocument();
  });
});
