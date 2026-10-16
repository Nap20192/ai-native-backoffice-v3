import { describe, expect, it } from "vitest";
import overviewFixture from "../mocks/trace-pi-turn.json";
import { normalizeSpan, parseOverview, type TraceSpan } from "./trace-api";
import {
  AUTO_COLLAPSE,
  NO_FILTER,
  TraceTree,
  axisTicks,
  barGeometry,
  buildTraceScale,
  collapseAll,
  createRowsBuilder,
  expandAll,
  isErrorSpan,
  isFilterActive,
  kindGroup,
  lastRootEnd,
  matchesFilter,
  mergeMatches,
  primaryEventOf,
  noDataGaps,
  revealSpan,
  rowWindow,
  searchTree,
  setCollapsed,
  toggleCollapse,
  type RowsContext,
  type TraceFilter,
  type TraceKindGroup,
} from "./trace-tree";

const id = (prefix: string, n: number) => prefix + n.toString(16).padStart(14, "0");
const T0 = 1_792_150_000_000;

function sp(spanId: string, over: Partial<TraceSpan> = {}): TraceSpan {
  return normalizeSpan({ span_id: spanId, kind: "event", name: spanId, start_ms: 0, ...over });
}

function fixtureTree(): TraceTree {
  const overview = parseOverview(overviewFixture);
  const tree = new TraceTree();
  for (const turn of overview.turns) tree.upsert(turn.turn);
  for (const span of overview.spans) tree.upsert(span);
  return tree;
}

const lastRootId = id("c1", 1);
function ctx(over: Partial<RowsContext> = {}): RowsContext {
  return { collapse: AUTO_COLLAPSE, filter: NO_FILTER, lastRootId, unloadedTurnIds: new Set(["evt_a1"]), ...over };
}
const filterOf = (groups: TraceKindGroup[], errorsOnly = false): TraceFilter => ({
  groups: new Set(groups),
  errorsOnly,
});

describe("TraceTree: построение", () => {
  it("кладёт ходы в корни и вкладывает остальные узлы по parent_span_id", () => {
    const tree = fixtureTree();
    expect(tree.size).toBe(27 + 1);
    expect(tree.roots.map((root) => root.span.turn_id)).toEqual(["evt_a1", "evt_b1", "evt_c1"]);
    const turnB = tree.get(id("b1", 1))!;
    expect(turnB.children.map((child) => child.span.kind)).toEqual([
      "sandbox", "model_call", "tool_call", "tool_call", "event", "model_call",
    ]);
    expect(tree.get(id("b1", 3))!.depth).toBe(2);
    expect(tree.get(id("b1", 3))!.parent!.span.kind).toBe("sandbox");
  });

  it("держит детей по порядку (start_ms, span_id), одинаковое начало решает span_id", () => {
    const tree = fixtureTree();
    const calls = tree.get(id("b1", 1))!.children.filter((child) => child.span.kind === "tool_call");
    expect(calls.map((call) => call.span.span_id)).toEqual([id("b1", 32), id("b1", 34)]);
  });

  it("вкладывает сабагента под вызов инструмента, а его ходы под сабагента", () => {
    const tree = fixtureTree();
    const model = tree.get(id("c1", 35))!;
    expect(model.depth).toBe(4);
    expect(tree.ancestors(model.span.span_id).map((node) => node.span.kind)).toEqual([
      "turn", "tool_call", "subagent", "turn",
    ]);
    expect(tree.get(id("c1", 33))!.span.thread_id).toBe("sthr_researcher");
  });
});

