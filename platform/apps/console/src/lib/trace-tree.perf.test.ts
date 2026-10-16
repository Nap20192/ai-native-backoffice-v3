import { describe, expect, it } from "vitest";
import { normalizeSpan, normalizeTurn, parseOverview, type TraceSpan, type TraceTurnSummary } from "./trace-api";
import { TraceStore } from "./trace-store";
import {
  AUTO_COLLAPSE,
  NO_FILTER,
  TraceTree,
  buildTraceScale,
  createRowsBuilder,
  expandAll,
  searchTree,
} from "./trace-tree";

/**
 * Пределы раздела 4.7 плана agent-trace.md на сессии из 200 ходов по 100 узлов
 * (20 000 спанов): построение дерева до 300 мс, применение 200 изменений до
 * 20 мс, поиск по загруженным спанам до 50 мс. Время берём лучшим из нескольких
 * прогонов: ноутбук занят другими задачами, а мы мерим код, а не планировщик.
 */

const T0 = 1_792_150_000_000;
const TURNS = 200;
const PER_TURN = 100;

const hex = (n: number) => n.toString(16).padStart(14, "0");

function makeTurn(index: number): TraceSpan[] {
  const turnId = `evt_${index}`;
  const root = `a1${hex(index * 1000)}`;
  const start = T0 + index * 200_000;
  let clock = start + 10;
  let counter = 1;
  const nextId = () => `a1${hex(index * 1000 + counter++)}`;
  const make = (over: Partial<TraceSpan> & { kind: TraceSpan["kind"] }): TraceSpan =>
    normalizeSpan({ span_id: nextId(), turn_id: turnId, harness: "pi", version: 2, ...over, start_ms: over.start_ms ?? clock } as never);

  const spans: TraceSpan[] = [
    normalizeSpan({
      span_id: root, turn_id: turnId, kind: "turn", name: "Агент", harness: "pi", start_ms: start, end_ms: start + 90_000,
      primary_event_id: turnId, event_ids: [turnId], version: 3,
    }),
  ];
  const sandbox = make({ kind: "sandbox", name: "attempt_1", parent_span_id: root, end_ms: clock + 900 });
  spans.push(sandbox);
  for (let phase = 0; phase < 4; phase += 1) {
    spans.push(make({ kind: "sandbox_phase", name: `phase_${phase}`, parent_span_id: sandbox.span_id, start_ms: clock + phase * 200, end_ms: clock + phase * 200 + 190 }));
  }
  clock += 1_000;
  while (spans.length < PER_TURN - 1) {
    const model = make({
      kind: "model_call", name: "claude-sonnet-4-5", model: "claude-sonnet-4-5", parent_span_id: root,
      start_ms: clock, end_ms: clock + 1_500, primary_event_id: `evt_${index}_m${spans.length}`, event_ids: [`evt_${index}_m${spans.length}`],
    });
    spans.push(model);
    clock += 1_500;
    const call = make({
      kind: "tool_call", name: spans.length % 7 === 0 ? "grep" : "bash", parent_span_id: root,
      start_ms: clock, end_ms: clock + 800, status: spans.length % 11 === 0 ? "error" : "ok",
      error: spans.length % 11 === 0 ? { type: "tool_error", message: "команда завершилась с кодом 1" } : null,
      primary_event_id: `evt_${index}_t${spans.length}`, event_ids: [`evt_${index}_t${spans.length}`],
    });
    spans.push(call);
    if (spans.length < PER_TURN - 1) {
      spans.push(make({ kind: "tool_exec", name: call.name, parent_span_id: call.span_id, start_ms: clock + 20, end_ms: clock + 780 }));
    }
    clock += 800;
  }
  spans.push(make({ kind: "event", name: "Предупреждение", parent_span_id: root, start_ms: clock, end_ms: clock }));
  return spans;
}

function makeTrace(): TraceSpan[] {
  return Array.from({ length: TURNS }, (_, index) => makeTurn(index)).flat();
}

function best(times: number[]): number {
  return Math.min(...times);
}

function measure(runs: number, body: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    body();
    times.push(performance.now() - start);
  }
  return best(times);
}

