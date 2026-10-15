import { useCrumbName } from "../lib/crumb-names";
import { Input } from "@/components/ui/input";
import { startTransition, useEffect, useMemo, useState, useRef } from "react";
import { useParams } from "react-router";
import {
  ClockIcon as ScheduleIcon,
  CornerDownRightIcon,
  ExternalLinkIcon,
  FileJsonIcon,
  FolderOpenIcon,
  LinkIcon,
  Loader2Icon,
  MessageSquareIcon,
  PencilIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { ApiError } from "../lib/api";
import { useManagedApi } from "../lib/useManagedApi";
import { readManagedMetadataObject } from "../lib/managed-metadata";
import { toast } from "sonner";
import { Markdown } from "../components/Markdown";
import { shortenId } from "../lib/format";
import {
  formatDateTimeRu,
  formatDurationRu,
  formatRelativeRu,
  plural,
} from "../components/session/format-ru";
import { Badge, StatusPill } from "../components/Badge";
import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";
import { Skeleton } from "../components/Skeleton";
import { AgentIcon, ClockIcon, DurationIcon, EnvIcon, VaultIcon } from "../components/icons";
import { FilesPanel, ResourcePanel } from "./session-detail/Panels";
import {
  TrajectoryOutcomeChip,
  TrajectoryRewardChip,
  TrajectoryViewerModal,
} from "./session-detail/Trajectory";
import { TimelineView } from "../components/timeline/TimelineView";
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
import type { Trajectory, TrajectoryOutcome } from "../lib/trajectory";
import { rewardHeadline, outcomeToStatusTone } from "../lib/trajectory";
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
import { useI18n } from "../i18n";

type View = "chat" | "timeline";

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

export function SessionDetail() {
  const { id } = useParams();
  const managedApi = useManagedApi();
  const { t } = useI18n();
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
  const [view, setView] = useState<View>("chat");
  const [sending, setSending] = useState(false);
  // Optimistic outbox slot — what the user typed, between hitting Send
  // and the server-side pending broadcast (system.user_message_pending)
  // arriving over SSE. Without this, hitting Send clears the input
  // field instantly and the user stares at a blank conversation for the
  // 100-500ms POST → SSE roundtrip. With it, the message appears in the
  // queued-state EventBubble immediately and is replaced by the server's
  // pending row the moment SSE delivers it. Single slot is intentional
  // (we never let two POSTs be in flight at once — Send is disabled
  // while `sending`). Set to null when SSE confirms or POST settles.
  const [localPending, setLocalPending] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [sessionMeta, setSessionMeta] = useState<{
    title?: string | null;
    environmentId?: string;
    vaultIds?: string[];
    vaults?: Array<{ id: string; name?: string }>;
    createdAt?: string;
    agentSnapshot?: { id?: string; name?: string; model?: string | { id: string }; description?: string | null; version?: number };
    envSnapshot?: { id?: string; name?: string; description?: string | null };
  }>({});
  useCrumbName(id, sessionMeta.title?.trim());
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [resourcePanel, setResourcePanel] = useState<
    | { kind: "agent"; id: string }
    | { kind: "environment"; id: string }
    | { kind: "vault"; id: string }
    | null
  >(null);
  const [showFiles, setShowFiles] = useState(false);
  const [linear, setLinear] = useState<{
    issueId?: string;
    issueIdentifier?: string;
    workspaceId?: string;
  } | null>(null);
  const [slack, setSlack] = useState<{
    channelId?: string;
    threadTs?: string;
    workspaceId?: string;
    eventKind?: string;
    publicationId?: string;
  } | null>(null);
  const [status, setStatus] = useState("idle");
  /** Lazy-fetched Trajectory v1 envelope. Drives the outcome + reward
   *  chips in the header strip and the Trajectory viewer modal. We don't
   *  block initial render on this — chips render as `—` until it lands.
   *  Sentinels mirror EvalRunDetail: "loading" while in flight, "error"
   *  if the fetch failed (404 = trajectory not built yet, 5xx = sandbox
   *  flaky); both keep the trigger from re-firing every render. */
  const [trajectory, setTrajectory] = useState<Trajectory | "loading" | "error" | undefined>(undefined);
  /** Sub-agent threads in this session. Primary is implicit at index 0
   *  (label "Main"). Empty when the session has only the primary thread,
   *  in which case the selector UI is hidden entirely. Refreshed on
   *  `session.thread_created` events arriving over SSE.
   *  parent_thread_id powers the tree view (coordinator → worker → sub-
   *  worker); missing parents fall back to the primary root. */
  const [threads, setThreads] = useState<
    Array<{ id: string; agent_name?: string; parent_thread_id?: string | null }>
  >([]);
  /** Currently-active thread id. Defaults to 'sthr_primary'. Filters
   *  the events array at render time. SSE-driven new threads don't
   *  auto-switch — the operator stays on whatever they're watching. */
  const [activeThreadId, setActiveThreadId] = useState<string>("sthr_primary");
  /** Server-mirrored pending queue, keyed by event_id. Populated from
   *  the initial GET /pending plus live system.user_message_pending /
   *  _promoted / _cancelled SSE frames. Pending entries render as a
   *  separate "outbox" section at the bottom of the timeline; once the
   *  server promotes the row (system.user_message_promoted), the entry
   *  is removed from this map and the canonical user.* event takes its
   *  place in the events array via the regular SSE broadcast. */
  const [pendingByEventId, setPendingByEventId] = useState<Map<string, PendingEntry>>(new Map());
  const [showTrajectory, setShowTrajectory] = useState(false);
  /** История событий загружена (первая выгрузка завершена). Пока нет, вместо
   *  пустого состояния показываем скелетон: «Отправьте сообщение» до конца
   *  загрузки вводило бы в заблуждение (правило 12 DDC). */
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const seenKeys = useRef(new Set<string>());

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
      // Server claimed our optimistic outbox slot — drop the client-only
      // mirror so we don't double-render the same user message (server
      // entry has more metadata + a stable event_id; ours has neither).
      const inner = p.event;
      const innerText =
        inner && (inner as { content?: Array<{ type?: string; text?: string }> }).content
          ?.find((c) => c.type === "text")?.text;
      if (innerText) setLocalPending((cur) => (cur === innerText ? null : cur));
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
    // Live-update the thread selector when a sub-agent spawns. We don't
    // auto-switch the operator's view — they stay on whatever they're
    // watching; the new tab just appears alongside.
    if (ev.type === "session.thread_created") {
      const tc = ev as {
        session_thread_id?: string;
        agent_name?: string;
        parent_thread_id?: string | null;
      };
      if (tc.session_thread_id && tc.session_thread_id !== "sthr_primary") {
        setThreads((prev) =>
          prev.some((t) => t.id === tc.session_thread_id)
            ? prev
            : [
                ...prev,
                {
                  id: tc.session_thread_id!,
                  agent_name: tc.agent_name,
                  // SessionDO emits thread_created with parent_thread_id;
                  // older sessions (pre-Phase 1) may not — fall back to
                  // primary so the tree stays well-formed.
                  parent_thread_id: tc.parent_thread_id ?? "sthr_primary",
                },
              ],
        );
      }
    }
    // Don't return — Timeline's bucketIntoTurns uses these as the close
    // boundary of a turn. Conversation view's EventBubble switch silently
    // skips unknown types so leaving them in `events` is harmless there.
    // Previously this dropped every span.* and agent.thinking event before
    // they reached `events` state, so Timeline saw none of model/wakeup/
    // compaction/outcome spans (entire reason waterfall looked empty).
    // Conversation view's EventBubble silently ignores unknown types via
    // its switch — keeping the events here costs the chat view nothing
    // and gives Timeline the full trajectory it needs.

    // Tag streamed events with arrival time so the timeline has a usable ts
    // even before the server-side stored copy round-trips.
    if (!ev.ts) ev.ts = new Date().toISOString();

    setEvents((prev) => [...prev, ev]);
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
    setAgentId("");
    setSessionMeta({});
    setLinear(null);
    setSlack(null);
    setEditingTitle(false);
    setTitleDraft("");
    setSavingTitle(false);
    setStatus("idle");
    setTrajectory(undefined);
    setThreads([]);
    setActiveThreadId("sthr_primary");
    setPendingByEventId(new Map());
    setLocalPending(null);
    setHistoryLoaded(false);
    const abort = new AbortController();

    // Load session info
    managedApi.sessions.retrieve(id)
      .then((s) => {
        setAgentId(s.agent?.id || "");
        setStatus(s.status);
        setSessionMeta({
          title: s.title ?? null,
          environmentId: s.environment_id,
          vaultIds: s.vault_ids,
          createdAt: s.created_at,
          agentSnapshot: s.agent,
        });
        setTitleDraft(s.title ?? "");

        const linearMeta = readManagedMetadataObject(s.metadata, "linear") as
          | { issueId?: string; issueIdentifier?: string; workspaceId?: string }
          | null;
        setLinear(
          linearMeta && (linearMeta.issueId || linearMeta.issueIdentifier)
            ? linearMeta
            : null,
        );
        const slackMeta = readManagedMetadataObject(s.metadata, "slack") as
          | { channelId?: string; threadTs?: string; workspaceId?: string; eventKind?: string; publicationId?: string }
          | null;
        setSlack(
          slackMeta && (slackMeta.channelId || slackMeta.threadTs)
            ? slackMeta
            : null,
        );

        // Live-resolve env + vault names by id. Per the id-only ref decision
        // (memory: session-resource-refs), the session API does not pre-bake
        // display data — clients fetch resources on demand. Names appear a
        // tick later than the badge frame; until then the badge falls back
        // to the short-id label.
        if (s.environment_id) {
          managedApi.environments.retrieve(s.environment_id)
            .then((env) => setSessionMeta((prev) => ({ ...prev, envSnapshot: env })))
            .catch(() => {});
        }
        if (s.vault_ids?.length) {
          Promise.all(
            s.vault_ids.map((vid) =>
              managedApi.vaults.retrieve(vid)
                .then((v) => ({ id: v.id, name: v.display_name }))
                .catch(() => ({ id: vid })),
            ),
          ).then((vaults) => setSessionMeta((prev) => ({ ...prev, vaults })));
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

    // Threads list (primary + sub-agent). Primary is always present
    // (seeded by SessionDO on /init). Filter to non-primary so the
    // selector only renders when there's something to switch between
    // — single-thread sessions get zero UI clutter.
    managedApi.sessions.threads.list(id, { limit: 100 })
      .then((res) => {
        const subThreads = (res.data ?? [])
          .filter((t) => t.id !== "sthr_primary")
          .map((t) => ({
            id: t.id,
            parent_thread_id: t.parent_thread_id,
            agent_name: "name" in t.agent ? t.agent.name : undefined,
          }));
        setThreads(subThreads);
      })
      .catch(() => setThreads([]));

    return () => { abort.abort(); };
  }, [id]);

  const send = async (messageText: string, files?: File[]) => {
    const text = messageText.trim();
    if (!text && !files?.length) return;
    if (!id) return;
    setLocalPending(
      text ||
        (files?.length
          ? files.length === 1
            ? "Изображение"
            : `${files.length} ${plural(files.length, "изображение", "изображения", "изображений")}`
          : ""),
    );
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
          text: uploaded.length === 1 ? "Прикреплено изображение." : "Прикреплены изображения.",
        });
      }

      await managedApi.sessions.events.send(id, {
        events: [{ type: "user.message", content }],
      });
      // POST resolved → server already inserted the row + broadcast
      // system.user_message_pending. The outbox map will pick it up
      // (and likely already has by the time await unblocks here).
      // Clear our local slot so we don't double-render with the server
      // entry — but only if the server's pending hasn't already cleared
      // it via the system.user_message_pending handler.
      setLocalPending((cur) => (cur === text ? null : cur));
    } catch {
      // api() already toasted the error; clear the optimistic slot so
      // the user doesn't keep seeing a "stuck" pending row that will
      // never actually run.
      setLocalPending(null);
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
  /** Stable filtered list for Timeline — avoid reallocating on every
   *  SessionDetail render (SSE stream updates, keystrokes, etc.), which
   *  would otherwise invalidate TimelineView's bucketIntoTurns memo. */
  const timelineEvents = useMemo(
    () =>
      events.filter((e) => {
        const tid = (e as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
        return tid === activeThreadId;
      }),
    [events, activeThreadId],
  );
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

  const saveTitle = async () => {
    if (!id) return;
    setSavingTitle(true);
    try {
      const updated = await managedApi.sessions.update(id, { title: titleDraft.trim() });
      setSessionMeta((prev) => ({
        ...prev,
        title: updated.title ?? (titleDraft.trim() || null),
      }));
      setEditingTitle(false);
    } catch (e) {
      console.error("rename session failed", e);
    } finally {
      setSavingTitle(false);
    }
  };

  const activePendingEntries = Array.from(pendingByEventId.values())
    .filter((entry) => entry.session_thread_id === activeThreadId)
    .sort((a, b) => a.pending_seq - b.pending_seq);
  const hasTransientActivity = (
    (localPending !== null && activeThreadId === "sthr_primary")
    || activePendingEntries.length > 0
    || thinkingStreams.size > 0
    || toolInputStreams.size > 0
    || streams.size > 0
    || status === "running"
  );
  const transientActivity = (
    <SessionTransientActivity
      localPending={activeThreadId === "sthr_primary" ? localPending : null}
      pendingEntries={activePendingEntries}
      running={status === "running"}
      streams={streams}
      thinkingStreams={thinkingStreams}
      toolInputStreams={toolInputStreams}
    />
  );

  const trajectoryTitle =
    trajectory === "loading"
      ? "Загрузка траектории…"
      : trajectory === "error"
        ? "Траектория недоступна. Нажмите, чтобы посмотреть причину"
        : "Показать исходную траекторию (Trajectory v1)";

  return (
    <div className="page flex h-full min-h-0 flex-col gap-4">
      {/* Шапка: название, чипы состава сессии и действия. Заголовок
          страницы h1 24px bold, ряд чипов под ним, действия справа
          (.head-row, правило 7 DDC). Хлебные крошки над страницей уже несут
          путь и id сессии, поэтому ссылки «назад» здесь нет. */}
      <div className="head-row mb-2 shrink-0">
        <div className="head-main space-y-3">
          {/* Название сессии редактируется на месте; пустое показывает
              приглушённое «Сессия без названия», чтобы переименование было
              заметно. */}
          <div className="flex min-h-10 items-center gap-2">
            {editingTitle ? (
              <>
                <Input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className="min-w-0 flex-1"
                  placeholder={t.sessions.sessionTitle}
                  aria-label={t.sessions.sessionTitle}
                  autoFocus
                  disabled={savingTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveTitle();
                    if (e.key === "Escape") {
                      setEditingTitle(false);
                      setTitleDraft(sessionMeta.title ?? "");
                    }
                  }}
                />
                <Button
                  onClick={() => void saveTitle()}
                  loading={savingTitle}
                  loadingLabel={t.common.saving}
                >
                  {t.common.save}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingTitle(false);
                    setTitleDraft(sessionMeta.title ?? "");
                  }}
                  disabled={savingTitle}
                >
                  {t.common.cancel}
                </Button>
              </>
            ) : (
              <>
                <h1
                  className="min-w-0 truncate text-2xl leading-8 font-bold tracking-tight text-ddc-heading"
                  title={sessionMeta.title?.trim() || undefined}
                >
                  {sessionMeta.title?.trim() || (
                    <span className="font-normal text-ddc-text-muted">{t.sessions.untitledSession}</span>
                  )}
                </h1>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    setTitleDraft(sessionMeta.title ?? "");
                    setEditingTitle(true);
                  }}
                  aria-label={t.sessions.editTitle}
                  title={t.sessions.editTitle}
                  className="text-ddc-icon-muted hover:text-ddc-text"
                >
                  <PencilIcon />
                </Button>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={status as "idle" | "running" | "terminated" | "error" | string} />
            {/* Итог траектории показываем только после завершения: пока
                сессия идёт, статус несёт StatusPill, двойной значок не нужен. */}
            <TrajectoryOutcomeChip trajectory={trajectory} />
            {/* Оценка проверяющего. Скрыта, пока проверка не прошла: нет
                оценки не значит «ноль». */}
            <TrajectoryRewardChip trajectory={trajectory} />
            {/* Агент, окружение и хранилища показываем всегда, чтобы состав
                сессии читался с первого взгляда. Если снимок не принёс имя,
                подставляем короткий id. */}
            {(sessionMeta.agentSnapshot?.id || agentId) && (
              <Badge
                icon={<AgentIcon />}
                label={sessionMeta.agentSnapshot?.name || shortenId(sessionMeta.agentSnapshot?.id || agentId)}
                title={`Агент: ${sessionMeta.agentSnapshot?.name || sessionMeta.agentSnapshot?.id || agentId}`}
                onClick={() =>
                  setResourcePanel({ kind: "agent", id: sessionMeta.agentSnapshot?.id || agentId })
                }
              />
            )}
            {sessionMeta.environmentId && (
              <Badge
                icon={<EnvIcon />}
                label={sessionMeta.envSnapshot?.name || shortenId(sessionMeta.environmentId)}
                title={`Окружение: ${sessionMeta.envSnapshot?.name || sessionMeta.environmentId}`}
                onClick={() =>
                  setResourcePanel({ kind: "environment", id: sessionMeta.environmentId! })
                }
              />
            )}
            {(sessionMeta.vaults ?? sessionMeta.vaultIds?.map((id) => ({ id, name: undefined })) ?? []).map((v) => (
              <Badge
                key={v.id}
                icon={<VaultIcon />}
                label={v.name || shortenId(v.id)}
                title={`Хранилище секретов: ${v.name || v.id}`}
                onClick={() => setResourcePanel({ kind: "vault", id: v.id })}
              />
            ))}
            <SessionDurationBadge events={events} />
            {sessionMeta.createdAt && <RelativeTimeBadge iso={sessionMeta.createdAt} />}
          </div>
        </div>
        <div className="head-actions">
          {/* Остановить показываем, пока сессия выполняется. Отправляет
              user.interrupt для активного потока: сервер прерывает ход,
              сбрасывает очередь и сообщает status_idle. Это выход из
              «зависшего» состояния, когда поток оборвался без status_idle. */}
          {status === "running" && view !== "chat" && (
            <Button
              variant="outline"
              onClick={() => void interrupt()}
              loading={interrupting}
              loadingLabel="Остановка…"
              title="Прервать текущий ход в этом потоке"
            >
              <SquareIcon />
              Остановить
            </Button>
          )}
          <Button
            variant={showFiles ? "secondary" : "outline"}
            onClick={() => setShowFiles((v) => !v)}
            aria-pressed={showFiles}
            aria-label="Файлы сессии"
            title="Файлы, которые агент сохранил в /mnt/session/outputs/"
          >
            <FolderOpenIcon />
            <span className="hidden sm:inline">Файлы</span>
          </Button>
          {/* Просмотр траектории доступен, когда ленивая загрузка завершилась.
              При ошибке кнопка остаётся активной: причину покажет окно. */}
          <Button
            variant="outline"
            onClick={() => setShowTrajectory(true)}
            disabled={trajectory === undefined || trajectory === "loading"}
            aria-label="Траектория"
            title={trajectoryTitle}
          >
            <FileJsonIcon />
            <span className="hidden sm:inline">Траектория</span>
          </Button>
        </div>
      </div>

      {/* Режим просмотра. Одна панель вкладок tabs (правило 5 DDC),
          справа число событий на хронологии. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div role="tablist" aria-label="Режим просмотра" className="tabs">
          <ViewTab label="Разговор" active={view === "chat"} onClick={() => setView("chat")} />
          <ViewTab
            label="Хронология"
            active={view === "timeline"}
            onClick={() => startTransition(() => setView("timeline"))}
          />
        </div>
        {view === "timeline" && (
          <span className="text-xs text-ddc-text-muted tabular-nums">
            {events.length} {plural(events.length, "событие", "события", "событий")}
          </span>
        )}
      </div>

      {/* Потоки: только когда есть субагенты. Основной поток неявно стоит
          первым, вкладки субагентов появляются по мере их запуска. Выбор
          потока фильтрует и разговор, и хронологию. */}
      {threads.length > 0 && (
        <ThreadTree
          threads={threads}
          activeThreadId={activeThreadId}
          onSelect={setActiveThreadId}
        />
      )}

      {/* Контекст Linear (сессию запустил вебхук Linear) */}
      {linear && (
        <div className="callout shrink-0 flex-wrap items-center">
          <LinkIcon className="size-4 flex-none" aria-hidden="true" />
          <span className="font-medium">Linear</span>
          <span className="text-ddc-text-muted">·</span>
          <span>
            задача{" "}
            <span className="font-mono">{linear.issueIdentifier ?? linear.issueId}</span>
          </span>
          {linear.workspaceId && (
            <a
              href={`https://linear.app`}
              target="_blank"
              rel="noreferrer"
              className="link ml-auto inline-flex items-center gap-1"
            >
              Открыть в Linear
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
          )}
        </div>
      )}

      {/* Контекст Slack (сессию запустило событие Slack) */}
      {slack && (
        <div className="callout shrink-0 flex-wrap items-center">
          <MessageSquareIcon className="size-4 flex-none" aria-hidden="true" />
          <span className="font-medium">Slack</span>
          <span className="text-ddc-text-muted">·</span>
          <span>
            {slack.channelId ? (
              slack.workspaceId ? (
                <a
                  href={`slack://channel?team=${slack.workspaceId}&id=${slack.channelId}`}
                  className="link font-mono"
                  title="Открыть в приложении Slack"
                >
                  канал {slack.channelId}
                </a>
              ) : (
                <>
                  канал <span className="font-mono">{slack.channelId}</span>
                </>
              )
            ) : (
              "–"
            )}
            {slack.threadTs && (
              <>
                {" "}тред{" "}
                <span className="font-mono">{slack.threadTs}</span>
              </>
            )}
          </span>
          {slack.eventKind && (
            <span className="font-mono text-xs tracking-wider text-ddc-text-muted uppercase">
              {slack.eventKind}
            </span>
          )}
        </div>
      )}

      {/* Рабочая область: разговор или хронология, справа выдвижная панель.
          События фильтруются по выбранному потоку. События без метки потока
          (старые и служебные) относятся к основному. Карточка относительная,
          чтобы панели на узком экране ложились поверх неё. */}
      <div className="card relative flex min-h-[24rem] min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col">
          {view === "chat" ? (
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
            />
          ) : (
            <TimelineView
              key={`${id ?? "session"}:${activeThreadId}`}
              events={timelineEvents}
              loading={!historyLoaded}
            />
          )}
        </div>
        {resourcePanel && (
          <ResourcePanel
            panel={resourcePanel}
            onClose={() => setResourcePanel(null)}
          />
        )}
        {showFiles && id && (
          <FilesPanel sessionId={id} onClose={() => setShowFiles(false)} />
        )}
      </div>
      <TrajectoryViewerModal
        open={showTrajectory}
        onClose={() => setShowTrajectory(false)}
        sessionId={id ?? ""}
        trajectory={trajectory}
      />
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