describe("TraceTree: запись строк", () => {
  it("заменяет строку при большем version и отбрасывает равный и меньший", () => {
    const tree = new TraceTree();
    expect(tree.upsert(sp("a", { version: 2, name: "новый" }))).toBe("inserted");
    expect(tree.upsert(sp("a", { version: 2, name: "тот же version" }))).toBe("ignored");
    expect(tree.upsert(sp("a", { version: 1, name: "старый" }))).toBe("ignored");
    expect(tree.get("a")!.span.name).toBe("новый");
    expect(tree.upsert(sp("a", { version: 3, name: "ещё новее" }))).toBe("replaced");
    expect(tree.get("a")!.span.name).toBe("ещё новее");
  });

  it("удаляет строку с deleted и не даёт старой строке воскресить её", () => {
    const tree = new TraceTree();
    tree.upsert(sp("a", { version: 2 }));
    expect(tree.upsert(sp("a", { version: 3, deleted: true }))).toBe("removed");
    expect(tree.get("a")).toBeUndefined();
    expect(tree.roots).toHaveLength(0);
    expect(tree.upsert(sp("a", { version: 2 }))).toBe("ignored");
    expect(tree.upsert(sp("a", { version: 4 }))).toBe("inserted");
    expect(tree.upsert(sp("zzz", { version: 1, deleted: true }))).toBe("ignored");
  });

  it("переносит узел вместе с детьми при новом parent_span_id", () => {
    const tree = new TraceTree();
    tree.upsert(sp("root", { kind: "turn", start_ms: 0 }));
    tree.upsert(sp("p1", { parent_span_id: "root", start_ms: 1 }));
    tree.upsert(sp("p2", { parent_span_id: "root", start_ms: 2 }));
    tree.upsert(sp("kid", { parent_span_id: "p1", start_ms: 3 }));
    expect(tree.get("kid")!.depth).toBe(2);

    tree.upsert(sp("p1", { parent_span_id: "p2", start_ms: 1, version: 2 }));

    expect(tree.get("root")!.children.map((node) => node.span.span_id)).toEqual(["p2"]);
    expect(tree.get("p2")!.children.map((node) => node.span.span_id)).toEqual(["p1"]);
    expect(tree.get("p1")!.depth).toBe(2);
    expect(tree.get("kid")!.depth).toBe(3);
  });

  it("пересортирует соседей, когда у узла изменилось start_ms", () => {
    const tree = new TraceTree();
    tree.upsert(sp("root", { kind: "turn" }));
    tree.upsert(sp("x", { parent_span_id: "root", start_ms: 10 }));
    tree.upsert(sp("y", { parent_span_id: "root", start_ms: 20 }));
    tree.upsert(sp("x", { parent_span_id: "root", start_ms: 30, version: 2 }));
    expect(tree.get("root")!.children.map((node) => node.span.span_id)).toEqual(["y", "x"]);
  });

  it("хранит ребёнка без родителя и цепляет его, когда родитель приходит", () => {
    const tree = new TraceTree();
    tree.upsert(sp("kid", { parent_span_id: "late", start_ms: 5 }));
    expect(tree.roots).toHaveLength(0);
    expect(tree.orphanCount()).toBe(1);
    tree.upsert(sp("late", { kind: "turn", start_ms: 1 }));
    expect(tree.orphanCount()).toBe(0);
    expect(tree.get("late")!.children.map((node) => node.span.span_id)).toEqual(["kid"]);
    expect(tree.get("kid")!.depth).toBe(1);
  });

  it("не образует цикл и считает такие узлы неприкреплёнными", () => {
    const tree = new TraceTree();
    tree.upsert(sp("a", { parent_span_id: "b" }));
    tree.upsert(sp("b", { parent_span_id: "a" }));
    tree.upsert(sp("self", { parent_span_id: "self" }));
    expect(tree.roots).toHaveLength(0);
    expect(tree.orphanCount()).toBeGreaterThanOrEqual(2);
    expect(tree.ancestors("a")).toEqual([]);
  });

  it("при удалении родителя оставляет детей неприкреплёнными до нового родителя", () => {
    const tree = new TraceTree();
    tree.upsert(sp("root", { kind: "turn" }));
    tree.upsert(sp("mid", { parent_span_id: "root", start_ms: 1 }));
    tree.upsert(sp("kid", { parent_span_id: "mid", start_ms: 2 }));
    tree.upsert(sp("mid", { parent_span_id: "root", deleted: true, version: 2 }));
    expect(tree.get("root")!.children).toHaveLength(0);
    expect(tree.orphanCount()).toBe(1);
    tree.upsert(sp("kid", { parent_span_id: "root", start_ms: 2, version: 2 }));
    expect(tree.orphanCount()).toBe(0);
    expect(tree.get("root")!.children.map((node) => node.span.span_id)).toEqual(["kid"]);
  });

  it("растит revision и rev предков только у затронутой ветки", () => {
    const tree = fixtureTree();
    const rootB = tree.get(id("b1", 1))!;
    const rootC = tree.get(id("c1", 1))!;
    const revB = rootB.rev;
    const revC = rootC.rev;
    const revision = tree.revision;
    tree.upsert(sp(id("c1", 16), { ...tree.get(id("c1", 16))!.span, ttft_ms: 99, version: 10 }));
    expect(tree.revision).toBeGreaterThan(revision);
    expect(rootC.rev).toBeGreaterThan(revC);
    expect(rootB.rev).toBe(revB);
    expect(tree.get(id("c1", 1))!.rev).toBe(rootC.rev);
  });
});

