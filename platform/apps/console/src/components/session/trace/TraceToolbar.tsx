import type { KeyboardEvent, Ref } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Maximize2Icon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PlainButton } from "@/components/ui/plain-button";
import { cn } from "@/lib/utils";
import { NO_FILTER, TRACE_KIND_GROUPS, isFilterActive, type TraceFilter, type TraceKindGroup } from "../../../lib/trace-tree";
import { GROUP_LABEL } from "./trace-text";

export interface TraceToolbarProps {
  query: string;
  onQueryChange(query: string): void;
  matchCount: number;
  /** 0..matchCount-1; -1, пока пользователь не перешёл к совпадению. */
  currentMatch: number;
  onNextMatch(): void;
  onPrevMatch(): void;
  /** Серверный поиск по ходам, которых нет в консоли. */
  searchProgress: { remainingTurns: number; totalTurns: number } | null;
  filter: TraceFilter;
  onFilterChange(filter: TraceFilter): void;
  onCollapseAll(): void;
  onExpandAll(): void;
  zoomIndex: number;
  zoomSteps: number;
  onZoomOut(): void;
  onZoomIn(): void;
  /** Включено окно времени (выделение мышью или «Весь ход»). */
  hasWindow: boolean;
  /** Есть выбранный узел, ход которого можно показать целиком. */
  canFitTurn: boolean;
  onFitTurn(): void;
  onResetWindow(): void;
  /** Пока идёт ход, можно следить за последней строкой. */
  showFollow: boolean;
  follow: boolean;
  onFollowChange(follow: boolean): void;
  /** Телефон: водопада нет, масштаб и окно времени не нужны. */
  compact?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * Панель над водопадом: поиск по трейсу, фильтр по виду узлов, свёртка,
 * масштаб и слежение. Поле 32 px, как в поиске по разговору.
 */
export function TraceToolbar({
  query,
  onQueryChange,
  matchCount,
  currentMatch,
  onNextMatch,
  onPrevMatch,
  searchProgress,
  filter,
  onFilterChange,
  onCollapseAll,
  onExpandAll,
  zoomIndex,
  zoomSteps,
  onZoomOut,
  onZoomIn,
  hasWindow,
  canFitTurn,
  onFitTurn,
  onResetWindow,
  showFollow,
  follow,
  onFollowChange,
  compact = false,
  inputRef,
}: TraceToolbarProps) {
  const searching = query.length > 0;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) onPrevMatch();
      else onNextMatch();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (searching) onQueryChange("");
      else event.currentTarget.blur();
    }
  };

  const toggleGroup = (group: TraceKindGroup) => {
    const groups = new Set(filter.groups);
    if (groups.has(group)) groups.delete(group);
    else groups.add(group);
    onFilterChange({ groups, errorsOnly: filter.errorsOnly });
  };

  const progressText =
    searching && searchProgress && searchProgress.remainingTurns > 0
      ? `ищу: ${Math.max(0, searchProgress.totalTurns - searchProgress.remainingTurns)} из ${searchProgress.totalTurns} ходов`
      : null;

  return (
    <div className="flex flex-col gap-2" data-trace-toolbar role="search">
      <div className="flex flex-wrap items-center gap-2">
        <div className={cn("relative w-full min-w-0 sm:w-[200px]", searching && "sm:w-72")}>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ddc-icon-muted"
          />
          <Input
            aria-label="Найти в трейсе"
            autoComplete="off"
            className={cn("h-8 rounded-lg py-[7px] pr-2.5 pl-8 text-xs leading-4", searching && "pr-[7.5rem]")}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            placeholder="Найти в трейсе"
            ref={inputRef}
            type="search"
            value={query}
          />
          {searching ? (
            <div className="absolute inset-y-0 right-0.5 flex items-center">
              <span aria-live="polite" className="px-1.5 text-xs tabular-nums text-ddc-text-muted" data-testid="match-counter">
                {matchCount === 0 ? "0/0" : `${currentMatch + 1}/${matchCount}`}
              </span>
              <Button
                aria-label="Назад"
                className="size-6 rounded-md"
                disabled={matchCount === 0}
                onClick={onPrevMatch}
                size="icon-xs"
                title="Назад"
                variant="ghost"
              >
                <ChevronUpIcon aria-hidden="true" className="size-3.5" />
              </Button>
              <Button
                aria-label="Далее"
                className="size-6 rounded-md"
                disabled={matchCount === 0}
                onClick={onNextMatch}
                size="icon-xs"
                title="Далее"
                variant="ghost"
              >
                <ChevronDownIcon aria-hidden="true" className="size-3.5" />
              </Button>
              <Button
                aria-label="Очистить поиск"
                className="size-6 rounded-md"
                onClick={() => onQueryChange("")}
                size="icon-xs"
                title="Очистить поиск"
                variant="ghost"
              >
                <XIcon aria-hidden="true" className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </div>
        {progressText ? (
          <span aria-live="polite" className="text-xs text-ddc-text-muted" data-testid="search-progress">
            {progressText}
          </span>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button onClick={onCollapseAll} size="xs" title="Свернуть всё ([)" variant="ghost">
            <ChevronsDownUpIcon aria-hidden="true" />
            Свернуть всё
          </Button>
          <Button onClick={onExpandAll} size="xs" title="Развернуть всё (])" variant="ghost">
            <ChevronsUpDownIcon aria-hidden="true" />
            Развернуть всё
          </Button>
          {compact ? null : (
            <>
              <Button aria-label="Мельче" disabled={zoomIndex <= 0} onClick={onZoomOut} size="icon-xs" title="Мельче" variant="ghost">
                <ZoomOutIcon aria-hidden="true" />
              </Button>
              <Button
                aria-label="Крупнее"
                disabled={zoomIndex >= zoomSteps - 1}
                onClick={onZoomIn}
                size="icon-xs"
                title="Крупнее"
                variant="ghost"
              >
                <ZoomInIcon aria-hidden="true" />
              </Button>
              <Button disabled={!canFitTurn} onClick={onFitTurn} size="xs" title="Показать ход выбранного узла целиком" variant="ghost">
                <Maximize2Icon aria-hidden="true" />
                Весь ход
              </Button>
              {hasWindow ? (
                <Button onClick={onResetWindow} size="xs" variant="ghost">
                  <RotateCcwIcon aria-hidden="true" />
                  Весь трейс
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Фильтр">
        {TRACE_KIND_GROUPS.map((group) => (
          <PlainButton
            aria-pressed={filter.groups.has(group)}
            className="chip-toggle"
            key={group}
            onClick={() => toggleGroup(group)}
          >
            {GROUP_LABEL[group]}
          </PlainButton>
        ))}
        <PlainButton
          aria-pressed={filter.errorsOnly}
          className="chip-toggle"
          onClick={() => onFilterChange({ groups: filter.groups, errorsOnly: !filter.errorsOnly })}
        >
          Только ошибки
        </PlainButton>
        {isFilterActive(filter) ? (
          <Button onClick={() => onFilterChange(NO_FILTER)} size="xs" variant="ghost">
            <XIcon aria-hidden="true" />
            Сбросить фильтр
          </Button>
        ) : null}
        {showFollow ? (
          <PlainButton
            aria-pressed={follow}
            className="chip-toggle ml-auto"
            onClick={() => onFollowChange(!follow)}
            title="Держать в виду последнюю строку, пока вы не прокрутите список сами"
          >
            Следить за ходом
          </PlainButton>
        ) : null}
      </div>
    </div>
  );
}
