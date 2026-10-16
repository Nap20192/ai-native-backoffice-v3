import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ModelRequest, ToolCall, TranscriptBlock } from "../../lib/session-stats";
import { formatClockRu, formatMinimapTimeRu } from "./format-ru";
import {
  compressedScale,
  minimapSegments,
  TranscriptMinimap,
  type MinimapSegment,
  type TranscriptMinimapProps,
} from "./TranscriptMinimap";

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

const T0 = Date.UTC(2026, 9, 15, 11, 40, 0);

function request(id: string, startMs: number, endMs: number | null, isError = false): ModelRequest {
  return {
    id,
    startEventId: id,
    endEventId: endMs === null ? null : `${id}-end`,
    threadId: "sthr_primary",
    startMs,
    endMs,
    durationMs: endMs === null ? null : endMs - startMs,
    isError,
  };
}

function toolItem(name: string): Block<"request">["items"][number] {
  const call: ToolCall = {
    useEventId: `use-${name}`,
    resultEventId: null,
    confirmationEventId: null,
    name,
    kind: "builtin",
    input: {},
    output: null,
    isError: false,
    status: "completed",
    startMs: null,
    endMs: null,
    durationMs: null,
    waitingMs: 0,
    threadId: "sthr_primary",
    requestId: null,
  };
  return { kind: "tool", call };
}

function requestBlock(
  id: string,
  startMs: number,
  endMs: number | null,
  items: Block<"request">["items"] = [],
  isError = false,
): Block<"request"> {
  return {
    kind: "request",
    id,
    atMs: startMs,
    eventIds: [id],
    request: request(id, startMs, endMs, isError),
    endMs,
    thinking: false,
    thoughtMs: null,
    items,
  };
}

function userBlock(id: string, atMs: number, text = "Привет"): Block<"user"> {
  return { kind: "user", id, atMs, eventIds: [id], eventId: id, text, status: "processed", wakeup: false };
}

function errorBlock(id: string, atMs: number): Block<"error"> {
  return {
    kind: "error",
    id,
    atMs,
    eventIds: [id],
    eventId: id,
    message: "Песочница не запустилась",
    errorType: null,
    retrying: false,
  };
}

const outcomeBlock: Block<"outcome_defined"> = {
  kind: "outcome_defined",
  id: "out",
  atMs: T0 + 5_000,
  eventIds: ["out"],
  eventId: "out",
  outcome: {
    outcomeId: "o1",
    eventId: "out",
    description: "Отчёт",
    rubric: { type: "text", content: "Критерии" },
    maxIterations: 3,
    definedAtMs: T0 + 5_000,
    evaluations: [],
  },
};

const gradingBlock: Block<"grading"> = {
  kind: "grading",
  id: "grade",
  atMs: T0 + 30_000,
  eventIds: ["grade"],
  eventId: "grade",
  outcomeId: "o1",
  evaluation: {
    iteration: 0,
    result: "needs_revision",
    explanation: "Доработать",
    startEventId: null,
    endEventId: "grade",
    startMs: null,
    atMs: T0 + 30_000,
  },
  index: 0,
  count: 1,
};

