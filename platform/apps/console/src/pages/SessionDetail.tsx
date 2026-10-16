import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { BetaEnvironment } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { BetaManagedAgentsSessionThread } from "@anthropic-ai/sdk/resources/beta/sessions/threads/threads";
import {
  ClockIcon as ScheduleIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PanelRightOpenIcon,
  XIcon,
} from "lucide-react";
import { ApiError, useApi } from "../lib/api";
import { useManagedApi } from "../lib/useManagedApi";
import { useCrumbName } from "../lib/crumb-names";
import { readManagedMetadataObject } from "../lib/managed-metadata";
import { formatToolOutput } from "../lib/tool-output";
import {
  OptimisticUserMessages,
  attachmentOnlyText,
  createOptimisticUserEvent,
  userMessageText,
} from "../lib/optimistic-user-message";
import { toast } from "sonner";
import { Markdown } from "../components/Markdown";
import { EMPTY_VALUE, formatDateTimeRu, sessionErrorText } from "../components/session/format-ru";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Skeleton } from "../components/Skeleton";
import type { Event } from "../lib/events";
import {
  reduceManagedDeltaFrame,
  type ManagedDeltaState,
} from "../lib/managed-stream";
import {
  projectCanonicalChatTurns,
  type WireSessionEvent,
} from "@openma/common/session-events/managed";
import { ManagedSessionConversation } from "../components/session/ManagedSessionConversation";
import {
  PRIMARY_THREAD_ID,
  collectOutcomes,
  computeSessionTotals,
  eventThreadId,
  eventsOfThread,
  type EventSelection,
  type SelectionSource,
} from "../lib/session-stats";
import { downloadTrace } from "../lib/trace-api";
import { SessionHeader } from "../components/session/SessionHeader";
import {
  SessionViewTabs,
  parseSessionView,
  type SessionView,
} from "../components/session/SessionViewTabs";
import { TraceView } from "../components/session/trace/TraceView";
import {
  DefineOutcomeDialog,
  ShortcutsDialog,
  type OutcomeParams,
} from "../components/session/SessionDialogs";
import {
  INSPECTOR_DEFAULT_WIDTH,
  SessionInspector,
  clampInspectorWidth,
  parseInspectorTab,
  readInspectorPrefs,
  writeInspectorPrefs,
  type InspectorPrefs,
  type InspectorTab,
} from "../components/session/inspector/SessionInspector";
import { SessionPropertyRow, SessionTab } from "../components/session/inspector/SessionTab";
import { ResourcesTab } from "../components/session/inspector/ResourcesTab";
import { useOutputFileViewer } from "../components/session/inspector/useOutputFileViewer";
import { OutputLinkContext } from "../lib/output-links";
import { ThreadsTab } from "../components/session/inspector/ThreadsTab";
import {
  EventsTab,
  copyEventsToClipboard,
  downloadEventsFile,
} from "../components/session/inspector/EventsTab";
import { ToolsTab } from "../components/session/inspector/ToolsTab";
// Console-specific renderers used only inside OpenMA UI host slots.
import { Message, MessageContent } from "../components/ai-elements/message";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../components/ai-elements/reasoning";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "../components/ai-elements/tool";
import { CodeBlock } from "../components/ai-elements/code-block";
import { SessionComposer } from "../components/session/SessionComposer";

/** A user.* event sitting in the server-side pending_events queue.
 *  Maintained client-side via system.user_message_pending /
 *  _promoted / _cancelled SSE frames. Server is authoritative on what's
 *  pending; client mirrors the row for outbox rendering only. */
interface PendingEntry {
  event_id: string;
  pending_seq: number;
  enqueued_at: number;
  session_thread_id: string;
  /** The full canonical user.* event the server enqueued. */
  event: Event;
}

function waitForStreamRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Ширина, до которой инспектор встаёт нижним листом. */
const NARROW_QUERY = "(max-width: 767px)";

function readNarrow(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(NARROW_QUERY).matches;
}

/** true на экране уже 768 px. Без `matchMedia` (тесты) считаем экран широким. */
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(readNarrow);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  return narrow;
}

/** Строки «Источник» для вкладки «Сессия»: сессию запустил Linear или Slack. */
function buildSourceRows(metadata: Record<string, string> | null | undefined): ReactNode {
  const linear = readManagedMetadataObject(metadata, "linear") as
    | { issueId?: string; issueIdentifier?: string; workspaceId?: string }
    | null;
  const slack = readManagedMetadataObject(metadata, "slack") as
    | { channelId?: string; threadTs?: string; workspaceId?: string; eventKind?: string }
    | null;
  const hasLinear = Boolean(linear && (linear.issueId || linear.issueIdentifier));
  const hasSlack = Boolean(slack && (slack.channelId || slack.threadTs));
  if (!hasLinear && !hasSlack) return null;
  return (
    <>
      {hasLinear && linear && (
        <SessionPropertyRow label="Источник">
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span>Linear, задача</span>
            <span className="font-mono">{linear.issueIdentifier ?? linear.issueId}</span>
            {linear.workspaceId && (
              <a
                href="https://linear.app"
                target="_blank"
                rel="noreferrer"
                className="link inline-flex items-center gap-1"
              >
                Открыть в Linear
                <ExternalLinkIcon className="size-3" aria-hidden="true" />
              </a>
            )}
          </span>
        </SessionPropertyRow>
      )}
      {hasSlack && slack && (
        <SessionPropertyRow label="Источник">
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <span>Slack, канал</span>
            {slack.channelId && slack.workspaceId ? (
              <a
                href={`slack://channel?team=${slack.workspaceId}&id=${slack.channelId}`}
                className="link font-mono"
                title="Открыть в приложении Slack"
              >
                {slack.channelId}
              </a>
            ) : (
              <span className="font-mono">{slack.channelId ?? EMPTY_VALUE}</span>
            )}
            {slack.threadTs && (
              <>
                <span>тред</span>
                <span className="font-mono">{slack.threadTs}</span>
              </>
            )}
            {slack.eventKind && (
              <span className="font-mono text-2xs tracking-wider text-ddc-text-muted uppercase">
                {slack.eventKind}
              </span>
            )}
          </span>
        </SessionPropertyRow>
      )}
    </>
  );
}

