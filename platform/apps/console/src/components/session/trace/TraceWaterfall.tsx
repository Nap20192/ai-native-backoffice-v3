import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import {
  AnchorIcon,
  ArrowRightIcon,
  BotIcon,
  BoxIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CpuIcon,
  FlagIcon,
  GitBranchIcon,
  HourglassIcon,
  LayersIcon,
  Loader2Icon,
  Minimize2Icon,
  PlayIcon,
  PlugIcon,
  RepeatIcon,
  ServerIcon,
  ShieldCheckIcon,
  TargetIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WorkflowIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { PlainButton } from "@/components/ui/plain-button";
import { cn } from "@/lib/utils";
import type { TraceSpan, TraceSpanKind, TraceTurnSummary } from "../../../lib/trace-api";
import {
  axisTicks,
  barGeometry,
  buildTraceScale,
  isErrorSpan,
  lastRootEnd,
  noDataGaps,
  rowWindow,
  type TraceNode,
  type TraceRow,
  type TraceTree,
} from "../../../lib/trace-tree";
import { EMPTY_VALUE, formatShortDurationRu } from "../format-ru";
import {
  durationCellText,
  errorBadgeText,
  eventLabel,
  formatClockMsRu,
  isLevelZeroTurn,
  rowStatusText,
  spanDurationMs,
  spanSubtitle,
  spanTitle,
  turnBadges,
  waitingSinceText,
} from "./trace-text";
import "./trace.css";

/**
 * Дерево и водопад трейса (docs/plans/agent-trace.md, 4.2 и 4.7). Слева дерево
 * с вложенностью, посередине полосы на общей шкале времени, справа длительность.
 * Левая и правая колонки липкие, поэтому при крупном масштабе прокручивается
 * только шкала. Строки одной высоты, в разметке стоят только видимые строки
 * и запас вокруг них.
 */

export const TRACE_ROW_HEIGHT = 24;
export const TRACE_PHONE_ROW_HEIGHT = 44;
export const TRACE_ZOOM_STEPS = [1, 2, 4, 8, 16] as const;

const DURATION_WIDTH = 72;
const AXIS_HEIGHT = 28;
const OVERSCAN = 8;
const FALLBACK_WIDTH = 960;
const FALLBACK_HEIGHT = 480;
const MIN_BRUSH_PX = 8;
const TICK_MIN_GAP_PX = 88;
/** Место под подпись риски: у правого края риски без места не рисуются, чтобы не лезть под колонку длительности. */
const TICK_LABEL_WIDTH_PX = 64;
const TIMER_MS = 250;
const RESCALE_MS = 2_000;

export interface TraceWaterfallProps {
  tree: TraceTree;
  /** Номер правки дерева: дерево меняется на месте, по номеру пересчитывается шкала. */
  revision: number;
  rows: readonly TraceRow[];
  window: { fromMs: number; toMs: number } | null;
  zoom: number;
  now: () => number;
  selectedSpanId: string | null;
  currentMatchId: string | null;
  matchIds: ReadonlySet<string>;
  /** Номер хода по span_id строки хода. */
  turnNumbers: ReadonlyMap<string, number>;
  /** Сводки ходов по span_id строки хода. */
  summaries: ReadonlyMap<string, TraceTurnSummary>;
  /** Строки ходов, поддерево которых сейчас грузится. */
  loadingSpanIds: ReadonlySet<string>;
  /** Аргумент вызова инструмента для серой подписи. */
  toolInput(span: TraceSpan): string | null;
  phone: boolean;
  revealRequest: { spanId: string; seq: number } | null;
  follow: boolean;
  onUserScroll(): void;
  onSelect(spanId: string): void;
  onCollapseChange(spanId: string, collapsed: boolean): void;
  onCollapseAll(): void;
  onExpandAll(): void;
  onWindowChange(window: { fromMs: number; toMs: number }): void;
  /** Escape в списке: страница закрывает детали, а потом снимает выбор. */
  onEscape(): void;
}

/* ---------- Оформление по виду ---------- */

const BAR_BY_KIND: Record<TraceSpanKind, string> = {
  turn: "bg-ink-300",
  sandbox: "bg-ink-400",
  sandbox_phase: "bg-ink-400",
  harness_start: "bg-ink-400",
  acp_prompt: "bg-sky-300",
  model_call: "bg-sky-300",
  agent_step: "bg-ink-300",
  hook: "bg-ink-300",
  compaction: "bg-ink-300",
  tool_call: "bg-emerald-300",
  tool_exec: "bg-emerald-300",
  tool_wait: "bg-amber-300",
  retry_wait: "bg-amber-300",
  subagent: "bg-brand-300",
  outcome_eval: "bg-brand-300",
  event: "bg-ink-400",
};

function barClass(span: TraceSpan): string {
  if (isErrorSpan(span)) return "bg-(--ddc-dot-danger)";
  if (span.status === "denied" || span.status === "interrupted" || span.status === "cancelled") {
    return "bg-(--ddc-dot-neutral)";
  }
  if (span.kind === "event" && eventLabel(span.name) === "Предупреждение") return "bg-amber-400";
  return BAR_BY_KIND[span.kind];
}

const ICON_BY_KIND: Record<TraceSpanKind, LucideIcon> = {
  turn: WorkflowIcon,
  sandbox: BoxIcon,
  sandbox_phase: ServerIcon,
  harness_start: PlayIcon,
  acp_prompt: BotIcon,
  agent_step: LayersIcon,
  model_call: CpuIcon,
  tool_call: WrenchIcon,
  tool_wait: HourglassIcon,
  tool_exec: TerminalIcon,
  subagent: GitBranchIcon,
  outcome_eval: TargetIcon,
  compaction: Minimize2Icon,
  retry_wait: RepeatIcon,
  hook: AnchorIcon,
  event: FlagIcon,
};

const ICON_BY_EVENT: Record<string, LucideIcon> = {
  "Ошибка": CircleAlertIcon,
  "Предупреждение": TriangleAlertIcon,
  "Подключение MCP": PlugIcon,
  "Подтверждение": ShieldCheckIcon,
};

function iconOf(span: TraceSpan): LucideIcon {
  return (span.kind === "event" && ICON_BY_EVENT[eventLabel(span.name)]) || ICON_BY_KIND[span.kind];
}

function statusTone(span: TraceSpan): "danger" | "warning" | "muted" {
  if (isErrorSpan(span)) return "danger";
  if (span.status === "waiting" || (span.kind === "turn" && span.attrs.stop_reason === "requires_action")) return "warning";
  return "muted";
}

/** Подсказка полосы: название, длительность и время начала. */
function barTitle(title: string, duration: string, startMs: number): string {
  return [title, duration === EMPTY_VALUE ? null : duration, formatClockMsRu(startMs)].filter(Boolean).join(", ");
}

/* ---------- Размеры ---------- */

function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () =>
      setSize((previous) =>
        previous.width === element.clientWidth && previous.height === element.clientHeight
          ? previous
          : { width: element.clientWidth, height: element.clientHeight },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function rootOf(node: TraceNode): TraceNode {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/* ---------- Компонент ---------- */

export function TraceWaterfall({
  tree,
  revision,
  rows,
  window: timeWindow,
  zoom,
  now,
  selectedSpanId,
  currentMatchId,
  matchIds,
  turnNumbers,
  summaries,
  loadingSpanIds,
  toolInput,
  phone,
  revealRequest,
  follow,
  onUserScroll,
  onSelect,
  onCollapseChange,
  onCollapseAll,
  onExpandAll,
  onWindowChange,
  onEscape,
}: TraceWaterfallProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(scrollRef);
  const viewportW = size.width > 0 ? size.width : FALLBACK_WIDTH;
  const viewportH = size.height > 0 ? size.height : FALLBACK_HEIGHT;

  const rowH = phone ? TRACE_PHONE_ROW_HEIGHT : TRACE_ROW_HEIGHT;
  const axisH = phone ? 0 : AXIS_HEIGHT;
  const bodyH = Math.max(0, viewportH - axisH);
  const labelW = phone ? viewportW : viewportW >= 1000 ? 380 : viewportW >= 720 ? 320 : 240;
  const barViewportW = Math.max(160, viewportW - labelW - DURATION_WIDTH);
  const barW = phone ? 0 : barViewportW * zoom;
  const contentW = labelW + barW + DURATION_WIDTH;

  // Текущее время, на которое построена шкала. Живёт до следующей правки дерева.
  const nowRef = useRef(now);
  nowRef.current = now;
  const [rescale, setRescale] = useState(0);
  const builtNow = useMemo(() => nowRef.current(), [revision, timeWindow?.fromMs, timeWindow?.toMs, rescale]);
  const lastTurnEndMs = useMemo(() => lastRootEnd(tree, builtNow), [tree, revision, builtNow]);
  const scale = useMemo(
    () => buildTraceScale(tree, { widthPx: barW, nowMs: builtNow, window: timeWindow }),
    [tree, revision, barW, builtNow, timeWindow],
  );
  const ticks = useMemo(() => (phone ? [] : axisTicks(scale, { minGapPx: TICK_MIN_GAP_PX, labelWidthPx: TICK_LABEL_WIDTH_PX })), [scale, phone]);

  /* Окно строк. */
  const [firstRow, setFirstRow] = useState(0);
  const range = rowWindow({
    scrollTop: firstRow * rowH,
    viewportHeight: bodyH,
    rowHeight: rowH,
    total: rows.length,
    overscan: OVERSCAN,
  });
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const setScrollTop = useCallback(
    (top: number) => {
      const element = scrollRef.current;
      if (!element) return;
      const value = Math.max(0, top);
      element.scrollTop = value;
      setFirstRow(Math.floor(value / rowH));
    },
    [rowH],
  );

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const next = Math.floor(event.currentTarget.scrollTop / rowH);
      setFirstRow((previous) => (previous === next ? previous : next));
    },
    [rowH],
  );

  // Показать узел: к середине окна.
  useEffect(() => {
    if (!revealRequest) return;
    const index = rowsRef.current.findIndex((row) => row.span.span_id === revealRequest.spanId);
    if (index < 0) return;
    const maxScroll = Math.max(0, rowsRef.current.length * rowH - bodyH);
    setScrollTop(clamp(index * rowH - bodyH / 2 + rowH / 2, 0, maxScroll));
    // Запрос уникален по seq; остальные значения читаются на момент запроса.
  }, [revealRequest?.seq, revealRequest?.spanId]);

  // Выбранная строка остаётся в видимой части.
  useEffect(() => {
    if (!selectedSpanId) return;
    const element = scrollRef.current;
    const index = rowsRef.current.findIndex((row) => row.span.span_id === selectedSpanId);
    if (!element || index < 0) return;
    const top = index * rowH;
    const bottom = top + rowH;
    const current = element.scrollTop;
    if (top < current) setScrollTop(top);
    else if (bottom > current + bodyH) setScrollTop(bottom - bodyH);
  }, [selectedSpanId]);

  // Слежение за ходом: последняя строка в виду.
  useEffect(() => {
    if (!follow) return;
    const element = scrollRef.current;
    if (!element) return;
    const bottom = Math.max(0, rows.length * rowH - bodyH);
    if (Math.abs(element.scrollTop - bottom) > 1) setScrollTop(bottom);
  }, [follow, rows, rowH, bodyH, setScrollTop]);

  /* Открытые полосы растут по таймеру через переменную CSS, дерево не пересчитывается. */
  const visible = rows.slice(range.start, range.end);
  const hasOpenBars = !phone && visible.some((row) => row.span.end_ms === null && row.span.status === "running");
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (!hasOpenBars) {
      element.style.removeProperty("--trace-now-x");
      return;
    }
    const tick = () => {
      const extra = Math.max(0, nowRef.current() - builtNow);
      element.style.setProperty("--trace-now-x", `${scale.toX(builtNow) + extra * scale.pxPerMs}px`);
    };
    tick();
    const timer = setInterval(tick, TIMER_MS);
    // Правый край шкалы тоже растёт: раз в две секунды пересчитываем её по текущему времени.
    const rescaleTimer = setInterval(() => setRescale((value) => value + 1), RESCALE_MS);
    return () => {
      clearInterval(timer);
      clearInterval(rescaleTimer);
    };
  }, [hasOpenBars, builtNow, scale]);

  /* Выделение участка мышью на оси. */
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  const onAxisMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x0 = clamp(event.clientX - rect.left, 0, barW);
    setBrush({ x0, x1: x0 });
    const move = (moveEvent: MouseEvent) => setBrush({ x0, x1: clamp(moveEvent.clientX - rect.left, 0, barW) });
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      dragCleanup.current = null;
    };
    const up = (upEvent: MouseEvent) => {
      stop();
      const x1 = clamp(upEvent.clientX - rect.left, 0, barW);
      setBrush(null);
      if (Math.abs(x1 - x0) < MIN_BRUSH_PX) return;
      onWindowChange({ fromMs: scale.toMs(Math.min(x0, x1)), toMs: scale.toMs(Math.max(x0, x1)) });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    dragCleanup.current = stop;
  };

  /* Клавиши дерева. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
    const list = rowsRef.current;
    const index = selectedSpanId ? list.findIndex((row) => row.span.span_id === selectedSpanId) : -1;
    const current = index >= 0 ? list[index]! : null;
    const selectAt = (target: number) => {
      const next = list[clamp(target, 0, list.length - 1)];
      if (next) onSelect(next.span.span_id);
    };
    switch (event.key) {
      case "ArrowDown":
      case "j":
        event.preventDefault();
        if (list.length) selectAt(index < 0 ? 0 : index + 1);
        break;
      case "ArrowUp":
      case "k":
        event.preventDefault();
        if (list.length) selectAt(index < 0 ? list.length - 1 : index - 1);
        break;
      case "Escape":
        onEscape();
        break;
      case "ArrowRight":
        if (!current) break;
        event.preventDefault();
        if (current.expandable && current.collapsed) onCollapseChange(current.span.span_id, false);
        else if (current.expandable && list[index + 1] && list[index + 1]!.depth > current.depth) selectAt(index + 1);
        break;
      case "ArrowLeft":
        if (!current) break;
        event.preventDefault();
        if (current.expandable && !current.collapsed) onCollapseChange(current.span.span_id, true);
        else if (current.node.parent) onSelect(current.node.parent.span.span_id);
        break;
      case "Enter":
        if (current) {
          event.preventDefault();
          onSelect(current.span.span_id);
        }
        break;
      case "[":
        event.preventDefault();
        onCollapseAll();
        break;
      case "]":
        event.preventDefault();
        onExpandAll();
        break;
      case "o":
        if (current?.expandable) onCollapseChange(current.span.span_id, false);
        break;
      case "p":
        if (current?.expandable) onCollapseChange(current.span.span_id, true);
        break;
      default:
        break;
    }
  };

  const cssVars = { "--trace-label-w": `${labelW}px`, "--trace-bar-w": `${barW}px` } as CSSProperties;
  const durationContext = { nowMs: builtNow, lastTurnEndMs };

  return (
    <div
      aria-activedescendant={selectedSpanId ? `trace-row-${selectedSpanId}` : undefined}
      aria-label="Трейс"
      aria-rowcount={rows.length + (phone ? 0 : 1)}
      className="focus-visible:outline-none"
      data-trace-scroll
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        // Нажатие на полосу прокрутки: пользователь двигает список сам.
        if (event.target === event.currentTarget) onUserScroll();
      }}
      onScroll={onScroll}
      onTouchMove={onUserScroll}
      onWheel={(event) => {
        if (event.deltaY < 0) onUserScroll();
      }}
      ref={scrollRef}
      role="treegrid"
      style={cssVars}
      tabIndex={0}
    >
      <div data-trace-content style={{ width: phone ? "100%" : contentW }}>
        {phone ? null : (
          <div aria-rowindex={1} data-trace-axis role="row" style={{ width: contentW }}>
            <div data-trace-sticky="left" role="columnheader">
              Операция
            </div>
            <div
              aria-label="Шкала времени"
              data-trace-axis-bar
              onMouseDown={onAxisMouseDown}
              role="columnheader"
              style={{ width: barW }}
              title="Выделите участок мышью, чтобы приблизить его"
            >
              {scale.idleGaps.map((gap) => (
                <div
                  data-trace-axis-gap
                  key={`${gap.startMs}`}
                  style={{ left: gap.x, width: Math.max(2, gap.width) }}
                  title={`Простой ${formatShortDurationRu(gap.endMs - gap.startMs)}`}
                />
              ))}
              {ticks.map((tick) => (
                <span data-trace-tick key={tick.ms} style={{ left: tick.x }}>
                  {tick.label}
                </span>
              ))}
              {brush ? (
                <div
                  data-trace-brush
                  style={{ left: Math.min(brush.x0, brush.x1), width: Math.abs(brush.x1 - brush.x0) }}
                />
              ) : null}
            </div>
            <div data-trace-sticky="right" role="columnheader" style={{ justifyContent: "flex-end" }}>
              Длительность
            </div>
          </div>
        )}
        <div data-trace-body style={{ height: rows.length * rowH }}>
          {phone
            ? null
            : scale.idleGaps.map((gap) => (
                <div
                  aria-hidden="true"
                  data-trace-gap
                  key={`${gap.startMs}`}
                  style={{ left: labelW + gap.x, width: Math.max(2, gap.width) }}
                />
              ))}
          {visible.map((row, offset) => {
            const index = range.start + offset;
            const span = row.span;
            const summary = summaries.get(span.span_id) ?? null;
            const title = spanTitle(span, { turnNumber: turnNumbers.get(span.span_id) });
            const subtitle = spanSubtitle(span, {
              toolInput: span.kind === "tool_call" ? toolInput(span) : null,
              parentToolName: row.node.parent?.span.tool?.name ?? null,
            });
            const statusText = rowStatusText(span);
            const errorText = errorBadgeText(span, summary);
            const badges = summary ? turnBadges(summary) : [];
            const failed = isErrorSpan(span);
            const matched = matchIds.has(span.span_id);
            const duration = durationCellText(span, durationContext);
            const loading = loadingSpanIds.has(span.span_id);
            const Icon = iconOf(span);
            const position: CSSProperties = phone
              ? { top: index * rowH, left: 0, right: 0 }
              : { top: index * rowH, width: contentW };

            const label = (
              <>
                {row.expandable ? (
                  <PlainButton
                    aria-label={row.collapsed ? "Развернуть" : "Свернуть"}
                    data-trace-chevron
                    onClick={(event) => {
                      event.stopPropagation();
                      onCollapseChange(span.span_id, !row.collapsed);
                    }}
                    tabIndex={-1}
                  >
                    {loading ? (
                      <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" data-trace-loading />
                    ) : row.collapsed ? (
                      <ChevronRightIcon aria-hidden="true" className="size-3.5" />
                    ) : (
                      <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                    )}
                  </PlainButton>
                ) : (
                  <span aria-hidden="true" data-trace-chevron />
                )}
                <Icon aria-hidden="true" data-trace-kind-icon />
                <span className={cn(failed && "text-ddc-danger-text")} data-trace-title>
                  {title}
                </span>
                {statusText ? (
                  <span data-tone={statusTone(span)} data-trace-status>
                    {statusText}
                  </span>
                ) : null}
                {errorText ? (
                  <span data-tone="danger" data-trace-status>
                    {errorText}
                  </span>
                ) : null}
                {badges.map((badge) => (
                  <span data-tone={badge.tone} data-trace-badge key={badge.key} title={badge.hint}>
                    {badge.text}
                  </span>
                ))}
                {subtitle ? (
                  <span data-trace-subtitle title={subtitle}>
                    {subtitle}
                  </span>
                ) : null}
              </>
            );

            const common = {
              "aria-expanded": row.expandable ? !row.collapsed : undefined,
              "aria-level": row.depth + 1,
              "aria-rowindex": index + 1 + (phone ? 0 : 1),
              "aria-selected": span.span_id === selectedSpanId,
              "data-dimmed": row.dimmed ? "true" : "false",
              "data-error": failed ? "true" : "false",
              "data-kind": span.kind,
              "data-match": span.span_id === currentMatchId ? "current" : matched ? "true" : undefined,
              "data-span-id": span.span_id,
              "data-status": span.status,
              "data-trace-row": true,
              id: `trace-row-${span.span_id}`,
              onClick: () => onSelect(span.span_id),
              role: "row",
              style: position,
            } as const;

            if (phone) {
              const root = rootOf(row.node).span;
              const rootMs = Math.max(1, spanDurationMs(root, durationContext));
              const share = clamp((spanDurationMs(span, durationContext) / rootMs) * 100, 0, 100);
              return (
                <div key={span.span_id} {...common} data-phone="true" style={{ ...position, paddingLeft: 8 + row.depth * 12 }}>
                  <div data-trace-phone-line role="rowheader" style={{ borderRight: 0, padding: 0 }}>
                    <div data-trace-phone-main>{label}</div>
                    <span data-trace-duration role="gridcell">
                      {duration}
                    </span>
                  </div>
                  <div data-trace-phone-share>
                    <span className={barClass(span)} data-trace-share style={{ width: `${share}%` }} />
                  </div>
                </div>
              );
            }

            const bar = barGeometry(span, scale, durationContext);
            const gaps = summary && isLevelZeroTurn(summary) ? noDataGaps(row.node, { nowMs: builtNow }) : [];
            const barStyle: CSSProperties = bar.open
              ? { left: bar.left, width: `calc(var(--trace-now-x, ${bar.left + bar.width}px) - ${bar.left}px)` }
              : { left: bar.left, width: bar.width };

            return (
              <div key={span.span_id} {...common}>
                <div
                  data-trace-label
                  data-trace-sticky="left"
                  role="rowheader"
                  style={{ paddingLeft: 6 + row.depth * 14 }}
                  title={subtitle ? `${title}: ${subtitle}` : title}
                >
                  {label}
                </div>
                <div data-trace-barcell role="gridcell" style={{ width: barW }}>
                  <span
                    className={barClass(span)}
                    data-open={bar.open ? "true" : undefined}
                    data-point={bar.point ? "true" : undefined}
                    data-precision={span.precision}
                    data-trace-bar
                    data-waiting={bar.waiting ? "true" : undefined}
                    style={barStyle}
                    title={barTitle(title, duration, span.start_ms)}
                  />
                  {gaps.map((gap) => (
                    <span
                      data-trace-nodata
                      key={gap.startMs}
                      style={{ left: scale.toX(gap.startMs), width: Math.max(2, scale.toX(gap.endMs) - scale.toX(gap.startMs)) }}
                      title="нет данных"
                    />
                  ))}
                  {bar.waiting ? (
                    <span data-trace-wait-label>
                      <ArrowRightIcon aria-hidden="true" className="size-3" />
                      {waitingSinceText(span)}
                    </span>
                  ) : null}
                </div>
                <div data-trace-duration data-trace-sticky="right" role="gridcell">
                  {duration}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
