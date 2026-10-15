import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useInRouterContext } from "react-router";
import {
  AlarmClockIcon,
  BanIcon,
  CheckIcon,
  CircleXIcon,
  CopyIcon,
  FileIcon,
  FilePenIcon,
  FileTextIcon,
  FolderSearchIcon,
  GlobeIcon,
  LoaderCircleIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlugIcon,
  SearchCodeIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { AgentUITurnState } from "@openma/common/agent-ui";
import { projectAcpChatTurn } from "@openma/common/chat-ui";
import type {
  CanonicalChatTurn,
  WireSessionEvent,
} from "@openma/common/session-events/managed";
import { Badge } from "@/components/ui/badge";
import { PlainButton } from "@/components/ui/plain-button";
import { cn } from "@/lib/utils";
import { formatToolOutput } from "../../lib/tool-output";
import {
  toolInputPreview,
  totalInput,
  type RequestItem,
  type ToolCall,
  type TranscriptBlock,
} from "../../lib/session-stats";
import { Markdown } from "../Markdown";
import {
  formatClockRu,
  formatDateTimeRu,
  formatGapRu,
  formatShortDurationRu,
  formatTokensRu,
  TURN_FAILED_FALLBACK,
} from "./format-ru";
import {
  ClampedContent,
  GradingBlock,
  InlineTextButton,
  isSelectingText,
  OutcomeDefinedBlock,
  SESSION_CARD_CLASS,
  SESSION_CARD_SELECTED_CLASS,
} from "./OutcomeBlock";
import "./transcript.css";

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

export interface CanonicalSessionTurnProps {
  turn: CanonicalChatTurn;
  /** Блоки хода из buildTranscriptBlocks(turn.rawEvents). */
  blocks: readonly TranscriptBlock[];
  agentName: string;
  sessionId?: string;
  selectedEventId: string | null;
  selectedBlockId: string | null;
  /** Раскрыть вызов при выборе; false для выбора из «Инструментов» и мини-карты. */
  expandSelected: boolean;
  hoveredBlockId: string | null;
  onSelectEvent(eventId: string | null): void;
  onJumpToBlock(blockId: string): void;
}

/**
 * Managed owns the wire vocabulary; OpenMA common owns the conversation turn.
 * This adapter is deliberately pure so SessionDetail never rebuilds chat UI.
 */
export function projectCanonicalSessionTurn(turn: CanonicalChatTurn): AgentUITurnState {
  const span = eventTimeSpan(turn.rawEvents);
  return projectAcpChatTurn(
    {
      id: turn.id,
      promptText: turn.userText,
      events: turn.rawEvents.map((payload) => ({ payload })),
      assistantText: turn.render.assistantText,
      status: canonicalTurnStatus(turn.status),
      // Причину берём из самих событий: общий пакет теряет error.message
      // (объект `{type, message}`) и подставляет английское «Session error».
      errorMessage: turn.status === "errored"
        ? sessionErrorMessages(turn.rawEvents).join("\n") || TURN_FAILED_FALLBACK
        : undefined,
      // Без меток времени библиотека считает длительность хода нулём.
      startedAt: span?.startedAt,
      endedAt: turn.status === "running" ? undefined : span?.endedAt,
    },
    { rendered: turn.render },
  );
}


/** Время события в миллисекундах: processed_at сервера, затем ts, который
 *  консоль ставит при получении (ISO-строка или секунды/миллисекунды). */
function eventTimeMs(event: WireSessionEvent): number | undefined {
  const processedAt = event.processed_at;
  if (typeof processedAt === "string") {
    const parsed = Date.parse(processedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  const processedAtMs = event.processed_at_ms;
  if (typeof processedAtMs === "number" && Number.isFinite(processedAtMs)) return processedAtMs;
  const ts = event.ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) return ts < 1e11 ? ts * 1000 : ts;
  return undefined;
}

/** Первое и последнее время среди событий хода; `undefined`, если меток нет. */
function eventTimeSpan(
  events: readonly WireSessionEvent[],
): { startedAt: number; endedAt: number } | undefined {
  let startedAt = Infinity;
  let endedAt = -Infinity;
  for (const event of events) {
    const time = eventTimeMs(event);
    if (time === undefined) continue;
    if (time < startedAt) startedAt = time;
    if (time > endedAt) endedAt = time;
  }
  return Number.isFinite(startedAt) ? { startedAt, endedAt } : undefined;
}

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message.trim() || undefined;
  }
  return undefined;
}

