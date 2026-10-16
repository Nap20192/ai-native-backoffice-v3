import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Ref } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePhoneLayout } from "@/hooks/use-phone-layout";
import { ApiError } from "../../../lib/api";
import type { TraceClient, TraceSearchMatch, TraceSpan, TraceTurnSummary } from "../../../lib/trace-api";
import { useTraceClient } from "../../../lib/trace-api";
import { toolInputPreview, type EventSelection, type SessionEvent } from "../../../lib/session-stats";
import {
  TraceStore,
  createTraceSync,
  searchRemote,
  turnKey,
  type TraceState,
  type TraceSync,
} from "../../../lib/trace-store";
import {
  AUTO_COLLAPSE,
  NO_FILTER,
  collapseAll,
  createRowsBuilder,
  expandAll,
  lastRootEnd,
  mergeMatches,
  primaryEventOf,
  revealSpan,
  searchTree,
  setCollapsed,
  type CollapseState,
  type TraceFilter,
  type TraceTree,
} from "../../../lib/trace-tree";
import { EmptyState } from "../../EmptyState";
import { LoadError } from "../../LoadError";
import { TraceDetails } from "./TraceDetails";
import { TraceToolbar } from "./TraceToolbar";
import { TRACE_ZOOM_STEPS, TraceWaterfall } from "./TraceWaterfall";

/**
 * Вкладка «Трейс» (docs/plans/agent-trace.md, раздел 4): панель поиска и
 * фильтров, водопад по времени и панель деталей выбранного узла. Данные берутся
 * постранично с сервера и обновляются по курсору изменений. Страница сессии
 * показывает вкладку в режиме `?view=trace` (SessionDetail).
 */

export interface TraceViewProps {
  sessionId: string;
  /** События сессии: из них берутся ввод и результат инструментов. */
  events: readonly SessionEvent[];
  selection: EventSelection;
  /** Выбор узла сообщает странице событие узла (или null, если события нет). */
  onSelectEvent(eventId: string | null, source: "trace"): void;
  /** Кнопка «В разговоре»: страница переключает вид и прокручивает ленту к блоку. */
  onShowInTranscript(eventId: string): void;
  /** Кнопка «Открыть поток» у сабагента: страница переключает ленту на поток. */
  onOpenThread?(threadId: string): void;
  running: boolean;
  /** Ссылка на поле поиска: страница фокусирует его клавишей «/». */
  searchInputRef?: Ref<HTMLInputElement>;
  /** Подмена клиента API (тесты, фикстуры). */
  client?: TraceClient;
  now?: () => number;
  /** Период опроса изменений, пока идёт сессия или сервер собирает трейс. */
  pollIntervalMs?: number;
  /** Задержка поиска по серверу после ввода и между повторами. */
  searchDebounceMs?: number;
}

const defaultNow = () => Date.now();
const LIVE_EVENT_DELAY_MS = 250;
/** События живого потока, после которых трейс мог измениться. */
const LIVE_EVENT = /^(span\.|agent\.tool_|agent\.mcp_tool_|agent\.custom_tool_|session\.status_|session\.thread_)/;
const NO_MATCHES: readonly TraceSearchMatch[] = [];

/** Узел события: сначала те, у кого оно главное (самый верхний выигрывает), потом любой, чей список событий его содержит. */
function findSpanByEvent(tree: TraceTree, eventId: string): string | null {
  let primary: { spanId: string; depth: number } | null = null;
  let fallback: string | null = null;
  for (const [spanId, node] of tree.nodes) {
    if (node.span.primary_event_id === eventId) {
      if (primary === null || node.depth < primary.depth) primary = { spanId, depth: node.depth };
    } else if (fallback === null && node.span.event_ids.includes(eventId)) {
      fallback = spanId;
    }
  }
  return primary?.spanId ?? fallback;
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Проверьте соединение и повторите попытку.";
}

export function TraceView(props: TraceViewProps) {
  // Другая сессия начинает с чистого состояния.
  return <TraceViewInner key={props.sessionId} {...props} />;
}

