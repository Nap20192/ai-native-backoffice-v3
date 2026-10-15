import type { KeyboardEvent, ReactNode, Ref } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SearchIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Масштаб шкалы мини-карты: во сколько раз дорожка шире колонки. */
export type MinimapZoom = 1 | 2 | 4 | 8;
export const MINIMAP_ZOOM_STEPS: readonly MinimapZoom[] = [1, 2, 4, 8];

export interface TranscriptToolbarProps {
  query: string;
  onQueryChange(query: string): void;
  matchCount: number;
  /** 0..matchCount-1; -1, если совпадений нет. */
  currentMatch: number;
  onNextMatch(): void;
  onPrevMatch(): void;
  zoom: MinimapZoom;
  onZoomChange(zoom: MinimapZoom): void;
  inputRef?: Ref<HTMLInputElement>;
  /** Справа от лупы: кнопка «Инспектор» от страницы. */
  trailing?: ReactNode;
}

/**
 * Строка под шапкой сессии: поиск по разговору и масштаб мини-карты.
 * Поле 32 px (в образце 28 px, но цель нажатия по DDC не меньше 32 px).
 * На телефоне поле занимает всю ширину, лупы и «Инспектор» уходят в строку
 * ниже и прижимаются вправо.
 */
export function TranscriptToolbar({
  query,
  onQueryChange,
  matchCount,
  currentMatch,
  onNextMatch,
  onPrevMatch,
  zoom,
  onZoomChange,
  inputRef,
  trailing,
}: TranscriptToolbarProps) {
  const searching = query.length > 0;
  const zoomIndex = MINIMAP_ZOOM_STEPS.indexOf(zoom);
  const zoomOut = MINIMAP_ZOOM_STEPS[zoomIndex - 1];
  const zoomIn = MINIMAP_ZOOM_STEPS[zoomIndex + 1];

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

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-session-transcript-toolbar
      role="search"
    >
      <div className={cn("relative w-full min-w-0 sm:w-[172px]", searching && "sm:w-64")}>
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ddc-icon-muted"
        />
        {/* 32 px как у DDC input-xs: h-8 перебивает 40 px базового поля. */}
        <Input
          aria-label="Найти в разговоре"
          autoComplete="off"
          className={cn("h-8 rounded-lg py-[7px] pr-2.5 pl-8 text-xs leading-4", searching && "pr-[7.5rem]")}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          placeholder="Найти в разговоре"
          ref={inputRef}
          type="search"
          value={query}
        />
        {searching ? (
          <div className="absolute inset-y-0 right-0.5 flex items-center">
            <span
              aria-live="polite"
              className="px-1.5 text-xs tabular-nums text-ddc-text-muted"
              data-testid="match-counter"
            >
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
      <div className="ml-auto flex items-center gap-1">
        <Button
          aria-label="Мельче"
          disabled={!zoomOut}
          onClick={() => zoomOut && onZoomChange(zoomOut)}
          size="icon-xs"
          title="Мельче"
          variant="ghost"
        >
          <ZoomOutIcon aria-hidden="true" />
        </Button>
        <Button
          aria-label="Крупнее"
          disabled={!zoomIn}
          onClick={() => zoomIn && onZoomChange(zoomIn)}
          size="icon-xs"
          title="Крупнее"
          variant="ghost"
        >
          <ZoomInIcon aria-hidden="true" />
        </Button>
        {trailing}
      </div>
    </div>
  );
}