/** Причины всех `session.error` хода без повторов (повтор попытки шлёт ту же). */
export function sessionErrorMessages(events: readonly WireSessionEvent[]): string[] {
  const messages: string[] = [];
  for (const event of events) {
    if (event.type !== "session.error") continue;
    const message = errorText(event.error) ?? errorText(event.message);
    if (message && !messages.includes(message)) messages.push(message);
  }
  return messages;
}

/* ---------- Ход разговора ---------- */

/**
 * Один ход разговора в раскладке консоли Claude: плашки «Пользователь» и
 * агента с временем, карточки запросов к модели со строками вызовов,
 * блоки результата и оценки, разрыв времени, ошибки. Компонент ничего не
 * хранит: выбор, раскрытие и наведение приходят свойствами.
 */
export function CanonicalSessionTurn({
  turn,
  blocks,
  agentName = "Агент",
  selectedEventId,
  selectedBlockId,
  expandSelected,
  hoveredBlockId,
  onSelectEvent,
  onJumpToBlock,
}: CanonicalSessionTurnProps) {
  const rawById = useMemo(() => {
    const map = new Map<string, WireSessionEvent>();
    for (const event of turn.rawEvents) {
      if (typeof event.id === "string" && event.id) map.set(event.id, event);
    }
    return map;
  }, [turn.rawEvents]);

  // Повтор попытки шлёт ту же ошибку: показываем каждую причину один раз.
  const shown = useMemo(() => {
    const seen = new Set<string>();
    return blocks.filter((block) => {
      if (block.kind !== "error") return true;
      if (seen.has(block.message)) return false;
      seen.add(block.message);
      return true;
    });
  }, [blocks]);

  const answerEventId = useMemo(() => {
    let last: string | null = null;
    for (const block of shown) {
      if (block.kind !== "request") continue;
      for (const item of block.items) {
        if (item.kind === "text" && item.text.trim()) last = item.eventId;
      }
    }
    return last;
  }, [shown]);

  const gradings = useMemo(
    () => shown.filter((block): block is Block<"grading"> => block.kind === "grading"),
    [shown],
  );
  const outcomes = useMemo(
    () => shown.filter((block): block is Block<"outcome_defined"> => block.kind === "outcome_defined"),
    [shown],
  );

  const hasUserBlock = shown.some((block) => block.kind === "user");
  let previousWasAgent = false;
  const nodes: ReactNode[] = [];

  shown.forEach((block, index) => {
    const key = block.id || `${block.kind}:${index}`;
    const selected = block.id !== "" && selectedBlockId === block.id;
    const hovered = block.id !== "" && hoveredBlockId === block.id;
    const select = () => onSelectEvent(block.id);

    if (block.kind === "request") {
      const toolSelected = block.items.some(
        (item) => item.kind === "tool" && callMatches(item.call, selectedEventId),
      );
      nodes.push(
        <div key={key}>
          {previousWasAgent ? null : <AgentHeader agentName={agentName} atMs={block.atMs} />}
          <RequestCard
            answerEventId={answerEventId}
            block={block}
            expandSelected={expandSelected}
            hovered={hovered}
            onSelectEvent={onSelectEvent}
            rawById={rawById}
            selected={selected && !toolSelected}
            selectedEventId={selectedEventId}
          />
        </div>,
      );
      previousWasAgent = true;
      return;
    }
    previousWasAgent = false;

    switch (block.kind) {
      case "user": {
        const raw = rawById.get(block.eventId);
        const metadata = raw?.metadata as { harness?: string; kind?: string; scheduled_at?: string } | undefined;
        const scheduled = metadata?.harness === "schedule" && metadata?.kind === "wakeup";
        nodes.push(
          <UserBlockView
            block={block}
            hovered={hovered}
            key={key}
            onSelect={select}
            scheduledAt={scheduled ? metadata?.scheduled_at : undefined}
            selected={selected}
            wakeup={block.wakeup || scheduled}
          />,
        );
        break;
      }
      case "outcome_defined":
        nodes.push(
          <div data-hovered={hovered ? "true" : "false"} key={key}>
            <OutcomeDefinedBlock block={block} onSelect={select} selected={selected} />
          </div>,
        );
        break;
      case "grading": {
        const sameOutcome = gradings.filter((candidate) => candidate.outcomeId === block.outcomeId);
        const at = sameOutcome.findIndex((candidate) => candidate.id === block.id);
        const prev = at > 0 ? sameOutcome[at - 1] : undefined;
        const next = at >= 0 && at < sameOutcome.length - 1 ? sameOutcome[at + 1] : undefined;
        const rubricTarget = outcomes.find((candidate) => candidate.outcome.outcomeId === block.outcomeId);
        nodes.push(
          <div data-hovered={hovered ? "true" : "false"} key={key}>
            <GradingBlock
              block={block}
              onJumpToRubric={() => rubricTarget && onJumpToBlock(rubricTarget.id)}
              onNext={next ? () => onJumpToBlock(next.id) : undefined}
              onPrev={prev ? () => onJumpToBlock(prev.id) : undefined}
              onSelect={select}
              selected={selected}
            />
          </div>,
        );
        break;
      }
      case "gap":
        if (block.atMs !== null) {
          nodes.push(
            <div
              className="flex justify-center"
              data-block-id={block.id}
              data-block-kind="gap"
              key={key}
            >
              <span
                className="rounded-full bg-ddc-surface-sunken px-3 py-0.5 text-xs tabular-nums text-ddc-text-muted"
                data-search-skip
              >
                {formatGapRu(block.atMs, block.gapMs)}
              </span>
            </div>,
          );
        }
        break;
      case "error":
        nodes.push(<SessionTurnError block={block} key={key} onSelect={select} selected={selected} />);
        break;
      case "warning":
        nodes.push(<SessionTurnWarning block={block} key={key} onSelect={select} selected={selected} />);
        break;
      default:
        break;
    }
  });

  const plan = turn.render.plan;
  const notes = turn.status !== "errored" ? turn.render.notes : [];

  return (
    <article
      className="flex min-w-0 flex-col gap-3 py-1.5"
      data-session-turn-status={turn.status}
      data-turn-id={turn.id}
    >
      {!hasUserBlock && turn.userText ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2" data-search-skip>
            <Badge variant="brand">Пользователь</Badge>
          </div>
          <div className={SESSION_CARD_CLASS} data-session-card data-selected="false">
            <p className="break-words whitespace-pre-wrap" data-session-turn-prompt>
              {turn.userText}
            </p>
          </div>
        </div>
      ) : null}
      {plan.length > 0 ? (
        <ol className="space-y-1 text-sm text-ddc-label" data-session-turn-plan>
          {plan.map((entry, index) => (
            <li key={`${turn.id}:plan:${index}`}>{entry.content}</li>
          ))}
        </ol>
      ) : null}
      {nodes}
      {notes.map((note, index) => (
        <p className="callout-warning" key={`${turn.id}:note:${index}`} role="status">
          {note}
        </p>
      ))}
    </article>
  );
}

