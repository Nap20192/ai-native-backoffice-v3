import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAssistantShortcut } from "./use-assistant-shortcut";

function Probe({ onToggle }: { onToggle: () => void }) {
  useAssistantShortcut(onToggle);
  return (
    <div>
      <input aria-label="поле" />
      <div role="dialog" data-state="open" />
    </div>
  );
}

describe("useAssistantShortcut", () => {
  it("Ctrl I переключает панель и гасит действие браузера", () => {
    const onToggle = vi.fn();
    render(<Probe onToggle={onToggle} />);
    const notCancelled = fireEvent.keyDown(window, { key: "i", ctrlKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false);
  });

  it("работает и из поля ввода: панель закрывается тем же сочетанием", () => {
    const onToggle = vi.fn();
    const { getByLabelText } = render(<Probe onToggle={onToggle} />);
    fireEvent.keyDown(getByLabelText("поле"), { key: "i", ctrlKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("русская раскладка: Ctrl Ш тоже открывает панель", () => {
    const onToggle = vi.fn();
    render(<Probe onToggle={onToggle} />);
    fireEvent.keyDown(window, { key: "ш", code: "KeyI", ctrlKey: true });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("не реагирует на I без Ctrl, на Ctrl+Shift+I и Ctrl+Alt+I", () => {
    const onToggle = vi.fn();
    render(<Probe onToggle={onToggle} />);
    fireEvent.keyDown(window, { key: "i" });
    fireEvent.keyDown(window, { key: "I", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(window, { key: "i", ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("не срабатывает на автоповтор удержанной клавиши", () => {
    const onToggle = vi.fn();
    render(<Probe onToggle={onToggle} />);
    fireEvent.keyDown(window, { key: "i", ctrlKey: true, repeat: true });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("после размонтирования подписки нет", () => {
    const onToggle = vi.fn();
    const { unmount } = render(<Probe onToggle={onToggle} />);
    unmount();
    fireEvent.keyDown(window, { key: "i", ctrlKey: true });
    expect(onToggle).not.toHaveBeenCalled();
  });
});
