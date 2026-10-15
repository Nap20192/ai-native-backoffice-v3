import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Правая панель записи (`role="dialog"`, не модальная): журнал открывает в
 * ней карточку запроса, «Лимиты» открывают квоту. Список остаётся виден и
 * доступен. Панель открывается параметром адреса, Escape закрывает её и
 * возвращает фокус на строку списка. На экране уже 768 px занимает всю ширину
 * с отступом 8 px.
 */
export function RowInspector({
  title,
  subtitle,
  width = "request",
  onClose,
  onPrev,
  onNext,
  prevDisabled = false,
  nextDisabled = false,
  returnFocusSelector,
  children,
}: {
  /** Крошка в верхней полосе: «Запрос», «Лимит». */
  title: string;
  /** ID серым моноширинным или область: «Рабочее пространство». */
  subtitle?: ReactNode;
  width?: "request" | "limit";
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  /** Селектор строки списка, на которую вернётся фокус после закрытия. */
  returnFocusSelector?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const selectorRef = useRef(returnFocusSelector);
  selectorRef.current = returnFocusSelector;

  // Фокус уходит в панель при открытии и возвращается в список при закрытии.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const bySelector = selectorRef.current
        ? document.querySelector<HTMLElement>(selectorRef.current)
        : null;
      const target = bySelector ?? previous;
      if (target && target.isConnected) target.focus({ preventScroll: true });
    };
  }, []);

  // Escape закрывает панель, если его уже не обработал открытый поповер.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label={title}
      tabIndex={-1}
      className={cn(
        "card fixed top-2 right-2 bottom-2 z-40 flex min-w-0 flex-col overflow-hidden rounded-2xl outline-hidden animate-fade-in",
        "max-md:left-2",
        width === "limit" ? "md:w-[680px]" : "md:w-[560px]",
      )}
    >
      <div className="flex flex-none items-center justify-between gap-2 border-b border-ddc-divider px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="font-medium text-ddc-heading">{title}</span>
          {subtitle && (
            <span className="min-w-0 truncate font-mono text-xs text-ddc-text-muted">{subtitle}</span>
          )}
        </div>
        <div className="flex flex-none items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Предыдущая"
            title="Предыдущая"
            disabled={prevDisabled || !onPrev}
            onClick={onPrev}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Следующая"
            title="Следующая"
            disabled={nextDisabled || !onNext}
            onClick={onNext}
          >
            <ChevronDownIcon />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Закрыть" title="Закрыть" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </div>
  );
}
