import { useEffect, useRef } from "react";

/** Событие для тех, кто стоит вне провайдера (командная палитра): открыть панель. */
export const ASSISTANT_OPEN_EVENT = "openma:assistant-open";

export function requestAssistantOpen(): void {
  window.dispatchEvent(new Event(ASSISTANT_OPEN_EVENT));
}

/**
 * Ctrl I открывает и закрывает панель ассистента на любой странице (раздел 1.2
 * плана). Сочетание работает и из поля ввода: им же панель закрывают. Русская
 * раскладка распознаётся по коду клавиши. Ctrl+Shift+I и Ctrl+Alt+I остаются
 * браузеру.
 */
export function useAssistantShortcut(toggle: () => void): void {
  const ref = useRef(toggle);
  ref.current = toggle;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      if (event.repeat) return;
      const isI = event.code === "KeyI" || event.key.toLowerCase() === "i";
      if (!isI) return;
      event.preventDefault();
      ref.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
