import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { ArrowDownIcon } from "lucide-react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { AgentChatView, type AgentChatViewSlots } from "@openma/common/chat-ui";
import type { CanonicalChatTurn } from "@openma/common/session-events/managed";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  blockIdByEventId,
  buildTranscriptBlocks,
  eventTimeMs,
  type EventSelection,
  type SessionEvent,
  type TranscriptBlock,
} from "../../lib/session-stats";
import {
  CanonicalSessionTurn,
  projectCanonicalSessionTurn,
} from "./CanonicalSessionTurn";
import { minimapSegments, TranscriptMinimap } from "./TranscriptMinimap";
import { TranscriptToolbar, type MinimapZoom } from "./TranscriptToolbar";
import "./transcript.css";

export interface ManagedSessionConversationProps {
  afterTurns?: ReactNode;
  beforeComposer?: ReactNode;
  composer: ReactNode;
  empty?: ReactNode;
  sessionId?: string;
  /** Ходы выбранного потока: projectCanonicalChatTurns(events, { threadId }). */
  turns: readonly CanonicalChatTurn[];
  agentName: string;
  running: boolean;
  selection: EventSelection;
  onSelectEvent(eventId: string | null, source: "transcript" | "minimap"): void;
  /** Кнопка «Инспектор» от страницы справа в строке поиска. */
  toolbarTrailing?: ReactNode;
  /** Слой поверх ленты и поля ввода под поиском и мини-картой: на узком
   *  экране там встаёт инспектор нижним листом. */
  overlay?: ReactNode;
}

/* ---------- Поиск по разговору ---------- */

export interface SearchMatch {
  blockId: string;
  /** Номер совпадения внутри блока, с нуля. */
  ordinal: number;
  /** Смещение в тексте блока и длина совпадения. */
  start: number;
  length: number;
}

/**
 * Совпадения запроса в текстах блоков, по порядку блоков, без учёта
 * регистра. Запрос ищется как простой текст: точка и скобки в нём не
 * образуют шаблона. Пустой и пробельный запрос совпадений не даёт.
 */
export function findSearchMatches(
  texts: ReadonlyArray<{ blockId: string; text: string }>,
  query: string,
): SearchMatch[] {
  if (!query.trim()) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const matches: SearchMatch[] = [];
  for (const { blockId, text } of texts) {
    let ordinal = 0;
    for (const found of text.matchAll(pattern)) {
      matches.push({ blockId, ordinal, start: found.index ?? 0, length: found[0].length });
      ordinal += 1;
    }
  }
  return matches;
}

interface BlockText {
  blockId: string;
  text: string;
  nodes: Array<{ node: Text; start: number }>;
}

/** Текстовые узлы каждого блока ленты в порядке документа. Подписи, время и
 *  кнопки (data-search-skip) в поиск не входят. */
function collectBlockTexts(root: HTMLElement): BlockText[] {
  const result: BlockText[] = [];
  root.querySelectorAll<HTMLElement>("[data-block-id]").forEach((element) => {
    const nodes: BlockText["nodes"] = [];
    let text = "";
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest("[data-search-skip]")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      nodes.push({ node, start: text.length });
      text += node.data;
    }
    result.push({ blockId: element.dataset.blockId ?? "", text, nodes });
  });
  return result;
}

function rangeFor(info: BlockText, start: number, length: number): Range | null {
  const end = start + length;
  const first = info.nodes.find((entry) => start >= entry.start && start < entry.start + entry.node.data.length);
  const last = info.nodes.find((entry) => end > entry.start && end <= entry.start + entry.node.data.length);
  if (!first || !last) return null;
  const range = first.node.ownerDocument.createRange();
  range.setStart(first.node, start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}

const sameMatches = (a: readonly SearchMatch[], b: readonly SearchMatch[]) =>
  a.length === b.length &&
  a.every(
    (match, index) =>
      match.blockId === b[index]!.blockId &&
      match.start === b[index]!.start &&
      match.length === b[index]!.length,
  );

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
type HighlightConstructor = new () => { add(range: Range): void };

/** CSS Custom Highlight API есть не везде (в jsdom нет): тогда подсветки нет,
 *  а счётчик и переходы работают. */
function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  if (typeof CSS === "undefined") return null;
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : null;
}