function callMatches(call: ToolCall, eventId: string | null): boolean {
  if (!eventId) return false;
  return (
    call.useEventId === eventId ||
    call.resultEventId === eventId ||
    call.confirmationEventId === eventId
  );
}

/* ---------- Реплика пользователя и метка агента ---------- */

function AgentHeader({ agentName, atMs }: { agentName: string; atMs: number | null }) {
  return (
    <div className="mb-1 flex min-w-0 items-center gap-2" data-agent-header data-search-skip>
      <Badge className="max-w-full min-w-0" variant="info">
        <span className="truncate">{agentName}</span>
      </Badge>
      {atMs !== null ? (
        <time className="text-xs tabular-nums text-ddc-text-muted">{formatClockRu(atMs)}</time>
      ) : null}
    </div>
  );
}

function UserBlockView({
  block,
  selected,
  hovered,
  wakeup,
  scheduledAt,
  onSelect,
}: {
  block: Block<"user">;
  selected: boolean;
  hovered: boolean;
  wakeup: boolean;
  scheduledAt: string | undefined;
  onSelect(): void;
}) {
  return (
    <div
      className="space-y-1"
      data-block-id={block.id}
      data-block-kind="user"
      data-hovered={hovered ? "true" : "false"}
    >
      {wakeup ? (
        <p
          className="flex items-center gap-1 text-xs text-ddc-text-muted"
          data-search-skip
          title={scheduledAt ? `Запланировано на ${formatDateTimeRu(scheduledAt)}` : undefined}
        >
          <AlarmClockIcon aria-hidden="true" className="size-3.5" />
          Пробуждение по расписанию
        </p>
      ) : null}
      <div className="flex items-center gap-2" data-search-skip>
        <Badge variant="brand">Пользователь</Badge>
        {block.atMs !== null ? (
          <time className="text-xs tabular-nums text-ddc-text-muted">{formatClockRu(block.atMs)}</time>
        ) : null}
        {block.status === "pending" ? (
          <span className="text-xs text-ddc-text-muted">Отправляется…</span>
        ) : null}
        {block.status === "cancelled" ? (
          <span className="text-xs text-ddc-text-muted">Отменено</span>
        ) : null}
      </div>
      <div
        className={cn(SESSION_CARD_CLASS, selected && SESSION_CARD_SELECTED_CLASS)}
        data-selected={selected ? "true" : "false"}
        data-session-card
        onClick={() => {
          if (!isSelectingText()) onSelect();
        }}
      >
        <p className="break-words whitespace-pre-wrap" data-session-turn-prompt>
          {block.text}
        </p>
      </div>
    </div>
  );
}