describe("kindGroup, фильтр и ошибки", () => {
  it("раскладывает виды по группам чипов", () => {
    expect(kindGroup("turn")).toBe("turn");
    expect(kindGroup("model_call")).toBe("model");
    expect(kindGroup("acp_prompt")).toBe("model");
    expect(kindGroup("tool_call")).toBe("tool");
    expect(kindGroup("tool_exec")).toBe("tool");
    expect(kindGroup("hook")).toBe("tool");
    expect(kindGroup("subagent")).toBe("subagent");
    expect(kindGroup("sandbox")).toBe("sandbox");
    expect(kindGroup("sandbox_phase")).toBe("sandbox");
    expect(kindGroup("harness_start")).toBe("sandbox");
    expect(kindGroup("tool_wait")).toBe("wait");
    expect(kindGroup("retry_wait")).toBe("wait");
    expect(kindGroup("event")).toBeNull();
    expect(kindGroup("compaction")).toBeNull();
  });

  it("isErrorSpan: статус error и событие «Ошибка»", () => {
    expect(isErrorSpan(sp("a", { status: "error" }))).toBe(true);
    expect(isErrorSpan(sp("b", { kind: "event", name: "Ошибка" }))).toBe(true);
    expect(isErrorSpan(sp("b2", { kind: "event", name: "error" }))).toBe(true);
    expect(isErrorSpan(sp("c", { status: "denied" }))).toBe(false);
    expect(isErrorSpan(sp("d", { status: "ok" }))).toBe(false);
  });

  it("matchesFilter соединяет группы по ИЛИ, а «только ошибки» по И", () => {
    const tool = sp("t", { kind: "tool_call", status: "error" });
    const model = sp("m", { kind: "model_call" });
    expect(isFilterActive(NO_FILTER)).toBe(false);
    expect(matchesFilter(model, NO_FILTER)).toBe(true);
    expect(matchesFilter(model, filterOf(["tool"]))).toBe(false);
    expect(matchesFilter(model, filterOf(["tool", "model"]))).toBe(true);
    expect(matchesFilter(tool, filterOf(["tool"], true))).toBe(true);
    expect(matchesFilter(sp("t2", { kind: "tool_call" }), filterOf(["tool"], true))).toBe(false);
    expect(isFilterActive(filterOf([], true))).toBe(true);
  });
});

