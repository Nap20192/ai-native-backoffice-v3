import { describe, expect, it, vi } from "vitest";
import changesFixture from "../mocks/trace-changes.json";
import overviewFixture from "../mocks/trace-pi-turn.json";
import {
  normalizeSpan,
  normalizeTurn,
  parseChangesPage,
  parseOverview,
  type TraceChangesPage,
  type TraceClient,
  type TraceSpan,
} from "./trace-api";
import { TraceStore, createTraceSync, searchRemote, type RemoteSearchProgress } from "./trace-store";

const id = (prefix: string, n: number) => prefix + n.toString(16).padStart(14, "0");
const T0 = 1_792_150_000_000;

function span(spanId: string, over: Partial<TraceSpan> = {}): TraceSpan {
  return normalizeSpan({ span_id: spanId, kind: "event", name: spanId, start_ms: T0, ...over });
}

function loadedStore(): TraceStore {
  const store = new TraceStore("sesn_01TRACEFIXTURE");
  store.applyOverview(parseOverview(overviewFixture));
  return store;
}

describe("TraceStore: первый ответ", () => {
  it("кладёт сводки, строки и курсор, помечает загруженными ходы с поддеревом", () => {
    const store = loadedStore();
    const state = store.getSnapshot();
    expect(state.ready).toBe(true);
    expect(state.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(state.turns.map((turn) => turn.turn.turn_id)).toEqual(["evt_a1", "evt_b1", "evt_c1"]);
    expect([...state.loadedTurnIds].sort()).toEqual(["evt_b1", "evt_c1"]);
    expect(state.loadingTurnIds.size).toBe(0);
    expect(state.tree.size).toBe(28);
    expect(state.tree.get(id("a1", 1))).toBeDefined();
    expect(state.cursor).toBe(overviewFixture.cursor);
    expect(state.turnsBefore).toBeNull();
    expect(state.collecting).toBe(false);
  });

  it("при spans_next держит ходы в загрузке, пока остаток не дочитан", () => {
    const store = new TraceStore("s");
    const overview = parseOverview({ ...overviewFixture, spans_next: "rest" });
    const loading = store.applyOverview(overview);
    expect(loading.sort()).toEqual(["evt_b1", "evt_c1"]);
    expect(store.getSnapshot().loadedTurnIds.size).toBe(0);
    expect([...store.getSnapshot().loadingTurnIds].sort()).toEqual(["evt_b1", "evt_c1"]);
    store.finishLoad(loading);
    expect([...store.getSnapshot().loadedTurnIds].sort()).toEqual(["evt_b1", "evt_c1"]);
    expect(store.getSnapshot().loadingTurnIds.size).toBe(0);
  });

  it("повторный ответ не плодит строки, а новая сессия очищает дерево", () => {
    const store = loadedStore();
    store.applyOverview(parseOverview(overviewFixture));
    expect(store.getSnapshot().tree.size).toBe(28);
    store.reset("other");
    expect(store.getSnapshot().tree.size).toBe(0);
    expect(store.getSnapshot().ready).toBe(false);
    expect(store.getSnapshot().sessionId).toBe("other");
  });
});

describe("TraceStore: подписка", () => {
  it("отдаёт один и тот же снимок между изменениями и уведомляет подписчиков", () => {
    const store = new TraceStore("s");
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.applyOverview(parseOverview(overviewFixture));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    off();
    store.applyOverview(parseOverview({ ...overviewFixture, collecting: true }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("не уведомляет, если страница изменений ничего не изменила", () => {
    const store = loadedStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.applyChanges({ spans: [], turns: [], cursor: "same", more: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().cursor).toBe("same");
    const snapshot = store.getSnapshot();
    store.applyChanges({ spans: [], turns: [], cursor: "same", more: false });
    expect(store.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("TraceStore: изменения ?after", () => {
  it("применяет фикстуру изменений: version, удаление, перенос, чужой ход, новый ход", () => {
    const store = loadedStore();
    store.applyChanges(parseChangesPage(changesFixture));
    const { tree, turns } = store.getSnapshot();

    expect(tree.get(id("c1", 16))!.span).toMatchObject({ ttft_ms: 710, version: 3 });
    expect(tree.get(id("b1", 16))!.span.model).toBe("claude-sonnet-4-5");
    expect(tree.get(id("b1", 35))).toBeUndefined();
    expect(tree.get(id("b1", 80))!.parent!.span.span_id).toBe(id("b1", 32));
    expect(tree.get(id("b1", 32))!.children.map((node) => node.span.span_id)).toContain(id("b1", 80));
    expect(tree.get(id("b1", 1))!.children.map((node) => node.span.span_id)).not.toContain(id("b1", 80));
    expect(tree.get(id("a2", 1))).toBeUndefined();

    expect(tree.get(id("c1", 64))!.span.status).toBe("running");
    expect(tree.get(id("c1", 65))!.span).toMatchObject({ status: "ok" });
    expect(tree.get(id("c1", 66))!.parent!.span.span_id).toBe(id("c1", 64));

    expect(turns.map((turn) => turn.turn.turn_id)).toEqual(["evt_a1", "evt_b1", "evt_c1", "evt_d1"]);
    expect(turns[2]).toMatchObject({ version: 7, waiting_count: 0, state: "complete" });
    expect(store.getSnapshot().loadedTurnIds.has("evt_d1")).toBe(true);
    expect(tree.get(id("d1", 2))!.parent!.span.span_id).toBe(id("d1", 1));
    expect(tree.roots.map((root) => root.span.turn_id)).toEqual(["evt_a1", "evt_b1", "evt_c1", "evt_d1"]);

    expect(store.getSnapshot().cursor).toBe(changesFixture.cursor);
    expect(store.getSnapshot().collecting).toBe(true);
  });

  it("больший version сводки заменяет старую, меньший отбрасывается", () => {
    const store = loadedStore();
    const stale = normalizeTurn({
      turn: { ...overviewFixture.turns[1]!.turn, version: 1 },
      state: "open",
      version: 1,
    });
    store.applyChanges({ spans: [], turns: [stale], cursor: "c", more: false });
    expect(store.getSnapshot().turns[1]!.state).toBe("complete");
  });

  it("признак сбора от сервера главнее расчёта по состояниям ходов", () => {
    const store = loadedStore();
    store.applyChanges({ spans: [], turns: [], cursor: "c1", more: false, collecting: true });
    expect(store.getSnapshot().collecting).toBe(true);
    store.applyChanges({ spans: [], turns: [], cursor: "c2", more: false, collecting: false });
    expect(store.getSnapshot().collecting).toBe(false);
    store.applyChanges({ ...parseChangesPage(changesFixture), collecting: false });
    expect(store.getSnapshot().turns.some((turn) => turn.state === "open")).toBe(true);
    expect(store.getSnapshot().collecting).toBe(false);
  });

  it("applySummary заменяет сводку хода по version и обновляет строку хода в дереве", () => {
    const store = loadedStore();
    const older = overviewFixture.turns[0]!;
    const built = normalizeTurn({ ...older, state: "repaired", span_count: 9, version: 8, turn: { ...older.turn, version: 8, name: "собран" } });
    store.applySummary(built);
    expect(store.getSnapshot().turns[0]).toMatchObject({ state: "repaired", span_count: 9, version: 8 });
    expect(store.getSnapshot().tree.get(id("a1", 1))!.span.name).toBe("собран");
    store.applySummary(normalizeTurn({ ...older, state: "not_built", version: 2, turn: { ...older.turn, version: 2 } }));
    expect(store.getSnapshot().turns[0]!.state).toBe("repaired");
  });

  it("applySummary добавляет сводку неизвестного хода", () => {
    const store = loadedStore();
    const extra = normalizeTurn({ turn: span(id("e1", 1), { kind: "turn", turn_id: "evt_e", start_ms: T0 - 10_000, version: 1 }), state: "complete" });
    store.applySummary(extra);
    expect(store.getSnapshot().turns.map((turn) => turn.turn.turn_id)).toEqual(["evt_e", "evt_a1", "evt_b1", "evt_c1"]);
  });

  it("строки хода без загруженного поддерева отбрасываются, сводка остаётся", () => {
    const store = loadedStore();
    store.applyChanges({
      spans: [span(id("a2", 7), { turn_id: "evt_a1", parent_span_id: id("a1", 1), version: 1 })],
      turns: [],
      cursor: "c",
      more: false,
    });
    expect(store.getSnapshot().tree.get(id("a2", 7))).toBeUndefined();
    expect(store.getSnapshot().turns[0]!.turn.turn_id).toBe("evt_a1");
  });

  it("корневая строка известного, но не загруженного хода обновляется", () => {
    const store = loadedStore();
    const root = overviewFixture.turns[0]!.turn;
    store.applyChanges({
      spans: [normalizeSpan({ ...root, kind: "turn", end_ms: root.start_ms + 9_999, version: 9 } as never)],
      turns: [],
      cursor: "c",
      more: false,
    });
    expect(store.getSnapshot().tree.get(id("a1", 1))!.span.end_ms).toBe(root.start_ms + 9_999);
  });

  it("строки без хода (спаны OTel без привязки) принимаются", () => {
    const store = loadedStore();
    store.applyChanges({ spans: [span("otel-loose", { turn_id: null, version: 1 })], turns: [], cursor: "c", more: false });
    expect(store.getSnapshot().tree.get("otel-loose")).toBeDefined();
  });
});

describe("TraceStore: загрузка поддерева и буфер", () => {
  it("изменение, пришедшее во время загрузки хода, ждёт страницы и применяется после неё", () => {
    const store = loadedStore();
    const turnId = "evt_a1";
    const root = id("a1", 1);
    store.beginLoad([turnId]);
    store.applyChanges({
      spans: [span(id("a1", 9), { turn_id: turnId, parent_span_id: root, name: "из изменений", version: 5 })],
      turns: [],
      cursor: "c1",
      more: false,
    });
    expect(store.getSnapshot().tree.get(id("a1", 9))).toBeUndefined();

    store.applySpans([
      span(id("a1", 9), { turn_id: turnId, parent_span_id: root, name: "из страницы", version: 2 }),
      span(id("a1", 10), { turn_id: turnId, parent_span_id: root, start_ms: T0 + 5, version: 1 }),
    ]);
    store.finishLoad([turnId]);

    const state = store.getSnapshot();
    expect(state.loadedTurnIds.has(turnId)).toBe(true);
    expect(state.tree.get(id("a1", 9))!.span.name).toBe("из изменений");
    expect(state.tree.get(id("a1", 10))).toBeDefined();
  });

  it("строки неизвестного хода ждут его сводку, даже если она на следующей странице", () => {
    const store = loadedStore();
    store.applyChanges({
      spans: [
        span(id("e1", 1), { turn_id: "evt_e1", kind: "turn", name: "ход E", version: 1 }),
        span(id("e1", 2), { turn_id: "evt_e1", parent_span_id: id("e1", 1), version: 1 }),
      ],
      turns: [],
      cursor: "c1",
      more: true,
    });
    expect(store.getSnapshot().tree.get(id("e1", 2))).toBeUndefined();

    const rootRow = span(id("e1", 1), { turn_id: "evt_e1", kind: "turn", name: "ход E", version: 1 });
    store.applyChanges({
      spans: [],
      turns: [normalizeTurn({ turn: rootRow, state: "open", version: 1 })],
      cursor: "c2",
      more: false,
    });
    expect(store.getSnapshot().tree.get(id("e1", 2))!.parent!.span.span_id).toBe(id("e1", 1));
    expect(store.getSnapshot().loadedTurnIds.has("evt_e1")).toBe(true);
  });

  it("applyTurns добавляет более ранние ходы в начало списка", () => {
    const store = new TraceStore("s");
    const overview = parseOverview(overviewFixture);
    store.applyOverview({ ...overview, turns: overview.turns.slice(1), turns_before: "before-1" });
    expect(store.getSnapshot().turnsBefore).toBe("before-1");
    store.applyTurns({ turns: overview.turns.slice(0, 1), turns_before: null });
    expect(store.getSnapshot().turns.map((turn) => turn.turn.turn_id)).toEqual(["evt_a1", "evt_b1", "evt_c1"]);
    expect(store.getSnapshot().turnsBefore).toBeNull();
    expect(store.getSnapshot().tree.roots[0]!.span.turn_id).toBe("evt_a1");
  });
});

describe("createTraceSync", () => {
  function client(over: Partial<TraceClient> = {}): TraceClient {
    return {
      getOverview: vi.fn(async () => parseOverview(overviewFixture)),
      getTurnsBefore: vi.fn(async () => ({ turns: [], turns_before: null })),
      getTurnPage: vi.fn(async () => ({ spans: [], spans_next: null })),
      getSpansPage: vi.fn(async () => ({ spans: [], spans_next: null })),
      getChanges: vi.fn(async () => ({ spans: [], turns: [], cursor: "next", more: false })),
      search: vi.fn(async () => ({ matches: [], next: null, remaining_turns: 0 })),
      ...over,
    };
  }

  it("init читает первый ответ и дочитывает остаток по spans_next", async () => {
    const store = new TraceStore("s");
    const extra = span(id("c1", 99), { turn_id: "evt_c1", parent_span_id: id("c1", 1), version: 1 });
    const api = client({
      getOverview: vi.fn(async () => parseOverview({ ...overviewFixture, spans_next: "rest-1" })),
      getSpansPage: vi.fn(async (page: string) =>
        page === "rest-1" ? { spans: [], spans_next: "rest-2" } : { spans: [extra], spans_next: null },
      ),
    });
    await createTraceSync({ client: api, store }).init();
    expect(api.getSpansPage).toHaveBeenNthCalledWith(1, "rest-1");
    expect(api.getSpansPage).toHaveBeenNthCalledWith(2, "rest-2");
    const state = store.getSnapshot();
    expect(state.tree.get(id("c1", 99))).toBeDefined();
    expect([...state.loadedTurnIds].sort()).toEqual(["evt_b1", "evt_c1"]);
    expect(state.loadingTurnIds.size).toBe(0);
  });

  it("loadTurn читает страницы поддерева до конца и один раз при повторных вызовах", async () => {
    const store = loadedStore();
    const pages = new Map([
      ["", { spans: [span(id("a1", 2), { turn_id: "evt_a1", parent_span_id: id("a1", 1), version: 1 })], spans_next: "p2" }],
      ["p2", { spans: [span(id("a1", 3), { turn_id: "evt_a1", parent_span_id: id("a1", 1), version: 1 })], spans_next: null }],
    ]);
    const api = client({ getTurnPage: vi.fn(async (_turn: string, page?: string | null) => pages.get(page ?? "")!) });
    const sync = createTraceSync({ client: api, store });
    const [first, second] = [sync.loadTurn("evt_a1"), sync.loadTurn("evt_a1")];
    expect(store.getSnapshot().loadingTurnIds.has("evt_a1")).toBe(true);
    await Promise.all([first, second]);
    expect(api.getTurnPage).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().loadedTurnIds.has("evt_a1")).toBe(true);
    expect(store.getSnapshot().tree.get(id("a1", 3))).toBeDefined();
    await sync.loadTurn("evt_a1");
    expect(api.getTurnPage).toHaveBeenCalledTimes(2);
  });

  it("после ошибки загрузки ход снова можно загрузить", async () => {
    const store = loadedStore();
    const getTurnPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("сеть"))
      .mockResolvedValueOnce({ spans: [], spans_next: null });
    const sync = createTraceSync({ client: client({ getTurnPage }), store });
    await expect(sync.loadTurn("evt_a1")).rejects.toThrow("сеть");
    expect(store.getSnapshot().loadingTurnIds.size).toBe(0);
    expect(store.getSnapshot().loadedTurnIds.has("evt_a1")).toBe(false);
    await sync.loadTurn("evt_a1");
    expect(store.getSnapshot().loadedTurnIds.has("evt_a1")).toBe(true);
  });

  it("loadTurn берёт свежую сводку хода с первой страницы: не построенный ход перестаёт быть таким", async () => {
    const older = overviewFixture.turns[0]!;
    const built = normalizeTurn({ ...older, state: "repaired", span_count: 3, version: 9, turn: { ...older.turn, version: 9 } });
    const store = new TraceStore("s");
    const overview = parseOverview(overviewFixture);
    store.applyOverview({ ...overview, turns: [normalizeTurn({ ...older, state: "not_built", version: 0, turn: { ...older.turn, version: 0 } }), ...overview.turns.slice(1)] });
    expect(store.getSnapshot().turns[0]!.state).toBe("not_built");
    const getTurnPage = vi.fn(async () => ({ spans: [], spans_next: null, turn: built, collecting: false }));
    await createTraceSync({ client: client({ getTurnPage }), store }).loadTurn("evt_a1");
    expect(store.getSnapshot().turns[0]).toMatchObject({ state: "repaired", version: 9 });
  });

  it("loadOlder читает более ранние ходы по turns_before и ничего не делает без курсора", async () => {
    const store = new TraceStore("s");
    const overview = parseOverview(overviewFixture);
    store.applyOverview({ ...overview, turns: overview.turns.slice(1), turns_before: "tb" });
    const getTurnsBefore = vi.fn(async () => ({ turns: overview.turns.slice(0, 1), turns_before: null }));
    const sync = createTraceSync({ client: client({ getTurnsBefore }), store });
    await sync.loadOlder();
    expect(getTurnsBefore).toHaveBeenCalledWith("tb");
    expect(store.getSnapshot().turns).toHaveLength(3);
    await sync.loadOlder();
    expect(getTurnsBefore).toHaveBeenCalledTimes(1);
  });

  it("poll идёт по курсору и читает страницы, пока more", async () => {
    const store = loadedStore();
    const answers: TraceChangesPage[] = [
      { spans: [span(id("c1", 16), { ...store.getSnapshot().tree.get(id("c1", 16))!.span, ttft_ms: 1, version: 20 })], turns: [], cursor: "cur-2", more: true },
      { spans: [], turns: [], cursor: "cur-3", more: false },
    ];
    const getChanges = vi.fn(async () => answers.shift()!);
    const sync = createTraceSync({ client: client({ getChanges }), store });
    await sync.poll();
    expect(getChanges).toHaveBeenNthCalledWith(1, overviewFixture.cursor);
    expect(getChanges).toHaveBeenNthCalledWith(2, "cur-2");
    expect(store.getSnapshot().cursor).toBe("cur-3");
    expect(store.getSnapshot().tree.get(id("c1", 16))!.span.ttft_ms).toBe(1);
  });

  it("poll не запускается без курсора и не удваивает запросы", async () => {
    const store = new TraceStore("s");
    const getChanges = vi.fn(async () => ({ spans: [], turns: [], cursor: "x", more: false }) as TraceChangesPage);
    const sync = createTraceSync({ client: client({ getChanges }), store });
    await sync.poll();
    expect(getChanges).not.toHaveBeenCalled();

    store.applyOverview(parseOverview(overviewFixture));
    await Promise.all([sync.poll(), sync.poll(), sync.poll()]);
    // Первый запрос идёт сразу, остальные сливаются в один повтор.
    expect(getChanges.mock.calls.length).toBeLessThanOrEqual(2);
    expect(getChanges.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("после dispose ответы больше не попадают в стор", async () => {
    const store = new TraceStore("s");
    let release: (value: ReturnType<typeof parseOverview>) => void = () => {};
    const getOverview = vi.fn(() => new Promise<ReturnType<typeof parseOverview>>((resolve) => { release = resolve; }));
    const sync = createTraceSync({ client: client({ getOverview }), store });
    const init = sync.init();
    sync.dispose();
    release(parseOverview(overviewFixture));
    await init;
    expect(store.getSnapshot().ready).toBe(false);
  });

  it("init пробрасывает ошибку первого запроса", async () => {
    const store = new TraceStore("s");
    const sync = createTraceSync({
      client: client({ getOverview: vi.fn(async () => { throw new Error("нет доступа"); }) }),
      store,
    });
    await expect(sync.init()).rejects.toThrow("нет доступа");
    expect(store.getSnapshot().ready).toBe(false);
  });
});

describe("searchRemote", () => {
  const match = (spanId: string, turnId = "evt_a1") => ({ span_id: spanId, turn_id: turnId, kind: "tool_call", name: "grep" });

  it("собирает совпадения со всех страниц next без повторов", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ matches: [match("a"), match("b")], next: "n1", remaining_turns: 0 })
      .mockResolvedValueOnce({ matches: [match("b"), match("c")], next: null, remaining_turns: 0 });
    const progress: RemoteSearchProgress[] = [];
    const found = await searchRemote({ search }, "grep", { isCancelled: () => false, onProgress: (p) => progress.push(p), retryDelayMs: 0 });
    expect(found.map((item) => item.span_id)).toEqual(["a", "b", "c"]);
    expect(search).toHaveBeenNthCalledWith(1, "grep", null);
    expect(search).toHaveBeenNthCalledWith(2, "grep", "n1");
    expect(progress.at(-1)).toMatchObject({ done: true, remainingTurns: 0 });
  });

  it("повторяет запрос, пока сервер достраивает ходы, и сообщает остаток", async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce({ matches: [match("a")], next: null, remaining_turns: 800 })
      .mockResolvedValueOnce({ matches: [match("a"), match("b")], next: null, remaining_turns: 300 })
      .mockResolvedValueOnce({ matches: [match("a"), match("b")], next: null, remaining_turns: 0 });
    const remaining: number[] = [];
    const found = await searchRemote({ search }, "grep", {
      isCancelled: () => false,
      onProgress: (p) => remaining.push(p.remainingTurns),
      retryDelayMs: 0,
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(remaining).toEqual([800, 300, 0]);
    expect(found.map((item) => item.span_id)).toEqual(["a", "b"]);
  });

  it("проходит поиск заново, если сервер достроил старый ход, когда курсор уже ушёл вперёд", async () => {
    // Сервер отдаёт по одному совпадению в порядке начала узла. Старый ход он достраивает во втором запросе.
    const nodes = [
      { key: 1, turn: "evt_old", match: match("old", "evt_old") },
      { key: 2, turn: "evt_new", match: match("new1", "evt_new") },
      { key: 3, turn: "evt_new", match: match("new2", "evt_new") },
    ];
    let requests = 0;
    const search = vi.fn(async (_query: string, after: string | null) => {
      requests += 1;
      const built = requests >= 2;
      const rest = nodes.filter((node) => (built || node.turn !== "evt_old") && node.key > (after === null ? 0 : Number(after)));
      const page = rest.slice(0, 1);
      return {
        matches: page.map((node) => node.match),
        next: rest.length > 1 ? String(page[0]!.key) : null,
        remaining_turns: built ? 0 : 1,
      };
    });
    const progress: RemoteSearchProgress[] = [];
    const found = await searchRemote({ search }, "grep", { isCancelled: () => false, onProgress: (p) => progress.push(p), retryDelayMs: 0 });
    expect(found.map((item) => item.span_id).sort()).toEqual(["new1", "new2", "old"]);
    expect(search).toHaveBeenNthCalledWith(3, "grep", null);
    expect(progress.at(-1)).toMatchObject({ done: true, remainingTurns: 0 });
  });

  it("считает застой по проходам, когда совпадения идут несколькими страницами", async () => {
    const search = vi.fn(async (_query: string, after: string | null) =>
      after === null
        ? { matches: [match("a")], next: "n1", remaining_turns: 5 }
        : { matches: [match("b")], next: null, remaining_turns: 5 });
    const progress: RemoteSearchProgress[] = [];
    const found = await searchRemote({ search }, "x", { isCancelled: () => false, onProgress: (p) => progress.push(p), retryDelayMs: 0, stallLimit: 3 });
    expect(search.mock.calls.length).toBeLessThanOrEqual(8);
    expect(found.map((item) => item.span_id)).toEqual(["a", "b"]);
    expect(progress.at(-1)).toMatchObject({ done: true, remainingTurns: 5 });
  });

  it("останавливается, когда число недостроенных ходов не двигается", async () => {
    const search = vi.fn(async () => ({ matches: [match("a")], next: null, remaining_turns: 5 }));
    const progress: RemoteSearchProgress[] = [];
    await searchRemote({ search }, "x", { isCancelled: () => false, onProgress: (p) => progress.push(p), retryDelayMs: 0, stallLimit: 3 });
    expect(search.mock.calls.length).toBeLessThanOrEqual(5);
    expect(progress.at(-1)).toMatchObject({ done: true, remainingTurns: 5 });
  });

  it("не шлёт результат после отмены", async () => {
    let cancelled = false;
    const search = vi.fn(async () => {
      cancelled = true;
      return { matches: [match("a")], next: "n1", remaining_turns: 0 };
    });
    const onProgress = vi.fn();
    await searchRemote({ search }, "x", { isCancelled: () => cancelled, onProgress, retryDelayMs: 0 });
    expect(search).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
