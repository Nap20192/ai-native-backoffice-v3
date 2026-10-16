import { formatClockRu } from "../components/session/format-ru";
import type { TraceSearchMatch, TraceSpan, TraceSpanKind } from "./trace-api";

/**
 * Дерево трейса и всё, что считается над ним без React: вложенность, строки
 * списка со свёрткой и фильтром, поиск, шкала времени со сжатием простоев,
 * геометрия полос и окно видимых строк (docs/plans/agent-trace.md, 4.2..4.7).
 *
 * Дерево изменяется на месте: строка с большим `version` заменяет узел,
 * `deleted` убирает его, новый `parent_span_id` переносит узел вместе с
 * детьми. Индекс `span_id` ведёт к узлу, дети лежат по порядку (start_ms,
 * span_id). У каждого узла и его предков растёт `rev`, по нему кэш строк
 * пересобирает только затронутый ход.
 */

export interface TraceNode {
  span: TraceSpan;
  parent: TraceNode | null;
  children: TraceNode[];
  /** Глубина от корня, у корня 0. */
  depth: number;
  /** Номер правки дерева, при которой менялся узел или кто-то из его потомков. */
  rev: number;
}

export type UpsertResult = "inserted" | "replaced" | "removed" | "ignored";

/** Цепочка предков длиннее этой считается ошибкой структуры. */
const MAX_DEPTH = 64;

function compareNodes(a: TraceNode, b: TraceNode): number {
  return a.span.start_ms - b.span.start_ms || (a.span.span_id < b.span.span_id ? -1 : a.span.span_id > b.span.span_id ? 1 : 0);
}

/** Индекс первой позиции, где узел `node` стоит не раньше элементов массива. */
function lowerBound(list: readonly TraceNode[], node: TraceNode): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareNodes(list[mid]!, node) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function insertSorted(list: TraceNode[], node: TraceNode): void {
  const at = lowerBound(list, node);
  if (at === list.length) list.push(node);
  else list.splice(at, 0, node);
}

function removeSorted(list: TraceNode[], node: TraceNode): void {
  let at = lowerBound(list, node);
  while (at < list.length && list[at] !== node && compareNodes(list[at]!, node) === 0) at += 1;
  if (list[at] === node) list.splice(at, 1);
  else {
    const found = list.indexOf(node);
    if (found >= 0) list.splice(found, 1);
  }
}

export class TraceTree {
  readonly nodes = new Map<string, TraceNode>();
  readonly roots: TraceNode[] = [];
  /** Растёт при любой правке. */
  revision = 0;
  /** Узлы, ждущие родителя: id родителя -> дети. */
  private readonly waiting = new Map<string, TraceNode[]>();
  /** Узлы, которые не прикреплены ни к корню, ни к родителю. */
  private readonly unattached = new Set<string>();
  /** Версия удаления: старая строка с меньшим version не воскресит узел. */
  private readonly tombstones = new Map<string, number>();

  get size(): number {
    return this.nodes.size;
  }

  get(spanId: string): TraceNode | undefined {
    return this.nodes.get(spanId);
  }

  has(spanId: string): boolean {
    return this.nodes.has(spanId);
  }

  orphanCount(): number {
    return this.unattached.size;
  }

  /** Предки от корня до родителя. */
  ancestors(spanId: string): TraceNode[] {
    const chain: TraceNode[] = [];
    for (let node = this.nodes.get(spanId)?.parent ?? null; node; node = node.parent) chain.push(node);
    return chain.reverse();
  }

  upsert(span: TraceSpan): UpsertResult {
    const spanId = span.span_id;
    const tomb = this.tombstones.get(spanId);
    if (tomb !== undefined && span.version <= tomb) return "ignored";
    const existing = this.nodes.get(spanId);
    if (existing && span.version <= existing.span.version) return "ignored";

    if (span.deleted) {
      this.tombstones.set(spanId, span.version);
      if (!existing) return "ignored";
      this.removeNode(existing);
      return "removed";
    }
    if (tomb !== undefined) this.tombstones.delete(spanId);

    if (!existing) {
      const node: TraceNode = { span, parent: null, children: [], depth: 0, rev: 0 };
      this.nodes.set(spanId, node);
      this.attach(node);
      this.adoptWaiting(node);
      this.touch(node);
      return "inserted";
    }

    const moved = existing.span.parent_span_id !== span.parent_span_id || existing.span.start_ms !== span.start_ms;
    if (moved) this.detach(existing);
    existing.span = span;
    if (moved) {
      this.attach(existing);
      this.adoptWaiting(existing);
    }
    this.touch(existing);
    return "replaced";
  }

