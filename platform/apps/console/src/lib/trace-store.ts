import type {
  TraceChangesPage,
  TraceClient,
  TraceOverview,
  TraceSearchMatch,
  TraceSpan,
  TraceTurnsPage,
  TraceTurnSummary,
} from "./trace-api";
import { TraceTree } from "./trace-tree";

/**
 * Локальная копия трейса сессии. Сервер хранит трейс в готовом виде, поэтому
 * консоль только применяет строки: большая `version` заменяет, меньшая
 * отбрасывается, `deleted` удаляет, новый `parent_span_id` переносит узел.
 * Строки хода, чьё поддерево не загружено, отбрасываются, а сводки всех
 * ходов остаются (docs/plans/agent-trace.md, 4.5).
 */

export interface TraceState {
  sessionId: string;
  traceId: string | null;
  /** Одно дерево на все загруженные узлы. Меняется на месте, смотрите на `revision`. */
  tree: TraceTree;
  /** Сводки ходов по возрастанию (start_ms, turn_id). */
  turns: readonly TraceTurnSummary[];
  turnsBefore: string | null;
  /** Курсор потока изменений. */
  cursor: string | null;
  /** Есть ход в состоянии open или settling. */
  collecting: boolean;
  loadedTurnIds: ReadonlySet<string>;
  loadingTurnIds: ReadonlySet<string>;
  ready: boolean;
  revision: number;
}

/** Идентификатор хода верхнего уровня: turn_id его строки, а для старых данных span_id. */
export function turnKey(summary: TraceTurnSummary): string {
  return summary.turn.turn_id ?? summary.turn.span_id;
}

const PENDING_LIMIT = 5000;

function compareTurns(a: TraceTurnSummary, b: TraceTurnSummary): number {
  const keyA = turnKey(a);
  const keyB = turnKey(b);
  return a.turn.start_ms - b.turn.start_ms || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0);
}

function deriveCollecting(turns: readonly TraceTurnSummary[]): boolean {
  return turns.some((turn) => turn.state === "open" || turn.state === "settling");
}

export class TraceStore {
  private readonly tree = new TraceTree();
  private readonly listeners = new Set<() => void>();
  /** Строки потока изменений, пришедшие для хода, который ещё грузится или неизвестен. */
  private readonly pending = new Map<string, TraceSpan[]>();
  private pendingCount = 0;
  private state: TraceState;

  constructor(sessionId: string) {
    this.state = this.initial(sessionId);
  }

  getSnapshot = (): TraceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  reset(sessionId: string): void {
    this.tree.clear();
    this.pending.clear();
    this.pendingCount = 0;
    this.state = this.initial(sessionId);
    this.notify();
  }

  /**
   * Первый ответ маршрута. Возвращает id ходов, чьё поддерево ещё дочитывается
   * по `spans_next`: вызывающий закончит загрузку через `finishLoad`.
   */
  applyOverview(overview: TraceOverview): string[] {
    this.tree.clear();
    this.pending.clear();
    this.pendingCount = 0;
    const turns = [...overview.turns].sort(compareTurns);
    for (const summary of turns) this.tree.upsert(summary.turn);
    this.tree.upsertMany(overview.spans);
    const ids = [...new Set(overview.spans.map((span) => span.turn_id).filter((id): id is string => id !== null))];
    const rest = overview.spans_next !== null;
    this.commit({
      traceId: overview.trace_id || null,
      turns,
      turnsBefore: overview.turns_before,
      cursor: overview.cursor || null,
      collecting: overview.collecting || deriveCollecting(turns),
      loadedTurnIds: rest ? new Set() : new Set(ids),
      loadingTurnIds: rest ? new Set(ids) : new Set(),
      ready: true,
    });
    return rest ? ids : [];
  }

  /** Строки страницы, которую читает вызывающий (остаток ответа, поддерево хода). */
  applySpans(spans: readonly TraceSpan[]): void {
    if (this.tree.upsertMany(spans) > 0) this.commit({});
  }

