import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { PlainButton } from "@/components/ui/plain-button";

/**
 * Переключатель над колонкой разговора: «Разговор» и «Трейс». Вид живёт в
 * адресе страницы (`?view=trace`), а содержимое выбранного вида стоит в
 * панели ниже. Слева в строке вкладки, справа слот страницы: там встаёт
 * кнопка «Инспектор», пока инспектор закрыт, а у вида «Трейс» нет своей
 * строки поиска со слотом.
 */

export type SessionView = "conversation" | "trace";

export const SESSION_VIEWS: readonly SessionView[] = ["conversation", "trace"];

const VIEW_LABEL: Record<SessionView, string> = {
  conversation: "Разговор",
  trace: "Трейс",
};

/** Значение `view` из адреса. Неизвестное и пустое значение открывает разговор. */
export function parseSessionView(value: string | null): SessionView {
  return value === "trace" ? "trace" : "conversation";
}

export interface SessionViewTabsProps {
  view: SessionView;
  onViewChange(view: SessionView): void;
  /** Справа в строке вкладок, вне списка вкладок. */
  trailing?: ReactNode;
  /** Содержимое выбранного вида. */
  children: ReactNode;
}

export function SessionViewTabs({ view, onViewChange, trailing, children }: SessionViewTabsProps) {
  const baseId = useId();
  const tabId = (value: SessionView) => `${baseId}-tab-${value}`;
  const panelId = `${baseId}-panel`;
  const tabRefs = useRef(new Map<SessionView, HTMLButtonElement>());

  const select = (value: SessionView) => {
    if (value !== view) onViewChange(value);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = SESSION_VIEWS.indexOf(view);
    let next: SessionView | undefined;
    if (event.key === "ArrowRight") next = SESSION_VIEWS[(index + 1) % SESSION_VIEWS.length];
    else if (event.key === "ArrowLeft") {
      next = SESSION_VIEWS[(index - 1 + SESSION_VIEWS.length) % SESSION_VIEWS.length];
    } else if (event.key === "Home") next = SESSION_VIEWS[0];
    else if (event.key === "End") next = SESSION_VIEWS[SESSION_VIEWS.length - 1];
    if (!next) return;
    event.preventDefault();
    onViewChange(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-3 pt-1" data-session-views>
        <div role="tablist" aria-label="Вид сессии" className="tabs">
          {SESSION_VIEWS.map((value) => (
            <PlainButton
              key={value}
              ref={(node) => {
                if (node) tabRefs.current.set(value, node);
                else tabRefs.current.delete(value);
              }}
              role="tab"
              id={tabId(value)}
              aria-selected={value === view}
              aria-controls={panelId}
              tabIndex={value === view ? 0 : -1}
              onClick={() => select(value)}
              onKeyDown={onTabKeyDown}
              className="tab"
            >
              {VIEW_LABEL[value]}
            </PlainButton>
          ))}
        </div>
        {trailing ? <div className="ml-auto flex items-center gap-1 pr-1">{trailing}</div> : null}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(view)}
        className="flex min-h-0 flex-1 flex-col"
      >
        {children}
      </div>
    </>
  );
}