describe("строки списка", () => {
  const ids = (rows: Array<{ span: TraceSpan }>) => rows.map((row) => row.span.span_id);

  it("по умолчанию раскрыт последний ход, старые и ветки сабагентов свёрнуты", () => {
    const rows = createRowsBuilder()(fixtureTree(), ctx());
    expect(ids(rows)).toEqual([
      id("a1", 1), id("b1", 1), id("c1", 1),
      id("c1", 2), id("c1", 80), id("c1", 16), id("c1", 32), id("c1", 33),
      id("c1", 48), id("c1", 64), id("c1", 65),
    ]);
    const byId = new Map(rows.map((row) => [row.span.span_id, row]));
    expect(byId.get(id("a1", 1))).toMatchObject({ depth: 0, expandable: true, collapsed: true });
    expect(byId.get(id("b1", 1))).toMatchObject({ expandable: true, collapsed: true });
    expect(byId.get(id("c1", 1))).toMatchObject({ expandable: true, collapsed: false });
    expect(byId.get(id("c1", 33))).toMatchObject({ depth: 2, expandable: true, collapsed: true });
    expect(byId.get(id("c1", 2))).toMatchObject({ depth: 1, expandable: false, collapsed: false });
  });

  it("ход A без загруженных детей раскрывается только как незагруженный", () => {
    const rows = createRowsBuilder()(fixtureTree(), ctx({ unloadedTurnIds: new Set() }));
    expect(rows[0]).toMatchObject({ span: expect.objectContaining({ turn_id: "evt_a1" }), expandable: false });
  });

  it("«Развернуть всё» показывает каждый узел, «Свернуть всё» только ходы", () => {
    const build = createRowsBuilder();
    const tree = fixtureTree();
    expect(build(tree, ctx({ collapse: expandAll() }))).toHaveLength(tree.size);
    const collapsed = build(tree, ctx({ collapse: collapseAll() }));
    expect(ids(collapsed)).toEqual([id("a1", 1), id("b1", 1), id("c1", 1)]);
  });

  it("явное свёртывание узла перекрывает правило по умолчанию", () => {
    const build = createRowsBuilder();
    const tree = fixtureTree();
    const open = toggleCollapse(AUTO_COLLAPSE, id("b1", 1), true);
    const rows = build(tree, ctx({ collapse: open }));
    expect(ids(rows)).toContain(id("b1", 16));
    expect(rows.find((row) => row.span.span_id === id("b1", 1))!.collapsed).toBe(false);
    const closed = setCollapsed(open, id("c1", 1), true);
    expect(ids(build(tree, ctx({ collapse: closed }))).filter((spanId) => spanId.startsWith("c1"))).toEqual([id("c1", 1)]);
  });

  it("revealSpan раскрывает всех предков узла", () => {
    const build = createRowsBuilder();
    const tree = fixtureTree();
    const target = id("c1", 36);
    expect(ids(build(tree, ctx()))).not.toContain(target);
    const revealed = revealSpan(AUTO_COLLAPSE, tree, target);
    expect(ids(build(tree, ctx({ collapse: revealed })))).toContain(target);
  });

  it("фильтр по группе показывает найденные узлы и приглушённых предков, без свёрнутости по умолчанию", () => {
    const rows = createRowsBuilder()(fixtureTree(), ctx({ filter: filterOf(["tool"]) }));
    const byId = new Map(rows.map((row) => [row.span.span_id, row]));
    expect(byId.has(id("a1", 1))).toBe(false);
    expect(byId.get(id("b1", 32))!.dimmed).toBe(false);
    expect(byId.get(id("b1", 33))!.dimmed).toBe(false);
    expect(byId.get(id("c1", 36))!.dimmed).toBe(false);
    expect(byId.get(id("b1", 1))!.dimmed).toBe(true);
    expect(byId.get(id("c1", 33))!.dimmed).toBe(true);
    expect(byId.get(id("c1", 34))!.dimmed).toBe(true);
    expect(byId.has(id("b1", 16))).toBe(false);
  });

  it("«только ошибки» оставляет упавшие узлы и путь к ним", () => {
    const rows = createRowsBuilder()(fixtureTree(), ctx({ filter: filterOf([], true) }));
    expect(ids(rows)).toEqual([
      id("b1", 1), id("b1", 34), id("b1", 35),
      id("c1", 1), id("c1", 32), id("c1", 33), id("c1", 34), id("c1", 36), id("c1", 37),
    ]);
    const dimmed = rows.filter((row) => row.dimmed).map((row) => row.span.span_id);
    expect(dimmed).toEqual([id("b1", 1), id("c1", 1), id("c1", 32), id("c1", 33), id("c1", 34)]);
  });

  it("пересобирает только изменившийся корень и отдаёт те же строки остальных", () => {
    const build = createRowsBuilder();
    const tree = fixtureTree();
    const context = ctx({ collapse: expandAll() });
    const first = build(tree, context);
    tree.upsert(sp(id("c1", 16), { ...tree.get(id("c1", 16))!.span, ttft_ms: 5, version: 10 }));
    const second = build(tree, context);
    const pick = (rows: typeof first, spanId: string) => rows.find((row) => row.span.span_id === spanId);
    expect(pick(second, id("b1", 16))).toBe(pick(first, id("b1", 16)));
    expect(pick(second, id("a1", 1))).toBe(pick(first, id("a1", 1)));
    expect(pick(second, id("c1", 16))).not.toBe(pick(first, id("c1", 16)));
    expect(pick(second, id("c1", 16))!.span.ttft_ms).toBe(5);
  });
});