const HIGHLIGHT_ALL = "session-search";
const HIGHLIGHT_CURRENT = "session-search-current";

function clearHighlights() {
  const api = highlightApi();
  api?.registry.delete(HIGHLIGHT_ALL);
  api?.registry.delete(HIGHLIGHT_CURRENT);
}

/* ---------- Модель ленты ---------- */

interface ConversationModel {
  blocksByTurn: ReadonlyMap<string, readonly TranscriptBlock[]>;
  allBlocks: readonly TranscriptBlock[];
  blockOfEvent: ReadonlyMap<string, string>;
  turnOfBlock: ReadonlyMap<string, string>;
  turnOfEvent: ReadonlyMap<string, string>;
  /** id результата и подтверждения вызова в id его agent.tool_use. */
  toolUseOf: ReadonlyMap<string, string>;
  /** Порядок для клавиш J и K: блок, затем его вызовы. */
  sequence: readonly string[];
}

const EMPTY_BLOCKS: readonly TranscriptBlock[] = [];
const EMPTY_SET: ReadonlySet<string> = new Set();

function buildModel(turns: readonly CanonicalChatTurn[]): ConversationModel {
  const blocksByTurn = new Map<string, readonly TranscriptBlock[]>();
  const turnOfBlock = new Map<string, string>();
  const turnOfEvent = new Map<string, string>();
  const toolUseOf = new Map<string, string>();
  const allBlocks: TranscriptBlock[] = [];
  const allEvents: SessionEvent[] = [];
  const sequence: string[] = [];
  let previousEventMs: number | null = null;

  for (const turn of turns) {
    // События ответа API и потока совпадают по полям: типы WireSessionEvent и Event шире и уже друг друга.
    const events = turn.rawEvents as unknown as SessionEvent[];
    const blocks = buildTranscriptBlocks(events, { previousEventMs });
    blocksByTurn.set(turn.id, blocks);
    for (const event of events) {
      if (event.id) turnOfEvent.set(event.id, turn.id);
      const time = eventTimeMs(event);
      if (time !== null) previousEventMs = previousEventMs === null ? time : Math.max(previousEventMs, time);
    }
    for (const block of blocks) {
      if (block.id) turnOfBlock.set(block.id, turn.id);
      if (block.kind === "gap") continue;
      if (block.id) sequence.push(block.id);
      if (block.kind !== "request") continue;
      for (const item of block.items) {
        if (item.kind !== "tool") continue;
        const { call } = item;
        if (call.useEventId) sequence.push(call.useEventId);
        for (const id of [call.useEventId, call.resultEventId, call.confirmationEventId]) {
          if (id) toolUseOf.set(id, call.useEventId);
        }
      }
    }
    allBlocks.push(...blocks);
    allEvents.push(...events);
  }

  return {
    blocksByTurn,
    allBlocks,
    blockOfEvent: blockIdByEventId(allBlocks, allEvents),
    turnOfBlock,
    turnOfEvent,
    toolUseOf,
    sequence,
  };
}

/* ---------- Кнопка «Вниз» ---------- */

/** Круглая кнопка 32 px по центру над полем ввода, пока лента прокручена
 *  вверх. Положение задаём сами: классы оболочки лежат в node_modules, и
 *  Tailwind консоли их не собирает. */
export function JumpToBottomButton({
  onClick,
  className,
  icon,
}: {
  onClick(): void;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <Button
      aria-label="Вниз"
      className={cn(className, "absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full")}
      onClick={onClick}
      size="icon-xs"
      title="Вниз"
      type="button"
      variant="outline"
    >
      {icon ?? <ArrowDownIcon aria-hidden="true" />}
    </Button>
  );
}

const renderScrollButton: NonNullable<AgentChatViewSlots["renderScrollButton"]> = ({
  onClick,
  className,
  icon,
}) => <JumpToBottomButton className={className} icon={icon} onClick={onClick} />;