/** Поле ввода, в котором клавиши страницы (D, ?) не должны срабатывать. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}


type Dialog = "outcome" | "shortcuts" | "archive" | null;

export function SessionDetail() {
  const { id } = useParams();
  // Окно файлов агента: ссылка на файл в ответе агента открывает просмотр.
  const outputViewer = useOutputFileViewer(id ?? "");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const managedApi = useManagedApi();
  const { apiRaw } = useApi();
  const [events, setEvents] = useState<Event[]>([]);
  /** In-flight assistant streams keyed by message_id. Each entry holds
   *  the deltas accumulated so far. Wiped on the matching agent.message
   *  (same message_id), which becomes the canonical render. */
  const [streams, setStreams] = useState<Map<string, string>>(new Map());
  /** In-flight reasoning streams keyed by thinking_id. Same lifecycle
   *  as messages — drained on matching agent.thinking. */
  const [thinkingStreams, setThinkingStreams] = useState<Map<string, string>>(new Map());
  const managedDeltaState = useRef<ManagedDeltaState>({
    kinds: new Map(),
    text: new Map(),
  });
  /** In-flight tool-input streams keyed by tool_use_id. Wiped when the
   *  canonical agent.tool_use / mcp_tool_use / custom_tool_use lands
   *  with the same id (toolCallId on the AI SDK side). The accumulated
   *  string is partial JSON — render as a code block, not Markdown. */
  const [toolInputStreams, setToolInputStreams] = useState<Map<string, { name?: string; partial: string }>>(new Map());
  const [sending, setSending] = useState(false);
  // Реплика, которую пользователь только что отправил. Её кладём в events
  // сразу, как локальное событие user.message: ход разговора строится из
  // событий, и реплика остаётся в нём на своём месте всё время работы агента и
  // после конца хода. Старый сервер не присылает user.message в потоке,
  // поэтому без этого реплика появилась бы только после перезагрузки.
  // Подтверждает её ответ на POST или user.message из потока (addEvent): запись
  // забирают по id события или, пока он неизвестен, по тексту. Показанное
  // событие остаётся прежним, чтобы не менялся id хода и ход не
  // перерисовывался с нуля.
  const optimistic = useRef(new OptimisticUserMessages());
  /** Снимок сессии с сервера. Название и архивация правятся на месте. */
  const [session, setSession] = useState<BetaManagedAgentsSession | null>(null);
  const [environment, setEnvironment] = useState<BetaEnvironment | null>(null);
  const [vaults, setVaults] = useState<Array<{ id: string; name?: string }>>([]);
  useCrumbName(id, session?.title?.trim());
  const [status, setStatus] = useState("idle");
  /** Потоки сессии, включая основной. Обновляются на `session.thread_created`. */
  const [threads, setThreads] = useState<BetaManagedAgentsSessionThread[]>([]);
  /** Выбранный поток. Фильтрует ленту, вкладки «События» и «Инструменты».
   *  Новые потоки из SSE не переключают выбор: оператор остаётся там, где смотрел. */
  const [activeThreadId, setActiveThreadId] = useState<string>(PRIMARY_THREAD_ID);
  /** Server-mirrored pending queue, keyed by event_id. Populated from
   *  the initial GET /pending plus live system.user_message_pending /
   *  _promoted / _cancelled SSE frames. Pending entries render as a
   *  separate "outbox" section at the bottom of the timeline; once the
   *  server promotes the row (system.user_message_promoted), the entry
   *  is removed from this map and the canonical user.* event takes its
   *  place in the events array via the regular SSE broadcast. */
  const [pendingByEventId, setPendingByEventId] = useState<Map<string, PendingEntry>>(new Map());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [archiving, setArchiving] = useState(false);
  /** История событий загружена (первая выгрузка завершена). Пока нет, вместо
   *  пустого состояния показываем скелетон: «Отправьте сообщение» до конца
   *  загрузки вводило бы в заблуждение (правило 12 DDC). */
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const seenKeys = useRef(new Set<string>());

  // ── Инспектор, выбор события и адрес ───────────────────────────────────
  const narrow = useNarrowViewport();
  const urlTab = searchParams.get("inspector");
  const prefs = useRef<InspectorPrefs | null | undefined>(undefined);
  if (prefs.current === undefined) prefs.current = readInspectorPrefs();
  const [inspectorOpen, setInspectorOpen] = useState(
    () => urlTab !== null || (prefs.current?.open ?? !narrow),
  );
  const [inspectorWidth, setInspectorWidth] = useState(
    () => prefs.current?.width ?? INSPECTOR_DEFAULT_WIDTH,
  );
  /** Вкладка, на которой закрыли инспектор: открытие возвращает её. */
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => parseInspectorTab(urlTab));
  const [selection, setSelection] = useState<EventSelection>(() => ({
    eventId: searchParams.get("event"),
    source: "url",
    seq: 0,
  }));
  const eventParam = searchParams.get("event");
  const eventParamRef = useRef(eventParam);
  eventParamRef.current = eventParam;
  /** Вид колонки слева: разговор или трейс. Источник правды параметр `view` в адресе. */
  const view = parseSessionView(searchParams.get("view"));
  const viewRef = useRef(view);
  viewRef.current = view;
  /** Поле поиска вкладки «Трейс»: клавиша «/» ставит в него фокус. */
  const traceSearchRef = useRef<HTMLInputElement>(null);

  const updateParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          mutate(next);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const rememberPrefs = useCallback((patch: Partial<InspectorPrefs>) => {
    const next: InspectorPrefs = {
      ...(prefs.current?.open === undefined ? {} : { open: prefs.current.open }),
      width: prefs.current?.width ?? INSPECTOR_DEFAULT_WIDTH,
      ...patch,
    };
    prefs.current = next;
    writeInspectorPrefs(next);
  }, []);

  const openInspector = useCallback(() => {
    setInspectorOpen(true);
    rememberPrefs({ open: true });
    updateParams((params) => params.set("inspector", inspectorTab));
  }, [inspectorTab, rememberPrefs, updateParams]);

  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    rememberPrefs({ open: false });
    updateParams((params) => params.delete("inspector"));
  }, [rememberPrefs, updateParams]);

  const changeTab = useCallback(
    (tab: InspectorTab) => {
      setInspectorTab(tab);
      updateParams((params) => params.set("inspector", tab));
    },
    [updateParams],
  );

  const changeWidth = useCallback(
    (width: number) => {
      const next = clampInspectorWidth(width);
      setInspectorWidth(next);
      rememberPrefs({ width: next });
    },
    [rememberPrefs],
  );

  /** Единственный путь выбора события: лента, мини-карта, вкладки инспектора и
   *  трейс зовут его, параметр `event` в адресе остаётся источником правды.
   *  `alsoParams` правит другие параметры той же записью в адрес: две записи
   *  подряд из одного обработчика затирают друг друга, потому что вторая
   *  читает адрес, каким он был при отрисовке. */
  const commitSelection = useCallback(
    (eventId: string | null, source: SelectionSource, alsoParams?: (params: URLSearchParams) => void) => {
      setSelection((previous) => ({ eventId, source, seq: previous.seq + 1 }));
      updateParams((params) => {
        if (eventId) params.set("event", eventId);
        else params.delete("event");
        alsoParams?.(params);
      });
    },
    [updateParams],
  );
  const selectEvent = useCallback(
    (eventId: string | null, source: SelectionSource) => commitSelection(eventId, source),
    [commitSelection],
  );

  /** Вид пишется в адрес явно, и `view=conversation` тоже верная ссылка: без параметра открывается разговор. */
  const changeView = useCallback(
    (next: SessionView) => updateParams((params) => params.set("view", next)),
    [updateParams],
  );

  /** «В разговоре» в деталях узла трейса: открывает разговор и повторяет выбор
   *  узла, лента прокручивается к его блоку. Событие сабагента лежит в ленте
   *  его потока, поэтому поток выбирается вместе с видом. */
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const showInTranscript = useCallback(
    (eventId: string) => {
      const event = eventsRef.current.find((item) => item.id === eventId);
      if (event) setActiveThreadId(eventThreadId(event));
      commitSelection(eventId, "trace", (params) => params.set("view", "conversation"));
    },
    [commitSelection],
  );

  /** «Открыть поток» у сабагента: разговор показывает его поток. */
  const openThread = useCallback(
    (threadId: string) => {
      setActiveThreadId(threadId);
      changeView("conversation");
    },
    [changeView],
  );

  // Dedup key for SSE re-delivery + initial-fetch overlap. `id` is stamped
  // on every event by the server (sevt-* for tool_results / stream events;
  // toolCallId for tool_use overrides) so it's a uniqueness guarantee
  // across the wire. The previous content-based key dropped legitimate
  // distinct events whose payloads happened to be byte-identical (two
  // back-to-back `gh repo list` calls both timing out with the same
  // 401 stderr was the repro). Fallback only kicks in for legacy events
  // that pre-date stamping.
  const eventKey = (e: Event) =>
    (e as { id?: string }).id
    ?? `${e.type}:${JSON.stringify(e.content || e.tool_use_id || e.error || "").slice(0, 120)}`;

  /** Подтверждение локальной реплики ответом на POST: берём у серверного
   *  события время обработки, id остаётся локальным. По нему реплику ещё
   *  найдут очередь (system.user_message_pending) и откат при ошибке. */
  const confirmLocalMessage = (localId: string, serverEvent: Event) => {
    const processedAt = (serverEvent as { processed_at?: unknown }).processed_at;
    if (typeof processedAt !== "string") return;
    setEvents((prev) =>
      prev.map((e) => (e.id === localId ? { ...e, processed_at: processedAt } : e)),
    );
  };

  /** user.message сервера из потока заменяет локальную реплику на месте:
   *  id, время и содержимое берём у сервера. Иначе «События», выбор
   *  `?event=` и скачанный журнал несут id `local-user-…`, которого нет
   *  в журнале сессии. */
  const replaceLocalMessage = (localId: string, serverEvent: Event) => {
    setEvents((prev) =>
      prev.map((e) => (e.id === localId ? { ...e, ...serverEvent } : e)),
    );
  };

  const addEvent = (e: Record<string, unknown>) => {
    const ev = e as Event;

    // Managed Agents v2 streaming uses an event_start/event_delta pair for
    // both assistant text and thinking. Keep the correlation state outside
    // React so back-to-back frames cannot race a render; mirror only the
    // accumulated strings into component state.
    const reducedDelta = reduceManagedDeltaFrame(managedDeltaState.current, e);
    managedDeltaState.current = reducedDelta.state;
    if (reducedDelta.action?.type === "open" || reducedDelta.action?.type === "append") {
      const target = reducedDelta.action.stream === "agent.message"
        ? setStreams
        : setThinkingStreams;
      const id = reducedDelta.action.id;
      target((previous) => {
        const next = new Map(previous);
        next.set(id, reducedDelta.state.text.get(id) ?? "");
        return next;
      });
      return;
    }
    if (reducedDelta.action?.type === "close") {
      const target = reducedDelta.action.stream === "agent.message"
        ? setStreams
        : setThinkingStreams;
      const id = reducedDelta.action.id;
      target((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Map(previous);
        next.delete(id);
        return next;
      });
    }

    // Streaming chunk lifecycle. None of these go into the events list
    // (would pollute history once the canonical agent.message lands);
    // they drive the `streams` map that the renderer overlays after
    // committed events. The matching agent.message arrives with the
    // same message_id and replaces the in-flight render.
    if (ev.type === "agent.message_stream_start" && ev.message_id) {
      const mid = ev.message_id;
      setStreams((prev) => {
        if (prev.has(mid)) return prev;
        const next = new Map(prev);
        next.set(mid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.message_chunk" && ev.message_id && typeof ev.delta === "string") {
      const mid = ev.message_id;
      const delta = ev.delta;
      setStreams((prev) => {
        const next = new Map(prev);
        next.set(mid, (next.get(mid) ?? "") + delta);
        return next;
      });
      return;
    }
    if (ev.type === "agent.message_stream_end") {
      // Hold the in-flight render until the canonical agent.message
      // arrives — keeps UI stable through the brief gap between the
      // SSE stream_end and the events-log commit. If the run was
      // aborted/interrupted, the canonical event will land via the
      // recovery path and clean up the same way.
      return;
    }

    // Thinking stream lifecycle. Same pattern as message stream:
    // start opens an entry, chunk appends, end is held, canonical
    // agent.thinking with same thinking_id closes it.
    if (ev.type === "agent.thinking_stream_start" && typeof ev.thinking_id === "string") {
      const tid = ev.thinking_id;
      setThinkingStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_chunk" && typeof ev.thinking_id === "string" && typeof ev.delta === "string") {
      const tid = ev.thinking_id;
      const delta = ev.delta;
      setThinkingStreams((prev) => {
        const next = new Map(prev);
        next.set(tid, (next.get(tid) ?? "") + delta);
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_stream_end") return;

    // Tool-input stream lifecycle. The accumulated string is partial
    // JSON; once tool_use lands with the same id, drop the in-flight
    // render and let the EventBubble's collapsed tool widget take over.
    if (ev.type === "agent.tool_use_input_stream_start" && ev.tool_use_id) {
      const tid = ev.tool_use_id;
      const name = (ev as { tool_name?: string }).tool_name;
      setToolInputStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, { name, partial: "" });
        return next;
      });
      return;
    }
    if (ev.type === "agent.tool_use_input_chunk" && ev.tool_use_id && typeof ev.delta === "string") {
      const tid = ev.tool_use_id;
      const delta = ev.delta;
      setToolInputStreams((prev) => {
        const cur = prev.get(tid);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(tid, { ...cur, partial: cur.partial + delta });
        return next;
      });
      return;
    }
    if (ev.type === "agent.tool_use_input_stream_end") return;

    // Canonical agent.message lands → drop the in-flight render so
    // we don't double-show the same content.
    if (ev.type === "agent.message" && ev.message_id) {
      const mid = ev.message_id;
      setStreams((prev) => {
        if (!prev.has(mid)) return prev;
        const next = new Map(prev);
        next.delete(mid);
        return next;
      });
    }

    // Canonical agent.thinking → drop the in-flight reasoning entry.
    // If the canonical event has thinking_id we use it; otherwise we
    // bail-clear all live thinking streams (multi-stream-per-step is
    // rare and safer to err on closing them all).
    if (ev.type === "agent.thinking") {
      const tid = typeof ev.thinking_id === "string" ? ev.thinking_id : undefined;
      setThinkingStreams((prev) => {
        if (prev.size === 0) return prev;
        if (tid && !prev.has(tid)) return prev;
        const next = new Map(prev);
        if (tid) next.delete(tid);
        else next.clear();
        return next;
      });
    }

    // Canonical tool_use of any kind (built-in, MCP, custom) → drop
    // in-flight tool input. The canonical id field equals the AI SDK
    // toolCallId we used as tool_use_id.
    if ((ev.type === "agent.tool_use"
      || ev.type === "agent.mcp_tool_use"
      || ev.type === "agent.custom_tool_use") && ev.id) {
      const tid = ev.id;
      setToolInputStreams((prev) => {
        if (!prev.has(tid)) return prev;
        const next = new Map(prev);
        next.delete(tid);
        return next;
      });
    }

    const key = eventKey(ev);
    if (seenKeys.current.has(key)) return;
    seenKeys.current.add(key);

    // user.message сервера, который мы уже показали локальной репликой:
    // подтверждаем её, а второй копии в ход не добавляем.
    if (ev.type === "user.message") {
      const localId = optimistic.current.claimForEvent(ev.id, userMessageText(ev.content));
      if (localId) {
        replaceLocalMessage(localId, ev);
        return;
      }
    }

    if (ev.type === "session.status_running") setStatus("running");
    if (ev.type === "session.status_idle") setStatus("idle");
    // session.error → idle: defense-in-depth for the catch-all status_idle
    // emit (processUserMessage finally) in case a future code path forgets
    // to pair status_running with status_idle. Note: do NOT also map
    // status_rescheduled — that's a transient retry-pending state, not a
    // terminal one. Mapping it caused observed pill flicker
    // running→idle→running→idle×3 during exponential-backoff retries
    // (sess-y2bfxm1de4e1zqxm 2026-05-11). The next status_running event
    // for the retry attempt naturally restores the pill.
    if (ev.type === "session.error") {
      setStatus("idle");
      // session.error implies the active turn is dead; the harness won't
      // pick anything else off the queue until the next user.message.
      // Drop the outbox so the user doesn't see ghosts of inputs that
      // can never run on this session state.
      setPendingByEventId(new Map());
    }

    // AMA-spec pending-queue notifications. The server is authoritative
    // on what's queued; we mirror its state into pendingByEventId so the
    // outbox renders without polling /pending.
    if (ev.type === "system.user_message_pending") {
      const p = ev as unknown as {
        event_id: string;
        pending_seq: number;
        enqueued_at: number;
        session_thread_id: string;
        event: Event;
      };
      // Сервер взял реплику в очередь: убираем локальную копию из хода, чтобы
      // не показывать одну реплику дважды (очередь рисует её сама, пока она не
      // перейдёт в ход событием user.message).
      const inner = p.event;
      const innerText =
        inner && (inner as { content?: Array<{ type?: string; text?: string }> }).content
          ?.find((c) => c.type === "text")?.text;
      const localId = optimistic.current.claimForPending(p.event_id, innerText ?? "");
      if (localId) {
        setEvents((prev) => prev.filter((e) => e.id !== localId));
      }
      if (p.event_id) {
        setPendingByEventId((prev) => {
          const next = new Map(prev);
          next.set(p.event_id, {
            event_id: p.event_id,
            pending_seq: p.pending_seq,
            enqueued_at: p.enqueued_at,
            session_thread_id: p.session_thread_id ?? "sthr_primary",
            event: p.event,
          });
          return next;
        });
      }
      // System frame — don't add to events list. The canonical user.*
      // event arrives separately at drain time.
      return;
    }
    if (ev.type === "system.user_message_promoted") {
      const p = ev as unknown as { event_id?: string };
      if (p.event_id) {
        setPendingByEventId((prev) => {
          if (!prev.has(p.event_id!)) return prev;
          const next = new Map(prev);
          next.delete(p.event_id!);
          return next;
        });
      }
      return;
    }
    if (ev.type === "system.user_message_cancelled") {
      const p = ev as unknown as { event_id?: string };
      if (p.event_id) {
        setPendingByEventId((prev) => {
          if (!prev.has(p.event_id!)) return prev;
          const next = new Map(prev);
          next.delete(p.event_id!);
          return next;
        });
      }
      return;
    }
    // user.interrupt also clears the outbox client-side (server emits
    // _cancelled per row above; this is defensive for the case where the
    // SDK posts user.interrupt without a thread filter and we want to
    // drop everything for the active thread).
    if (ev.type === "user.interrupt") {
      const tid = (ev as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
      setPendingByEventId((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        for (const [k, v] of prev) {
          if (v.session_thread_id === tid) next.delete(k);
        }
        return next;
      });
    }
    // Субагент запущен: список потоков перечитываем, чтобы вкладка «Потоки»
    // получила имя, модель и статус. Выбор оператора не переключаем.
    if (ev.type === "session.thread_created") {
      refreshThreads();
    }

    // Время прихода нужно событиям потока, у которых своего времени ещё нет:
    // по нему считаются возраст и активность до ответа сервера.
    if (!ev.ts) ev.ts = new Date().toISOString();

    setEvents((prev) => [...prev, ev]);
  };

  /** Список потоков с сервера: основной и субагенты. */
  const refreshThreads = () => {
    if (!id) return;
    managedApi.sessions.threads.list(id, { limit: 100 })
      .then((res) => setThreads(res.data ?? []))
      .catch(() => {});
  };

  useEffect(() => {
    if (!id) return;
    // Full per-session state reset before loading the new id. The
    // canonical bug this fixes: clicking from /sessions/A to /sessions/B
    // re-runs this effect with a new id, but `events` (and the other
    // session-scoped state below) was retained from session A. Same
    // SessionDetail component instance handles both routes — React only
    // re-runs the effect, doesn't unmount/remount — so without an
    // explicit reset the user sees session A's content under session B's
    // URL until the SSE refill catches up. Hard refresh works because
    // it re-mounts the whole tree from a fresh state. Reported 2026-05-13.
    seenKeys.current.clear();
    managedDeltaState.current = { kinds: new Map(), text: new Map() };
    setEvents([]);
    setStreams(new Map());
    setThinkingStreams(new Map());
    setToolInputStreams(new Map());
    setSession(null);
    setEnvironment(null);
    setVaults([]);
    setStatus("idle");
    setThreads([]);
    setActiveThreadId(PRIMARY_THREAD_ID);
    setSelection({ eventId: eventParamRef.current, source: "url", seq: 0 });
    setPendingByEventId(new Map());
    optimistic.current.clear();
    setHistoryLoaded(false);
    const abort = new AbortController();

    // Load session info
    managedApi.sessions.retrieve(id)
      .then((s) => {
        if (abort.signal.aborted) return;
        setSession(s);
        setStatus(s.status);

        // Live-resolve env + vault names by id. Per the id-only ref decision
        // (memory: session-resource-refs), the session API does not pre-bake
        // display data — clients fetch resources on demand. Names appear a
        // tick later than the chip frame; until then the chip falls back
        // to the short-id label.
        if (s.environment_id) {
          managedApi.environments.retrieve(s.environment_id)
            .then((env) => {
              if (!abort.signal.aborted) setEnvironment(env);
            })
            .catch(() => {});
        }
        if (s.vault_ids?.length) {
          Promise.all(
            s.vault_ids.map((vid) =>
              managedApi.vaults.retrieve(vid)
                .then((v) => ({ id: v.id, name: v.display_name }))
                .catch(() => ({ id: vid })),
            ),
          ).then((list) => {
            if (!abort.signal.aborted) setVaults(list);
          });
        }
      })
      .catch(() => {});

    // Load canonical Managed Agents history. `next_page` is an opaque cursor;
    // do not parse it or depend on the old OMA `{seq, ts, data}` envelope.
    // Each page is applied as it arrives so long sessions render progressively.
    void (async () => {
      let page: string | undefined;
      const seenPages = new Set<string>();
      const pageLimit = 100;
      // Bound the loop so a malformed `next_page` never spins forever.
      // Even at 200/page this covers 100k events, well past anything the
      // sandbox SQL store retains in practice.
      for (let i = 0; i < 500; i++) {
        try {
          const res = await managedApi.sessions.events.list(id, {
            limit: pageLimit,
            order: "asc",
            page,
          });
          for (const managedEvent of res.data) {
            const e = managedEvent as unknown as Event;
            if (!e.ts && typeof e.processed_at === "string") e.ts = e.processed_at;
            addEvent(e);
          }
          if (!res.next_page || seenPages.has(res.next_page)) break;
          seenPages.add(res.next_page);
          page = res.next_page;
        } catch {
          break;
        }
      }
      if (!abort.signal.aborted) setHistoryLoaded(true);
    })();

    // Connect the official Managed Agents async event stream. Reconnect only
    // transport/5xx failures; 4xx responses are terminal until navigation or
    // auth state changes, so retrying them would only hammer the API.
    void (async () => {
      const backoffMs = [1_000, 2_000, 4_000, 8_000];
      let failures = 0;
      while (!abort.signal.aborted) {
        try {
          const liveEvents = await managedApi.sessions.events.stream(
            id,
            { event_deltas: ["agent.message", "agent.thinking"] },
            { signal: abort.signal },
          );
          failures = 0;
          for await (const event of liveEvents) {
            if (abort.signal.aborted) break;
            addEvent(event as unknown as Record<string, unknown>);
          }
        } catch (error) {
          if (abort.signal.aborted) break;
          if (
            error instanceof ApiError &&
            error.status >= 400 &&
            error.status < 500
          ) {
            break;
          }
        }
        if (abort.signal.aborted) break;
        const delay = backoffMs[Math.min(failures, backoffMs.length - 1)];
        failures += 1;
        await waitForStreamRetry(delay, abort.signal);
      }
    })();

    refreshThreads();

    return () => { abort.abort(); };
  }, [id]);

  const send = async (messageText: string, files?: File[]) => {
    const text = messageText.trim();
    if (!text && !files?.length) return;
    if (!id) return;
    const shownText = text || attachmentOnlyText(files?.length ?? 0);
    const localId = optimistic.current.add(shownText);
    setEvents((prev) => [
      ...prev,
      createOptimisticUserEvent(localId, shownText, new Date().toISOString()),
    ]);
    setSending(true);
    try {
      // Upload attachments first so the user.message can reference them
      // by file_id. File scope and downloadability are server-owned fields
      // in the Managed Files API. Per-file failures don't block the others — the text
      // still goes out and the user can retry the failed upload.
      const uploaded: Array<{ id: string; filename: string; media_type: string }> = [];
      if (files?.length) {
        for (const file of files) {
          try {
            const r = await managedApi.files.upload({ file });
            uploaded.push({ id: r.id, filename: r.filename, media_type: r.mime_type });
          } catch (e) {
            console.error("file upload failed", file.name, e);
          }
        }
      }

      // The + button is image-only — vision inputs go inline to the
      // model. Non-vision file attachments belong on a separate path
      // (env-mounted resources) and aren't reachable from this button,
      // so this loop only emits `image` content blocks.
      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "file"; file_id: string } }
      > = [];
      if (text) content.push({ type: "text", text });
      for (const u of uploaded) {
        if (u.media_type.startsWith("image/")) {
          content.push({
            type: "image",
            source: { type: "file", file_id: u.id },
          });
        }
        // non-images can't slip through the accept filter, but if one
        // does (drag-drop on some browsers ignores accept) we drop it
        // silently rather than fall back to a document block the model
        // may not handle.
      }
      if (!text && uploaded.length) {
        content.unshift({
          type: "text",
          text: attachmentOnlyText(uploaded.length),
        });
      }

      const accepted = await managedApi.sessions.events.send(id, {
        events: [{ type: "user.message", content }],
      });
      // POST принят. Запоминаем id события на сервере: так user.message из
      // потока, если сервер его пришлёт, подтвердит именно эту реплику.
      const sent = accepted?.data?.find((e) => e.type === "user.message") as
        | Event
        | undefined;
      if (sent && typeof sent.id === "string") {
        if (seenKeys.current.has(eventKey(sent))) {
          // Серверное событие уже пришло отдельной записью (другой текст):
          // локальная копия лишняя.
          if (optimistic.current.release(localId)) {
            setEvents((prev) => prev.filter((e) => e.id !== localId));
          }
        } else if (optimistic.current.accept(localId, sent.id)) {
          confirmLocalMessage(localId, sent);
        }
      }
    } catch {
      // api() already toasted the error; убираем реплику, которая не ушла.
      if (optimistic.current.release(localId)) {
        setEvents((prev) => prev.filter((e) => e.id !== localId));
      }
    }
    setSending(false);
  };

  // Stop button — posts user.interrupt to abort whatever turn(s) are
  // running on the active thread. Server-side this triggers the
  // thread-scoped AbortController, marks pending events cancelled, and
  // emits status_idle. Recovery path for the "stuck Running" failure
  // mode where a DO eviction killed an in-flight stream and no clean
  // status_idle was ever broadcast.
  const [interrupting, setInterrupting] = useState(false);
  const canonicalTurns = useMemo(
    () => projectCanonicalChatTurns(events as WireSessionEvent[], { threadId: activeThreadId }),
    [activeThreadId, events],
  );
  /** События выбранного потока для вкладок «События» и «Инструменты». События
   *  без метки потока (старые и служебные) относятся к основному. */
  const threadEvents = useMemo(
    () => eventsOfThread(events, activeThreadId),
    [events, activeThreadId],
  );
  const totals = useMemo(() => computeSessionTotals(events), [events]);
  const outcomes = useMemo(() => collectOutcomes(events), [events]);
  const sourceRows = useMemo(() => buildSourceRows(session?.metadata), [session]);
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const agentName =
    (activeThread?.agent as { name?: string } | undefined)?.name ?? session?.agent?.name ?? "Агент";
  const agentTools =
    (activeThread?.agent as { tools?: unknown[] } | undefined)?.tools ?? session?.agent?.tools;
  const updatedMs = session ? Date.parse(session.updated_at) : Number.NaN;
  const lastActivityMs = totals.lastEventMs ?? (Number.isFinite(updatedMs) ? updatedMs : null);
  const threadsMuted = !threads.some((thread) => thread.id !== PRIMARY_THREAD_ID);

  const interrupt = async () => {
    if (!id) return;
    setInterrupting(true);
    try {
      await managedApi.sessions.events.send(id, {
        events: [{
            type: "user.interrupt",
            ...(activeThreadId !== "sthr_primary" ? { session_thread_id: activeThreadId } : {}),
          }],
      });
    } catch (e) {
      console.error("interrupt failed", e);
    }
    setInterrupting(false);
  };

  const rename = async (title: string) => {
    if (!id) return;
    const updated = await managedApi.sessions.update(id, { title });
    setSession((previous) =>
      previous ? { ...previous, title: updated?.title ?? (title || null) } : previous,
    );
  };

  const defineOutcome = async (event: OutcomeParams) => {
    if (!id) return;
    await managedApi.sessions.events.send(id, { events: [event] });
  };

  const archive = async () => {
    if (!id) return;
    setArchiving(true);
    try {
      await managedApi.sessions.archive(id);
      toast.success("Сессия архивирована");
      navigate("/sessions");
    } catch {
      // Обращение к серверу уже показало ошибку.
    } finally {
      setArchiving(false);
      setDialog(null);
    }
  };

  const copyAllEvents = async () => {
    try {
      await copyEventsToClipboard(events);
      toast.success("События скопированы");
    } catch {
      toast.error("Не удалось скопировать события");
    }
  };

  /** Весь трейс сессии файлом OTLP JSON. Ошибку запроса показываем сами,
   *  поэтому запрос идёт без тоста `api`. */
  const downloadSessionTrace = async () => {
    if (!id) return;
    try {
      await downloadTrace(id, (path) => apiRaw(path, { quiet: true }));
    } catch {
      toast.error("Не удалось скачать трейс");
    }
  };

  // Клавиши страницы: D показывает и прячет инспектор, T переключает разговор и
  // трейс, ? открывает список клавиш, / в трейсе ищет по нему. Остальные
  // клавиши обрабатывают лента, трейс и вкладки. Клавишу узнаём и по коду:
  // на русской раскладке буква другая.
  const toggleInspectorRef = useRef<() => void>(() => {});
  toggleInspectorRef.current = inspectorOpen ? closeInspector : openInspector;
  const toggleViewRef = useRef<() => void>(() => {});
  toggleViewRef.current = () => changeView(view === "trace" ? "conversation" : "trace");
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.key === "?") {
        event.preventDefault();
        setDialog("shortcuts");
      } else if (event.key === "d" || event.key === "D" || event.code === "KeyD") {
        event.preventDefault();
        toggleInspectorRef.current();
      } else if (event.key === "t" || event.key === "T" || event.code === "KeyT") {
        event.preventDefault();
        // Удержанная клавиша не должна гонять вид туда и обратно.
        if (!event.repeat) toggleViewRef.current();
      } else if (event.key === "/" && viewRef.current === "trace") {
        const field = traceSearchRef.current;
        if (!field) return;
        event.preventDefault();
        field.focus();
        field.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activePendingEntries = Array.from(pendingByEventId.values())
    .filter((entry) => entry.session_thread_id === activeThreadId)
    .sort((a, b) => a.pending_seq - b.pending_seq);
  const hasTransientActivity = (
    activePendingEntries.length > 0
    || thinkingStreams.size > 0
    || toolInputStreams.size > 0
    || streams.size > 0
    || status === "running"
  );
  const transientActivity = (
    <SessionTransientActivity
      pendingEntries={activePendingEntries}
      running={status === "running"}
      streams={streams}
      thinkingStreams={thinkingStreams}
      toolInputStreams={toolInputStreams}
    />
  );

  const layout = narrow ? "sheet" : "side";

  const inspector = inspectorOpen && (
    <SessionInspector
      layout={layout}
      tab={inspectorTab}
      onTabChange={changeTab}
      onClose={closeInspector}
      width={inspectorWidth}
      onWidthChange={changeWidth}
      threadsMuted={threadsMuted}
    >
      {inspectorTab === "session" &&
        (session ? (
          <SessionTab
            session={session}
            environment={environment}
            vaults={vaults}
            status={status}
            totals={totals}
            outcomes={outcomes}
            sources={sourceRows}
          />
        ) : (
          <InspectorSkeleton />
        ))}
      {/* Пока история не пришла, пустой список событий вводил бы в
          заблуждение (правило 12 DDC): стоит скелетон, как в ленте. */}
      {inspectorTab === "events" &&
        (historyLoaded ? (
          <EventsTab
            sessionId={id ?? ""}
            events={threadEvents}
            selection={selection}
            onSelectEvent={selectEvent}
          />
        ) : (
          <InspectorSkeleton />
        ))}
      {inspectorTab === "tools" &&
        (historyLoaded ? (
          <ToolsTab
            events={threadEvents}
            agentTools={agentTools}
            selection={selection}
            onSelectEvent={selectEvent}
          />
        ) : (
          <InspectorSkeleton />
        ))}
      {inspectorTab === "resources" && id && <ResourcesTab sessionId={id} />}
      {inspectorTab === "thread" &&
        (session ? (
          <ThreadsTab
            session={session}
            threads={threads}
            events={events}
            activeThreadId={activeThreadId}
            onSelectThread={setActiveThreadId}
          />
        ) : (
          <InspectorSkeleton />
        ))}
    </SessionInspector>
  );

  /** Кнопка открытия закрытого инспектора. В разговоре она стоит в строке поиска, в трейсе в строке вкладок. */
  const inspectorButton = (
    <Button variant="outline" size="xs" onClick={openInspector}>
      <PanelRightOpenIcon aria-hidden="true" />
      Инспектор
    </Button>
  );
  // Колонка слева на узком экране с отступом 24 px: лист идёт от края до края.
  const sheetOverlay =
    layout === "sheet" && inspector ? (
      <div className="-mx-6 flex h-full min-h-0 flex-col">{inspector}</div>
    ) : undefined;

  // Монтируется только открытый вид. Своей памяти у вида нет: что выбрано, знает
  // адрес (`event`), и вид после возврата находит свою строку сам. Трейс получает
  // события всех потоков, потому что показывает и сабагентов.
  const traceView = (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Отступ 12 px ставит края водопада под вкладки «Разговор» и «Трейс». */}
      <div className="flex min-h-0 flex-1 flex-col px-3">
        <TraceView
          events={events}
          onOpenThread={openThread}
          onSelectEvent={selectEvent}
          onShowInTranscript={showInTranscript}
          running={status === "running"}
          searchInputRef={traceSearchRef}
          selection={selection}
          sessionId={id ?? ""}
        />
      </div>
      {sheetOverlay ? (
        <div className="absolute inset-0 z-30 flex min-h-0 flex-col" data-session-overlay>
          {sheetOverlay}
        </div>
      ) : null}
    </div>
  );

  const conversationView = (
    <ManagedSessionConversation
      afterTurns={transientActivity}
      composer={<SessionComposer
        interrupting={interrupting}
        onError={(error) => toast.error(error.message)}
        onStop={() => void interrupt()}
        onSubmit={async ({ text, files }) => {
          const rawFiles = files
            .map((file) => file.file)
            .filter((file): file is File => file instanceof File);
          await send(text, rawFiles);
        }}
        running={status === "running"}
        sending={sending}
      />}
      empty={
        hasTransientActivity
          ? transientActivity
          : historyLoaded
            ? undefined
            : <SessionHistorySkeleton />
      }
      sessionId={id}
      turns={canonicalTurns}
      agentName={agentName}
      running={status === "running"}
      selection={selection}
      onSelectEvent={selectEvent}
      overlay={sheetOverlay}
      toolbarTrailing={inspectorOpen ? undefined : inspectorButton}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-6 pt-6 pb-3 md:px-8">
        <SessionHeader
          session={session}
          environment={environment}
          status={status}
          totals={totals}
          lastActivityMs={lastActivityMs}
          onRename={rename}
          onInterrupt={() => void interrupt()}
          onDefineOutcome={() => setDialog("outcome")}
          onArchive={() => setDialog("archive")}
          onCopyEvents={() => void copyAllEvents()}
          onDownloadEvents={() => {
            if (id) downloadEventsFile(id, events);
          }}
          onDownloadTrace={() => void downloadSessionTrace()}
          onShowShortcuts={() => setDialog("shortcuts")}
        />
      </div>

      {/* Рабочая область: слева колонка с переключателем «Разговор» и «Трейс»,
          справа инспектор до низа окна. В разговоре колонка несёт поиск,
          мини-карту, ленту и поле ввода, в трейсе целиком водопад. На узком
          экране инспектор нижний лист поверх колонки. */}
      <OutputLinkContext.Provider value={id ? outputViewer.openByName : null}>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col px-6 md:pr-6 md:pl-8">
            <SessionViewTabs
              view={view}
              onViewChange={changeView}
              trailing={view === "trace" && !inspectorOpen ? inspectorButton : undefined}
            >
              {view === "trace" ? traceView : conversationView}
            </SessionViewTabs>
          </div>
          {layout === "side" && inspector}
        </div>
      </OutputLinkContext.Provider>

      <DefineOutcomeDialog
        open={dialog === "outcome"}
        onClose={() => setDialog(null)}
        onSubmit={defineOutcome}
      />
      <ShortcutsDialog open={dialog === "shortcuts"} onClose={() => setDialog(null)} />
      <ConfirmDialog
        open={dialog === "archive"}
        title="Архивировать сессию?"
        message="Сессия уйдёт в архив и пропадёт из списка активных."
        confirmLabel="Архивировать"
        busy={archiving}
        onConfirm={() => void archive()}
        onCancel={() => setDialog(null)}
      />
      {outputViewer.dialog}
    </div>
  );
}