function shuffled<T>(items: readonly T[]): T[] {
  // Простой детерминированный перемешиватель, чтобы дети приходили раньше родителей.
  const result = [...items];
  let seed = 12345;
  for (let i = result.length - 1; i > 0; i -= 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

const spans = makeTrace();

describe("пределы 4.7 на 20 000 спанах", () => {
  it("фикстура: 200 ходов по 100 спанов", () => {
    expect(spans).toHaveLength(TURNS * PER_TURN);
  });

  it("строит дерево за 300 мс, в порядке прихода и вперемешку", () => {
    const ordered = measure(3, () => {
      const tree = new TraceTree();
      for (const span of spans) tree.upsert(span);
      expect(tree.size).toBe(20_000);
    });
    const mixed = shuffled(spans);
    const random = measure(3, () => {
      const tree = new TraceTree();
      for (const span of mixed) tree.upsert(span);
      expect(tree.size).toBe(20_000);
      expect(tree.orphanCount()).toBe(0);
      expect(tree.roots).toHaveLength(TURNS);
    });
    expect(ordered).toBeLessThan(300);
    expect(random).toBeLessThan(300);
  });

  it("применяет 200 изменений за 20 мс", () => {
    const summaries: TraceTurnSummary[] = Array.from({ length: TURNS }, (_, index) =>
      normalizeTurn({ turn: spans[index * PER_TURN]!, state: "complete", version: 1, span_count: PER_TURN }),
    );
    const times: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const store = new TraceStore("s");
      store.applyOverview(parseOverview({
        trace_id: "t", session_id: "s", turns: summaries, turns_before: null, spans: [], spans_next: null, cursor: "c", collecting: false,
      }));
      store.beginLoad(summaries.map((turn) => turn.turn.turn_id!));
      store.applySpans(spans);
      store.finishLoad(summaries.map((turn) => turn.turn.turn_id!));

      const batch: TraceSpan[] = [];
      for (let i = 0; i < 200; i += 1) {
        const source = spans[(i * 97 + 13) % spans.length]!;
        batch.push({ ...source, version: source.version + 1 + run, status: i % 10 === 0 ? "error" : source.status });
      }
      const start = performance.now();
      store.applyChanges({ spans: batch, turns: [], cursor: `c${run}`, more: false });
      times.push(performance.now() - start);
      expect(store.getSnapshot().tree.size).toBe(20_000);
    }
    expect(best(times)).toBeLessThan(20);
  });

  it("ищет по загруженным спанам за 50 мс, включая холодный первый поиск", () => {
    const times: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      // Свежие копии строк: кэш текста поиска хранится по объекту строки, поиск каждый раз холодный.
      const tree = new TraceTree();
      for (const span of spans) tree.upsert({ ...span });
      const start = performance.now();
      const hits = searchTree(tree, "кодом 1");
      times.push(performance.now() - start);
      expect(hits.length).toBeGreaterThan(100);
    }
    expect(best(times)).toBeLessThan(50);
  });

  it("собирает 20 000 строк целиком, а после правки одного хода пересобирает только его", () => {
    const tree = new TraceTree();
    for (const span of spans) tree.upsert(span);
    const build = createRowsBuilder();
    const context = { collapse: expandAll(), filter: NO_FILTER, lastRootId: null, unloadedTurnIds: new Set<string>() };

    const startAll = performance.now();
    const rows = build(tree, context);
    const full = performance.now() - startAll;
    expect(rows).toHaveLength(20_000);
    expect(full).toBeLessThan(200);

    const target = spans[5 * PER_TURN + 7]!;
    const incremental = measure(5, () => {
      tree.upsert({ ...target, version: tree.get(target.span_id)!.span.version + 1 });
      build(tree, context);
    });
    expect(incremental).toBeLessThan(20);
  });

  it("по умолчанию показывает только последний ход развёрнутым", () => {
    const tree = new TraceTree();
    for (const span of spans) tree.upsert(span);
    const last = spans[(TURNS - 1) * PER_TURN]!.span_id;
    const rows = createRowsBuilder()(tree, { collapse: AUTO_COLLAPSE, filter: NO_FILTER, lastRootId: last, unloadedTurnIds: new Set() });
    expect(rows).toHaveLength(TURNS - 1 + PER_TURN);
  });

  it("строит шкалу по 200 ходам за миллисекунды", () => {
    const tree = new TraceTree();
    for (const span of spans) tree.upsert(span);
    const time = measure(5, () => {
      const scale = buildTraceScale(tree, { widthPx: 1200, nowMs: T0 + TURNS * 200_000 });
      expect(scale.idleGaps.length).toBeGreaterThan(0);
    });
    expect(time).toBeLessThan(20);
  });
});
