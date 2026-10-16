import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import changesFixture from "../../../mocks/trace-changes.json";
import overviewFixture from "../../../mocks/trace-pi-turn.json";
import {
  normalizeSpan,
  parseChangesPage,
  parseOverview,
  type TraceClient,
  type TraceSearchPage,
  type TraceSpan,
} from "../../../lib/trace-api";
import type { SessionEvent } from "../../../lib/session-stats";
import { TraceView, type TraceViewProps } from "./TraceView";

const id = (prefix: string, n: number) => prefix + n.toString(16).padStart(14, "0");
const T0 = 1_792_150_000_000;
const NOW = T0 + 1_700_000;

const events: SessionEvent[] = [
  { type: "agent.tool_use", id: "evt_b_use1", name: "bash", input: { command: "sleep 0.4" } },
  { type: "agent.tool_result", id: "evt_b_res1", tool_use_id: "evt_b_use1", content: [{ type: "text", text: "ok" }] },
  { type: "agent.tool_use", id: "evt_c_use2", name: "web_search", input: { query: "курс доллара" } },
];

/** Подсчёт хода A, чья выдача по страницам нужна для проверок незагруженного поддерева. */
function olderTurn(): TraceSpan[] {
  const base = { parent_span_id: id("a1", 1), turn_id: "evt_a1", harness: "pi" };
  return [
    normalizeSpan({ ...base, span_id: id("a2", 1), kind: "sandbox", name: "attempt_1", start_ms: T0 + 10, end_ms: T0 + 800, version: 2 }),
    normalizeSpan({
      ...base, span_id: id("a2", 2), kind: "model_call", name: "claude-sonnet-4-5", model: "claude-sonnet-4-5",
      start_ms: T0 + 900, end_ms: T0 + 2_900, primary_event_id: "evt_a_mrs1", event_ids: ["evt_a_mrs1"], version: 2,
    }),
    normalizeSpan({
      ...base, span_id: id("a2", 3), kind: "tool_call", name: "read_file", start_ms: T0 + 2_900, end_ms: T0 + 3_200,
      tool: { name: "read_file", call_id: "toolu_a1", kind: "builtin", mcp_server: null },
      primary_event_id: "evt_a_use1", event_ids: ["evt_a_use1"], version: 2,
    }),
  ];
}

function makeClient(over: Partial<TraceClient> = {}) {
  return {
    getOverview: vi.fn(async () => parseOverview(overviewFixture)),
    getTurnsBefore: vi.fn(async () => ({ turns: [], turns_before: null })),
    getTurnPage: vi.fn(async (turnId: string) => ({ spans: turnId === "evt_a1" ? olderTurn() : [], spans_next: null })),
    getSpansPage: vi.fn(async () => ({ spans: [], spans_next: null })),
    getChanges: vi.fn(async () => ({ spans: [], turns: [], cursor: "next", more: false })),
    search: vi.fn(async (): Promise<TraceSearchPage> => ({ matches: [], next: null, remaining_turns: 0 })),
    ...over,
  } satisfies TraceClient;
}

function renderView(over: Partial<TraceViewProps> = {}, clientOver: Partial<TraceClient> = {}) {
  const client = makeClient(clientOver);
  const props: TraceViewProps = {
    sessionId: "sesn_01TRACEFIXTURE",
    events,
    selection: { eventId: null, source: "url", seq: 0 },
    onSelectEvent: vi.fn(),
    onShowInTranscript: vi.fn(),
    running: false,
    client,
    now: () => NOW,
    pollIntervalMs: 20,
    searchDebounceMs: 0,
    ...over,
  };
  const utils = render(<TraceView {...props} />);
  return { ...utils, client, props, rerenderWith: (next: Partial<TraceViewProps>) => utils.rerender(<TraceView {...props} {...next} />) };
}

const ready = () => screen.findByRole("treegrid", { name: "Трейс" });
const row = (container: HTMLElement, spanId: string) => container.querySelector<HTMLElement>(`[data-span-id="${spanId}"]`)!;
const rowIds = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-trace-row]")].map((el) => el.dataset.spanId);
const searchBox = () => screen.getByRole("searchbox", { name: "Найти в трейсе" });