  beginLoad(turnIds: readonly string[]): void {
    const loading = new Set(this.state.loadingTurnIds);
    let changed = false;
    for (const id of turnIds) {
      if (this.state.loadedTurnIds.has(id) || loading.has(id)) continue;
      loading.add(id);
      changed = true;
    }
    if (changed) this.commit({ loadingTurnIds: loading });
  }

  /** Поддерево прочитано до конца: ход считается загруженным, отложенные изменения применяются. */
  finishLoad(turnIds: readonly string[]): void {
    const loading = new Set(this.state.loadingTurnIds);
    const loaded = new Set(this.state.loadedTurnIds);
    for (const id of turnIds) {
      loading.delete(id);
      loaded.add(id);
      this.replayPending(id);
    }
    this.commit({ loadingTurnIds: loading, loadedTurnIds: loaded });
  }

  /** Загрузка не удалась: ход можно загрузить заново. */
  abortLoad(turnIds: readonly string[]): void {
    const loading = new Set(this.state.loadingTurnIds);
    for (const id of turnIds) {
      loading.delete(id);
      this.dropPending(id);
    }
    this.commit({ loadingTurnIds: loading });
  }

  applyTurns(page: TraceTurnsPage): void {
    const turns = [...this.state.turns];
    const known = new Set(turns.map(turnKey));
    for (const summary of page.turns) {
      this.tree.upsert(summary.turn);
      if (!known.has(turnKey(summary))) {
        turns.push(summary);
        known.add(turnKey(summary));
      }
    }
    turns.sort(compareTurns);
    this.commit({ turns, turnsBefore: page.turns_before });
  }

  /** Свежая сводка хода (с первой страницы поддерева): заменяет прежнюю, если новее, и добавляет неизвестную. */
  applySummary(summary: TraceTurnSummary): void {
    const key = turnKey(summary);
    const turns = [...this.state.turns];
    const index = turns.findIndex((turn) => turnKey(turn) === key);
    if (index >= 0) {
      if (summary.version <= turns[index]!.version) return;
      turns[index] = summary;
    } else {
      turns.push(summary);
    }
    turns.sort(compareTurns);
    this.tree.upsert(summary.turn);
    this.commit({ turns, collecting: this.state.collecting || deriveCollecting(turns) });
  }

  /** Страница потока изменений. Сначала сводки (они регистрируют новые ходы), потом строки. */
  applyChanges(page: TraceChangesPage): void {
    let changed = false;
    let turns = this.state.turns;
    let loaded = this.state.loadedTurnIds;

    for (const summary of page.turns) {
      const key = turnKey(summary);
      const index = turns.findIndex((turn) => turnKey(turn) === key);
      if (index < 0) {
        turns = [...turns, summary].sort(compareTurns);
        this.tree.upsert(summary.turn);
        loaded = new Set(loaded).add(key);
        this.replayPending(key);
        changed = true;
      } else if (summary.version > turns[index]!.version) {
        const next = [...turns];
        next[index] = summary;
        turns = next.sort(compareTurns);
        this.tree.upsert(summary.turn);
        changed = true;
      }
    }

    const knownTurns = new Set(turns.map(turnKey));
    for (const span of page.spans) {
      const turnId = span.turn_id;
      if (turnId === null || loaded.has(turnId)) {
        if (this.tree.upsert(span) !== "ignored") changed = true;
      } else if (this.state.loadingTurnIds.has(turnId) || !knownTurns.has(turnId)) {
        this.buffer(turnId, span);
      } else if (span.kind === "turn" && span.parent_span_id === null) {
        // Строка самого хода видна и у незагруженного хода.
        if (this.tree.upsert(span) !== "ignored") changed = true;
      }
    }

    const cursor = page.cursor && page.cursor !== this.state.cursor ? page.cursor : this.state.cursor;
    if (cursor !== this.state.cursor) changed = true;
    // Признак сбора от сервера точнее расчёта по состояниям: сервер знает про сроки ожидания хвоста.
    const collecting = typeof page.collecting === "boolean" ? page.collecting : deriveCollecting(turns);
    if (collecting !== this.state.collecting) changed = true;
    if (!changed) return;
    this.commit({ turns, loadedTurnIds: loaded, cursor, collecting });
  }

