import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BetaEnvironment } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EllipsisVerticalIcon,
  MessageCircleQuestionIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PlainButton } from "@/components/ui/plain-button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { SessionTotals } from "../../lib/session-stats";
import { AgentChip, EnvironmentChip } from "../../pages/session-detail/Panels";
import { StatusPill } from "../Badge";
import { ClockIcon, DurationIcon } from "../icons";
import { Skeleton } from "../Skeleton";
import {
  EMPTY_VALUE,
  formatEventDateTimeRu,
  formatRelativeRu,
  formatShortDurationRu,
} from "./format-ru";

/**
 * Шапка страницы сессии: ID с копированием, меню действий, название с
 * правкой по месту, статус и чипы состава и времени. Три ряда на десктопе.
 * На узком экране чипы идут двумя строками: агент и окружение, длительность
 * и активность. Токенов, стоимости и бюджета в шапке нет, потому что модели
 * внутренние.
 */

export interface SessionHeaderProps {
  session: BetaManagedAgentsSession | null;
  environment: BetaEnvironment | null;
  status: string;
  totals: SessionTotals;
  lastActivityMs: number | null;
  onRename(title: string): Promise<void>;
  onInterrupt(): void;
  onDefineOutcome(): void;
  onArchive(): void;
  onCopyEvents(): void;
  onDownloadEvents(): void;
  onDownloadTrace(): void;
  onShowShortcuts(): void;
}

/** Текущее время, которое обновляется само: возраст последней активности
 *  на странице не застывает. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function InfoChip({
  name,
  icon,
  tip,
  children,
}: {
  /** Метка data-session-chip: по ней чип находят тесты и проверка скилла. */
  name: "duration" | "activity";
  icon: ReactNode;
  tip: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          data-session-chip={name}
          className="inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs leading-4 text-ddc-text-muted hover:bg-ddc-surface-muted"
        >
          <span className="flex flex-none text-ddc-icon-muted">{icon}</span>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex-col items-start gap-0.5">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