describe("поиск по загруженным узлам", () => {
  it("находит по имени и инструменту в порядке отображения без учёта регистра", () => {
    expect(searchTree(fixtureTree(), "BASH")).toEqual([id("b1", 32), id("b1", 34)]);
  });

  it("находит по модели, span_id, id события и тексту ошибки", () => {
    const tree = fixtureTree();
    expect(searchTree(tree, "haiku")).toEqual([id("c1", 35), id("c1", 38)]);
    expect(searchTree(tree, id("c1", 36))).toEqual([id("c1", 36)]);
    expect(searchTree(tree, "evt_b_res2")).toEqual([id("b1", 34)]);
    expect(searchTree(tree, "хост не разрешён")).toEqual([id("c1", 36), id("c1", 37)]);
  });

  it("пустой запрос и запрос из пробелов ничего не находят", () => {
    const tree = fixtureTree();
    expect(searchTree(tree, "")).toEqual([]);
    expect(searchTree(tree, "   ")).toEqual([]);
    expect(searchTree(tree, "нет такого узла")).toEqual([]);
  });

  it("не видит удалённый узел", () => {
    const tree = fixtureTree();
    tree.upsert(sp(id("b1", 32), { ...tree.get(id("b1", 32))!.span, deleted: true, version: 10 }));
    expect(searchTree(tree, "bash")).toEqual([id("b1", 34)]);
  });
});

describe("mergeMatches", () => {
  it("ставит совпадения незагруженных ходов в порядок ходов и не дублирует загруженные", () => {
    const tree = fixtureTree();
    const local = searchTree(tree, "web_search");
    expect(local).toEqual([id("c1", 36)]);
    const merged = mergeMatches(
      tree,
      local,
      [
        { span_id: "a1x", turn_id: "evt_a1", kind: "tool_call", name: "web_search" },
        { span_id: id("c1", 36), turn_id: "evt_c1", kind: "tool_call", name: "web_search" },
      ],
      ["evt_a1", "evt_b1", "evt_c1"],
    );
    expect(merged).toEqual([
      { spanId: "a1x", turnId: "evt_a1", loaded: false },
      { spanId: id("c1", 36), turnId: "evt_c1", loaded: true },
    ]);
  });
});