beforeEach(() => {
  vi.stubGlobal("matchMedia", undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TraceView: загрузка", () => {
  it("показывает загрузку, потом ходы по порядку, последний раскрыт", async () => {
    const { container } = renderView();
    expect(screen.getByText("Загрузка трейса")).toBeInTheDocument();
    await ready();
    expect(rowIds(container)).toEqual([
      id("a1", 1), id("b1", 1), id("c1", 1),
      id("c1", 2), id("c1", 80), id("c1", 16), id("c1", 32), id("c1", 33), id("c1", 48), id("c1", 64), id("c1", 65),
    ]);
    expect(within(row(container, id("c1", 1))).getByText("Ход 3")).toBeInTheDocument();
    expect(screen.queryByText("Загрузка трейса")).toBeNull();
  });

  it("при ошибке показывает «Не удалось загрузить трейс» и повторяет по кнопке", async () => {
    const getOverview = vi.fn().mockRejectedValueOnce(new Error("сеть")).mockResolvedValue(parseOverview(overviewFixture));
    renderView({}, { getOverview });
    expect(await screen.findByText("Не удалось загрузить трейс")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await ready();
    expect(getOverview).toHaveBeenCalledTimes(2);
  });

  it("у сессии без ходов пишет, что трейса пока нет", async () => {
    renderView({}, { getOverview: vi.fn(async () => parseOverview({ ...overviewFixture, turns: [], spans: [] })) });
    expect(await screen.findByText("В этой сессии пока нет трейса")).toBeInTheDocument();
  });

  it("кнопка «Показать более ранние ходы» читает turns_before", async () => {
    const overview = parseOverview(overviewFixture);
    const getTurnsBefore = vi.fn(async () => ({ turns: overview.turns.slice(0, 1), turns_before: null }));
    const { container } = renderView(
      {},
      {
        getOverview: vi.fn(async () => ({ ...overview, turns: overview.turns.slice(1), turns_before: "tb-1" })),
        getTurnsBefore,
      },
    );
    await ready();
    expect(row(container, id("a1", 1))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Показать более ранние ходы" }));
    await waitFor(() => expect(row(container, id("a1", 1))).not.toBeNull());
    expect(getTurnsBefore).toHaveBeenCalledWith("tb-1");
    expect(screen.queryByRole("button", { name: "Показать более ранние ходы" })).toBeNull();
  });
});

describe("TraceView: выбор и детали", () => {
  it("клик по строке выбирает событие узла и открывает детали", async () => {
    const { container, props } = renderView();
    await ready();
    fireEvent.click(row(container, id("c1", 16)));
    expect(props.onSelectEvent).toHaveBeenCalledWith("evt_c_mrs1", "trace");
    expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "true");
    const details = screen.getByRole("region", { name: "Детали узла" });
    expect(within(details).getByRole("heading", { name: "Вызов модели" })).toBeInTheDocument();
  });

  it("узел без события сообщает о выборе без события", async () => {
    const { container, props } = renderView();
    await ready();
    fireEvent.click(row(container, id("c1", 2)));
    expect(props.onSelectEvent).toHaveBeenCalledWith(null, "trace");
    expect(screen.getByRole("button", { name: "В разговоре" })).toBeDisabled();
  });

  it("«В разговоре» передаёт событие узла странице, закрытие прячет детали", async () => {
    const { container, props } = renderView();
    await ready();
    fireEvent.click(row(container, id("c1", 16)));
    fireEvent.click(screen.getByRole("button", { name: "В разговоре" }));
    expect(props.onShowInTranscript).toHaveBeenCalledWith("evt_c_mrs1");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть детали" }));
    expect(screen.queryByRole("region", { name: "Детали узла" })).toBeNull();
    expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "true");
  });

  it("в деталях инструмента виден ввод из событий сессии", async () => {
    const { container } = renderView({ selection: { eventId: "evt_b_use1", source: "events", seq: 1 } });
    await ready();
    await waitFor(() => expect(row(container, id("b1", 32))).not.toBeNull());
    expect(screen.getByRole("region", { name: "Ввод" })).toHaveTextContent("sleep 0.4");
  });

  it("выбор события в инспекторе выделяет его узел и раскрывает предков", async () => {
    const { container, rerenderWith } = renderView();
    await ready();
    expect(row(container, id("b1", 32))).toBeNull();
    rerenderWith({ selection: { eventId: "evt_b_use1", source: "events", seq: 1 } });
    await waitFor(() => expect(row(container, id("b1", 32))).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByText("sleep 0.4")).toBeInTheDocument();
  });

  it("снятие выбора снаружи снимает выделение узла", async () => {
    const { container, rerenderWith } = renderView({ selection: { eventId: "evt_c_mrs1", source: "events", seq: 1 } });
    await ready();
    await waitFor(() => expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "true"));
    rerenderWith({ selection: { eventId: null, source: "events", seq: 2 } });
    await waitFor(() => expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "false"));
  });

  it("после переключения вида вкладка открывается заново и выделяет узел по выбору страницы, сделанному в ней же", async () => {
    const { container } = renderView({ selection: { eventId: "evt_c_mrs1", source: "trace", seq: 3 } });
    await ready();

    await waitFor(() => expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("region", { name: "Детали узла" })).toBeInTheDocument();
  });

  it("выбор из самой вкладки не возвращается обратно и не перебивает локальный выбор", async () => {
    const { container, rerenderWith } = renderView();
    await ready();
    fireEvent.click(row(container, id("c1", 16)));
    rerenderWith({ selection: { eventId: "evt_c_mrs1", source: "trace", seq: 1 } });
    expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "true");
  });
});

