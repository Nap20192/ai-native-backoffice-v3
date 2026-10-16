import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { XIcon } from "lucide-react";

import { PlainButton } from "@/components/ui/plain-button";
import { cn } from "@/lib/utils";

/**
 * Инспектор страницы сессии: полоса вкладок, ручка ширины и панель
 * содержимого. Что лежит на вкладке, решает страница: неактивные вкладки
 * она не монтирует (контракт docs/plans/session-page.md, раздел 6.5).
 *
 * На десктопе инспектор стоит справа и меняет ширину перетаскиванием левой
 * кромки, от 360 до 720 px. На узком экране он нижний лист от 40 % высоты
 * экрана до низа.
 */

export type InspectorTab = "session" | "events" | "tools" | "resources" | "thread";

export const INSPECTOR_TABS: readonly InspectorTab[] = [
  "session",
  "events",
  "tools",
  "resources",
  "thread",
];

const TAB_LABEL: Record<InspectorTab, string> = {
  session: "Сессия",
  events: "События",
  tools: "Инструменты",
  resources: "Ресурсы",
  thread: "Потоки",
};

/** Неизвестное или пустое значение из адреса даёт «Сессия». */
export function parseInspectorTab(value: string | null): InspectorTab {
  return INSPECTOR_TABS.find((tab) => tab === value) ?? "session";
}

export const INSPECTOR_MIN_WIDTH = 360;
export const INSPECTOR_DEFAULT_WIDTH = 480;
export const INSPECTOR_MAX_WIDTH = 720;
/** Шаг ширины с клавиатуры. */
const KEYBOARD_STEP = 16;

export function clampInspectorWidth(width: number): number {
  if (Number.isNaN(width)) return INSPECTOR_DEFAULT_WIDTH;
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, width));
}

// ── Настройки в localStorage ─────────────────────────────────────────────

export const INSPECTOR_STORAGE_KEY = "oma.session.inspector";

export interface InspectorPrefs {
  /** Нет значения: решает размер экрана (открыт на десктопе, закрыт на телефоне). */
  open?: boolean;
  width: number;
}

/** Запись из хранилища или null, если её нет, она битая или хранилище закрыто. */
export function readInspectorPrefs(): InspectorPrefs | null {
  try {
    const raw = localStorage.getItem(INSPECTOR_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { open, width } = parsed as { open?: unknown; width?: unknown };
    return {
      ...(typeof open === "boolean" ? { open } : {}),
      width: typeof width === "number" ? clampInspectorWidth(width) : INSPECTOR_DEFAULT_WIDTH,
    };
  } catch {
    return null;
  }
}

export function writeInspectorPrefs(prefs: InspectorPrefs): void {
  try {
    localStorage.setItem(INSPECTOR_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Хранилище закрыто (приватное окно, запрет сайта): настройки живут до перезагрузки.
  }
}

// ── Компонент ────────────────────────────────────────────────────────────

export interface SessionInspectorProps {
  layout: "side" | "sheet";
  tab: InspectorTab;
  onTabChange(tab: InspectorTab): void;
  onClose(): void;
  width: number;
  onWidthChange(width: number): void;
  threadsMuted: boolean;
  /** Содержимое активной вкладки; неактивные вкладки не монтируются. */
  children: ReactNode;
}

export function SessionInspector({
  layout,
  tab,
  onTabChange,
  onClose,
  width,
  onWidthChange,
  threadsMuted,
  children,
}: SessionInspectorProps) {
  const baseId = useId();
  const tabId = (value: InspectorTab) => `${baseId}-tab-${value}`;
  const panelId = `${baseId}-panel`;
  const tabRefs = useRef(new Map<InspectorTab, HTMLButtonElement>());
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Ручка на левой кромке: движение влево расширяет панель.
      onWidthChangeRef.current(clampInspectorWidth(drag.startWidth + drag.startX - event.clientX));
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { startX: event.clientX, startWidth: widthRef.current };
    event.preventDefault();
  }, []);

  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidthChange(clampInspectorWidth(width + KEYBOARD_STEP));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidthChange(clampInspectorWidth(width - KEYBOARD_STEP));
    }
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const index = INSPECTOR_TABS.indexOf(tab);
    let next: InspectorTab | null = null;
    if (event.key === "ArrowRight") next = INSPECTOR_TABS[(index + 1) % INSPECTOR_TABS.length];
    else if (event.key === "ArrowLeft") {
      next = INSPECTOR_TABS[(index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length];
    } else if (event.key === "Home") next = INSPECTOR_TABS[0];
    else if (event.key === "End") next = INSPECTOR_TABS[INSPECTOR_TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    onTabChange(next);
    tabRefs.current.get(next)?.focus();
  };

  const isSheet = layout === "sheet";

  return (
    <aside
      aria-label="Инспектор сессии"
      data-layout={layout}
      style={isSheet ? undefined : { width }}
      className={cn(
        "relative flex min-h-0 flex-col bg-ddc-surface",
        isSheet
          ? "h-full border-t border-ddc-divider shadow-card"
          : "h-full shrink-0 border-l border-ddc-divider",
      )}
    >
      {!isSheet && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину инспектора"
          aria-valuemin={INSPECTOR_MIN_WIDTH}
          aria-valuemax={INSPECTOR_MAX_WIDTH}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={onHandleKeyDown}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-ddc-selected-bg focus-visible:bg-ddc-selected-bg"
        />
      )}
      <div
        role="tablist"
        aria-label="Вкладки инспектора"
        className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-ddc-divider px-2"
      >
        {INSPECTOR_TABS.map((value) => {
          const selected = value === tab;
          const muted = value === "thread" && threadsMuted;
          return (
            <PlainButton
              key={value}
              ref={(node) => {
                if (node) tabRefs.current.set(value, node);
                else tabRefs.current.delete(value);
              }}
              type="button"
              role="tab"
              id={tabId(value)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(value)}
              onKeyDown={onTabKeyDown}
              className={cn(
                "inline-flex h-6 flex-none items-center rounded-lg px-2 text-xs leading-4 font-medium whitespace-nowrap hover:bg-ddc-surface-muted",
                selected
                  ? "bg-ddc-selected-bg text-ddc-selected-text hover:bg-ddc-selected-bg"
                  : muted
                    ? "text-ddc-text-muted"
                    : "text-ddc-label",
              )}
            >
              {TAB_LABEL[value]}
            </PlainButton>
          );
        })}
        <PlainButton
          onClick={onClose}
          aria-label="Закрыть инспектор"
          title="Закрыть инспектор"
          className="ml-auto inline-flex size-6 flex-none items-center justify-center rounded-lg text-ddc-icon-muted hover:bg-ddc-ghost-hover hover:text-ddc-text"
        >
          <XIcon className="size-3.5" aria-hidden="true" />
        </PlainButton>
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(tab)}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {children}
      </div>
    </aside>
  );
}
