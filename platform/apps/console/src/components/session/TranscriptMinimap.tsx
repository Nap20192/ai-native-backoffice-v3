import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { PlainButton } from "@/components/ui/plain-button";
import { cn } from "@/lib/utils";
import type { TranscriptBlock } from "../../lib/session-stats";
import {
  formatClockRu,
  formatMinimapTimeRu,
  formatShortDurationRu,
} from "./format-ru";
import type { MinimapZoom } from "./TranscriptToolbar";

/* ---------- Отрезки по блокам разговора ---------- */

export interface MinimapSegment {
  blockId: string;
  eventId: string;
  kind: "request" | "user" | "outcome" | "grading" | "error";
  startMs: number;
  endMs: number;
  /** «Вызвал write» или первые слова ответа или реплики. */
  label: string;
  /** Запрос без конца: его правый край это «сейчас». */
  open?: boolean;
}

const LABEL_MAX = 60;

function shorten(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX).trimEnd()}…` : line;
}

type RequestBlock = Extract<TranscriptBlock, { kind: "request" }>;

function requestLabel(block: RequestBlock): string {
  const text = block.items.find((item) => item.kind === "text" && item.text.trim().length > 0);
  if (text && text.kind === "text") return shorten(text.text);
  const tool = block.items.find((item) => item.kind === "tool");
  if (tool && tool.kind === "tool") return `Вызвал ${tool.call.name}`;
  return block.thinking ? "Размышление" : "Запрос к модели";
}

/**
 * Отрезки мини-карты. Запрос к модели идёт от начала до конца, реплика,
 * результат, оценка и ошибка сессии это короткие метки в одну точку.
 * Блоки без времени, разрывы и предупреждения отрезков не дают.
 */
export function minimapSegments(blocks: readonly TranscriptBlock[]): MinimapSegment[] {
  const segments: MinimapSegment[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "request": {
        const startMs = block.request?.startMs ?? block.atMs;
        if (startMs === null) break;
        const endMs = block.request?.endMs ?? block.endMs;
        segments.push({
          blockId: block.id,
          eventId: block.id,
          kind: block.request?.isError ? "error" : "request",
          startMs,
          endMs: endMs === null ? startMs : Math.max(endMs, startMs),
          label: requestLabel(block),
          ...(endMs === null && block.request ? { open: true } : {}),
        });
        break;
      }
      case "user":
        if (block.atMs !== null) {
          segments.push(mark(block, "user", shorten(block.text) || "Сообщение"));
        }
        break;
      case "outcome_defined":
        if (block.atMs !== null) segments.push(mark(block, "outcome", "Задан результат"));
        break;
      case "grading":
        if (block.atMs !== null) {
          // Оценка в образце идёт полосой от начала до конца, без начала остаётся меткой.
          const segment = mark(block, "grading", `Оценка, итерация ${block.evaluation.iteration + 1}`);
          const startMs = block.evaluation.startMs;
          segments.push(startMs !== null && startMs <= segment.endMs ? { ...segment, startMs } : segment);
        }
        break;
      case "error":
        if (block.atMs !== null) segments.push(mark(block, "error", shorten(block.message) || "Ошибка сессии"));
        break;
      default:
        break;
    }
  }
  return segments;
}

function mark(
  block: TranscriptBlock & { atMs: number | null },
  kind: MinimapSegment["kind"],
  label: string,
): MinimapSegment {
  const at = block.atMs as number;
  return { blockId: block.id, eventId: block.id, kind, startMs: at, endMs: at, label };
}

/* ---------- Шкала времени со сжатием простоев ---------- */

export interface TimeScale {
  width: number;
  toX(ms: number): number;
  toMs(x: number): number;
}

const IDLE_GAP_MS = 60_000;
const IDLE_WIDTH_PX = 6;

function effectiveEnd(segment: MinimapSegment, nowMs: number | null | undefined): number {
  return segment.open && nowMs != null ? Math.max(nowMs, segment.startMs) : segment.endMs;
}

/**
 * Время на дорожку в пикселях. Простой длиннее idleGapMs (60 с) сжимается до
 * idleWidthPx (6 px), остальное время делит оставшуюся ширину поровну на
 * миллисекунду. Ширина дорожки равна ширине колонки на масштаб.
 */
export function compressedScale(
  segments: readonly MinimapSegment[],
  options: {
    widthPx: number;
    zoom: MinimapZoom;
    idleGapMs?: number;
    idleWidthPx?: number;
    nowMs?: number | null;
  },
): TimeScale {
  const width = Math.max(0, options.widthPx) * options.zoom;
  const idleGapMs = options.idleGapMs ?? IDLE_GAP_MS;
  const idleWidthPx = options.idleWidthPx ?? IDLE_WIDTH_PX;

  const stamps = new Set<number>();
  for (const segment of segments) {
    stamps.add(segment.startMs);
    stamps.add(effectiveEnd(segment, options.nowMs));
  }
  const times = [...stamps].sort((a, b) => a - b);
  if (times.length < 2) {
    const only = times[0] ?? 0;
    return { width, toX: () => 0, toMs: () => only };
  }

  const gaps = times.slice(1).map((time, index) => time - times[index]!);
  const idleCount = gaps.filter((gap) => gap > idleGapMs).length;
  const linearMs = gaps.reduce((sum, gap) => (gap > idleGapMs ? sum : sum + gap), 0);
  let idle = 0;
  if (idleCount > 0) {
    idle = linearMs > 0 ? Math.min(idleWidthPx, width / (2 * idleCount)) : width / idleCount;
  }
  const pxPerMs = linearMs > 0 ? (width - idle * idleCount) / linearMs : 0;

  // Левый край каждого промежутка и его ширина в пикселях.
  const starts: number[] = [];
  const widths: number[] = [];
  let x = 0;
  for (const gap of gaps) {
    starts.push(x);
    const piece = gap > idleGapMs ? idle : gap * pxPerMs;
    widths.push(piece);
    x += piece;
  }
  const total = x;
  const first = times[0]!;
  const last = times[times.length - 1]!;

  const scale = (position: number) => (total > 0 ? (position / total) * width : 0);

  return {
    width,
    toX(ms) {
      if (ms <= first) return 0;
      if (ms >= last) return scale(total);
      let low = 0;
      let high = gaps.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (times[mid]! <= ms) low = mid;
        else high = mid - 1;
      }
      const gap = gaps[low]!;
      const fraction = gap > 0 ? (ms - times[low]!) / gap : 0;
      return scale(starts[low]! + widths[low]! * fraction);
    },
    toMs(position) {
      if (total === 0 || position <= 0) return first;
      if (position >= width) return last;
      const target = (position / width) * total;
      let low = 0;
      let high = gaps.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid]! <= target) low = mid;
        else high = mid - 1;
      }
      const piece = widths[low]!;
      const fraction = piece > 0 ? (target - starts[low]!) / piece : 0;
      return times[low]! + gaps[low]! * fraction;
    },
  };
}

/* ---------- Мини-карта ---------- */

export interface TranscriptMinimapProps {
  blocks: readonly TranscriptBlock[];
  agentName: string;
  nowMs: number | null;
  zoom: MinimapZoom;
  visibleBlockIds: ReadonlySet<string>;
  hoveredBlockId: string | null;
  selectedBlockId: string | null;
  matchBlockIds: ReadonlySet<string>;
  /** Метка времени, когда курсор стоит на графике стоимости в инспекторе. */
  externalCursorMs?: number | null;
  onHoverBlock(blockId: string | null): void;
  onSelectBlock(blockId: string, eventId: string): void;
}

/** Ширина колонки, пока её нет в вёрстке (тесты, первый кадр). */
const FALLBACK_WIDTH_PX = 720;
const CARD_WIDTH_PX = 320;
const MARK_MIN_WIDTH_PX = 3;
const BAR_MIN_WIDTH_PX = 2;

function useElementWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

const KIND_CLASS: Record<MinimapSegment["kind"], string> = {
  request: "bg-sky-300 data-[active=true]:bg-sky-500",
  user: "bg-brand-500",
  outcome: "bg-brand-300 data-[active=true]:bg-brand-500",
  grading: "bg-sky-200 data-[active=true]:bg-sky-400",
  error: "bg-(--ddc-dot-danger)",
};

const KIND_OWNER: Record<MinimapSegment["kind"], string> = {
  request: "",
  user: "Пользователь",
  outcome: "Пользователь",
  grading: "Оценка",
  error: "Ошибка",
};

export function TranscriptMinimap({
  blocks,
  agentName,
  nowMs,
  zoom,
  visibleBlockIds,
  hoveredBlockId,
  selectedBlockId,
  matchBlockIds,
  externalCursorMs,
  onHoverBlock,
  onSelectBlock,
}: TranscriptMinimapProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const measured = useElementWidth(frameRef);
  const widthPx = measured > 0 ? measured : FALLBACK_WIDTH_PX;
  const [scrollLeft, setScrollLeft] = useState(0);
  const [localHover, setLocalHover] = useState<string | null>(null);
  const [cursorX, setCursorX] = useState<number | null>(null);

  const segments = useMemo(() => minimapSegments(blocks), [blocks]);
  const scale = useMemo(
    () => compressedScale(segments, { widthPx, zoom, nowMs }),
    [segments, widthPx, zoom, nowMs],
  );
  const placed = useMemo(
    () =>
      segments.map((segment) => {
        const left = scale.toX(segment.startMs);
        const right = scale.toX(effectiveEnd(segment, nowMs));
        const minWidth = segment.kind === "request" ? BAR_MIN_WIDTH_PX : MARK_MIN_WIDTH_PX;
        return { segment, left, width: Math.max(right - left, minWidth) };
      }),
    [segments, scale, nowMs],
  );

  // С масштабом больше 1 дорожка длиннее колонки: выбранный отрезок держим в кадре.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || zoom === 1 || !selectedBlockId) return;
    const target = placed.find((entry) => entry.segment.blockId === selectedBlockId);
    if (!target) return;
    const viewport = scroller.clientWidth || widthPx;
    const from = scroller.scrollLeft;
    if (target.left < from || target.left + target.width > from + viewport) {
      scroller.scrollLeft = Math.max(0, target.left - viewport / 2);
    }
  }, [selectedBlockId, zoom, placed, widthPx]);

  const visibleFrame = useMemo(() => {
    let left = Infinity;
    let right = -Infinity;
    for (const entry of placed) {
      if (!visibleBlockIds.has(entry.segment.blockId)) continue;
      left = Math.min(left, entry.left);
      right = Math.max(right, entry.left + entry.width);
    }
    return Number.isFinite(left) ? { left, width: right - left } : null;
  }, [placed, visibleBlockIds]);

  const hoverEntry = localHover ? placed.find((entry) => entry.segment.blockId === localHover) : undefined;

  const setHover = (blockId: string | null) => {
    setLocalHover(blockId);
    onHoverBlock(blockId);
  };

  const onTrackMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setCursorX(Math.min(Math.max(event.clientX - rect.left, 0), scale.width));
  };

  const externalX =
    cursorX === null && externalCursorMs !== null && externalCursorMs !== undefined
      ? scale.toX(externalCursorMs)
      : null;
  const cursorLineX = cursorX ?? externalX;
  const cursorMs =
    cursorX !== null ? scale.toMs(cursorX) : externalX !== null ? (externalCursorMs ?? null) : null;

  const cardLeft = hoverEntry
    ? Math.min(Math.max(hoverEntry.left - scrollLeft, 0), Math.max(widthPx - CARD_WIDTH_PX, 0))
    : 0;

  return (
    <div
      aria-label="Карта хода"
      className="relative w-full min-w-0"
      data-session-minimap
      ref={frameRef}
      role="group"
    >
      <div
        className="h-12 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        ref={scrollerRef}
      >
        <div
          className="relative h-12"
          data-minimap-track
          onMouseLeave={() => setCursorX(null)}
          onMouseMove={onTrackMove}
          style={{ width: scale.width }}
        >
          <div aria-hidden="true" className="absolute inset-x-0 top-2 h-6 rounded-md bg-ddc-surface-sunken" />
          {visibleFrame ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 h-7 rounded-md border border-ddc-border-strong bg-ddc-surface/40"
              data-minimap-window
              style={{ left: visibleFrame.left, width: visibleFrame.width }}
            />
          ) : null}
          {placed.map(({ segment, left, width }) => {
            const selected = segment.blockId === selectedBlockId;
            const hovered = segment.blockId === hoveredBlockId || segment.blockId === localHover;
            return (
              <PlainButton
                aria-current={selected ? "true" : undefined}
                aria-label={`${segment.label}, ${formatClockRu(segment.startMs)}`}
                className={cn(
                  "absolute top-2 h-6 rounded-[3px] transition-colors",
                  KIND_CLASS[segment.kind],
                  selected && "ring-2 ring-ddc-ring",
                  segment.kind === "request" && hovered && !selected && "bg-sky-500",
                )}
                data-active={selected || hovered ? "true" : "false"}
                data-block-id={segment.blockId}
                data-hovered={hovered ? "true" : "false"}
                data-kind={segment.kind}
                data-minimap-segment
                data-selected={selected ? "true" : "false"}
                key={segment.blockId}
                onBlur={() => setHover(null)}
                onClick={() => onSelectBlock(segment.blockId, segment.eventId)}
                onFocus={() => setHover(segment.blockId)}
                onMouseEnter={() => setHover(segment.blockId)}
                onMouseLeave={() => setHover(null)}
                style={{ left, width }}
              />
            );
          })}
          {placed.map(({ segment, left, width }) =>
            matchBlockIds.has(segment.blockId) ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-[33px] h-1 rounded-full bg-amber-400"
                data-block-id={segment.blockId}
                data-minimap-match
                key={`match:${segment.blockId}`}
                style={{ left, width: Math.max(width, MARK_MIN_WIDTH_PX) }}
              />
            ) : null,
          )}
          {cursorLineX !== null ? (
            <>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-0.5 h-8 w-px bg-ddc-text"
                data-minimap-cursor
                style={{ left: cursorLineX }}
              />
              {cursorMs !== null ? (
                <span
                  className="pointer-events-none absolute top-[35px] rounded bg-ddc-surface px-1 text-2xs leading-3 whitespace-nowrap tabular-nums text-ddc-text-muted"
                  data-testid="minimap-cursor-label"
                  style={{ left: Math.min(cursorLineX + 4, Math.max(scale.width - 96, 0)) }}
                >
                  {formatMinimapTimeRu(cursorMs)}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {hoverEntry ? (
        <div
          className="pointer-events-none absolute bottom-full z-30 mb-1 rounded-xl border border-ddc-border bg-ddc-surface p-2 text-xs leading-4 shadow-soft"
          data-testid="minimap-card"
          style={{ left: cardLeft, width: CARD_WIDTH_PX }}
        >
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 truncate font-medium",
                hoverEntry.segment.kind === "request" || hoverEntry.segment.kind === "error"
                  ? "text-ddc-tone-info-fg"
                  : "text-ddc-tone-brand-fg",
              )}
            >
              {hoverEntry.segment.kind === "request" || hoverEntry.segment.kind === "error"
                ? agentName
                : KIND_OWNER[hoverEntry.segment.kind]}
            </span>
            {hoverEntry.segment.endMs > hoverEntry.segment.startMs ? (
              <span className="ml-auto flex-none tabular-nums text-ddc-text-muted">
                {formatShortDurationRu(hoverEntry.segment.endMs - hoverEntry.segment.startMs)}
              </span>
            ) : null}
            <span
              className={cn(
                "flex-none tabular-nums text-ddc-text-muted",
                hoverEntry.segment.endMs > hoverEntry.segment.startMs ? undefined : "ml-auto",
              )}
            >
              {formatClockRu(hoverEntry.segment.startMs)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-ddc-text">{hoverEntry.segment.label}</div>
        </div>
      ) : null}
    </div>
  );
}