describe("TraceView: StrictMode", () => {
  it("двойной запуск эффектов в StrictMode не ломает загрузку и опрос", async () => {
    const client = makeClient();
    const props: TraceViewProps = {
      sessionId: "sesn_01TRACEFIXTURE",
      events,
      selection: { eventId: null, source: "url", seq: 0 },
      onSelectEvent: vi.fn(),
      onShowInTranscript: vi.fn(),
      running: true,
      client,
      now: () => NOW,
      pollIntervalMs: 20,
      searchDebounceMs: 0,
    };
    const { container } = render(
      <StrictMode>
        <TraceView {...props} />
      </StrictMode>,
    );
    await ready();
    expect(row(container, id("c1", 1))).not.toBeNull();
    await waitFor(() => expect(client.getChanges).toHaveBeenCalledWith(overviewFixture.cursor));
  });
});

describe("TraceView: события узлов и клавиши", () => {
  it("у выполнения инструмента без своего события выбирается событие вызова", async () => {
    const { container, props } = renderView();
    await ready();
    fireEvent.click(within(row(container, id("b1", 1))).getByRole("button", { name: "Развернуть" }));
    fireEvent.click(row(container, id("b1", 33)));
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("evt_b_use1", "trace");
    expect(screen.getByRole("button", { name: "В разговоре" })).toBeEnabled();
  });

  it("событие вызова выделяет сам вызов, а не его ожидание с тем же событием, в любом порядке строк", async () => {
    const overview = parseOverview(overviewFixture);
    const { container } = renderView(
      { selection: { eventId: "evt_c_use3", source: "events", seq: 1 } },
      { getOverview: vi.fn(async () => ({ ...overview, spans: [...overview.spans].reverse() })) },
    );
    await ready();
    await waitFor(() => expect(row(container, id("c1", 64))).toHaveAttribute("aria-selected", "true"));
    expect(row(container, id("c1", 65))).toHaveAttribute("aria-selected", "false");
  });

  it("Escape сначала закрывает детали, потом снимает выбор и сообщает странице", async () => {
    const { container, props } = renderView();
    await ready();
    fireEvent.click(row(container, id("c1", 16)));
    const grid = screen.getByRole("treegrid", { name: "Трейс" });
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Детали узла" })).toBeNull();
    expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(grid, { key: "Escape" });
    expect(row(container, id("c1", 16))).toHaveAttribute("aria-selected", "false");
    expect(props.onSelectEvent).toHaveBeenLastCalledWith(null, "trace");
  });

  it("клавиши j и k двигают выбор, как стрелки", async () => {
    const { container } = renderView();
    await ready();
    const grid = screen.getByRole("treegrid", { name: "Трейс" });
    fireEvent.click(row(container, id("c1", 16)));
    fireEvent.keyDown(grid, { key: "j" });
    expect(row(container, id("c1", 32))).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(grid, { key: "k" });
    fireEvent.keyDown(grid, { key: "k" });
    expect(row(container, id("c1", 80))).toHaveAttribute("aria-selected", "true");
  });

  it("поле поиска получает внешнюю ссылку, чтобы страница могла сфокусировать его клавишей /", async () => {
    const searchInputRef = { current: null as HTMLInputElement | null };
    renderView({ searchInputRef });
    await ready();
    expect(searchInputRef.current).toBe(searchBox());
  });
});

