import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";
import { ChevronDownIcon, ChevronRightIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { pickTickStep } from "../../lib/format";
import type { Event } from "../../lib/events";
import { EmptyState } from "../EmptyState";
import { Skeleton } from "../Skeleton";
import { formatDurationRu, plural } from "../session/format-ru";
import { bucketIntoTurns, deriveSpans } from "./derive";
import { eventTsMs, resolveTurnExpanded } from "./eventTime";
import {
  DURATION_COL_W,
  FAMILY_BAR,
  FAMILY_DOT,
  LABEL_COL_W,
  MAX_CHART_PX,
  MAX_TICKS,
  STATUS_LABEL,
  STATUS_TEXT,
  TRIGGER_DOT,
  TRIGGER_LABEL,
  type Span,
  type TimelineSelection,
  type Turn,
  type TurnTriggerKind,
} from "./types";

/**
 * Top-level timeline orchestrator. Buckets events into turns, renders one
 * TurnCard per turn with idle dividers between, and hosts the shared
 * right-side detail panel that any span click in any card populates.
 *
 * Performance notes for long sessions:
 * - Only the latest turn mounts expanded; older turns stay collapsed until
 *   clicked so we don't deriveSpans / paint waterfalls for every turn on tab
 *   switch. Expansion is controlled: when a new turn appends, the previous
 *   latest collapses unless the user explicitly overrode it.
 * - Chart width + tick count are hard-capped (see MAX_CHART_PX / MAX_TICKS).
 * - Turn cards use `content-visibility: auto` so off-screen paint is skipped.
 */
export function TimelineView({
  events,
  loading = false,
}: {
  events: Event[];
  /** История ещё грузится: вместо пустого состояния показываем скелетон. */
  loading?: boolean;
}) {
  const turns = useMemo(() => bucketIntoTurns(events), [events]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<TimelineSelection | null>(null);
  /** turnId → explicit expanded override. Absent = follow auto (latest only). */
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const selectedSpanKey = selection?.spanKey ?? null;
  const latestTurnId = turns.length > 0 ? turns[turns.length - 1].id : undefined;

  // Auto-scroll to the latest turn when new ones land. Skip if user has
  // scrolled up — they're inspecting an older turn and shouldn't get yanked.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }
  }, [turns.length]);

  if (turns.length === 0) {
    if (loading) {
      return (
        <div className="flex-1 space-y-3 p-6" aria-busy="true" role="status">
          <span className="sr-only">Загрузка хронологии…</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          size="sm"
          kind="session"
          title="Хронология пока пуста"
          body="Отправьте сообщение, и здесь появятся данные о времени выполнения."
          className="border-0 shadow-none"
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={containerRef} className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4 sm:p-6">
        {turns.map((turn, i) => {
          const prev = i > 0 ? turns[i - 1] : null;
          const idleMs =
            prev && prev.endedAt && turn.triggerTs && turn.triggerTs > prev.endedAt
              ? turn.triggerTs - prev.endedAt
              : 0;
          const expanded = resolveTurnExpanded(turn.id, latestTurnId, expandedOverrides);
          return (
            <Fragment key={turn.id}>
              {idleMs > 0 && <IdleDivider ms={idleMs} nextKind={turn.triggerKind} />}
              <TurnCard
                turn={turn}
                expanded={expanded}
                onToggleExpanded={() =>
                  setExpandedOverrides((prevMap) => ({
                    ...prevMap,
                    [turn.id]: !expanded,
                  }))
                }
                selectedSpanKey={selectedSpanKey}
                onSelectSpan={(span) =>
                  setSelection((cur) =>
                    cur?.spanKey === span.key
                      ? null
                      : { spanKey: span.key, spanLabel: span.label, events: span.events },
                  )
                }
              />
            </Fragment>
          );
        })}
      </div>
      {selection && <DetailPanel selection={selection} onClose={() => setSelection(null)} />}
    </div>
  );
}

/** Cap pretty-printed event JSON so a single huge tool_result doesn't
 *  freeze the main thread when opening the side panel. */
function stringifyEventCapped(ev: Event, maxChars = 50_000): string {
  try {
    const s = JSON.stringify(ev, null, 2);
    if (s.length <= maxChars) return s;
    return `${s.slice(0, maxChars)}\n… обрезано (ещё ${s.length - maxChars} симв.)`;
  } catch {
    return "[событие не удалось сериализовать]";
  }
}

function IdleDivider({ ms, nextKind }: { ms: number; nextKind: TurnTriggerKind }) {
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-ddc-text-muted tabular-nums">
      <div className="flex-1 border-t border-dashed border-ddc-divider" />
      <span>
        Простой {formatDurationRu(ms)}
        {nextKind === "wakeup" && " · пробуждение по расписанию"}
      </span>
      <div className="flex-1 border-t border-dashed border-ddc-divider" />
    </div>
  );
}

function DetailPanel({
  selection,
  onClose,
}: {
  selection: TimelineSelection;
  onClose: () => void;
}) {
  return (
    // Шире xl панель стоит справа шириной 420px (=== SIDE_PANEL_W); уже xl она
    // ложится поверх хронологии, иначе график сжимался бы до нуля.
    <aside
      className="absolute inset-0 z-10 flex min-h-0 w-full flex-col border-l border-ddc-divider bg-ddc-surface animate-fade-in xl:static xl:z-auto xl:w-[420px] xl:shrink-0 xl:animate-none"
      aria-label="Исходные события"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-ddc-divider px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="eyebrow">
            {selection.events.length === 1
              ? "Исходное событие"
              : `Исходные события (${selection.events.length})`}
          </div>
          <div className="mt-1 truncate text-sm font-medium text-ddc-heading" title={selection.spanLabel}>
            {selection.spanLabel}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          title="Закрыть"
          aria-label="Закрыть панель"
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
        {selection.events.map((ev, idx) => (
          <div key={idx} className="overflow-hidden rounded-xl border border-ddc-border">
            <div className="flex items-center gap-2 border-b border-ddc-divider bg-ddc-surface-muted px-3 py-1.5 font-mono text-xs">
              <span className="text-ddc-label">{ev.type}</span>
              {typeof ev.processed_at === "string" && (
                <span className="ml-auto text-ddc-text-muted tabular-nums">
                  {new Date(ev.processed_at).toISOString().slice(11, 23)}
                </span>
              )}
            </div>
            <pre className="overflow-x-auto px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-ddc-label">
              {stringifyEventCapped(ev)}
            </pre>
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * One waterfall row inside a TurnCard. Encapsulates the sticky
 * label-column / chart-area / duration-column layout so callers don't
 * have to re-derive the conditional bg-class for each cell.
 *
 * Pulling this out also kills the previous bug where two of the three
 * cells had `bg-bg-surface/30` and one had a different fallback because
 * I forgot to update them in lockstep.
 */
function TimelineRow({
  isSelected,
  onClick,
  title,
  chartPx,
  leftLabel,
  rightLabel,
  children,
}: {
  isSelected: boolean;
  onClick: () => void;
  title: string;
  chartPx: number;
  leftLabel: ReactNode;
  rightLabel: ReactNode;
  children: ReactNode;
}) {
  // Залипающие колонки закрашены непрозрачно: график прокручивается под ними.
  const stickyBg = isSelected ? "bg-ddc-selected-bg" : "bg-ddc-surface";
  return (
    <div style={{ width: LABEL_COL_W + chartPx + DURATION_COL_W }}>
      <div
        className={`group flex cursor-pointer items-center border-b border-ddc-divider py-1 hover:bg-ddc-surface-muted ${isSelected ? "bg-ddc-selected-bg" : ""}`}
        title={title}
        onClick={onClick}
      >
        <div
          className={`sticky left-0 z-20 flex shrink-0 items-center gap-2 px-4 text-xs group-hover:bg-ddc-surface-muted ${stickyBg}`}
          style={{ width: LABEL_COL_W }}
        >
          {leftLabel}
        </div>
        <div className="relative h-5 shrink-0" style={{ width: chartPx }}>
          {children}
        </div>
        <div
          className={`sticky right-0 z-20 shrink-0 pr-3 text-right text-xs text-ddc-text-muted tabular-nums group-hover:bg-ddc-surface-muted ${stickyBg}`}
          style={{ width: DURATION_COL_W }}
        >
          {rightLabel}
        </div>
      </div>
    </div>
  );
}

/**
 * One turn = one card. Header summarizes the trigger (kind, label,
 * duration, token totals, status). Body is a per-turn waterfall with
 * its own pxPerMs density picker — long turns don't impose their
 * scale on short neighbours and vice-versa.
 *
 * Collapsed by default (except the latest turn): deriveSpans + the
 * waterfall DOM only run after expand, which is what keeps Timeline
 * usable on long conversations.
 */
const TurnCard = memo(function TurnCard({
  turn,
  expanded,
  onToggleExpanded,
  selectedSpanKey,
  onSelectSpan,
}: {
  turn: Turn;
  expanded: boolean;
  onToggleExpanded: () => void;
  selectedSpanKey: string | null;
  onSelectSpan: (span: Span) => void;
}) {
  const collapsed = !expanded;

  // Expensive: only derive waterfall spans once the card is open.
  const { spans, totalMs } = useMemo(
    () => (collapsed ? { spans: [] as Span[], totalMs: 0 } : deriveSpans(turn.events)),
    [collapsed, turn.events],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pxPerMs, setPxPerMs] = useState<number | null>(null);
  const [mode, setMode] = useState<"auto" | "manual">("auto");

  // Auto-density picker: pick pxPerMs so the median consecutive event
  // gap is ~25px wide — but never wider than MAX_CHART_PX for the turn.
  useEffect(() => {
    if (collapsed || mode === "manual" || !scrollRef.current || totalMs <= 0) return;
    const viewportChartPx = scrollRef.current.clientWidth - LABEL_COL_W - DURATION_COL_W - 64;
    if (viewportChartPx <= 0) return;
    const times: number[] = [];
    for (const s of spans) {
      times.push(s.startMs);
      if (s.durationMs > 0) times.push(s.startMs + s.durationMs);
    }
    times.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const g = times[i] - times[i - 1];
      if (g > 0) gaps.push(g);
    }
    let candidate: number;
    if (gaps.length === 0) {
      candidate = viewportChartPx / totalMs;
    } else {
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 1;
      candidate = 25 / median;
    }
    const fit = viewportChartPx / totalMs;
    const capped = MAX_CHART_PX / totalMs;
    // Prefer density for readability, but never exceed the pixel budget
    // (and never go below fit-to-viewport so the whole turn stays visible
    // without horizontal scroll when it fits).
    const auto = Math.min(capped, Math.max(fit, Math.min(5, candidate)));
    setPxPerMs(auto);
  }, [collapsed, mode, spans, totalMs]);

  const effectivePxPerMs = useMemo(() => {
    const raw = pxPerMs ?? Math.min(0.05, MAX_CHART_PX / Math.max(totalMs, 1));
    if (totalMs <= 0) return raw;
    // Clamp so chart width never exceeds MAX_CHART_PX even in manual zoom.
    return Math.min(raw, MAX_CHART_PX / totalMs);
  }, [pxPerMs, totalMs]);

  const chartPx = Math.max(200, Math.min(MAX_CHART_PX, totalMs * effectivePxPerMs));

  const zoomBy = (factor: number) => {
    setMode("manual");
    setPxPerMs((p) => {
      const base = p ?? effectivePxPerMs;
      return Math.min(MAX_CHART_PX / Math.max(totalMs, 1), Math.max(0.0001, base * factor));
    });
  };
  const fitToViewport = () => {
    if (!scrollRef.current) return;
    const viewportChartPx = scrollRef.current.clientWidth - LABEL_COL_W - DURATION_COL_W - 64;
    if (viewportChartPx > 0 && totalMs > 0) setPxPerMs(viewportChartPx / totalMs);
    setMode("manual");
  };
  const resetAuto = () => {
    setMode("auto");
    setPxPerMs(null);
  };

  // Tick spacing: aim for ~120px between labels, then raise the step
  // until we stay under MAX_TICKS (long schedule waits used to mint
  // hundreds of tick nodes).
  const ticks = useMemo(() => {
    if (totalMs <= 0 || effectivePxPerMs <= 0) return [] as number[];
    const desiredStepMs = 120 / effectivePxPerMs;
    let tickStep = pickTickStep(desiredStepMs * 6);
    while (totalMs / tickStep > MAX_TICKS) {
      tickStep *= 2;
    }
    const out: number[] = [];
    for (let t = 0; t <= totalMs; t += tickStep) out.push(t);
    return out;
  }, [totalMs, effectivePxPerMs]);

  // Aggregate per-turn cost / token totals from span events that carry
  // model_usage. Cheap walk — runs even when collapsed so the header
  // still shows totals.
  const tokens = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let calls = 0;
    for (const e of turn.events) {
      if (e.type !== "span.model_request_end") continue;
      const usage =
        (e as { model_usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } }).model_usage ??
        (e.data as { model_usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } } | undefined)?.model_usage;
      if (usage) {
        input += usage.input_tokens ?? 0;
        output += usage.output_tokens ?? 0;
        cacheRead += usage.cache_read_input_tokens ?? 0;
        calls += 1;
      }
    }
    return { input, output, cacheRead, calls };
  }, [turn.events]);

  const turnDurationMs = useMemo(() => {
    if (turn.endedAt && turn.triggerTs) return Math.max(0, turn.endedAt - turn.triggerTs);
    if (!collapsed && totalMs > 0) return totalMs;
    // Collapsed / still-running: cheap first→last timestamp without deriveSpans.
    if (turn.events.length === 0) return 0;
    const first = eventTsMs(turn.events[0]);
    const last = eventTsMs(turn.events[turn.events.length - 1]);
    return first > 0 && last >= first ? last - first : 0;
  }, [turn.endedAt, turn.triggerTs, turn.events, collapsed, totalMs]);

  const triggerTitleText = (() => {
    if (!turn.trigger) return null;
    const c = (turn.trigger as { content?: Array<{ type: string; text?: string }> }).content;
    if (!Array.isArray(c)) return null;
    const t = c.find((b) => b.type === "text")?.text;
    return t ? t.slice(0, 80) : null;
  })();

  const borderClass =
    turn.status === "errored" || turn.status === "terminated"
      ? "border-ddc-tone-danger-ring"
      : "border-ddc-border";

  return (
    <div
      className={`rounded-xl border bg-ddc-surface ${borderClass}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 48px" }}
    >
      {/* Шапка хода: вид запуска, текст запроса и сводка справа. На узком
          экране сводка уходит под заголовок (flex-wrap). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggleExpanded}
          className="text-ddc-icon-muted hover:text-ddc-text"
          title={collapsed ? "Развернуть" : "Свернуть"}
          aria-label={collapsed ? "Развернуть ход" : "Свернуть ход"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </Button>
        <span className={`h-2 w-2 shrink-0 rounded-full ${TRIGGER_DOT[turn.triggerKind]}`} aria-hidden="true" />
        <span className="font-medium text-ddc-heading">{TRIGGER_LABEL[turn.triggerKind]}</span>
        {triggerTitleText && (
          <span className="max-w-md min-w-0 truncate text-ddc-text-muted" title={triggerTitleText}>
            «{triggerTitleText}»
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-ddc-text-muted tabular-nums">
          <span>
            {collapsed
              ? `${turn.events.length} ${plural(turn.events.length, "событие", "события", "событий")}`
              : `${spans.length} ${plural(spans.length, "этап", "этапа", "этапов")}`}
          </span>
          <span>{formatDurationRu(turnDurationMs)}</span>
          {tokens.calls > 0 && (
            <span
              title={`${tokens.calls} ${plural(tokens.calls, "вызов", "вызова", "вызовов")} модели`}
            >
              {tokens.input}↓ {tokens.output}↑
              {tokens.cacheRead > 0 && ` кэш ${tokens.cacheRead}`}
            </span>
          )}
          <span className={`font-medium ${STATUS_TEXT[turn.status]}`}>{STATUS_LABEL[turn.status]}</span>
        </span>
      </div>

      {!collapsed && spans.length > 0 && (
        <>
          <ZoomToolbar
            mode={mode}
            pxPerMs={effectivePxPerMs}
            onZoomBy={zoomBy}
            onFit={fitToViewport}
            onAuto={resetAuto}
          />
          <div ref={scrollRef} className="overflow-x-auto border-t border-ddc-divider pb-3">
            {/* Ось времени */}
            <div className="sticky top-0 z-10 bg-ddc-surface pt-2" style={{ width: LABEL_COL_W + chartPx + DURATION_COL_W }}>
              <div className="flex items-center">
                <div className="sticky left-0 z-30 shrink-0 bg-ddc-surface" style={{ width: LABEL_COL_W }} />
                <div className="relative h-5 border-b border-ddc-divider" style={{ width: chartPx }}>
                  {ticks.map((t) => (
                    <div
                      key={t}
                      className="absolute top-0 flex h-full flex-col items-start text-xs text-ddc-text-muted tabular-nums"
                      style={{ left: `${t * effectivePxPerMs}px` }}
                    >
                      <span className="-translate-x-1/2 px-1">{formatDurationRu(t)}</span>
                      <div className="w-px flex-1 bg-ddc-divider" />
                    </div>
                  ))}
                </div>
                <div className="sticky right-0 z-30 shrink-0 bg-ddc-surface" style={{ width: DURATION_COL_W }} />
              </div>
            </div>

            {/* Rows */}
            {spans.map((s) => {
              const left = s.startMs * effectivePxPerMs;
              const width = s.durationMs > 0 ? Math.max(2, s.durationMs * effectivePxPerMs) : 0;
              const isSelected = selectedSpanKey === s.key;
              const title = s.detail
                ? `${s.label} · ${formatDurationRu(s.durationMs)} · ${s.detail}`
                : `${s.label} · ${formatDurationRu(s.durationMs)}`;
              const monoLabel = s.family === "tool" || s.family === "mcp" || s.family === "custom_tool";
              return (
                <TimelineRow
                  key={s.key}
                  isSelected={isSelected}
                  onClick={() => onSelectSpan(s)}
                  title={title}
                  chartPx={chartPx}
                  leftLabel={
                    <>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${FAMILY_DOT[s.family]}`} aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-ddc-label ${monoLabel ? "font-mono" : ""}`}>{s.label}</div>
                        {s.detail && (
                          <div className="truncate text-xs text-ddc-text-muted">{s.detail}</div>
                        )}
                      </div>
                    </>
                  }
                  rightLabel={s.durationMs > 0 ? formatDurationRu(s.durationMs) : "·"}
                >
                  {width > 0 ? (
                    <>
                      <div
                        className={`absolute top-1 h-3 rounded-sm ${FAMILY_BAR[s.family]} opacity-90 group-hover:opacity-100`}
                        style={{ left: `${left}px`, width: `${width}px` }}
                      />
                      {typeof s.ttftMs === "number" && s.durationMs > 0 && (
                        <div
                          className="absolute top-1 h-3 w-px bg-ddc-surface"
                          style={{ left: `${left + s.ttftMs * effectivePxPerMs}px` }}
                          title={`Первый токен через ${formatDurationRu(s.ttftMs)}`}
                        />
                      )}
                    </>
                  ) : (
                    <div
                      className={`absolute top-0 bottom-0 w-px ${FAMILY_DOT[s.family]}`}
                      style={{ left: `${left}px` }}
                    />
                  )}
                </TimelineRow>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
});

function ZoomToolbar({
  mode,
  pxPerMs,
  onZoomBy,
  onFit,
  onAuto,
}: {
  mode: "auto" | "manual";
  pxPerMs: number;
  onZoomBy: (factor: number) => void;
  onFit: () => void;
  onAuto: () => void;
}) {
  const fmtRate = (ppms: number) => {
    const pps = ppms * 1000;
    if (pps >= 100) return `${Math.round(pps)} px/с`;
    if (pps >= 1) return `${pps.toFixed(1).replace(".", ",")} px/с`;
    return `${pps.toFixed(2).replace(".", ",")} px/с`;
  };
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs">
      <Button
        variant="outline"
        size="icon-xs"
        onClick={() => onZoomBy(0.5)}
        aria-label="Уменьшить масштаб"
        title="Уменьшить масштаб"
      >
        <MinusIcon />
      </Button>
      <PlainButton
        type="button"
        className="chip-toggle"
        aria-pressed={mode === "auto"}
        onClick={onAuto}
        title="Подбирать масштаб по плотности событий"
      >
        Авто
      </PlainButton>
      <PlainButton
        type="button"
        className="chip-toggle"
        onClick={onFit}
        title="Уместить ход по ширине экрана"
      >
        По ширине
      </PlainButton>
      <Button
        variant="outline"
        size="icon-xs"
        onClick={() => onZoomBy(2)}
        aria-label="Увеличить масштаб"
        title="Увеличить масштаб"
      >
        <PlusIcon />
      </Button>
      <span className="ml-2 text-ddc-text-muted tabular-nums">{fmtRate(pxPerMs)}</span>
    </div>
  );
}