  /** Число строк, которые что-то изменили. */
  upsertMany(spans: readonly TraceSpan[]): number {
    let changed = 0;
    for (const span of spans) if (this.upsert(span) !== "ignored") changed += 1;
    return changed;
  }

  remove(spanId: string): boolean {
    const node = this.nodes.get(spanId);
    if (!node) return false;
    this.removeNode(node);
    return true;
  }

  clear(): void {
    this.nodes.clear();
    this.roots.length = 0;
    this.waiting.clear();
    this.unattached.clear();
    this.tombstones.clear();
    this.revision += 1;
  }

  private touch(node: TraceNode): void {
    this.revision += 1;
    for (let current: TraceNode | null = node; current; current = current.parent) current.rev = this.revision;
  }

  /** Цикл по заявленным `parent_span_id`, а не по указателям: узел без родителя в дереве тоже может замкнуть круг. */
  private createsCycle(parentId: string, nodeId: string): boolean {
    let current: string | null = parentId;
    for (let steps = 0; current !== null; steps += 1) {
      if (current === nodeId || steps > MAX_DEPTH) return true;
      current = this.nodes.get(current)?.span.parent_span_id ?? null;
    }
    return false;
  }

  private addWaiting(parentId: string, node: TraceNode): void {
    const list = this.waiting.get(parentId);
    if (list) {
      if (!list.includes(node)) list.push(node);
    } else {
      this.waiting.set(parentId, [node]);
    }
    this.unattached.add(node.span.span_id);
  }

  private removeWaiting(parentId: string, node: TraceNode): void {
    const list = this.waiting.get(parentId);
    if (!list) return;
    const at = list.indexOf(node);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.waiting.delete(parentId);
  }

  private setDepth(node: TraceNode, depth: number): void {
    const stack: Array<[TraceNode, number]> = [[node, depth]];
    while (stack.length) {
      const [current, value] = stack.pop()!;
      current.depth = value;
      for (const child of current.children) stack.push([child, value + 1]);
    }
  }

  private attach(node: TraceNode): void {
    const parentId = node.span.parent_span_id;
    if (parentId === null) {
      node.parent = null;
      insertSorted(this.roots, node);
      this.unattached.delete(node.span.span_id);
      this.setDepth(node, 0);
      return;
    }
    const parent = this.nodes.get(parentId);
    if (!parent || this.createsCycle(parentId, node.span.span_id)) {
      node.parent = null;
      this.addWaiting(parentId, node);
      return;
    }
    node.parent = parent;
    insertSorted(parent.children, node);
    this.unattached.delete(node.span.span_id);
    this.setDepth(node, parent.depth + 1);
  }

  /** Дети, которые ждали этот узел (или застряли в цикле через него), пробуют прикрепиться. */
  private adoptWaiting(node: TraceNode): void {
    const list = this.waiting.get(node.span.span_id);
    if (!list) return;
    this.waiting.delete(node.span.span_id);
    for (const child of [...list]) {
      this.unattached.delete(child.span.span_id);
      this.attach(child);
      this.touch(child);
    }
  }

  /** Убирает узел из корней, списка родителя или очереди ожидания. */
  private detach(node: TraceNode): void {
    const parentId = node.span.parent_span_id;
    if (parentId === null) {
      removeSorted(this.roots, node);
    } else if (node.parent) {
      removeSorted(node.parent.children, node);
      this.touch(node.parent);
    } else {
      this.removeWaiting(parentId, node);
    }
    node.parent = null;
    this.unattached.delete(node.span.span_id);
  }

  private removeNode(node: TraceNode): void {
    this.detach(node);
    this.nodes.delete(node.span.span_id);
    for (const child of node.children) {
      child.parent = null;
      this.addWaiting(node.span.span_id, child);
    }
    node.children = [];
    this.revision += 1;
  }
}

/* ---------- Виды и фильтр ---------- */

export type TraceKindGroup = "turn" | "model" | "tool" | "subagent" | "sandbox" | "wait";

export const TRACE_KIND_GROUPS: readonly TraceKindGroup[] = ["turn", "model", "tool", "subagent", "sandbox", "wait"];