/** Кнопка копирования значения в буфер обмена. Галочка на полторы секунды
 *  показывает, что значение скопировано. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Буфер обмена закрыт: копировать нечем, показывать нечего.
    }
  };
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      onClick={() => void copy()}
      className="size-6 text-ddc-icon-muted hover:text-ddc-text"
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

function SessionTitle({
  session,
  onRename,
}: {
  session: BetaManagedAgentsSession;
  onRename(title: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const title = session.title?.trim() ?? "";

  const start = () => {
    setDraft(title);
    setEditing(true);
  };
  const cancel = () => {
    if (saving) return;
    setEditing(false);
  };
  const save = async () => {
    setSaving(true);
    try {
      await onRename(draft.trim());
      setEditing(false);
    } catch {
      // Обращение к серверу уже показало ошибку: поле остаётся открытым.
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="min-w-0 max-sm:basis-full">
        <Input
          autoFocus
          value={draft}
          disabled={saving}
          aria-label="Название сессии"
          placeholder={session.id}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
          }}
          className="h-9 w-full min-w-64 text-[22px] leading-7 font-medium"
        />
        <div className="mt-1 flex gap-1">
          <Button
            variant="outline"
            size="icon-xs"
            className="size-6"
            aria-label="Сохранить название"
            title="Сохранить название"
            loading={saving}
            onClick={() => void save()}
          >
            <CheckIcon className="size-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon-xs"
            className="size-6"
            aria-label="Отменить"
            title="Отменить"
            disabled={saving}
            onClick={cancel}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <h1 className="m-0 min-w-0 max-w-full text-[22px] leading-7 font-medium text-ddc-heading max-sm:basis-full">
      <PlainButton
        onClick={start}
        title="Изменить название"
        className="-mx-2 block max-w-[calc(100%+1rem)] truncate rounded-lg border border-transparent px-2 py-0.5 text-left hover:border-ddc-border-strong"
      >
        {title || session.id}
      </PlainButton>
    </h1>
  );
}

function HeaderSkeleton() {
  return (
    <div className="shrink-0 space-y-3" role="status" aria-busy="true">
      <span className="sr-only">Загрузка сессии…</span>
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-7 w-80 max-w-full" />
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-6 w-32" />
      </div>
    </div>
  );
}

export function SessionHeader({
  session,
  environment,
  status,
  totals,
  lastActivityMs,
  onRename,
  onInterrupt,
  onDefineOutcome,
  onArchive,
  onCopyEvents,
  onDownloadEvents,
  onDownloadTrace,
  onShowShortcuts,
}: SessionHeaderProps) {
  const now = useNow(30_000);
  if (!session) return <HeaderSkeleton />;

  const createdMs = Date.parse(session.created_at);
  const endMs = lastActivityMs ?? totals.lastEventMs;
  const elapsedMs =
    Number.isFinite(createdMs) && endMs !== null && endMs >= createdMs ? endMs - createdMs : null;
  const running = status === "running" || status === "rescheduling";
  const archived = Boolean(session.archived_at);

  return (
    <TooltipProvider delayDuration={300}>
      <header className="shrink-0 space-y-2">
        <div className="flex items-center gap-1">
          <span
            className="min-w-0 truncate font-mono text-xs text-ddc-text-muted"
            title={session.id}
          >
            {session.id}
          </span>
          <CopyButton value={session.id} label="Копировать ID сессии" />
          <div className="ml-auto flex flex-none items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  Действия
                  <ChevronDownIcon className="size-4" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem disabled={!running} onSelect={onInterrupt}>
                  Прервать
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onDefineOutcome}>Задать результат…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={archived} onSelect={onArchive}>
                  Архивировать
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-disabled="true"
                  aria-label="Спросить помощника"
                  className="opacity-60"
                >
                  <MessageCircleQuestionIcon aria-hidden="true" />
                  <span className="max-sm:hidden">Спросить помощника</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Скоро</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Ещё" title="Ещё">
                  <EllipsisVerticalIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onSelect={onCopyEvents}>Копировать все события</DropdownMenuItem>
                <DropdownMenuItem onSelect={onDownloadEvents}>Скачать все события</DropdownMenuItem>
                <DropdownMenuItem onSelect={onDownloadTrace}>Скачать трейс</DropdownMenuItem>
                <DropdownMenuItem onSelect={onShowShortcuts}>Горячие клавиши</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <SessionTitle key={session.id} session={session} onRename={onRename} />
          <StatusPill status={status} />
          <div
            data-chip-group="resources"
            className="flex min-w-0 flex-wrap items-center gap-2 max-sm:basis-full"
          >
            <AgentChip agent={session.agent} />
            <EnvironmentChip id={session.environment_id} environment={environment} />
          </div>
          <div data-chip-group="time" className="flex flex-wrap items-center gap-1 max-sm:basis-full">
            {elapsedMs !== null && (
              <InfoChip
                name="duration"
                icon={<DurationIcon className="size-3.5" />}
                tip={
                  <>
                    <div>Прошло с создания: {formatShortDurationRu(elapsedMs)}</div>
                    <div>
                      Активное время: {totals.activeMs > 0 ? formatShortDurationRu(totals.activeMs) : EMPTY_VALUE}
                    </div>
                  </>
                }
              >
                <span>{formatShortDurationRu(elapsedMs)}</span>
              </InfoChip>
            )}
            {lastActivityMs !== null && (
              <InfoChip
                name="activity"
                icon={<ClockIcon className="size-3.5" />}
                tip={<div>{formatEventDateTimeRu(lastActivityMs)}</div>}
              >
                <span className="tabular-nums">{formatRelativeRu(now - lastActivityMs)}</span>
              </InfoChip>
            )}
          </div>
        </div>
      </header>
    </TooltipProvider>
  );
}