/** Скелетон вкладки, пока сессия не пришла. */
function InspectorSkeleton() {
  return (
    <div className="space-y-3 p-4" role="status" aria-busy="true">
      <span className="sr-only">Загрузка сессии…</span>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

/** Скелетон разговора, пока грузится история: реплика пользователя справа и
 *  ответ агента слева, как в разметке чата (правило 12 DDC). */
function SessionHistorySkeleton() {
  return (
    <div
      className="chat-turn-frame mx-auto w-full max-w-3xl min-w-0 space-y-4"
      aria-busy="true"
      role="status"
    >
      <span className="sr-only">Загрузка сессии…</span>
      <div className="ml-auto w-2/3 space-y-2 rounded-xl bg-ddc-surface-muted p-4">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="w-full space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}

function SessionTransientActivity({
  pendingEntries,
  running,
  streams,
  thinkingStreams,
  toolInputStreams,
}: {
  pendingEntries: PendingEntry[];
  running: boolean;
  streams: ReadonlyMap<string, string>;
  thinkingStreams: ReadonlyMap<string, string>;
  toolInputStreams: ReadonlyMap<string, { name?: string; partial: string }>;
}) {
  return (
    <div className="chat-turn-frame mx-auto w-full max-w-3xl min-w-0 space-y-4">
      {pendingEntries.map((entry) => (
        <EventRender
          event={entry.event}
          key={`pending-${entry.event_id}`}
          livePending
        />
      ))}
      {Array.from(thinkingStreams.entries()).map(([id, text]) => (
        <Reasoning defaultOpen isStreaming key={`think-${id}`}>
          <ReasoningTrigger />
          <ReasoningContent>{text}</ReasoningContent>
        </Reasoning>
      ))}
      {Array.from(toolInputStreams.entries()).map(([id, { name, partial }]) => (
        <Tool defaultOpen key={`tool-input-${id}`}>
          <ToolHeader
            state="input-streaming"
            toolName={name ?? "инструмент"}
            type="dynamic-tool"
          />
          <ToolContent>
            {partial ? (
              <div className="space-y-2 overflow-hidden">
                <h4 className="eyebrow">Параметры вызова</h4>
                <CodeBlock code={partial} language="json" />
              </div>
            ) : null}
          </ToolContent>
        </Tool>
      ))}
      {Array.from(streams.entries()).map(([id, text]) => (
        <Message from="assistant" key={`stream-${id}`}>
          <MessageContent>
            <Markdown>{text}</Markdown>
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-ddc-text-muted/50 align-middle" />
          </MessageContent>
        </Message>
      ))}
      {running
        && streams.size === 0
        && thinkingStreams.size === 0
        && toolInputStreams.size === 0 ? (
        <div className="flex items-center gap-2 py-2 text-sm text-ddc-text-muted" role="status">
          <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
          Агент работает…
        </div>
      ) : null}
    </div>
  );
}


/**
 * Renders a single canonical event using ai-elements primitives. Replaces
 * the pre-migration EventBubble + StreamingBubble + ThinkingStreamingBubble
 * + ToolInputStreamingBubble quartet — the in-flight streaming bubbles are
 * now inlined where they're consumed (using Reasoning isStreaming, Tool
 * input-streaming state, and an assistant Message with a cursor) so this
 * function only needs to handle the canonical event shapes.
 *
 * Type mapping:
 *   user.message              → <Message from="user|system">  (system for wakeups)
 *   agent.message             → <Message from="assistant"> + <Markdown>
 *   agent.thinking            → <Reasoning> + <ReasoningContent>
 *   agent.{tool_use,custom_tool_use,mcp_tool_use} → <Tool> + <ToolHeader> + <ToolInput> + <ToolOutput>
 *   agent.tool_result (orphan only, paired ones folded into use above)
 *                             → <Tool state="output-available"> with only ToolOutput
 *   session.error             → red alert div  (no ai-elements equivalent)
 *   session.warning           → amber alert div  (same)
 *   anything else             → null  (timeline-only events that shouldn't appear in chat)
 */

function EventRender({
  event,
  livePending = false,
  pairedResult,
  modelErrorCause,
}: {
  event: Event;
  /**
   * Caller-derived "no agent.* event has followed this user.* event
   * yet on the same thread" hint. The wire-level processed_at_ms
   * doesn't update live (no SSE re-broadcast on server UPDATE), so
   * we combine: pending iff (livePending AND wire-level says NULL)
   * OR (livePending true and we have no wire info yet). When livePending
   * is false we KNOW the agent has responded — drop the hourglass
   * regardless of wire state, otherwise the bubble would stay pending
   * for the entire turn even while the agent is mid-stream.
   */
  livePending?: boolean;
  /**
   * The matching `agent.tool_result` (or `agent.mcp_tool_result`) for
   * an `agent.tool_use` (or `custom_tool_use` / `mcp_tool_use`) event,
   * when present in the same filtered list. Caller pre-pairs by id and
   * suppresses the orphan tool_result render. Lets the Tool card show
   * input + output in one collapsible block instead of two disconnected
   * bubbles.
   */
  pairedResult?: Event;
  /**
   * Upstream model error context for `session.error` events. The
   * SSE-delivered session.error payload only carries a generic
   * "No output generated. Check the stream for errors." message; the
   * actionable cause (rate limit, billing, model 4xx, etc.) lives on
   * the preceding `span.model_request_end` with `is_error=true`. Caller
   * walks the events array and pairs them, passing the looked-up cause
   * here so operators see the real reason inline without diving into
   * the timeline tab. Only meaningful when `event.type === "session.error"`.
   */
  modelErrorCause?: { error: string; model?: string };
}) {
  // AMA pending lifecycle (set by event-log adapter from row.processed_at /
  // row.cancelled_at). Cancelled events stay in the log for audit but
  // the LLM never sees them (eventsToMessages skips); show them with
  // strikethrough so operators know the user retracted them.
  const meta = event as { processed_at_ms?: number | null; cancelled_at_ms?: number | null };
  // The hourglass shows when BOTH conditions hold:
  //   1. Caller says no later non-user event has arrived (livePending)
  //   2. Wire-level processed_at_ms agrees (still null)
  // Either condition flipping → no longer pending.
  const isPending =
    livePending &&
    meta.processed_at_ms == null &&
    meta.cancelled_at_ms == null;
  const isCancelled = meta.cancelled_at_ms != null;

  switch (event.type) {
    case "user.message": {
      // Wakeups synthesized by the schedule tool's onScheduledWakeup callback
      // also wire-type as user.message (per EventBase metadata convention),
      // but the user did NOT send them — visually distinguish so operators
      // don't get confused. metadata.harness === "schedule" + kind === "wakeup"
      // is the contract: see apps/agent/src/runtime/session-do.ts:onScheduledWakeup.
      const metadata = (event as { metadata?: { harness?: string; kind?: string; scheduled_at?: string } }).metadata;
      const isWakeup = metadata?.harness === "schedule" && metadata?.kind === "wakeup";
      const text = Array.isArray(event.content) ? event.content[0]?.text ?? "" : "";

      if (isWakeup) {
        // System-origin: left-aligned via from="system" (Message only
        // applies its right-aligned brand bubble for from="user"; anything
        // else lays out as plain assistant text). Layered on top is a
        // small info chip identifying the wakeup + the scheduled time
        // tooltip for traceability.
        const scheduledAt = metadata?.scheduled_at;
        return (
          <Message from="system">
            <div className="mb-1 flex items-center gap-1.5 text-xs text-ddc-text-muted">
              <span
                className="inline-flex h-5 items-center gap-1 rounded-md bg-ddc-tone-info-bg px-2 text-xs leading-4 font-medium text-ddc-tone-info-fg ring-1 ring-inset ring-ddc-tone-info-ring"
                title={scheduledAt ? `Запланировано на ${formatDateTimeRu(scheduledAt)}` : undefined}
              >
                <ScheduleIcon className="size-3.5" aria-hidden="true" />
                Пробуждение по расписанию
              </span>
            </div>
            <MessageContent className="rounded-xl bg-ddc-tone-info-bg px-4 py-3 text-ddc-tone-info-fg">
              {text}
            </MessageContent>
          </Message>
        );
      }

      // Cancelled: render strikethrough + muted so the audit trail is
      // visible without competing with live messages. Pending: dotted
      // border + hourglass label since drainEventQueue hasn't picked it
      // up yet. Live: default ai-elements user bubble (right-aligned,
      // bg-secondary which we've aliased to OMA's bg-surface).
      // Wireless: dropped the border-border-strong outline on both
      // override states — line-through + opacity (cancelled) and the
      // метка «В очереди» над пузырём (pending) несут сигнал
      // without a per-bubble outline competing with the surrounding
      // air.
      const cancelledOverride = "line-through opacity-70";
      const pendingOverride = "opacity-80";
      return (
        <Message from="user">
          {(isPending || isCancelled) && (
            <div className="flex items-center justify-end gap-1 text-right text-xs text-ddc-text-muted">
              {isPending && <ScheduleIcon className="size-3.5" aria-hidden="true" />}
              {isCancelled && <XIcon className="size-3.5" aria-hidden="true" />}
              <span>{isCancelled ? "Отозвано" : "В очереди…"}</span>
            </div>
          )}
          <MessageContent
            className={isCancelled ? cancelledOverride : isPending ? pendingOverride : undefined}
          >
            {text}
          </MessageContent>
        </Message>
      );
    }

    case "agent.message": {
      const text = (Array.isArray(event.content) ? event.content : [])
        .map((b) => b.text)
        .join("");
      return (
        <Message from="assistant">
          <MessageContent>
            <Markdown>{text}</Markdown>
          </MessageContent>
        </Message>
      );
    }

    case "agent.thinking": {
      // Canonical reasoning block — keep it visible after streaming
      // finishes. <Reasoning> defaults closed unless isStreaming; we
      // pass defaultOpen={false} so committed thoughts don't push the
      // active conversation off-screen but stay one click away.
      const text = (event as { text?: string }).text ?? "";
      if (!text) return null;
      return (
        <Reasoning isStreaming={false} defaultOpen={false}>
          <ReasoningTrigger />
          <ReasoningContent>{text}</ReasoningContent>
        </Reasoning>
      );
    }

    case "agent.tool_use":
    case "agent.custom_tool_use":
    case "agent.mcp_tool_use": {
      // All three use-types share the same shape (id + name + input);
      // MCP additionally carries mcp_server_name which we append to
      // the title so operators can tell built-in vs MCP at a glance.
      const mcpServerName =
        event.type === "agent.mcp_tool_use"
          ? (event as { mcp_server_name?: string }).mcp_server_name
          : undefined;
      const baseName = event.name ?? "инструмент";
      const title = mcpServerName ? `${baseName} (MCP · ${mcpServerName})` : baseName;
      // Result text: content-блоки склеиваем в текст (formatToolOutput),
      // а не показываем JSON-массивом.
      const rawContent = pairedResult
        ? (pairedResult as { content?: unknown }).content
        : undefined;
      const output: unknown = rawContent === undefined
        ? undefined
        : formatToolOutput(rawContent);
      // is_error is set by the agent runtime when a tool call failed
      // (bash non-zero exit + stderr surfaced, mcp tool returned an
      // error envelope, _finalizeStaleTurns injected an abort placeholder
      // for DO-eviction recovery, etc.). When present we route the same
      // payload through ToolOutput.errorText so the Tool block renders
      // in destructive styling, and badge to 'output-error' so the
      // header pill shows Failed instead of Completed. Without this,
      // bash returning "Sandbox container failed to start after 10
      // attempts..." looked identical to a successful run.
      const isError = pairedResult
        ? Boolean((pairedResult as { is_error?: boolean }).is_error)
        : false;
      const errorText = isError
        ? (typeof output === "string" ? output : JSON.stringify(output ?? null))
        : undefined;
      const state = pairedResult
        ? (isError ? "output-error" : "output-available")
        : "input-available";
      return (
        <Tool>
          <ToolHeader type="dynamic-tool" toolName={title} state={state} />
          <ToolContent>
            <ToolInput input={event.input ?? {}} />
            <ToolOutput
              output={isError ? undefined : output}
              errorText={errorText}
            />
          </ToolContent>
        </Tool>
      );
    }

    case "agent.tool_result":
    case "agent.mcp_tool_result": {
      // Orphan tool_result — caller couldn't pair it with a tool_use
      // (race / out-of-order delivery, or recovery-injected placeholder).
      // Render a degenerate Tool with output-only so the visual is still
      // a "tool" card (matching the rest of the timeline) but the header
      // signals it stands alone.
      const rawContent = (event as { content?: unknown }).content;
      const output: unknown = rawContent === undefined
        ? undefined
        : formatToolOutput(rawContent);
      return (
        <Tool>
          <ToolHeader
            type="dynamic-tool"
            toolName="Результат инструмента (без вызова)"
            state="output-available"
          />
          <ToolContent>
            <ToolOutput output={output} errorText={undefined} />
          </ToolContent>
        </Tool>
      );
    }

    case "session.error":
      return (
        <div className="callout-danger max-w-2xl flex-col items-stretch gap-1.5" role="alert">
          <div>Ошибка: {sessionErrorText(event.error)}</div>
          {modelErrorCause && (
            <div>
              <span className="font-medium">Причина</span>
              {modelErrorCause.model && (
                <span className="ml-1 font-mono">({modelErrorCause.model})</span>
              )}
              : {modelErrorCause.error}
            </div>
          )}
        </div>
      );

    case "session.warning":
      return (
        <div className="callout-warning max-w-2xl flex-col items-stretch gap-0.5" role="status">
          <div className="font-medium">Предупреждение ({String(event.source ?? "")})</div>
          <div>{String(event.message ?? "")}</div>
        </div>
      );

    default:
      return null;
  }
}