describe("minimapSegments", () => {
  it("запрос даёт отрезок от начала до конца с текстом ответа в подписи", () => {
    const blocks = [
      requestBlock("r1", T0, T0 + 8_100, [{ kind: "text", eventId: "m1", text: "Разберу вопрос на части и начну." }]),
    ];

    expect(minimapSegments(blocks)).toEqual([
      {
        blockId: "r1",
        eventId: "r1",
        kind: "request",
        startMs: T0,
        endMs: T0 + 8_100,
        label: "Разберу вопрос на части и начну.",
      },
    ]);
  });

  it("без текста подпись «Вызвал <инструмент>»", () => {
    const [segment] = minimapSegments([requestBlock("r1", T0, T0 + 57_700, [toolItem("write")])]);

    expect(segment?.label).toBe("Вызвал write");
  });

  it("длинный текст в подписи обрезается многоточием", () => {
    const [segment] = minimapSegments([
      requestBlock("r1", T0, T0 + 1_000, [{ kind: "text", eventId: "m", text: "а".repeat(200) }]),
    ]);

    expect(segment!.label.length).toBeLessThanOrEqual(61);
    expect(segment!.label.endsWith("…")).toBe(true);
  });

  it("запрос с ошибкой модели получает вид «error»", () => {
    const [segment] = minimapSegments([requestBlock("r1", T0, T0 + 1_000, [], true)]);

    expect(segment?.kind).toBe("error");
  });

  it("реплика, результат, оценка и ошибка сессии дают короткие метки", () => {
    const segments = minimapSegments([
      userBlock("u1", T0, "Вопрос про реакторы"),
      outcomeBlock,
      gradingBlock,
      errorBlock("e1", T0 + 40_000),
    ]);

    expect(segments.map((segment) => [segment.kind, segment.startMs === segment.endMs])).toEqual([
      ["user", true],
      ["outcome", true],
      ["grading", true],
      ["error", true],
    ]);
    expect(segments[0]?.label).toBe("Вопрос про реакторы");
    expect(segments[1]?.label).toBe("Задан результат");
    expect(segments[2]?.label).toBe("Оценка, итерация 1");
    expect(segments[3]?.label).toBe("Песочница не запустилась");
  });

  it("оценка с известным началом идёт отрезком от начала до конца, как светлые полосы образца", () => {
    const graded: Block<"grading"> = {
      ...gradingBlock,
      evaluation: { ...gradingBlock.evaluation, startEventId: "grade-start", startMs: T0 + 10_000 },
    };

    expect(minimapSegments([graded])[0]).toMatchObject({
      kind: "grading",
      startMs: T0 + 10_000,
      endMs: T0 + 30_000,
    });
  });

  it("разрыв времени, предупреждение и блоки без времени отрезков не дают", () => {
    const blocks: TranscriptBlock[] = [
      { kind: "gap", id: "gap", atMs: T0, eventIds: [], gapMs: 5_000_000 },
      { kind: "warning", id: "w", atMs: T0, eventIds: ["w"], eventId: "w", source: "agent", message: "Осторожно" },
      { ...userBlock("u-no-time", T0), atMs: null },
    ];

    expect(minimapSegments(blocks)).toEqual([]);
  });

  it("запрос без конца помечен открытым", () => {
    const [segment] = minimapSegments([requestBlock("r1", T0, null)]);

    expect(segment).toMatchObject({ open: true, startMs: T0, endMs: T0 });
  });
});

const seg = (blockId: string, startMs: number, endMs: number, kind: MinimapSegment["kind"] = "request"): MinimapSegment => ({
  blockId,
  eventId: blockId,
  kind,
  startMs,
  endMs,
  label: blockId,
});

describe("compressedScale", () => {
  const HOUR = 3_600_000;
  const segments = [
    seg("a", T0, T0 + 10_000),
    seg("b", T0 + 10_000, T0 + 20_000),
    seg("c", T0 + 14 * HOUR, T0 + 14 * HOUR + 10_000),
  ];

  it("ширина дорожки равна ширине колонки на масштаб", () => {
    expect(compressedScale(segments, { widthPx: 800, zoom: 1 }).width).toBe(800);
    expect(compressedScale(segments, { widthPx: 800, zoom: 4 }).width).toBe(3200);
  });

  it("простой в 14 часов занимает 6 px, а работа делит остаток по времени", () => {
    const scale = compressedScale(segments, { widthPx: 806, zoom: 1 });

    expect(scale.toX(T0)).toBeCloseTo(0, 5);
    // 20 с работы до простоя и 10 с после: на 800 px приходится 30 с.
    expect(scale.toX(T0 + 20_000)).toBeCloseTo((800 * 20) / 30, 5);
    expect(scale.toX(T0 + 14 * HOUR) - scale.toX(T0 + 20_000)).toBeCloseTo(6, 5);
    expect(scale.toX(T0 + 14 * HOUR + 10_000)).toBeCloseTo(806, 5);
  });

  it("зазор короче 60 с остаётся линейным", () => {
    const scale = compressedScale([seg("a", T0, T0 + 10_000), seg("b", T0 + 50_000, T0 + 60_000)], {
      widthPx: 600,
      zoom: 1,
    });

    expect(scale.toX(T0 + 50_000) - scale.toX(T0 + 10_000)).toBeCloseTo(400, 5);
  });

  it("toMs возвращает время по позиции, в том числе внутри сжатого зазора", () => {
    const scale = compressedScale(segments, { widthPx: 806, zoom: 2 });

    for (const ms of [T0, T0 + 7_000, T0 + 20_000, T0 + 7 * HOUR, T0 + 14 * HOUR + 4_000]) {
      expect(scale.toMs(scale.toX(ms))).toBeCloseTo(ms, 0);
    }
  });

  it("позиция не убывает с ростом времени и не выходит за края", () => {
    const scale = compressedScale(segments, { widthPx: 500, zoom: 1 });
    const xs = [T0 - 5_000, T0, T0 + 12_345, T0 + HOUR, T0 + 14 * HOUR, T0 + 15 * HOUR].map(scale.toX);

    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBe(500);
  });

  it("открытый отрезок тянется до «сейчас»", () => {
    const open: MinimapSegment = { ...seg("r", T0, T0), open: true };
    const scale = compressedScale([seg("u", T0 - 10_000, T0 - 10_000, "user"), open], {
      widthPx: 400,
      zoom: 1,
      nowMs: T0 + 10_000,
    });

    expect(scale.toX(T0 + 10_000)).toBeCloseTo(400, 5);
    expect(scale.toX(T0)).toBeCloseTo(200, 5);
  });

  it("без отрезков даёт ноль, без ошибок", () => {
    const scale = compressedScale([], { widthPx: 400, zoom: 1 });

    expect(scale.toX(T0)).toBe(0);
    expect(scale.toMs(100)).toBe(0);
  });
});