describe("шкала времени", () => {
  const nowMs = T0 + 1_700_000;
  const A = { start: T0, end: T0 + 4_800 };
  const B = { start: T0 + 1_500_000, end: T0 + 1_509_700 };
  const C = { start: T0 + 1_602_500, end: T0 + 1_633_100 };

  it("сжимает простой длиннее 60 с в 6 px и делит остальную ширину по времени", () => {
    const scale = buildTraceScale(fixtureTree(), { widthPx: 1000, nowMs });
    const linear = 4_800 + 9_700 + 30_600;
    const pxPerMs = (1000 - 12) / linear;
    expect(scale.toX(A.start)).toBeCloseTo(0, 5);
    expect(scale.toX(C.end)).toBeCloseTo(1000, 5);
    expect(scale.toX(A.end)).toBeCloseTo(4_800 * pxPerMs, 3);
    expect(scale.toX(B.start) - scale.toX(A.end)).toBeCloseTo(6, 5);
    expect(scale.toX(C.start) - scale.toX(B.end)).toBeCloseTo(6, 5);
    expect(scale.idleGaps).toHaveLength(2);
    expect(scale.idleGaps[0]).toMatchObject({ startMs: A.end, endMs: B.start, width: 6 });
    expect(scale.pxPerMs).toBeCloseTo(pxPerMs, 8);
  });

  it("не сжимает короткий промежуток до 60 с", () => {
    const tree = new TraceTree();
    tree.upsert(sp("a", { kind: "turn", start_ms: 0, end_ms: 1_000 }));
    tree.upsert(sp("b", { kind: "turn", start_ms: 31_000, end_ms: 32_000 }));
    const scale = buildTraceScale(tree, { widthPx: 640, nowMs: 40_000 });
    expect(scale.idleGaps).toEqual([]);
    expect(scale.toX(16_000)).toBeCloseTo(320, 3);
  });

  it("обратное преобразование возвращает исходное время", () => {
    const scale = buildTraceScale(fixtureTree(), { widthPx: 1000, nowMs });
    for (const ms of [A.start, A.start + 1_234, B.start + 5_000, C.start + 20_000, C.end]) {
      expect(scale.toMs(scale.toX(ms))).toBeCloseTo(ms, 0);
    }
    expect(scale.toX(B.start + 1_000)).toBeGreaterThan(scale.toX(B.start));
  });

  it("окно показывает только выбранный участок на всю ширину", () => {
    const scale = buildTraceScale(fixtureTree(), { widthPx: 800, nowMs, window: { fromMs: B.start, toMs: B.end } });
    expect(scale.toX(B.start)).toBeCloseTo(0, 5);
    expect(scale.toX(B.end)).toBeCloseTo(800, 5);
    expect(scale.toX(B.start + 4_850)).toBeCloseTo(400, 3);
    expect(scale.toX(A.end)).toBeLessThan(0);
    expect(scale.toX(C.start)).toBeGreaterThan(800);
    expect(scale.idleGaps).toEqual([]);
  });

  it("открытый корень тянется до текущего времени", () => {
    const tree = new TraceTree();
    tree.upsert(sp("a", { kind: "turn", start_ms: 0, end_ms: null, status: "running" }));
    const scale = buildTraceScale(tree, { widthPx: 500, nowMs: 10_000 });
    expect(scale.toX(0)).toBe(0);
    expect(scale.toX(10_000)).toBeCloseTo(500, 5);
  });

  it("пустое дерево и ход нулевой длины не ломают шкалу", () => {
    expect(buildTraceScale(new TraceTree(), { widthPx: 400, nowMs: 5 }).toX(100)).toBe(0);
    const tree = new TraceTree();
    tree.upsert(sp("a", { kind: "turn", start_ms: 100, end_ms: 100 }));
    const scale = buildTraceScale(tree, { widthPx: 400, nowMs: 100 });
    expect(Number.isFinite(scale.toX(100))).toBe(true);
    expect(Number.isFinite(scale.toMs(0))).toBe(true);
  });

  it("риски оси идут по возрастанию внутри ширины и не теснятся", () => {
    const scale = buildTraceScale(fixtureTree(), { widthPx: 1000, nowMs });
    const ticks = axisTicks(scale, { minGapPx: 80 });
    expect(ticks.length).toBeGreaterThan(2);
    expect(ticks.length).toBeLessThan(40);
    for (let i = 1; i < ticks.length; i += 1) {
      expect(ticks[i]!.x).toBeGreaterThan(ticks[i - 1]!.x);
    }
    for (const tick of ticks) {
      expect(tick.x).toBeGreaterThanOrEqual(0);
      expect(tick.x).toBeLessThanOrEqual(1000);
      expect(tick.label).toMatch(/^\d{2}:\d{2}:\d{2}(\.\d{3})?$/);
    }
  });

  it("риски не заходят ближе края, чем ширина подписи", () => {
    const scale = buildTraceScale(fixtureTree(), { widthPx: 1000, nowMs });
    const all = axisTicks(scale, { minGapPx: 80 });
    const trimmed = axisTicks(scale, { minGapPx: 80, labelWidthPx: 100 });
    expect(trimmed.length).toBeLessThan(all.length);
    expect(trimmed.every((tick) => tick.x + 100 <= 1000)).toBe(true);
    expect(trimmed).toEqual(all.filter((tick) => tick.x + 100 <= 1000));
  });

  it("риски на узком окне показывают миллисекунды", () => {
    const scale = buildTraceScale(fixtureTree(), { widthPx: 800, nowMs, window: { fromMs: B.start, toMs: B.start + 400 } });
    const ticks = axisTicks(scale, { minGapPx: 80 });
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.every((tick) => /\.\d{3}$/.test(tick.label))).toBe(true);
  });
});