/* ---------- Карточка запроса к модели ---------- */

function RequestCard({
  block,
  selected,
  hovered,
  selectedEventId,
  expandSelected,
  answerEventId,
  rawById,
  onSelectEvent,
}: {
  block: Block<"request">;
  selected: boolean;
  hovered: boolean;
  selectedEventId: string | null;
  expandSelected: boolean;
  answerEventId: string | null;
  rawById: ReadonlyMap<string, WireSessionEvent>;
  onSelectEvent(eventId: string | null): void;
}) {
  const usage = block.request?.usage ?? null;
  const showHead = block.thinking || usage !== null;

  return (
    <div
      className={cn(
        "group",
        SESSION_CARD_CLASS,
        "space-y-1",
        selected && SESSION_CARD_SELECTED_CLASS,
      )}
      data-block-id={block.id}
      data-block-kind="request"
      data-hovered={hovered ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-session-card
      onClick={() => {
        if (!isSelectingText()) onSelectEvent(block.id);
      }}
    >
      {showHead ? (
        <div className="flex min-w-0 items-center justify-between gap-2 text-xs leading-5" data-search-skip>
          {block.thinking ? (
            <PlainButton
              className="rounded text-left text-ddc-text-muted hover:text-ddc-text"
              data-session-thought
              onClick={(event) => {
                event.stopPropagation();
                onSelectEvent(block.id);
              }}
            >
              {block.thoughtMs !== null ? `Думал ${formatShortDurationRu(block.thoughtMs)}` : "Думал"}
            </PlainButton>
          ) : (
            <span />
          )}
          {usage ? (
            <span
              className={cn(
                "flex flex-none items-center gap-2 tabular-nums text-ddc-text-muted opacity-0 transition-opacity group-hover:opacity-100 group-data-[selected=true]:opacity-100",
              )}
              data-session-usage
            >
              <span>↑ {formatTokensRu(totalInput(usage))}</span>
              <span>↓ {formatTokensRu(usage.output)}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {block.items.map((item, index) => (
        <RequestItemView
          answerEventId={answerEventId}
          expandSelected={expandSelected}
          item={item}
          key={itemKey(item, index)}
          onSelectEvent={onSelectEvent}
          rawById={rawById}
          selectedEventId={selectedEventId}
        />
      ))}
    </div>
  );
}

function itemKey(item: RequestItem, index: number): string {
  if (item.kind === "tool") return item.call.useEventId || `tool:${index}`;
  return item.eventId || `${item.kind}:${index}`;
}

function RequestItemView({
  item,
  selectedEventId,
  expandSelected,
  answerEventId,
  rawById,
  onSelectEvent,
}: {
  item: RequestItem;
  selectedEventId: string | null;
  expandSelected: boolean;
  answerEventId: string | null;
  rawById: ReadonlyMap<string, WireSessionEvent>;
  onSelectEvent(eventId: string | null): void;
}) {
  if (item.kind === "text") {
    if (!item.text.trim()) return null;
    return (
      <ClampedContent>
        <div
          className="min-w-0 text-sm leading-6"
          data-session-agent-text
          data-session-turn-answer={item.eventId && item.eventId === answerEventId ? "true" : undefined}
        >
          <Markdown>{item.text}</Markdown>
        </div>
      </ClampedContent>
    );
  }

  if (item.kind === "thread_message") {
    const sent = item.direction === "sent";
    const who = item.agentName ? ` «${item.agentName}»` : "";
    return (
      <div className="min-w-0 space-y-0.5" data-thread-message={item.direction}>
        <p className="flex items-center gap-1.5 text-xs text-ddc-text-muted" data-search-skip>
          <MessagesSquareIcon aria-hidden="true" className="size-3.5" />
          {sent ? `Отправлено агенту${who}` : `Получено от агента${who}`}
        </p>
        {item.text.trim() ? (
          <ClampedContent>
            <div className="min-w-0 text-sm leading-6" data-session-agent-text>
              <Markdown>{item.text}</Markdown>
            </div>
          </ClampedContent>
        ) : null}
      </div>
    );
  }

  const { call } = item;
  const selected = callMatches(call, selectedEventId);
  const awaiting =
    call.status === "running" && rawById.get(call.useEventId)?.evaluated_permission === "ask";
  return (
    <ToolRow
      awaiting={awaiting}
      call={call}
      onToggle={() => onSelectEvent(selected && expandSelected ? null : call.useEventId)}
      open={selected && expandSelected}
      selected={selected}
    />
  );
}

/* ---------- Строка вызова инструмента ---------- */

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: TerminalIcon,
  read: FileTextIcon,
  write: FilePenIcon,
  edit: PencilIcon,
  glob: FolderSearchIcon,
  grep: SearchCodeIcon,
  web_fetch: GlobeIcon,
  web_search: GlobeIcon,
};

function toolIcon(call: ToolCall): LucideIcon {
  const known = TOOL_ICONS[call.name];
  if (known && call.kind === "builtin") return known;
  return call.kind === "mcp" ? PlugIcon : WrenchIcon;
}

function ToolRow({
  call,
  selected,
  open,
  awaiting,
  onToggle,
}: {
  call: ToolCall;
  selected: boolean;
  open: boolean;
  awaiting: boolean;
  onToggle(): void;
}) {
  const Icon = toolIcon(call);
  const preview = toolInputPreview(call.name, call.input);
  const finished = call.status === "completed" || call.status === "failed";

  return (
    <div
      className={cn("rounded-lg", selected && cn(SESSION_CARD_SELECTED_CLASS, "bg-ddc-surface-muted"))}
      data-event-id={call.useEventId}
      data-open={open ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      data-tool-call
    >
      <PlainButton
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1.5 py-0.5 text-left text-xs leading-5 transition-colors hover:bg-ddc-surface-muted"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        title={call.mcpServerName ? `${call.mcpServerName}: ${call.name}` : undefined}
      >
        <Icon aria-hidden="true" className="size-3.5 flex-none text-ddc-icon-muted" />
        <span className="flex-none font-mono font-semibold text-ddc-text">{call.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-ddc-text-muted" title={preview}>
          {preview}
        </span>
        <ToolStatus awaiting={awaiting} call={call} />
        {finished && call.durationMs !== null ? (
          <span className="flex-none tabular-nums text-ddc-text-muted" data-search-skip>
            {formatShortDurationRu(call.durationMs)}
          </span>
        ) : null}
      </PlainButton>
      {open ? <ToolDetails call={call} /> : null}
    </div>
  );
}

function ToolStatus({ call, awaiting }: { call: ToolCall; awaiting: boolean }) {
  switch (call.status) {
    case "failed":
      return (
        <Badge className="flex-none" data-search-skip variant="destructive">
          <CircleXIcon aria-hidden="true" />
          Ошибка
        </Badge>
      );
    case "denied":
      return (
        <Badge className="flex-none" data-search-skip variant="warning">
          <BanIcon aria-hidden="true" />
          Отклонено
        </Badge>
      );
    case "interrupted":
      return (
        <Badge className="flex-none" data-search-skip variant="neutral">
          Прервано
        </Badge>
      );
    case "running":
      return awaiting ? (
        <Badge className="flex-none" data-search-skip variant="warning">
          Ждёт вас
        </Badge>
      ) : (
        <span className="flex-none text-ddc-text-muted" data-search-skip>
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
          <span className="sr-only">Выполняется</span>
        </span>
      );
    default:
      return null;
  }
}

/* ---------- Раскрытый вызов ---------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

function languageForPath(path: string): string | null {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? (LANGUAGE_BY_EXTENSION[match[1]!.toLowerCase()] ?? null) : null;
}

/** Ограждение длиннее любой цепочки обратных кавычек внутри текста. */
function fenced(code: string, language: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <InlineTextButton
      aria-label="Копировать"
      className={cn("px-1", className)}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        } catch {
          // Буфер обмена недоступен (запрет браузера): кнопка просто ничего не делает.
        }
      }}
      title="Копировать"
    >
      {copied ? (
        <CheckIcon aria-hidden="true" className="size-3.5" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3.5" />
      )}
    </InlineTextButton>
  );
}

type BoxTone = "plain" | "danger" | "old" | "new";

const BOX_TONE: Record<BoxTone, string> = {
  plain: "bg-ddc-surface-sunken text-ddc-text [--session-card-bg:var(--ddc-surface-sunken)]",
  danger:
    "bg-ddc-tone-danger-bg text-ddc-tone-danger-fg [--session-card-bg:var(--ddc-tone-danger-bg)]",
  old: "bg-ddc-tone-danger-bg text-ddc-tone-danger-fg [--session-card-bg:var(--ddc-tone-danger-bg)]",
  new: "bg-ddc-tone-success-bg text-ddc-tone-success-fg [--session-card-bg:var(--ddc-tone-success-bg)]",
};

/** Моноширинный блок ввода или вывода: копирование справа вверху, длинный
 *  текст свёрнут с «Читать дальше». Метки data-* ставит вызывающий. */
function TextBox({
  text,
  tone = "plain",
  prefix,
  label,
  ...attributes
}: {
  text: string;
  tone?: BoxTone;
  prefix?: string;
  label?: string;
  [attribute: `data-${string}`]: string | boolean | undefined;
}) {
  return (
    <div>
      {label ? (
        <p className="mb-0.5 text-xs text-ddc-text-muted" data-search-skip>
          {label}
        </p>
      ) : null}
      <div className={cn("relative rounded-lg", BOX_TONE[tone])} {...attributes}>
        <CopyButton className="absolute top-1 right-1 z-10" text={text} />
        <ClampedContent>
          <pre className="m-0 px-3 py-2 pr-9 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
            {prefix ? <span className="select-none">{prefix}</span> : null}
            {text}
          </pre>
        </ClampedContent>
      </div>
    </div>
  );
}

function PathChip({ path }: { path: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-ddc-surface-sunken px-2 py-0.5 font-mono text-xs text-ddc-text"
        data-tool-path
      >
        <FileIcon aria-hidden="true" className="size-3.5 flex-none text-ddc-icon-muted" />
        <span className="truncate" title={path}>
          {path}
        </span>
      </span>
      <CopyButton text={path} />
    </div>
  );
}

function ToolDetails({ call }: { call: ToolCall }) {
  const input = asRecord(call.input);
  const output =
    call.output === undefined || call.output === null ? "" : formatToolOutput(call.output);
  const path = asText(input.file_path) || asText(input.path);

  let inputPart: ReactNode = null;
  if (call.name === "bash" && asText(input.command)) {
    inputPart = <TextBox data-tool-command prefix="$ " text={asText(input.command)} />;
  } else if (call.name === "write") {
    const content = asText(input.content);
    const language = languageForPath(path);
    inputPart = (
      <>
        {path ? <PathChip path={path} /> : null}
        {content && language ? (
          <div className="relative [--session-card-bg:var(--ddc-surface-muted)]" data-tool-code>
            <CopyButton className="absolute top-3 right-2 z-10" text={content} />
            <ClampedContent>
              <Markdown>{fenced(content, language)}</Markdown>
            </ClampedContent>
          </div>
        ) : content ? (
          <TextBox data-tool-code text={content} />
        ) : null}
      </>
    );
  } else if (call.name === "edit") {
    inputPart = (
      <>
        {path ? <PathChip path={path} /> : null}
        {asText(input.old_string) ? (
          <TextBox data-tool-old label="Было" text={asText(input.old_string)} tone="old" />
        ) : null}
        {asText(input.new_string) ? (
          <TextBox data-tool-new label="Стало" text={asText(input.new_string)} tone="new" />
        ) : null}
      </>
    );
  } else if (call.input !== undefined && Object.keys(input).length > 0) {
    const keys = Object.keys(input);
    const single = keys.length === 1 ? input[keys[0]!] : undefined;
    const command = typeof single === "string" ? single : JSON.stringify(call.input, null, 2);
    inputPart = <TextBox data-tool-command text={command} />;
  }

  let outputPart: ReactNode = null;
  if (call.status === "failed" || call.isError) {
    outputPart = <TextBox data-tool-output text={output || "Вызов завершился ошибкой."} tone="danger" />;
  } else if (output) {
    outputPart = <TextBox data-tool-output text={output} />;
  } else if (call.status === "denied") {
    outputPart = <p className="text-xs text-ddc-text-muted">Вы отклонили этот вызов, он не выполнялся.</p>;
  } else if (call.status === "interrupted") {
    outputPart = <p className="text-xs text-ddc-text-muted">Вызов прерван до результата.</p>;
  } else if (call.status === "running") {
    outputPart = <p className="text-xs text-ddc-text-muted">Результата пока нет.</p>;
  } else {
    outputPart = <p className="text-xs text-ddc-text-muted">Вывод пустой.</p>;
  }

  return (
    <div className="mt-1 space-y-1.5 px-1.5 pb-1.5" data-tool-details>
      {inputPart}
      {outputPart}
    </div>
  );
}

/** Подсказки к известным причинам: по тексту ошибки сервера. */
const ERROR_HINTS: ReadonlyArray<{ matches: RegExp; hint: () => ReactNode }> = [
  {
    matches: /No model card matched/i,
    hint: () => (
      <>
        Для модели агента не нашлась карточка, а ключ ANTHROPIC_API_KEY на сервере не задан.
        Создайте карточку в разделе «<ConsoleLink label="Карточки моделей" to="/model-cards" />» и
        отправьте сообщение ещё раз.
      </>
    ),
  },
  {
    // Песочница LiteBox ставит пакеты окружения при старте VM (litebox.ts, initializeBox).
    matches: /environment packages failed to install/i,
    hint: () => (
      <>
        Не установились пакеты окружения, песочница не запустилась. Проверьте имена и версии
        пакетов в разделе «<ConsoleLink label="Окружения" to="/environments" />». При сети
        «Ограниченный» включите «Разрешить сетевой доступ менеджерам пакетов».
      </>
    ),
  },
];

function ConsoleLink({ label, to }: { label: string; to: string }) {
  // Вне маршрутизатора (отдельный рендер хода) остаётся обычная ссылка.
  return useInRouterContext() ? (
    <Link className="link" to={to}>{label}</Link>
  ) : (
    <a className="link" href={to}>{label}</a>
  );
}

function SessionTurnError({
  block,
  selected,
  onSelect,
}: {
  block: Block<"error">;
  selected: boolean;
  onSelect(): void;
}) {
  const reason = block.message.trim() || TURN_FAILED_FALLBACK;
  const hint = ERROR_HINTS.find((entry) => entry.matches.test(reason));
  return (
    <div
      className={cn("callout-danger flex-col items-stretch gap-1.5", selected && SESSION_CARD_SELECTED_CLASS)}
      data-block-id={block.id}
      data-block-kind="error"
      data-selected={selected ? "true" : "false"}
      data-session-turn-status-message="error"
      onClick={() => {
        if (!isSelectingText()) onSelect();
      }}
      role="alert"
    >
      <p className="font-medium">Ошибка сессии</p>
      <p className="prose-wrap whitespace-pre-line">{reason}</p>
      {hint ? <p className="prose-wrap">{hint.hint()}</p> : null}
      {block.retrying ? <p className="text-xs">Повторная попытка…</p> : null}
    </div>
  );
}

function SessionTurnWarning({
  block,
  selected,
  onSelect,
}: {
  block: Block<"warning">;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <div
      className={cn("callout-warning flex-col items-stretch gap-1", selected && SESSION_CARD_SELECTED_CLASS)}
      data-block-id={block.id}
      data-block-kind="warning"
      data-selected={selected ? "true" : "false"}
      onClick={() => {
        if (!isSelectingText()) onSelect();
      }}
      role="status"
    >
      <p className="font-medium">Предупреждение{block.source ? ` (${block.source})` : ""}</p>
      <p className="prose-wrap whitespace-pre-line">{block.message}</p>
    </div>
  );
}

function canonicalTurnStatus(status: CanonicalChatTurn["status"]) {
  switch (status) {
    case "completed": return "complete" as const;
    case "errored": return "error" as const;
    case "terminated": return "cancelled" as const;
    default: return "running" as const;
  }
}