  private initial(sessionId: string): TraceState {
    return {
      sessionId,
      traceId: null,
      tree: this.tree,
      turns: [],
      turnsBefore: null,
      cursor: null,
      collecting: false,
      loadedTurnIds: new Set(),
      loadingTurnIds: new Set(),
      ready: false,
      revision: (this.state?.revision ?? 0) + 1,
    };
  }

  private buffer(turnId: string, span: TraceSpan): void {
    const list = this.pending.get(turnId);
    if (list) list.push(span);
    else this.pending.set(turnId, [span]);
    this.pendingCount += 1;
    if (this.pendingCount > PENDING_LIMIT) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.dropPending(oldest);
    }
  }

  private replayPending(turnId: string): void {
    const list = this.pending.get(turnId);
    if (!list) return;
    this.dropPending(turnId);
    this.tree.upsertMany(list);
  }

  private dropPending(turnId: string): void {
    const list = this.pending.get(turnId);
    if (!list) return;
    this.pendingCount -= list.length;
    this.pending.delete(turnId);
  }

  private commit(patch: Partial<TraceState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/* ---------- Загрузка страниц ---------- */

export interface TraceSync {
  /** Первый ответ маршрута и остаток поддеревьев по spans_next. */
  init(): Promise<void>;
  /** Поддерево хода страницами до конца. Повторный вызов делит одну загрузку. */
  loadTurn(turnId: string): Promise<void>;
  /** Более ранние сводки ходов по turns_before. */
  loadOlder(): Promise<void>;
  /** Изменения по курсору, страницы подряд, пока more. Одновременные вызовы сливаются. */
  poll(): Promise<void>;
  /** После dispose ответы больше не попадают в стор. */
  dispose(): void;
}

export function createTraceSync(deps: { client: TraceClient; store: TraceStore; maxPages?: number }): TraceSync {
  const { client, store } = deps;
  const maxPages = deps.maxPages ?? 500;
  let disposed = false;
  const loads = new Map<string, Promise<void>>();
  let older: Promise<void> | null = null;
  let polling: Promise<void> | null = null;
  let pollAgain = false;

  async function init(): Promise<void> {
    const overview = await client.getOverview();
    if (disposed) return;
    const loading = store.applyOverview(overview);
    let next = overview.spans_next;
    try {
      for (let pages = 0; next !== null; pages += 1) {
        if (pages >= maxPages) throw new Error("Слишком много страниц трейса");
        const page = await client.getSpansPage(next);
        if (disposed) return;
        store.applySpans(page.spans);
        next = page.spans_next;
      }
      if (loading.length) store.finishLoad(loading);
    } catch (error) {
      store.abortLoad(loading);
      throw error;
    }
  }

  function loadTurn(turnId: string): Promise<void> {
    const running = loads.get(turnId);
    if (running) return running;
    const state = store.getSnapshot();
    if (state.loadedTurnIds.has(turnId) || state.loadingTurnIds.has(turnId)) return Promise.resolve();
    store.beginLoad([turnId]);
    const job = (async () => {
      try {
        let page: string | null = null;
        for (let pages = 0; ; pages += 1) {
          if (pages >= maxPages) throw new Error("Слишком много страниц хода");
          const result = await client.getTurnPage(turnId, page);
          if (disposed) return;
          if (result.turn) store.applySummary(result.turn);
          store.applySpans(result.spans);
          page = result.spans_next;
          if (page === null) break;
        }
        store.finishLoad([turnId]);
      } catch (error) {
        store.abortLoad([turnId]);
        throw error;
      } finally {
        loads.delete(turnId);
      }
    })();
    loads.set(turnId, job);
    return job;
  }

  function loadOlder(): Promise<void> {
    if (older) return older;
    const cursor = store.getSnapshot().turnsBefore;
    if (!cursor) return Promise.resolve();
    older = client
      .getTurnsBefore(cursor)
      .then((page) => {
        if (!disposed) store.applyTurns(page);
      })
      .finally(() => {
        older = null;
      });
    return older;
  }

  async function pollOnce(): Promise<void> {
    let cursor = store.getSnapshot().cursor;
    for (let pages = 0; cursor && pages < maxPages; pages += 1) {
      const page = await client.getChanges(cursor);
      if (disposed) return;
      store.applyChanges(page);
      if (!page.more || !page.cursor || page.cursor === cursor) return;
      cursor = page.cursor;
    }
  }

  function poll(): Promise<void> {
    if (polling) {
      pollAgain = true;
      return polling;
    }
    polling = (async () => {
      try {
        do {
          pollAgain = false;
          await pollOnce();
        } while (pollAgain && !disposed);
      } finally {
        polling = null;
      }
    })();
    return polling;
  }

  return {
    init,
    loadTurn,
    loadOlder,
    poll,
    dispose() {
      disposed = true;
    },
  };
}

/* ---------- Поиск по всем ходам ---------- */

export interface RemoteSearchProgress {
  matches: TraceSearchMatch[];
  /** Ходы, которые сервер ещё достраивает для поиска. */
  remainingTurns: number;
  done: boolean;
}

/**
 * Серверный поиск по ходам, которых нет в консоли. Ответ приходит страницами
 * (`next`), а недостроенные ходы сервер достраивает между запросами и сообщает
 * их число в `remaining_turns`. Проход идёт от начала до последней страницы.
 * Ход, достроенный посреди прохода, может лежать до курсора, поэтому поиск
 * заканчивается только проходом, первая страница которого пришла без
 * недостроенных ходов. Иначе клиент начинает новый проход с начала.
 * Совпадения собираются без повторов.
 */
export async function searchRemote(
  client: Pick<TraceClient, "search">,
  query: string,
  options: {
    isCancelled(): boolean;
    onProgress(progress: RemoteSearchProgress): void;
    retryDelayMs?: number;
    maxRequests?: number;
    /** Столько повторов подряд без движения `remaining_turns`, и поиск заканчивается. */
    stallLimit?: number;
  },
): Promise<TraceSearchMatch[]> {
  const retryDelayMs = options.retryDelayMs ?? 300;
  const maxRequests = options.maxRequests ?? 600;
  const stallLimit = options.stallLimit ?? 20;
  const found = new Map<string, TraceSearchMatch>();
  let after: string | null = null;
  let remaining = 0;
  let stalled = 0;
  let requests = 0;
  /** Первая страница прохода пришла без недостроенных ходов: дальше проход их не достраивает. */
  let passComplete = false;
  /** Остаток в конце прошлого прохода. Застой меряем по проходам, а не по страницам. */
  let passRemaining: number | null = null;
  while (!options.isCancelled() && requests < maxRequests) {
    const page = await client.search(query, after);
    requests += 1;
    if (options.isCancelled()) return [...found.values()];
    for (const match of page.matches) found.set(match.span_id, match);
    if (after === null) passComplete = page.remaining_turns === 0;
    remaining = page.remaining_turns;
    if (page.next === null) {
      stalled = remaining === passRemaining ? stalled + 1 : 0;
      passRemaining = remaining;
    }
    const finished = page.next === null && (passComplete || stalled >= stallLimit);
    options.onProgress({ matches: [...found.values()], remainingTurns: remaining, done: finished });
    if (finished) return [...found.values()];
    if (page.next !== null) {
      after = page.next;
      continue;
    }
    // Новый проход с начала: узлы ходов, достроенных за этот проход, лежат и до его курсора.
    after = null;
    if (remaining > 0 && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (!options.isCancelled()) options.onProgress({ matches: [...found.values()], remainingTurns: remaining, done: true });
  return [...found.values()];
}