function TraceViewInner({
  sessionId,
  events,
  selection,
  onSelectEvent,
  onShowInTranscript,
  onOpenThread,
  running,
  searchInputRef,
  client: injectedClient,
  now = defaultNow,
  pollIntervalMs = 1_000,
  searchDebounceMs = 300,
}: TraceViewProps) {
  const defaultClient = useTraceClient(sessionId);
  const client = injectedClient ?? defaultClient;
  const store = useMemo(() => new TraceStore(sessionId), [sessionId]);
  const state: TraceState = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { tree } = state;
  const phone = usePhoneLayout();

  const syncRef = useRef<TraceSync | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [collapse, setCollapse] = useState<CollapseState>(AUTO_COLLAPSE);
  const [filter, setFilter] = useState<TraceFilter>(NO_FILTER);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);
  const [remote, setRemote] = useState<{ query: string; matches: TraceSearchMatch[]; remaining: number } | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(0);
  const [timeWindow, setTimeWindow] = useState<{ fromMs: number; toMs: number } | null>(null);
  const [follow, setFollow] = useState(true);
  const [revealRequest, setRevealRequest] = useState<{ spanId: string; seq: number } | null>(null);

  const onSelectEventRef = useRef(onSelectEvent);
  onSelectEventRef.current = onSelectEvent;
  const nowRef = useRef(now);
  nowRef.current = now;
  const stableNow = useCallback(() => nowRef.current(), []);

  /* ---------- Загрузка ---------- */

  useEffect(() => {
    const sync = createTraceSync({ client, store });
    syncRef.current = sync;
    let alive = true;
    setLoadError(null);
    sync.init().catch((error: unknown) => {
      if (alive) setLoadError(error ?? new Error("Не удалось загрузить трейс"));
    });
    return () => {
      alive = false;
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [client, store, attempt]);

  /* ---------- Живое обновление (4.5) ---------- */

  const active = running || state.collecting;

  useEffect(() => {
    if (!state.ready || !active) return;
    const timer = setInterval(() => {
      void syncRef.current?.poll().catch(() => {});
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [state.ready, active, pollIntervalMs]);

  // Сессия остановилась: последний раз читаем изменения, чтобы закрыть идущие узлы.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && state.ready) void syncRef.current?.poll().catch(() => {});
    wasRunning.current = running;
  }, [running, state.ready]);

  // Событие живого потока про трейс вызывает внеочередной запрос с задержкой 250 мс.
  const seenEvents = useRef(events.length);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const from = seenEvents.current;
    seenEvents.current = events.length;
    if (events.length <= from || !state.ready) return;
    if (!events.slice(from).some((event) => LIVE_EVENT.test(event.type))) return;
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => {
      liveTimer.current = null;
      void syncRef.current?.poll().catch(() => {});
    }, LIVE_EVENT_DELAY_MS);
  }, [events, state.ready]);
  useEffect(
    () => () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
    },
    [],
  );

  /* ---------- Производные данные ---------- */

  const eventsById = useMemo(() => {
    const map = new Map<string, SessionEvent>();
    for (const event of events) if (event.id) map.set(event.id, event);
    return map;
  }, [events]);

  const toolInput = useCallback(
    (span: TraceSpan): string | null => {
      const event = span.primary_event_id ? eventsById.get(span.primary_event_id) : undefined;
      return event ? toolInputPreview(span.tool?.name ?? span.name, event.input) : null;
    },
    [eventsById],
  );

  const turnInfo = useMemo(() => {
    const numbers = new Map<string, number>();
    const summaries = new Map<string, TraceTurnSummary>();
    const order: string[] = [];
    state.turns.forEach((summary, index) => {
      summaries.set(summary.turn.span_id, summary);
      order.push(turnKey(summary));
      // Номер ход получает, только если известны все ходы до него.
      if (state.turnsBefore === null) numbers.set(summary.turn.span_id, index + 1);
    });
    return { numbers, summaries, order };
  }, [state.turns, state.turnsBefore]);

  const unloadedTurnIds = useMemo(
    () => new Set(state.turns.filter((turn) => !state.loadedTurnIds.has(turnKey(turn))).map(turnKey)),
    [state.turns, state.loadedTurnIds],
  );
  const loadingSpanIds = useMemo(
    () => new Set(state.turns.filter((turn) => state.loadingTurnIds.has(turnKey(turn))).map((turn) => turn.turn.span_id)),
    [state.turns, state.loadingTurnIds],
  );

  const [buildRows] = useState(createRowsBuilder);
  const lastRootId = tree.roots[tree.roots.length - 1]?.span.span_id ?? null;
  const rows = useMemo(
    () => buildRows(tree, { collapse, filter, lastRootId, unloadedTurnIds }),
    // revision заменяет тело дерева, которое меняется на месте.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, state.revision, collapse, filter, lastRootId, unloadedTurnIds],
  );

  /* ---------- Выбор ---------- */

  const reveal = useCallback(
    (spanId: string) => {
      setCollapse((current) => revealSpan(current, store.getSnapshot().tree, spanId));
      setRevealRequest((previous) => ({ spanId, seq: (previous?.seq ?? 0) + 1 }));
    },
    [store],
  );

  const selectSpan = useCallback(
    (spanId: string, options: { reveal?: boolean } = {}) => {
      const node = store.getSnapshot().tree.get(spanId);
      setSelectedSpanId(spanId);
      setDetailsOpen(true);
      if (options.reveal) reveal(spanId);
      onSelectEventRef.current(node ? primaryEventOf(node) : null, "trace");
    },
    [store, reveal],
  );

  // Выбор события в другой части страницы выделяет его узел. Выбор с источником
  // «trace» сделан в этой же вкладке и уже показан, его не повторяем. Но вкладка,
  // открытая заново (страница переключила вид туда и обратно), ничего не помнит:
  // её первый выбор с таким источником показываем, как чужой.
  const syncedSelection = useRef<string | null>(null);
  useEffect(() => {
    const key = `${selection.seq}:${selection.eventId}`;
    if (selection.source === "trace" && syncedSelection.current !== null) {
      syncedSelection.current = key;
      return;
    }
    if (syncedSelection.current === key) return;
    if (selection.eventId === null) {
      syncedSelection.current = key;
      setSelectedSpanId(null);
      return;
    }
    if (!state.ready) return;
    syncedSelection.current = key;
    const spanId = findSpanByEvent(tree, selection.eventId);
    if (!spanId) {
      setSelectedSpanId(null);
      return;
    }
    setSelectedSpanId(spanId);
    setDetailsOpen(true);
    reveal(spanId);
  }, [selection.seq, selection.eventId, selection.source, state.ready, state.revision, tree, reveal]);

  const onCollapseChange = useCallback(
    (spanId: string, collapsed: boolean) => {
      const snapshot = store.getSnapshot();
      const node = snapshot.tree.get(spanId);
      setCollapse((current) => setCollapsed(current, spanId, collapsed));
      const turnId = node?.span.turn_id;
      if (!collapsed && node && node.span.kind === "turn" && node.span.parent_span_id === null && turnId && !snapshot.loadedTurnIds.has(turnId)) {
        syncRef.current?.loadTurn(turnId).catch(() => {
          setNotice("Не удалось загрузить ход. Повторите попытку.");
          setCollapse((current) => setCollapsed(current, spanId, true));
        });
      }
    },
    [store],
  );

  /* ---------- Поиск ---------- */

  const hasUnloaded = unloadedTurnIds.size > 0;
  useEffect(() => {
    const text = query.trim();
    if (!text || !state.ready || !hasUnloaded) {
      setRemote(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchRemote(client, text, {
        isCancelled: () => cancelled,
        retryDelayMs: searchDebounceMs,
        onProgress: (progress) => {
          if (!cancelled) setRemote({ query, matches: progress.matches, remaining: progress.done ? 0 : progress.remainingTurns });
        },
      }).catch(() => {
        if (!cancelled) setRemote(null);
      });
    }, searchDebounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, state.ready, hasUnloaded, client, searchDebounceMs]);

  const localIds = useMemo(
    () => searchTree(tree, query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, state.revision, query],
  );
  const remoteMatches = remote && remote.query === query ? remote.matches : NO_MATCHES;
  const matches = useMemo(
    () => mergeMatches(tree, localIds, remoteMatches, turnInfo.order),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, state.revision, localIds, remoteMatches, turnInfo.order],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const currentIndex = matchIndex >= 0 && matchIndex < matches.length ? matchIndex : -1;
  const currentMatchId = currentIndex >= 0 ? matches[currentIndex]!.spanId : null;
  const matchIds = useMemo(() => new Set(matches.filter((match) => match.loaded).map((match) => match.spanId)), [matches]);

  const goToMatch = useCallback(
    async (index: number) => {
      const match = matchesRef.current[index];
      if (!match) return;
      setMatchIndex(index);
      if (!match.loaded) {
        if (!match.turnId) return;
        try {
          await syncRef.current?.loadTurn(match.turnId);
        } catch {
          setNotice("Не удалось загрузить ход. Повторите попытку.");
          return;
        }
      }
      if (!store.getSnapshot().tree.has(match.spanId)) return;
      selectSpan(match.spanId, { reveal: true });
    },
    [store, selectSpan],
  );

  const onNextMatch = () => {
    const count = matches.length;
    if (count) void goToMatch(currentIndex < 0 ? 0 : (currentIndex + 1) % count);
  };
  const onPrevMatch = () => {
    const count = matches.length;
    if (count) void goToMatch(currentIndex < 0 ? count - 1 : (currentIndex - 1 + count) % count);
  };

  const searchProgress =
    query.trim() && remote && remote.query === query && remote.remaining > 0
      ? { remainingTurns: remote.remaining, totalTurns: state.turns.length }
      : null;

  /* ---------- Масштаб ---------- */

  const selectedNode = selectedSpanId ? tree.get(selectedSpanId) ?? null : null;
  const onFitTurn = () => {
    if (!selectedSpanId) return;
    const root = tree.ancestors(selectedSpanId)[0] ?? tree.get(selectedSpanId);
    if (!root) return;
    const start = root.span.start_ms;
    setTimeWindow({ fromMs: start, toMs: Math.max(root.span.end_ms ?? stableNow(), start + 1) });
  };

  // Escape: сначала закрываем детали, потом снимаем выбор.
  const onEscape = () => {
    if (detailsOpen && selectedSpanId) {
      setDetailsOpen(false);
      return;
    }
    if (selectedSpanId) {
      setSelectedSpanId(null);
      onSelectEventRef.current(null, "trace");
    }
  };

  /* ---------- Рисование ---------- */

  const linkAttr = selectedNode?.span.attrs.link_span_id;
  const linkedSpanId = typeof linkAttr === "string" && tree.has(linkAttr) ? linkAttr : null;

  const nowMs = stableNow();
  const durationContext = { nowMs, lastTurnEndMs: lastRootEnd(tree, nowMs) };

  if (loadError) {
    return (
      <div data-trace-view>
        <LoadError
          message={errorText(loadError)}
          onRetry={() => setAttempt((value) => value + 1)}
          size="sm"
          title="Не удалось загрузить трейс"
        />
      </div>
    );
  }
  if (!state.ready) {
    return (
      <div className="p-4 text-sm text-ddc-text-muted" data-trace-view role="status">
        Загрузка трейса
      </div>
    );
  }
  if (state.turns.length === 0) {
    return (
      <div data-trace-view>
        <EmptyState
          body="Ходы появятся, когда агент начнёт работу."
          size="sm"
          title="В этой сессии пока нет трейса"
          tone="neutral"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2" data-trace-view>
      <TraceToolbar
        canFitTurn={selectedNode !== null}
        compact={phone}
        inputRef={searchInputRef}
        currentMatch={currentIndex}
        filter={filter}
        follow={follow}
        hasWindow={timeWindow !== null}
        matchCount={matches.length}
        onCollapseAll={() => setCollapse(collapseAll())}
        onExpandAll={() => setCollapse(expandAll())}
        onFilterChange={setFilter}
        onFitTurn={onFitTurn}
        onFollowChange={setFollow}
        onNextMatch={onNextMatch}
        onPrevMatch={onPrevMatch}
        onQueryChange={(value) => {
          setQuery(value);
          setMatchIndex(-1);
        }}
        onResetWindow={() => setTimeWindow(null)}
        onZoomIn={() => setZoomIndex((index) => Math.min(TRACE_ZOOM_STEPS.length - 1, index + 1))}
        onZoomOut={() => setZoomIndex((index) => Math.max(0, index - 1))}
        query={query}
        searchProgress={searchProgress}
        showFollow={active}
        zoomIndex={zoomIndex}
        zoomSteps={TRACE_ZOOM_STEPS.length}
      />

      {notice ? (
        <div className="flex items-center gap-2 rounded-lg bg-ddc-tone-warning-bg px-3 py-2 text-xs text-ddc-tone-warning-fg" role="alert">
          <span className="min-w-0 flex-1">{notice}</span>
          <Button aria-label="Скрыть сообщение" onClick={() => setNotice(null)} size="icon-xs" variant="ghost">
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      {state.turnsBefore ? (
        <div>
          <Button onClick={() => void syncRef.current?.loadOlder().catch(() => setNotice("Не удалось загрузить ранние ходы."))} size="xs" variant="outline">
            Показать более ранние ходы
          </Button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ddc-border">
        <TraceWaterfall
          currentMatchId={currentMatchId}
          follow={follow && active}
          loadingSpanIds={loadingSpanIds}
          matchIds={matchIds}
          now={stableNow}
          onCollapseAll={() => setCollapse(collapseAll())}
          onCollapseChange={onCollapseChange}
          onEscape={onEscape}
          onExpandAll={() => setCollapse(expandAll())}
          onSelect={(spanId) => selectSpan(spanId)}
          onUserScroll={() => setFollow(false)}
          onWindowChange={setTimeWindow}
          phone={phone}
          revealRequest={revealRequest}
          revision={state.revision}
          rows={rows}
          selectedSpanId={selectedSpanId}
          summaries={turnInfo.summaries}
          toolInput={toolInput}
          tree={tree}
          turnNumbers={turnInfo.numbers}
          window={timeWindow}
          zoom={TRACE_ZOOM_STEPS[zoomIndex]!}
        />
        {selectedNode && detailsOpen ? (
          <TraceDetails
            durationContext={durationContext}
            eventsById={eventsById}
            layout={phone ? "sheet" : "panel"}
            node={selectedNode}
            linkedSpanId={linkedSpanId}
            onClose={() => setDetailsOpen(false)}
            onOpenThread={onOpenThread}
            onSelectSpan={(spanId) => selectSpan(spanId, { reveal: true })}
            onShowInTranscript={onShowInTranscript}
            span={selectedNode.span}
            summary={turnInfo.summaries.get(selectedNode.span.span_id) ?? null}
            turnNumber={turnInfo.numbers.get(selectedNode.span.span_id)}
          />
        ) : null}
      </div>
    </div>
  );
}