function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  // Вкладка DDC (.tab): выбранная читается через aria-selected и ложится на
  // заливку brand-50, подчёркивания нет (правило 5).
  return (
    <PlainButton
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className="tab"
    >
      {label}
    </PlainButton>
  );
}

/** Вкладка потока. Отступ слева растёт с глубиной, чтобы дерево субагентов
 *  читалось как стек вызовов: родитель выше своих потомков. */
function ThreadTab({
  label,
  active,
  onClick,
  depth = 0,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  depth?: number;
}) {
  return (
    <PlainButton
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className="tab"
      style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
    >
      {/* Знак ветки для depth>0: поток порождён другим потоком, а не стоит
          рядом с основным. */}
      {depth > 0 && (
        <CornerDownRightIcon className="size-3.5 text-ddc-icon-muted" aria-hidden="true" />
      )}
      <span>{label}</span>
    </PlainButton>
  );
}

/**
 * Дерево потоков с отступом по глубине. Корень sthr_primary называется
 * «Основной», дети идут по parent_thread_id обходом в глубину: родители
 * выше потомков.
 *
 * Сирот (parent_thread_id указывает на неизвестный поток: гонка при запуске
 * или устаревший снимок) переносим под sthr_primary, чтобы они остались
 * видимыми.
 */
function ThreadTree({
  threads,
  activeThreadId,
  onSelect,
}: {
  threads: Array<{ id: string; agent_name?: string; parent_thread_id?: string | null }>;
  activeThreadId: string;
  onSelect: (id: string) => void;
}) {
  const knownIds = new Set<string>(["sthr_primary", ...threads.map((t) => t.id)]);
  const childrenOf = new Map<string, typeof threads>();
  for (const t of threads) {
    const parent =
      t.parent_thread_id && knownIds.has(t.parent_thread_id)
        ? t.parent_thread_id
        : "sthr_primary";
    const arr = childrenOf.get(parent) ?? [];
    arr.push(t);
    childrenOf.set(parent, arr);
  }
  const flat: Array<{ id: string; label: string; depth: number }> = [
    { id: "sthr_primary", label: "Основной", depth: 0 },
  ];
  const walk = (parentId: string, depth: number) => {
    const kids = childrenOf.get(parentId) ?? [];
    for (const k of kids) {
      flat.push({ id: k.id, label: k.agent_name ?? k.id.slice(0, 12), depth });
      walk(k.id, depth + 1);
    }
  };
  walk("sthr_primary", 1);
  const maxDepth = flat.reduce((m, n) => Math.max(m, n.depth), 0);
  // Неглубокое дерево (один слой работников под основным) остаётся
  // горизонтальной панелью с прокруткой; глубокое встаёт столбцом, иначе
  // отступы не прочитать.
  const isFlat = maxDepth <= 1;
  return (
    <div
      role="tablist"
      aria-label="Потоки"
      className={
        isFlat
          ? "tabs shrink-0"
          : "tabs max-h-44 shrink-0 flex-col items-stretch gap-0 overflow-y-auto"
      }
    >
      {flat.map((n) => (
        <ThreadTab
          key={n.id}
          label={n.label}
          depth={isFlat ? 0 : n.depth}
          active={activeThreadId === n.id}
          onClick={() => onSelect(n.id)}
        />
      ))}
    </div>
  );
}