describe("TraceView: свёртка и загрузка ходов", () => {
  it("загруженный старый ход раскрывается сразу", async () => {
    const { container } = renderView();
    await ready();
    fireEvent.click(within(row(container, id("b1", 1))).getByRole("button", { name: "Развернуть" }));
    expect(row(container, id("b1", 16))).not.toBeNull();
    expect(row(container, id("b1", 34))).not.toBeNull();
  });

  it("незагруженный ход при раскрытии читает своё поддерево и показывает его", async () => {
    const { container, client } = renderView();
    await ready();
    fireEvent.click(within(row(container, id("a1", 1))).getByRole("button", { name: "Развернуть" }));
    await waitFor(() => expect(row(container, id("a2", 3))).not.toBeNull());
    expect(client.getTurnPage).toHaveBeenCalledWith("evt_a1", null);
    expect(within(row(container, id("a2", 3))).getByText("read_file")).toBeInTheDocument();
  });

  it("не удалась загрузка хода: сообщение и ход снова свёрнут", async () => {
    const getTurnPage = vi.fn().mockRejectedValue(new Error("сеть"));
    const { container } = renderView({}, { getTurnPage });
    await ready();
    fireEvent.click(within(row(container, id("a1", 1))).getByRole("button", { name: "Развернуть" }));
    expect(await screen.findByText("Не удалось загрузить ход. Повторите попытку.")).toBeInTheDocument();
    expect(within(row(container, id("a1", 1))).getByRole("button", { name: "Развернуть" })).toBeInTheDocument();
  });

  it("«Развернуть всё» и «Свернуть всё» меняют список", async () => {
    const { container } = renderView();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Развернуть всё" }));
    expect(row(container, id("b1", 16))).not.toBeNull();
    expect(row(container, id("c1", 36))).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Свернуть всё" }));
    expect(rowIds(container)).toEqual([id("a1", 1), id("b1", 1), id("c1", 1)]);
  });

  it("клавиши ] и [ в списке разворачивают и сворачивают всё", async () => {
    const { container } = renderView();
    await ready();
    const grid = screen.getByRole("treegrid", { name: "Трейс" });
    fireEvent.keyDown(grid, { key: "]" });
    expect(row(container, id("b1", 16))).not.toBeNull();
    fireEvent.keyDown(grid, { key: "[" });
    expect(rowIds(container)).toEqual([id("a1", 1), id("b1", 1), id("c1", 1)]);
  });
});

describe("TraceView: фильтр", () => {
  it("группа «Инструмент» оставляет инструменты и приглушённых предков", async () => {
    const { container } = renderView();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Инструмент" }));
    expect(screen.queryByText("Вызов модели")).toBeNull();
    expect(within(row(container, id("b1", 32))).getByText("bash")).toBeInTheDocument();
    expect(row(container, id("b1", 1))).toHaveAttribute("data-dimmed", "true");
    expect(row(container, id("b1", 32))).toHaveAttribute("data-dimmed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтр" }));
    expect(screen.getAllByText("Вызов модели").length).toBeGreaterThan(0);
  });

  it("«Только ошибки» оставляет упавшие узлы", async () => {
    const { container } = renderView();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Только ошибки" }));
    expect(rowIds(container)).toEqual([
      id("b1", 1), id("b1", 34), id("b1", 35), id("c1", 1), id("c1", 32), id("c1", 33), id("c1", 34), id("c1", 36), id("c1", 37),
    ]);
  });
});