const GROUP_OF_KIND: Partial<Record<TraceSpanKind, TraceKindGroup>> = {
  turn: "turn",
  model_call: "model",
  acp_prompt: "model",
  tool_call: "tool",
  tool_exec: "tool",
  hook: "tool",
  subagent: "subagent",
  sandbox: "sandbox",
  sandbox_phase: "sandbox",
  harness_start: "sandbox",
  tool_wait: "wait",
  retry_wait: "wait",
};

export function kindGroup(kind: TraceSpanKind): TraceKindGroup | null {
  return GROUP_OF_KIND[kind] ?? null;
}

export interface TraceFilter {
  groups: ReadonlySet<TraceKindGroup>;
  errorsOnly: boolean;
}

export const NO_FILTER: TraceFilter = { groups: new Set(), errorsOnly: false };

export function isFilterActive(filter: TraceFilter): boolean {
  return filter.groups.size > 0 || filter.errorsOnly;
}

/** Ошибка узла: статус error или событие «Ошибка» (сервер хранит его под именем error). */
export function isErrorSpan(span: TraceSpan): boolean {
  return span.status === "error" || (span.kind === "event" && (span.name === "error" || span.name === "Ошибка"));
}

export function matchesFilter(span: TraceSpan, filter: TraceFilter): boolean {
  if (filter.groups.size > 0) {
    const group = kindGroup(span.kind);
    if (group === null || !filter.groups.has(group)) return false;
  }
  return !filter.errorsOnly || isErrorSpan(span);
}

/* ---------- Свёртка ---------- */

export interface CollapseState {
  /** auto: последний ход раскрыт, остальные ходы и ветки сабагентов свёрнуты. */
  base: "auto" | "expanded" | "collapsed";
  /** Явный выбор по узлу: true значит свёрнут. */
  overrides: ReadonlyMap<string, boolean>;
}

export const AUTO_COLLAPSE: CollapseState = { base: "auto", overrides: new Map() };

export const expandAll = (): CollapseState => ({ base: "expanded", overrides: new Map() });
export const collapseAll = (): CollapseState => ({ base: "collapsed", overrides: new Map() });

export function setCollapsed(state: CollapseState, spanId: string, collapsed: boolean): CollapseState {
  const overrides = new Map(state.overrides);
  overrides.set(spanId, collapsed);
  return { base: state.base, overrides };
}

export function toggleCollapse(state: CollapseState, spanId: string, currentlyCollapsed: boolean): CollapseState {
  return setCollapsed(state, spanId, !currentlyCollapsed);
}

/** Раскрывает всех предков узла, чтобы строка попала в список. */
export function revealSpan(state: CollapseState, tree: TraceTree, spanId: string): CollapseState {
  const overrides = new Map(state.overrides);
  for (const ancestor of tree.ancestors(spanId)) overrides.set(ancestor.span.span_id, false);
  return { base: state.base, overrides };
}

/* ---------- Строки ---------- */

export interface TraceRow {
  node: TraceNode;
  span: TraceSpan;
  depth: number;
  /** У узла есть дети, либо это ход, поддерево которого ещё не загружено. */
  expandable: boolean;
  collapsed: boolean;
  /** Предок найденных узлов, показан приглушённым. */
  dimmed: boolean;
}

export interface RowsContext {
  collapse: CollapseState;
  filter: TraceFilter;
  /** span_id последнего хода: он раскрыт по умолчанию. */
  lastRootId: string | null;
  /** turn_id ходов, поддерево которых не загружено. */
  unloadedTurnIds: ReadonlySet<string>;
}

interface RootCacheEntry {
  rev: number;
  collapse: CollapseState;
  filter: TraceFilter;
  isLast: boolean;
  unloaded: boolean;
  rows: TraceRow[];
}

function subtreeMatches(node: TraceNode, filter: TraceFilter): boolean {
  if (matchesFilter(node.span, filter)) return true;
  for (const child of node.children) if (subtreeMatches(child, filter)) return true;
  return false;
}