describe("barGeometry", () => {
  const nowMs = T0 + 1_700_000;
  const scale = buildTraceScale(fixtureTree(), { widthPx: 1000, nowMs });
  const geometryCtx = { nowMs, lastTurnEndMs: T0 + 1_633_100 };

  it("закрытый узел занимает от начала до конца", () => {
    const span = fixtureTree().get(id("b1", 16))!.span;
    const bar = barGeometry(span, scale, geometryCtx);
    expect(bar.left).toBeCloseTo(scale.toX(span.start_ms), 5);
    expect(bar.width).toBeCloseTo(scale.toX(span.end_ms!) - scale.toX(span.start_ms), 5);
    expect(bar).toMatchObject({ open: false, waiting: false, point: false });
  });

  it("очень короткий узел получает минимальную ширину 2 px", () => {
    const span = sp("s", { kind: "sandbox_phase", start_ms: T0 + 10, end_ms: T0 + 11 });
    expect(barGeometry(span, scale, geometryCtx).width).toBe(2);
  });

  it("идущий узел тянется до текущего времени и помечен открытым", () => {
    const span = sp("r", { kind: "model_call", status: "running", start_ms: T0 + 1_699_000, end_ms: null });
    const bar = barGeometry(span, scale, geometryCtx);
    expect(bar.open).toBe(true);
    expect(bar.left + bar.width).toBeCloseTo(scale.toX(nowMs), 5);
  });

  it("ждущий узел тянется только до конца последнего хода", () => {
    const span = fixtureTree().get(id("c1", 64))!.span;
    const bar = barGeometry(span, scale, geometryCtx);
    expect(bar.waiting).toBe(true);
    expect(bar.open).toBe(false);
    expect(bar.left + bar.width).toBeCloseTo(scale.toX(T0 + 1_633_100), 5);
  });

  it("мгновенный узел рисуется точкой", () => {
    const span = fixtureTree().get(id("c1", 80))!.span;
    expect(barGeometry(span, scale, geometryCtx)).toMatchObject({ point: true, width: 0 });
  });
});