function SessionDurationBadge({ events }: { events: Event[] }) {
  if (events.length === 0) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    const ts = (e as { processed_at?: string }).processed_at;
    if (typeof ts !== "string") continue;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < first) first = t;
    if (t > last) last = t;
  }
  if (!Number.isFinite(first) || last <= first) return null;
  return (
    <Badge
      icon={<DurationIcon />}
      label={formatDurationRu(last - first)}
      title="Время от первого до последнего события"
    />
  );
}

function RelativeTimeBadge({ iso }: { iso: string }) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (
    <Badge
      icon={<ClockIcon />}
      label={formatRelativeRu(Date.now() - t)}
      title={`Создана ${formatDateTimeRu(iso)}`}
    />
  );
}

function SessionTransientActivity({
  localPending,
  pendingEntries,
  running,
  streams,
  thinkingStreams,
  toolInputStreams,
}: {
  localPending: string | null;
  pendingEntries: PendingEntry[];
  running: boolean;
  streams: ReadonlyMap<string, string>;
  thinkingStreams: ReadonlyMap<string, string>;
  toolInputStreams: ReadonlyMap<string, { name?: string; partial: string }>;
}) {
  return (
    <div className="chat-turn-frame mx-auto w-full max-w-3xl min-w-0 space-y-4">
      {localPending ? (
        <EventRender
          event={{ type: "user.message", content: [{ type: "text", text: localPending }] } as Event}
          livePending
        />
      ) : null}
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
      // Result text — Tool's <ToolOutput> takes the raw value and will
      // either CodeBlock-stringify an object or render a string in a
      // CodeBlock. We pre-stringify content arrays since they're an
      // OMA-specific shape, not a JSON-friendly object.
      const rawContent = pairedResult
        ? (pairedResult as { content?: unknown }).content
        : undefined;
      const output: unknown = rawContent === undefined
        ? undefined
        : typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent, null, 2);
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
        : typeof rawContent === "string"
          ? rawContent
          : JSON.stringify(rawContent, null, 2);
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
          <div>Ошибка: {event.error}</div>
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