function flattenRoot(root: TraceNode, context: RowsContext, isLast: boolean, unloaded: boolean): TraceRow[] {
  const rows: TraceRow[] = [];
  const { collapse, filter } = context;
  const filtering = isFilterActive(filter);

  const collapsedOf = (node: TraceNode, expandable: boolean): boolean => {
    if (!expandable) return false;
    const explicit = collapse.overrides.get(node.span.span_id);
    if (explicit !== undefined) return explicit;
    if (filtering) return false;
    if (collapse.base === "expanded") return false;
    if (collapse.base === "collapsed") return true;
    if (node.span.kind === "subagent") return true;
    return node === root && node.span.kind === "turn" && !isLast;
  };

  const visit = (node: TraceNode, depth: number): boolean => {
    const expandable = node.children.length > 0 || (node === root && unloaded);
    const collapsed = collapsedOf(node, expandable);
    if (!filtering) {
      rows.push({ node, span: node.span, depth, expandable, collapsed, dimmed: false });
      if (!collapsed) for (const child of node.children) visit(child, depth + 1);
      return true;
    }
    const mark = rows.length;
    const self = matchesFilter(node.span, filter);
    rows.push(undefined as unknown as TraceRow);
    let inside = false;
    if (!collapsed) {
      for (const child of node.children) if (visit(child, depth + 1)) inside = true;
    } else {
      inside = node.children.some((child) => subtreeMatches(child, filter));
    }
    if (!self && !inside) {
      rows.length = mark;
      return false;
    }
    rows[mark] = { node, span: node.span, depth, expandable, collapsed, dimmed: !self };
    return true;
  };
  visit(root, 0);
  return rows;
}

/**
 * Сборщик строк с кэшем по корням. Корень пересобирается, только если у него
 * изменился `rev`, свёртка, фильтр или признак «последний/не загружен».
 * Остальные корни отдают те же объекты строк.
 */
export function createRowsBuilder(): (tree: TraceTree, context: RowsContext) => TraceRow[] {
  const cache = new Map<string, RootCacheEntry>();
  return (tree, context) => {
    const out: TraceRow[] = [];
    const seen = new Set<string>();
    for (const root of tree.roots) {
      const rootId = root.span.span_id;
      seen.add(rootId);
      const isLast = rootId === context.lastRootId;
      const unloaded = root.span.turn_id !== null && context.unloadedTurnIds.has(root.span.turn_id);
      let entry = cache.get(rootId);
      if (
        !entry ||
        entry.rev !== root.rev ||
        entry.collapse !== context.collapse ||
        entry.filter !== context.filter ||
        entry.isLast !== isLast ||
        entry.unloaded !== unloaded
      ) {
        entry = {
          rev: root.rev,
          collapse: context.collapse,
          filter: context.filter,
          isLast,
          unloaded,
          rows: flattenRoot(root, context, isLast, unloaded),
        };
        cache.set(rootId, entry);
      }
      for (const row of entry.rows) out.push(row);
    }
    if (cache.size > seen.size) for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);
    return out;
  };
}

/* ---------- Поиск ---------- */

const haystacks = new WeakMap<TraceSpan, string>();

/** Поля, по которым ищет и сервер: имя, инструмент, модель, id спана и события, текст ошибки. */
function haystack(span: TraceSpan): string {
  let text = haystacks.get(span);
  if (text === undefined) {
    const parts: string[] = [span.name, span.span_id];
    if (span.tool) parts.push(span.tool.name);
    if (span.model) parts.push(span.model);
    if (span.primary_event_id) parts.push(span.primary_event_id);
    for (const eventId of span.event_ids) parts.push(eventId);
    if (span.error?.message) parts.push(span.error.message);
    text = parts.join("\n").toLowerCase();
    haystacks.set(span, text);
  }
  return text;
}

/** Совпадения в порядке отображения: ход за ходом, сверху вниз по дереву. */
export function searchTree(tree: TraceTree, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const found: string[] = [];
  const walk = (node: TraceNode) => {
    if (haystack(node.span).includes(needle)) found.push(node.span.span_id);
    for (const child of node.children) walk(child);
  };
  for (const root of tree.roots) walk(root);
  return found;
}

export interface TraceMatch {
  spanId: string;
  turnId: string | null;
  /** Узел уже в дереве. Иначе нужно сначала загрузить поддерево хода. */
  loaded: boolean;
}