describe("noDataGaps", () => {
  it("находит участки хода без детей длиннее 500 мс", () => {
    const tree = new TraceTree();
    tree.upsert(sp("t", { kind: "turn", start_ms: 0, end_ms: 10_000 }));
    tree.upsert(sp("s", { parent_span_id: "t", kind: "sandbox", start_ms: 0, end_ms: 900 }));
    tree.upsert(sp("e", { parent_span_id: "t", kind: "event", start_ms: 9_900, end_ms: 9_900 }));
    expect(noDataGaps(tree.get("t")!, { nowMs: 20_000, minMs: 500 })).toEqual([{ startMs: 900, endMs: 9_900 }]);
  });

  it("не рисует промежутки короче порога и учитывает перекрытие детей", () => {
    const tree = new TraceTree();
    tree.upsert(sp("t", { kind: "turn", start_ms: 0, end_ms: 2_000 }));
    tree.upsert(sp("a", { parent_span_id: "t", kind: "tool_call", start_ms: 0, end_ms: 900 }));
    tree.upsert(sp("b", { parent_span_id: "t", kind: "tool_call", start_ms: 500, end_ms: 1_700 }));
    expect(noDataGaps(tree.get("t")!, { nowMs: 5_000, minMs: 500 })).toEqual([]);
  });

  it("ход без детей целиком без данных, открытый ход считается до текущего времени", () => {
    const tree = new TraceTree();
    tree.upsert(sp("t", { kind: "turn", start_ms: 0, end_ms: null, status: "running" }));
    expect(noDataGaps(tree.get("t")!, { nowMs: 3_000, minMs: 500 })).toEqual([{ startMs: 0, endMs: 3_000 }]);
  });
});

describe("rowWindow", () => {
  it("считает окно видимых строк с запасом", () => {
    expect(rowWindow({ scrollTop: 0, viewportHeight: 240, rowHeight: 24, total: 1000, overscan: 3 })).toEqual({ start: 0, end: 13 });
    expect(rowWindow({ scrollTop: 2400, viewportHeight: 240, rowHeight: 24, total: 1000, overscan: 3 })).toEqual({ start: 97, end: 113 });
    expect(rowWindow({ scrollTop: 99_999, viewportHeight: 240, rowHeight: 24, total: 1000, overscan: 3 })).toEqual({ start: 987, end: 1000 });
  });

  it("пустой список и нулевая высота дают пустое окно", () => {
    expect(rowWindow({ scrollTop: 0, viewportHeight: 240, rowHeight: 24, total: 0, overscan: 3 })).toEqual({ start: 0, end: 0 });
  });
});

describe("lastRootEnd", () => {
  it("берёт конец последнего по времени хода, открытый ход считается до текущего времени", () => {
    const tree = fixtureTree();
    expect(lastRootEnd(tree, T0 + 5_000_000)).toBe(T0 + 1_633_100);
    tree.upsert(sp("open", { kind: "turn", start_ms: T0 + 1_700_000, end_ms: null, status: "running" }));
    expect(lastRootEnd(tree, T0 + 1_750_000)).toBe(T0 + 1_750_000);
  });

  it("у пустого дерева возвращает текущее время", () => {
    expect(lastRootEnd(new TraceTree(), 42)).toBe(42);
  });
});

describe("primaryEventOf", () => {
  it("берёт событие самого узла", () => {
    expect(primaryEventOf(fixtureTree().get(id("b1", 32))!)).toBe("evt_b_use1");
    expect(primaryEventOf(fixtureTree().get(id("b1", 16))!)).toBe("evt_b_mrs1");
  });

  it("у выполнения и ожидания инструмента без своего события берёт событие вызова", () => {
    const tree = fixtureTree();
    expect(tree.get(id("b1", 33))!.span.primary_event_id).toBeNull();
    expect(primaryEventOf(tree.get(id("b1", 33))!)).toBe("evt_b_use1");
    expect(primaryEventOf(tree.get(id("c1", 65))!)).toBe("evt_c_use3");
  });

  it("у остальных узлов без события его нет: фаза песочницы не подменяется событием хода", () => {
    const tree = fixtureTree();
    expect(primaryEventOf(tree.get(id("b1", 3))!)).toBeNull();
    expect(primaryEventOf(tree.get(id("b1", 2))!)).toBeNull();
  });
});