function setup(overrides: Partial<TranscriptMinimapProps> = {}) {
  const blocks: TranscriptBlock[] = [
    userBlock("u1", T0, "Вопрос"),
    requestBlock("r1", T0 + 1_000, T0 + 58_700, [toolItem("write")]),
    requestBlock("r2", T0 + 60_000, T0 + 65_000, [{ kind: "text", eventId: "m2", text: "Готово, вот итог." }]),
    errorBlock("e1", T0 + 70_000),
  ];
  const props: TranscriptMinimapProps = {
    blocks,
    agentName: "Deep researcher",
    nowMs: null,
    zoom: 1,
    visibleBlockIds: new Set(),
    hoveredBlockId: null,
    selectedBlockId: null,
    matchBlockIds: new Set(),
    onHoverBlock: vi.fn(),
    onSelectBlock: vi.fn(),
    ...overrides,
  };
  const view = render(<TranscriptMinimap {...props} />);
  return { props, ...view };
}

const segmentButtons = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-minimap-segment]"));

describe("TranscriptMinimap", () => {
  it("рисует по отрезку на блок, ошибки красным, запросы синим", () => {
    const { container } = setup();

    const buttons = segmentButtons(container);
    expect(buttons.map((button) => button.dataset.blockId)).toEqual(["u1", "r1", "r2", "e1"]);
    expect(buttons.map((button) => button.dataset.kind)).toEqual(["user", "request", "request", "error"]);
    expect(buttons[1]!.className).toContain("sky");
    expect(buttons[3]!.className).toContain("ddc-dot-danger");
    expect(buttons[0]!.className).toContain("brand");
  });

  it("оценку рисует светло-голубой полосой, как в образце", () => {
    const { container } = setup({ blocks: [gradingBlock] });

    const [grading] = segmentButtons(container);
    expect(grading!.dataset.kind).toBe("grading");
    expect(grading!.className).toContain("bg-sky-200");
    expect(grading!.className).not.toContain("ddc-dot-warning");
  });

  it("называет отрезки для экранного чтения по подписи и времени", () => {
    setup();

    expect(screen.getByRole("button", { name: /Вызвал write/ })).toBeInTheDocument();
  });

  it("клик по отрезку выбирает блок и событие", async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByRole("button", { name: /Вызвал write/ }));

    expect(props.onSelectBlock).toHaveBeenCalledWith("r1", "r1");
  });

  it("наведение показывает карточку с именем агента, длительностью, временем и подписью", async () => {
    const user = userEvent.setup();
    const { props, container } = setup();

    await user.hover(segmentButtons(container)[1]!);

    expect(props.onHoverBlock).toHaveBeenLastCalledWith("r1");
    const card = screen.getByTestId("minimap-card");
    expect(within(card).getByText("Deep researcher")).toBeInTheDocument();
    expect(within(card).getByText("57,7 с")).toBeInTheDocument();
    expect(within(card).getByText("Вызвал write")).toBeInTheDocument();
    expect(within(card).getByText(formatClockRu(T0 + 1_000))).toBeInTheDocument();
  });

  it("карточка в две строки, как в образце: имя, длительность и время сверху, подпись одной строкой", async () => {
    const user = userEvent.setup();
    const { container } = setup();

    await user.hover(segmentButtons(container)[1]!);

    const card = screen.getByTestId("minimap-card");
    const head = within(card).getByText("Deep researcher").parentElement!;
    expect(head).toHaveTextContent("57,7 с");
    expect(head).toHaveTextContent(formatClockRu(T0 + 1_000));
    expect(within(card).getByText("Вызвал write")).toHaveClass("truncate");
    expect(card.style.width).toBe("320px");
  });

  it("карточка метки пользователя называет «Пользователь» без длительности", async () => {
    const user = userEvent.setup();
    const { container } = setup();

    await user.hover(segmentButtons(container)[0]!);

    const card = screen.getByTestId("minimap-card");
    expect(within(card).getByText("Пользователь")).toBeInTheDocument();
    expect(within(card).getByText("Вопрос")).toBeInTheDocument();
  });

  it("уход курсора убирает карточку и снимает подсветку блока", async () => {
    const user = userEvent.setup();
    const { props, container } = setup();

    await user.hover(segmentButtons(container)[1]!);
    await user.unhover(segmentButtons(container)[1]!);

    expect(screen.queryByTestId("minimap-card")).not.toBeInTheDocument();
    expect(props.onHoverBlock).toHaveBeenLastCalledWith(null);
  });

  it("подсвечивает выбранный и наведённый блоки", () => {
    const { container } = setup({ selectedBlockId: "r1", hoveredBlockId: "r2" });

    const buttons = segmentButtons(container);
    expect(buttons[1]).toHaveAttribute("data-selected", "true");
    expect(buttons[1]).toHaveAttribute("aria-current", "true");
    expect(buttons[2]).toHaveAttribute("data-hovered", "true");
    expect(buttons[0]).toHaveAttribute("data-selected", "false");
  });

  it("отмечает совпадения поиска метками под дорожкой", () => {
    const { container } = setup({ matchBlockIds: new Set(["r2"]) });

    const marks = container.querySelectorAll("[data-minimap-match]");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveAttribute("data-block-id", "r2");
  });

  it("рамка показывает видимую часть ленты", () => {
    const { container } = setup({ visibleBlockIds: new Set(["r1", "r2"]) });

    const windowFrame = container.querySelector<HTMLElement>("[data-minimap-window]");
    expect(windowFrame).not.toBeNull();
    const buttons = segmentButtons(container);
    const left = Number.parseFloat(windowFrame!.style.left);
    const width = Number.parseFloat(windowFrame!.style.width);
    expect(left).toBeCloseTo(Number.parseFloat(buttons[1]!.style.left), 3);
    expect(left + width).toBeCloseTo(
      Number.parseFloat(buttons[2]!.style.left) + Number.parseFloat(buttons[2]!.style.width),
      3,
    );
  });

  it("без видимых блоков рамки нет", () => {
    const { container } = setup();

    expect(container.querySelector("[data-minimap-window]")).toBeNull();
  });

  it("масштаб расширяет дорожку: на 4 в четыре раза шире", () => {
    const { container, rerender, props } = setup({ zoom: 1 });
    const track = () => container.querySelector<HTMLElement>("[data-minimap-track]")!;
    const base = Number.parseFloat(track().style.width);

    rerender(<TranscriptMinimap {...props} zoom={4} />);

    expect(Number.parseFloat(track().style.width)).toBeCloseTo(base * 4, 3);
  });

  it("курсор подписан временем в этой точке", () => {
    const { container } = setup();
    const track = container.querySelector<HTMLElement>("[data-minimap-track]")!;
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 720, bottom: 48, width: 720, height: 48, x: 0, y: 0, toJSON() {} }) as DOMRect;

    fireEvent.mouseMove(track, { clientX: 0 });

    expect(screen.getByTestId("minimap-cursor-label")).toHaveTextContent(formatMinimapTimeRu(T0));
  });

  it("без отрезков показывает пустую дорожку без кнопок", () => {
    const { container } = setup({ blocks: [] });

    expect(segmentButtons(container)).toHaveLength(0);
    expect(container.querySelector("[data-minimap-track]")).not.toBeNull();
  });
});