/* ---------- Прилипание к низу ---------- */

/**
 * Отдаёт ленте `stopScroll` общей оболочки. Пока лента прилипает к низу,
 * раскрытие вызова после выбора снаружи возвращает её вниз, и блок уходит
 * из вида. Длинная лента идёт через виртуальный список без StickToBottom:
 * тогда контекста нет и ссылка пустая.
 */
function StickToBottomBridge({ stopRef }: { stopRef: MutableRefObject<(() => void) | null> }) {
  let stop: (() => void) | null;
  try {
    stop = useStickToBottomContext().stopScroll;
  } catch {
    stop = null;
  }
  useLayoutEffect(() => {
    stopRef.current = stop;
    return () => {
      stopRef.current = null;
    };
  });
  return null;
}

/* ---------- Разговор ---------- */

const MemoTurn = memo(CanonicalSessionTurn);

function isEditable(target: HTMLElement): boolean {
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

/** Элемент строки вызова или блока по id события, без экранирования
 *  селектора: id приходят с сервера. */
function findByAttribute(root: ParentNode | null, attribute: string, value: string): HTMLElement | null {
  if (!root) return null;
  for (const element of root.querySelectorAll<HTMLElement>(`[${attribute}]`)) {
    if (element.getAttribute(attribute) === value) return element;
  }
  return null;
}

/**
 * Разговор сессии. Общая оболочка `AgentChatView` держит прокрутку,
 * прилипание к низу и колонку поля ввода, а здесь стоят поиск и масштаб,
 * мини-карта и блоки хода. Выбор события один на страницу: лента, мини-карта
 * и инспектор читают и пишут его через `selection` и `onSelectEvent`.
 */
export function ManagedSessionConversation({
  afterTurns,
  beforeComposer,
  composer,
  empty,
  sessionId,
  turns,
  agentName,
  running,
  selection,
  onSelectEvent,
  toolbarTrailing,
  overlay,
}: ManagedSessionConversationProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const projectedTurns = useMemo(() => turns.map(projectCanonicalSessionTurn), [turns]);
  const sourceTurns = useMemo(() => new Map(turns.map((turn) => [turn.id, turn])), [turns]);
  const model = useMemo(() => buildModel(turns), [turns]);
  const hasSegments = useMemo(() => minimapSegments(model.allBlocks).length > 0, [model.allBlocks]);

  const onSelectRef = useRef(onSelectEvent);
  onSelectRef.current = onSelectEvent;
  const selectFromTranscript = useCallback(
    (eventId: string | null) => onSelectRef.current(eventId, "transcript"),
    [],
  );

  /* --- время «сейчас» для открытого запроса --- */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  /* --- выбор --- */
  const selectedEventId = selection.eventId;
  const selectedBlockId = selectedEventId ? (model.blockOfEvent.get(selectedEventId) ?? null) : null;
  const [collapsedSeq, setCollapsedSeq] = useState<number | null>(null);
  const expandSelected =
    selectedEventId !== null &&
    selection.source !== "tools" &&
    selection.source !== "minimap" &&
    collapsedSeq !== selection.seq;

  // Переход клавишами J, K, ↑ и ↓ только выбирает событие: раскрывает вызов
  // клавиша → или клик. Иначе каждый шаг по ленте раскрывал бы очередной вызов.
  const collapseNextSelection = useRef(false);
  useLayoutEffect(() => {
    if (!collapseNextSelection.current || selectedEventId === null) return;
    collapseNextSelection.current = false;
    setCollapsedSeq(selection.seq);
  }, [selection.seq, selectedEventId]);

  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<MinimapZoom>(1);

  // Любая прокрутка ленты к блоку сначала снимает прилипание к низу.
  const stopStickRef = useRef<(() => void) | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const scrolledKey = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (pendingScroll.current === null) return;
      cancelAnimationFrame(pendingScroll.current);
      pendingScroll.current = null;
      // Запланированная прокрутка не сработала (StrictMode снимает эффекты сразу
      // после монтирования): следующий запуск эффекта выбора поставит её заново.
      scrolledKey.current = null;
    },
    [],
  );

  const scrollToEvent = useCallback(
    (eventId: string, align: ScrollLogicalPosition, afterResize = false) => {
      const find = () => {
        const column = columnRef.current;
        const useId = model.toolUseOf.get(eventId);
        const blockId = model.blockOfEvent.get(eventId);
        return (
          (useId ? findByAttribute(column, "data-event-id", useId) : null) ??
          findByAttribute(column, "data-block-id", blockId ?? eventId)
        );
      };
      const target = find();
      if (!target) return false;
      stopStickRef.current?.();
      if (pendingScroll.current !== null) cancelAnimationFrame(pendingScroll.current);
      const run = () => {
        pendingScroll.current = null;
        (target.isConnected ? target : find())?.scrollIntoView({ block: align, behavior: "smooth" });
      };
      if (!afterResize) {
        run();
        return true;
      }
      // Выбор снаружи раскрывает или сворачивает вызов, высота ленты меняется.
      // Оболочка ловит это в ResizeObserver и сама ставит scrollTop, а это
      // обрывает плавную прокрутку. Ждём два кадра: наблюдатель отработал.
      pendingScroll.current = requestAnimationFrame(() => {
        pendingScroll.current = requestAnimationFrame(run);
      });
      return true;
    },
    [model],
  );

  const jumpToBlock = useCallback((blockId: string) => {
    const target = findByAttribute(columnRef.current, "data-block-id", blockId);
    if (!target) return;
    stopStickRef.current?.();
    target.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  // Выбор снаружи прокручивает ленту к событию. Выбор в самой ленте не
  // прокручивает: читатель уже видит блок. Если блока ещё нет (история
  // грузится), ждём его появления.
  useEffect(() => {
    if (selectedEventId === null) {
      scrolledKey.current = null;
      return;
    }
    const key = `${selection.seq}:${selectedEventId}`;
    if (scrolledKey.current === key) return;
    if (selection.source === "transcript") {
      scrolledKey.current = key;
      return;
    }
    if (scrollToEvent(selectedEventId, "center", true)) scrolledKey.current = key;
  }, [selection.seq, selection.source, selectedEventId, scrollToEvent]);

  /* --- поиск --- */
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [navTick, setNavTick] = useState(0);
  const blockTexts = useRef<BlockText[]>([]);
  const pendingMatchScroll = useRef(false);

  const current = matches.length === 0 ? -1 : Math.min(currentMatch, matches.length - 1);
  const currentBlockId = current >= 0 ? matches[current]!.blockId : null;

  const goToMatch = useCallback(
    (delta: number) => {
      if (matches.length === 0) return;
      pendingMatchScroll.current = true;
      setCurrentMatch((current < 0 ? 0 : current + delta + matches.length) % matches.length);
      setNavTick((tick) => tick + 1);
    },
    [current, matches.length],
  );
  const onQueryChange = useCallback((next: string) => {
    setQuery(next);
    setCurrentMatch(0);
    pendingMatchScroll.current = true;
    setNavTick((tick) => tick + 1);
  }, []);

  // Пересчёт при каждой отрисовке: подпись «3/12» и подсветка обязаны
  // совпадать с тем, что сейчас стоит на экране.
  useLayoutEffect(() => {
    if (!query.trim()) {
      blockTexts.current = [];
      setMatches((previous) => (previous.length === 0 ? previous : []));
      return;
    }
    const column = columnRef.current;
    if (!column) return;
    const infos = collectBlockTexts(column);
    blockTexts.current = infos;
    const next = findSearchMatches(infos, query);
    setMatches((previous) => (sameMatches(previous, next) ? previous : next));
  });

  useLayoutEffect(() => {
    const api = highlightApi();
    if (!api || matches.length === 0) {
      clearHighlights();
      return;
    }
    const all = new api.Highlight();
    const currentOnly = new api.Highlight();
    matches.forEach((match, index) => {
      const info = blockTexts.current.find((entry) => entry.blockId === match.blockId);
      const range = info ? rangeFor(info, match.start, match.length) : null;
      if (!range) return;
      all.add(range);
      if (index === current) currentOnly.add(range);
    });
    api.registry.set(HIGHLIGHT_ALL, all);
    api.registry.set(HIGHLIGHT_CURRENT, currentOnly);
    return clearHighlights;
  });

  useEffect(() => {
    if (!pendingMatchScroll.current || current < 0) return;
    pendingMatchScroll.current = false;
    const match = matches[current]!;
    const info = blockTexts.current.find((entry) => entry.blockId === match.blockId);
    const range = info ? rangeFor(info, match.start, match.length) : null;
    const anchor = range?.startContainer.parentElement ?? findByAttribute(columnRef.current, "data-block-id", match.blockId);
    if (!anchor) return;
    const scroll = () => {
      stopStickRef.current?.();
      anchor.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    const clamp = anchor.closest<HTMLElement>('[data-session-clamp][data-clamp-state="collapsed"]');
    if (clamp) {
      // Свёрнутый текст сначала раскрываем, потом прокручиваем уже по новой вёрстке.
      clamp.dispatchEvent(new CustomEvent("session-clamp-expand"));
      requestAnimationFrame(scroll);
    } else {
      scroll();
    }
  }, [matches, current, navTick]);

  /* --- видимая часть ленты для рамки на мини-карте --- */
  const [visibleBlockIds, setVisibleBlockIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const manyTurns = turns.length > 16;
  useEffect(() => {
    const column = columnRef.current;
    const scroller = column?.closest<HTMLElement>(".chat-scrollbar");
    if (!column || !scroller) return;
    const update = () => {
      const bounds = scroller.getBoundingClientRect();
      const ids = new Set<string>();
      column.querySelectorAll<HTMLElement>("[data-block-id]").forEach((element) => {
        const box = element.getBoundingClientRect();
        if (box.height > 0 && box.bottom > bounds.top && box.top < bounds.bottom) {
          ids.add(element.dataset.blockId ?? "");
        }
      });
      setVisibleBlockIds((previous) =>
        previous.size === ids.size && [...ids].every((id) => previous.has(id)) ? previous : ids,
      );
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [model, manyTurns]);

  /* --- клавиши --- */
  const keyContext = useRef({ model, selection, expandSelected, collapsedSeq });
  keyContext.current = { model, selection, expandSelected, collapsedSeq };

  useEffect(() => {
    const move = (delta: 1 | -1, requireSelection: boolean, event: KeyboardEvent) => {
      const { model: m, selection: sel } = keyContext.current;
      if (m.sequence.length === 0) return;
      let next: number;
      if (sel.eventId === null) {
        if (requireSelection) return;
        next = delta > 0 ? 0 : m.sequence.length - 1;
      } else {
        const id = m.toolUseOf.get(sel.eventId) ?? m.blockOfEvent.get(sel.eventId) ?? sel.eventId;
        const index = m.sequence.indexOf(id);
        next = index < 0 ? (delta > 0 ? 0 : m.sequence.length - 1) : Math.min(Math.max(index + delta, 0), m.sequence.length - 1);
      }
      event.preventDefault();
      const target = m.sequence[next]!;
      collapseNextSelection.current = true;
      onSelectRef.current(target, "transcript");
      scrollToEvent(target, "nearest");
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && isEditable(target)) return;
      const root = rootRef.current;
      if (
        target &&
        target !== document.body &&
        target !== document.documentElement &&
        !root?.contains(target)
      ) {
        return;
      }
      // Лист инспектора на узком экране стоит внутри корня ленты, но клавиши в
      // нём принадлежат инспектору, как на десктопе, где он вне корня.
      if (target?.closest("[data-session-overlay]")) return;
      // Открытое окно или меню само ловит Esc и стрелки.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;

      const { model: m, selection: sel, expandSelected: expanded, collapsedSeq: collapsed } = keyContext.current;
      switch (event.key) {
        case "/":
          event.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
          return;
        case "Escape":
          if (sel.eventId !== null) {
            event.preventDefault();
            onSelectRef.current(null, "transcript");
          }
          return;
        case "j":
        case "J":
          move(1, false, event);
          return;
        case "k":
        case "K":
          move(-1, false, event);
          return;
        case "ArrowDown":
          move(1, true, event);
          return;
        case "ArrowUp":
          move(-1, true, event);
          return;
        case "ArrowRight":
          if (sel.eventId !== null && m.toolUseOf.has(sel.eventId)) {
            event.preventDefault();
            if (collapsed === sel.seq) setCollapsedSeq(null);
            else if (!expanded) onSelectRef.current(sel.eventId, "transcript");
          }
          return;
        case "ArrowLeft":
          if (sel.eventId !== null && m.toolUseOf.has(sel.eventId)) {
            event.preventDefault();
            setCollapsedSeq(sel.seq);
          }
          return;
        default:
          return;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [scrollToEvent]);

  /* --- ходы --- */
  const ringBlockId = currentBlockId ?? selectedBlockId;
  const matchBlockIds = useMemo(() => new Set(matches.map((match) => match.blockId)), [matches]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-session-conversation ref={rootRef}>
      <div className="shrink-0 space-y-2 px-4 pt-2 pb-2" data-session-toolbar>
        <TranscriptToolbar
          currentMatch={current}
          inputRef={searchInputRef}
          matchCount={matches.length}
          onNextMatch={() => goToMatch(1)}
          onPrevMatch={() => goToMatch(-1)}
          onQueryChange={onQueryChange}
          onZoomChange={setZoom}
          query={query}
          trailing={toolbarTrailing}
          zoom={zoom}
        />
        {hasSegments ? (
          <TranscriptMinimap
            agentName={agentName}
            blocks={model.allBlocks}
            hoveredBlockId={hoveredBlockId}
            matchBlockIds={matchBlockIds}
            nowMs={running ? now : null}
            onHoverBlock={setHoveredBlockId}
            onSelectBlock={(_blockId, eventId) => onSelectEvent(eventId, "minimap")}
            selectedBlockId={ringBlockId}
            visibleBlockIds={visibleBlockIds}
            zoom={zoom}
          />
        ) : null}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <AgentChatView
          className="flex-1 min-h-0"
          phase="active"
          renderTurn={({ turn }) => {
            const source = sourceTurns.get(turn.id);
            if (!source) return null;
            const ownsEvent = selectedEventId !== null && model.turnOfEvent.get(selectedEventId) === turn.id;
            const owns = (blockId: string | null) =>
              blockId !== null && model.turnOfBlock.get(blockId) === turn.id ? blockId : null;
            return (
              <MemoTurn
                agentName={agentName}
                blocks={model.blocksByTurn.get(turn.id) ?? EMPTY_BLOCKS}
                expandSelected={ownsEvent && expandSelected}
                hoveredBlockId={owns(hoveredBlockId)}
                onJumpToBlock={jumpToBlock}
                onSelectEvent={selectFromTranscript}
                selectedBlockId={owns(ringBlockId)}
                selectedEventId={ownsEvent ? selectedEventId : null}
                sessionId={sessionId}
                turn={source}
              />
            );
          }}
          sessionId={sessionId}
          slots={{
            composer,
            beforeComposer,
            conversationContentAfter: afterTurns,
            renderScrollButton,
            wrapConversationContent: (children) => (
              <div
                className="mx-auto flex w-full max-w-[752px] min-w-0 flex-col gap-8 [--chat-message-padding-inline:16px]"
                data-session-column
                ref={columnRef}
              >
                <StickToBottomBridge stopRef={stopStickRef} />
                {children}
              </div>
            ),
            empty: empty ?? (
              <p className="text-sm text-ddc-text-muted">Отправьте сообщение, чтобы начать сессию.</p>
            ),
          }}
          surface="console"
          turns={projectedTurns}
        />
        {overlay ? (
          <div className="absolute inset-0 z-30 flex min-h-0 flex-col" data-session-overlay>
            {overlay}
          </div>
        ) : null}
      </div>
    </div>
  );
}