describe("TraceView: поиск", () => {
  it("находит среди загруженных, Enter идёт по совпадениям по кругу и раскрывает предков", async () => {
    const { container, props } = renderView();
    await ready();
    // Текст ошибки есть у вызова и у его выполнения: два совпадения подряд.
    fireEvent.change(searchBox(), { target: { value: "хост не разрешён" } });
    expect(screen.getByTestId("match-counter")).toHaveTextContent("0/2");
    expect(row(container, id("c1", 36))).toBeNull();

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(screen.getByTestId("match-counter")).toHaveTextContent("1/2");
    expect(row(container, id("c1", 36))).toHaveAttribute("aria-selected", "true");
    expect(row(container, id("c1", 36))).toHaveAttribute("data-match", "current");
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("evt_c_use2", "trace");

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(screen.getByTestId("match-counter")).toHaveTextContent("2/2");
    expect(row(container, id("c1", 37))).toHaveAttribute("aria-selected", "true");
    // У выполнения нет своего события, выбирается событие вызова.
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("evt_c_use2", "trace");

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(screen.getByTestId("match-counter")).toHaveTextContent("1/2");
    fireEvent.keyDown(searchBox(), { key: "Enter", shiftKey: true });
    expect(screen.getByTestId("match-counter")).toHaveTextContent("2/2");
  });

  it("запрос без совпадений показывает «0/0», очистка возвращает список", async () => {
    renderView();
    await ready();
    fireEvent.change(searchBox(), { target: { value: "нет такого" } });
    expect(screen.getByTestId("match-counter")).toHaveTextContent("0/0");
    fireEvent.click(screen.getByRole("button", { name: "Очистить поиск" }));
    expect(screen.queryByTestId("match-counter")).toBeNull();
  });

  it("ищет в незагруженных ходах через сервер, при выборе грузит ход и выделяет узел", async () => {
    const search = vi.fn(async (): Promise<TraceSearchPage> => ({
      matches: [{ span_id: id("a2", 3), turn_id: "evt_a1", kind: "tool_call", name: "read_file" }],
      next: null,
      remaining_turns: 0,
    }));
    const { container, client, props } = renderView({}, { search });
    await ready();
    fireEvent.change(searchBox(), { target: { value: "read_file" } });
    await waitFor(() => expect(screen.getByTestId("match-counter")).toHaveTextContent("0/1"));
    expect(search).toHaveBeenCalledWith("read_file", null);
    expect(client.getTurnPage).not.toHaveBeenCalled();

    fireEvent.keyDown(searchBox(), { key: "Enter" });
    await waitFor(() => expect(row(container, id("a2", 3))).toHaveAttribute("aria-selected", "true"));
    expect(client.getTurnPage).toHaveBeenCalledWith("evt_a1", null);
    expect(props.onSelectEvent).toHaveBeenLastCalledWith("evt_a_use1", "trace");
    expect(screen.getByTestId("match-counter")).toHaveTextContent("1/1");
  });

  it("пока сервер достраивает ходы, пишет «ищу: N из M ходов»", async () => {
    let finish: (page: TraceSearchPage) => void = () => {};
    const search = vi
      .fn()
      .mockResolvedValueOnce({ matches: [], next: null, remaining_turns: 2 })
      .mockImplementationOnce(() => new Promise<TraceSearchPage>((resolve) => { finish = resolve; }));
    renderView({}, { search });
    await ready();
    fireEvent.change(searchBox(), { target: { value: "grep" } });
    expect(await screen.findByText("ищу: 1 из 3 ходов")).toBeInTheDocument();
    await act(async () => { finish({ matches: [], next: null, remaining_turns: 0 }); });
    await waitFor(() => expect(screen.queryByText(/^ищу:/)).toBeNull());
  });

  it("если все ходы загружены, сервер не спрашивают", async () => {
    const overview = parseOverview(overviewFixture);
    const { client } = renderView({}, { getOverview: vi.fn(async () => ({ ...overview, turns: overview.turns.slice(1) })) });
    await ready();
    fireEvent.change(searchBox(), { target: { value: "grep" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(client.search).not.toHaveBeenCalled();
  });
});

describe("TraceView: масштаб", () => {
  it("«Весь ход» недоступна без выбора, после выбора включает окно, «Весь трейс» его снимает", async () => {
    const { container } = renderView();
    await ready();
    expect(screen.getByRole("button", { name: "Весь ход" })).toBeDisabled();
    fireEvent.click(row(container, id("c1", 16)));
    fireEvent.click(screen.getByRole("button", { name: "Весь ход" }));
    expect(screen.getByRole("button", { name: "Весь трейс" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Весь трейс" }));
    expect(screen.queryByRole("button", { name: "Весь трейс" })).toBeNull();
  });

  it("«Крупнее» и «Мельче» меняют ширину шкалы", async () => {
    const { container } = renderView();
    await ready();
    const width = () => parseFloat(container.querySelector<HTMLElement>("[data-trace-content]")!.style.width);
    const before = width();
    fireEvent.click(screen.getByRole("button", { name: "Крупнее" }));
    expect(width()).toBeGreaterThan(before);
    fireEvent.click(screen.getByRole("button", { name: "Мельче" }));
    expect(width()).toBe(before);
  });
});

describe("TraceView: живое обновление", () => {
  it("пока сессия идёт, раз в интервал читает изменения и показывает новый ход", async () => {
    const getChanges = vi.fn(async () => parseChangesPage(changesFixture));
    const { container } = renderView({ running: true }, { getChanges });
    await ready();
    await waitFor(() => expect(getChanges).toHaveBeenCalledWith(overviewFixture.cursor));
    await waitFor(() => expect(row(container, id("d1", 1))).not.toBeNull());
    expect(within(row(container, id("d1", 1))).getByText("Ход 4")).toBeInTheDocument();
    expect(row(container, id("d1", 2))).not.toBeNull();
    await waitFor(() => expect(getChanges).toHaveBeenCalledWith(changesFixture.cursor));
  });

  it("не опрашивает, когда сессия не идёт и сбор данных закончен, даже если есть ждущий узел", async () => {
    const { client } = renderView({ running: false });
    await ready();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(client.getChanges).not.toHaveBeenCalled();
  });

  it("опрашивает, пока сервер собирает трейс (collecting), даже когда сессия не идёт", async () => {
    const getOverview = vi.fn(async () => parseOverview({ ...overviewFixture, collecting: true }));
    const { client } = renderView({ running: false }, { getOverview });
    await ready();
    await waitFor(() => expect(client.getChanges).toHaveBeenCalled());
  });

  it("после остановки сессии читает изменения последний раз и затихает", async () => {
    const { client, rerenderWith } = renderView({ running: true });
    await ready();
    await waitFor(() => expect(client.getChanges).toHaveBeenCalled());
    rerenderWith({ running: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const settled = vi.mocked(client.getChanges).mock.calls.length;
    expect(settled).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(vi.mocked(client.getChanges).mock.calls.length).toBe(settled);
  });

  it("событие живого потока вызывает внеочередной запрос через 250 мс", async () => {
    const { client, rerenderWith } = renderView({ pollIntervalMs: 60_000 });
    await ready();
    expect(client.getChanges).not.toHaveBeenCalled();
    rerenderWith({ events: [...events, { type: "span.model_request_start", id: "evt_live" }] });
    await waitFor(() => expect(client.getChanges).toHaveBeenCalledTimes(1), { timeout: 1500 });
  });

  it("событие, не касающееся трейса, запрос не вызывает", async () => {
    const { client, rerenderWith } = renderView({ pollIntervalMs: 60_000 });
    await ready();
    rerenderWith({ events: [...events, { type: "user.message", id: "evt_user", content: "привет" }] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(client.getChanges).not.toHaveBeenCalled();
  });

  it("переключатель «Следить за ходом» виден, пока идёт ход, и выключается прокруткой вверх", async () => {
    renderView({ running: true });
    await ready();
    const toggle = screen.getByRole("button", { name: "Следить за ходом" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.wheel(screen.getByRole("treegrid", { name: "Трейс" }), { deltaY: -50 });
    expect(screen.getByRole("button", { name: "Следить за ходом" })).toHaveAttribute("aria-pressed", "false");
  });

  it("у завершённой сессии переключателя слежения нет", async () => {
    renderView({ running: false });
    await ready();
    expect(screen.queryByRole("button", { name: "Следить за ходом" })).toBeNull();
  });
});

describe("TraceView: подтверждение", () => {
  it("«К вызову» у узла подтверждения переходит к вызову инструмента в прошлом ходе и раскрывает его", async () => {
    const getChanges = vi.fn(async () => parseChangesPage(changesFixture));
    const { container } = renderView({ running: true }, { getChanges });
    await ready();
    await waitFor(() => expect(row(container, id("d1", 2))).not.toBeNull());
    expect(row(container, id("c1", 64))).toBeNull();
    fireEvent.click(row(container, id("d1", 2)));
    fireEvent.click(screen.getByRole("button", { name: "К вызову" }));
    await waitFor(() => expect(row(container, id("c1", 64))).toHaveAttribute("aria-selected", "true"));
  });
});

describe("TraceView: поток сабагента", () => {
  it("кнопка «Открыть поток» передаёт id потока странице", async () => {
    const onOpenThread = vi.fn();
    const { container } = renderView({ onOpenThread });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Развернуть всё" }));
    fireEvent.click(row(container, id("c1", 33)));
    fireEvent.click(screen.getByRole("button", { name: "Открыть поток" }));
    expect(onOpenThread).toHaveBeenCalledWith("sthr_researcher");
  });
});

describe("TraceView: телефон", () => {
  it("на телефоне строки без водопада, детали листом", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { container } = renderView();
    await ready();
    expect(screen.queryByRole("columnheader", { name: "Шкала времени" })).toBeNull();
    expect(row(container, id("c1", 16))).toHaveAttribute("data-phone", "true");
    fireEvent.click(row(container, id("c1", 16)));
    expect(screen.getByRole("region", { name: "Детали узла" })).toHaveAttribute("data-layout", "sheet");
  });
});