/** Собирает совпадения загруженных ходов и ответ сервера в один список по порядку ходов. */
export function mergeMatches(
  tree: TraceTree,
  localIds: readonly string[],
  remote: readonly TraceSearchMatch[],
  turnOrder: readonly string[],
): TraceMatch[] {
  const byTurn = new Map<string | null, TraceMatch[]>();
  const push = (match: TraceMatch) => {
    const list = byTurn.get(match.turnId);
    if (list) list.push(match);
    else byTurn.set(match.turnId, [match]);
  };
  const seen = new Set<string>();
  for (const spanId of localIds) {
    seen.add(spanId);
    push({ spanId, turnId: tree.get(spanId)?.span.turn_id ?? null, loaded: true });
  }
  for (const match of remote) {
    if (seen.has(match.span_id) || tree.has(match.span_id)) continue;
    seen.add(match.span_id);
    push({ spanId: match.span_id, turnId: match.turn_id, loaded: false });
  }
  const out: TraceMatch[] = [];
  const used = new Set<string | null>();
  for (const turnId of turnOrder) {
    used.add(turnId);
    for (const match of byTurn.get(turnId) ?? []) out.push(match);
  }
  for (const [turnId, list] of byTurn) if (!used.has(turnId)) for (const match of list) out.push(match);
  return out;
}

/* ---------- Шкала времени ---------- */

export interface IdleGap {
  startMs: number;
  endMs: number;
  x: number;
  width: number;
}

export interface ScaleRun {
  startMs: number;
  endMs: number;
}

export interface TraceScale {
  widthPx: number;
  windowFromMs: number;
  windowToMs: number;
  pxPerMs: number;
  /** Простои длиннее порога, сжатые до idleWidthPx, внутри окна. */
  idleGaps: IdleGap[];
  /** Непрерывные участки с линейным временем внутри окна, для рисок оси. */
  runs: ScaleRun[];
  toX(ms: number): number;
  toMs(x: number): number;
}

export interface ScaleOptions {
  widthPx: number;
  nowMs: number;
  window?: { fromMs: number; toMs: number } | null;
  idleGapMs?: number;
  idleWidthPx?: number;
}

const IDLE_GAP_MS = 60_000;
const IDLE_WIDTH_PX = 6;

interface Piece {
  from: number;
  to: number;
  idle: boolean;
}

/**
 * Шкала по ходам верхнего уровня. Простой между ходами длиннее 60 с сжимается
 * в 6 px, всё остальное время делит оставшуюся ширину поровну. Внутри хода
 * время линейное: ход покрывает всё, что в нём происходит. Окно `window`
 * показывает только выбранный участок на всю ширину. Вне окна и вне ходов
 * время продолжается линейно с той же скоростью.
 */
export function buildTraceScale(tree: TraceTree, options: ScaleOptions): TraceScale {
  const widthPx = Math.max(0, options.widthPx);
  const idleGapMs = options.idleGapMs ?? IDLE_GAP_MS;
  const idleWidthPx = options.idleWidthPx ?? IDLE_WIDTH_PX;

  const segments: Array<[number, number]> = [];
  for (const root of tree.roots) {
    const start = root.span.start_ms;
    const end = Math.max(start, root.span.end_ms ?? options.nowMs);
    const last = segments[segments.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else segments.push([start, end]);
  }

  if (segments.length === 0) {
    const at = options.nowMs;
    return {
      widthPx, windowFromMs: at, windowToMs: at, pxPerMs: 0, idleGaps: [], runs: [],
      toX: () => 0,
      toMs: () => at,
    };
  }

  const pieces: Piece[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const [from, to] = segments[i]!;
    pieces.push({ from, to, idle: false });
    const next = segments[i + 1];
    if (next) pieces.push({ from: to, to: next[0], idle: next[0] - to > idleGapMs });
  }
  // Накопленное линейное время и число сжатых простоев перед каждым куском.
  const linBefore: number[] = [];
  const idleBefore: number[] = [];
  let lin = 0;
  let idle = 0;
  for (const piece of pieces) {
    linBefore.push(lin);
    idleBefore.push(idle);
    if (piece.idle) idle += 1;
    else lin += piece.to - piece.from;
  }
  const firstMs = pieces[0]!.from;
  const lastMs = pieces[pieces.length - 1]!.to;
  const totalLin = lin;
  const totalIdle = idle;

  const pieceIndex = (ms: number): number => {
    let low = 0;
    let high = pieces.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (pieces[mid]!.from <= ms) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  /** Линейное время и число (дробное) простоев от начала шкалы до момента. */
  const position = (ms: number): { lin: number; idle: number } => {
    if (ms <= firstMs) return { lin: ms - firstMs, idle: 0 };
    if (ms >= lastMs) return { lin: totalLin + (ms - lastMs), idle: totalIdle };
    const k = pieceIndex(ms);
    const piece = pieces[k]!;
    if (piece.idle) {
      const span = piece.to - piece.from;
      return { lin: linBefore[k]!, idle: idleBefore[k]! + (span > 0 ? (ms - piece.from) / span : 0) };
    }
    return { lin: linBefore[k]! + (ms - piece.from), idle: idleBefore[k]! };
  };

  let windowFrom = firstMs;
  let windowTo = lastMs;
  if (options.window && options.window.toMs > options.window.fromMs) {
    windowFrom = options.window.fromMs;
    windowTo = options.window.toMs;
  }
  const from = position(windowFrom);
  const to = position(windowTo);
  const linInWindow = to.lin - from.lin;
  const idleInWindow = to.idle - from.idle;
  const idlePx = idleInWindow > 0 ? Math.min(idleWidthPx, widthPx / (2 * idleInWindow)) : idleWidthPx;
  const pxPerMs = linInWindow > 0 ? Math.max(0, widthPx - idlePx * idleInWindow) / linInWindow : 0;

  const gAt = (ms: number): number => {
    const p = position(ms);
    return pxPerMs * (p.lin - from.lin) + idlePx * (p.idle - from.idle);
  };
  const toX = (ms: number): number => gAt(ms);

  // Границы кусков в пикселях окна для обратного преобразования.
  const gBefore = pieces.map((_, k) => pxPerMs * (linBefore[k]! - from.lin) + idlePx * (idleBefore[k]! - from.idle));

  const toMs = (x: number): number => {
    if (pxPerMs === 0 && idlePx === 0) return windowFrom;
    const firstX = gBefore[0]!;
    const lastX = pxPerMs * (totalLin - from.lin) + idlePx * (totalIdle - from.idle);
    if (x <= firstX) return pxPerMs > 0 ? firstMs - (firstX - x) / pxPerMs : firstMs;
    if (x >= lastX) return pxPerMs > 0 ? lastMs + (x - lastX) / pxPerMs : lastMs;
    let low = 0;
    let high = pieces.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (gBefore[mid]! <= x) low = mid;
      else high = mid - 1;
    }
    const piece = pieces[low]!;
    const span = piece.to - piece.from;
    if (piece.idle) {
      const fraction = idlePx > 0 ? (x - gBefore[low]!) / idlePx : 0;
      return piece.from + Math.min(1, Math.max(0, fraction)) * span;
    }
    return pxPerMs > 0 ? piece.from + (x - gBefore[low]!) / pxPerMs : piece.from;
  };

  const idleGaps: IdleGap[] = [];
  const runs: ScaleRun[] = [];
  for (const piece of pieces) {
    const clipFrom = Math.max(piece.from, windowFrom);
    const clipTo = Math.min(piece.to, windowTo);
    if (clipTo <= clipFrom) continue;
    if (piece.idle) {
      idleGaps.push({ startMs: clipFrom, endMs: clipTo, x: toX(clipFrom), width: toX(clipTo) - toX(clipFrom) });
      continue;
    }
    const last = runs[runs.length - 1];
    if (last && last.endMs === clipFrom) last.endMs = clipTo;
    else runs.push({ startMs: clipFrom, endMs: clipTo });
  }

  return { widthPx, windowFromMs: windowFrom, windowToMs: windowTo, pxPerMs, idleGaps, runs, toX, toMs };
}

export interface AxisTick {
  ms: number;
  x: number;
  label: string;
}

const TICK_STEPS_MS = [
  1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
  600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
];
const MAX_TICKS = 200;

/**
 * Риски оси: время суток, кратное круглому шагу, только на линейных участках
 * шкалы. `labelWidthPx` оставляет у правого края место под подпись: риска,
 * которой не хватает места, не рисуется.
 */
export function axisTicks(scale: TraceScale, options: { minGapPx: number; labelWidthPx?: number }): AxisTick[] {
  if (scale.pxPerMs <= 0) return [];
  const step = TICK_STEPS_MS.find((candidate) => candidate * scale.pxPerMs >= options.minGapPx) ?? TICK_STEPS_MS[TICK_STEPS_MS.length - 1]!;
  const ticks: AxisTick[] = [];
  let lastX: number | null = null;
  for (const run of scale.runs) {
    for (let k = Math.ceil(run.startMs / step); k * step <= run.endMs; k += 1) {
      const ms = k * step;
      const x = scale.toX(ms);
      if (x < -0.5 || x + (options.labelWidthPx ?? 0) > scale.widthPx + 0.5) continue;
      if (lastX !== null && x - lastX < options.minGapPx * 0.999) continue;
      const clock = formatClockRu(ms);
      const millis = String(Math.floor(ms % 1000)).padStart(3, "0");
      ticks.push({ ms, x, label: step < 1000 ? `${clock}.${millis}` : clock });
      lastX = x;
      if (ticks.length >= MAX_TICKS) return ticks;
    }
  }
  return ticks;
}

/* ---------- Полосы ---------- */

export interface BarGeometry {
  left: number;
  width: number;
  /** Узел идёт: полоса тянется до текущего времени. */
  open: boolean;
  /** Узел ждёт: полоса тянется до конца последнего хода. */
  waiting: boolean;
  /** Мгновенный узел: рисуется точкой. */
  point: boolean;
}

export const MIN_BAR_WIDTH_PX = 2;

export function barGeometry(
  span: TraceSpan,
  scale: TraceScale,
  context: { nowMs: number; lastTurnEndMs: number },
): BarGeometry {
  const start = span.start_ms;
  let end: number;
  let open = false;
  let waiting = false;
  if (span.end_ms !== null) {
    end = span.end_ms;
  } else if (span.status === "waiting") {
    waiting = true;
    end = Math.max(start, context.lastTurnEndMs);
  } else if (span.status === "running") {
    open = true;
    end = Math.max(start, context.nowMs);
  } else {
    end = start;
  }
  const left = scale.toX(start);
  if (end <= start && !waiting && !open) return { left, width: 0, open, waiting, point: true };
  const width = Math.max(MIN_BAR_WIDTH_PX, scale.toX(end) - left);
  return { left, width, open, waiting, point: false };
}

/** Участки хода без детей длиннее порога: у harness без отчёта о работе это серое «нет данных». */
export function noDataGaps(
  turn: TraceNode,
  options: { nowMs: number; minMs?: number },
): Array<{ startMs: number; endMs: number }> {
  const minMs = options.minMs ?? 500;
  const turnStart = turn.span.start_ms;
  const turnEnd = turn.span.end_ms ?? options.nowMs;
  const gaps: Array<{ startMs: number; endMs: number }> = [];
  let cursor = turnStart;
  for (const child of turn.children) {
    const childStart = Math.max(child.span.start_ms, turnStart);
    const childEnd = Math.min(child.span.end_ms ?? (child.span.status === "waiting" ? turnEnd : options.nowMs), turnEnd);
    if (childStart - cursor > minMs) gaps.push({ startMs: cursor, endMs: childStart });
    cursor = Math.max(cursor, childEnd, childStart);
  }
  if (turnEnd - cursor > minMs) gaps.push({ startMs: cursor, endMs: turnEnd });
  return gaps;
}

/**
 * Событие узла для клика. У выполнения и ожидания инструмента без своего
 * события берётся событие вызова: так клик по «Выполнению» показывает вызов.
 * У остальных узлов без события его нет, фаза песочницы событием хода не подменяется.
 */
export function primaryEventOf(node: TraceNode): string | null {
  if (node.span.primary_event_id) return node.span.primary_event_id;
  if ((node.span.kind === "tool_exec" || node.span.kind === "tool_wait") && node.parent) {
    return node.parent.span.primary_event_id;
  }
  return null;
}

/** Конец последнего хода сессии: до него тянется узел «ждёт». Открытый ход идёт до текущего времени. */
export function lastRootEnd(tree: TraceTree, nowMs: number): number {
  let end = -Infinity;
  for (const root of tree.roots) end = Math.max(end, root.span.end_ms ?? nowMs);
  return Number.isFinite(end) ? end : nowMs;
}

/* ---------- Окно строк ---------- */

export function rowWindow(input: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  total: number;
  overscan: number;
}): { start: number; end: number } {
  const { viewportHeight, rowHeight, total, overscan } = input;
  if (total <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const maxScroll = Math.max(0, total * rowHeight - viewportHeight);
  const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScroll);
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewportHeight) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(total, last + overscan) };
}
