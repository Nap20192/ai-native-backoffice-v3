import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SESSION_VIEWS, SessionViewTabs, parseSessionView, type SessionView } from "./SessionViewTabs";

function renderTabs(view: SessionView = "conversation", extra: { onViewChange?: (view: SessionView) => void; trailing?: boolean } = {}) {
  const onViewChange = extra.onViewChange ?? vi.fn();
  render(
    <SessionViewTabs
      view={view}
      onViewChange={onViewChange}
      trailing={extra.trailing ? <button type="button">Инспектор</button> : undefined}
    >
      <p>Содержимое вида</p>
    </SessionViewTabs>,
  );
  return { onViewChange };
}

describe("parseSessionView", () => {
  it("«trace» открывает трейс, всё остальное разговор", () => {
    expect(parseSessionView("trace")).toBe("trace");
    expect(parseSessionView("conversation")).toBe("conversation");
    expect(parseSessionView(null)).toBe("conversation");
    expect(parseSessionView("")).toBe("conversation");
    expect(parseSessionView("timeline")).toBe("conversation");
  });

  it("видов два: разговор и трейс", () => {
    expect(SESSION_VIEWS).toEqual(["conversation", "trace"]);
  });
});

describe("SessionViewTabs", () => {
  it("рисует вкладки «Разговор» и «Трейс» и выделяет текущую", () => {
    renderTabs("trace");

    const list = screen.getByRole("tablist", { name: "Вид сессии" });
    expect(within(list).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Разговор", "Трейс"]);
    expect(within(list).getByRole("tab", { name: "Трейс" })).toHaveAttribute("aria-selected", "true");
    expect(within(list).getByRole("tab", { name: "Разговор" })).toHaveAttribute("aria-selected", "false");
  });

  it("в порядок табуляции входит только выбранная вкладка", () => {
    renderTabs("conversation");

    expect(screen.getByRole("tab", { name: "Разговор" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Трейс" })).toHaveAttribute("tabindex", "-1");
  });

  it("содержимое стоит в панели, которую называет выбранная вкладка", () => {
    renderTabs("trace");

    const panel = screen.getByRole("tabpanel", { name: "Трейс" });
    expect(panel).toHaveTextContent("Содержимое вида");
    expect(screen.getByRole("tab", { name: "Трейс" })).toHaveAttribute("aria-controls", panel.id);
    expect(screen.getByRole("tab", { name: "Разговор" })).toHaveAttribute("aria-controls", panel.id);
  });

  it("клик по другой вкладке сообщает вид, клик по текущей молчит", async () => {
    const { onViewChange } = renderTabs("conversation");

    await userEvent.click(screen.getByRole("tab", { name: "Разговор" }));
    expect(onViewChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("tab", { name: "Трейс" }));
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith("trace");
  });

  it("стрелки, Home и End переключают вид по кругу и переносят фокус на новую вкладку", async () => {
    const onViewChange = vi.fn();
    function Controlled() {
      const [view, setView] = useState<SessionView>("conversation");
      return (
        <SessionViewTabs
          view={view}
          onViewChange={(next) => {
            onViewChange(next);
            setView(next);
          }}
        >
          <p>Содержимое вида</p>
        </SessionViewTabs>
      );
    }
    render(<Controlled />);
    screen.getByRole("tab", { name: "Разговор" }).focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(onViewChange).toHaveBeenLastCalledWith("trace");
    expect(screen.getByRole("tab", { name: "Трейс" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Трейс" })).toHaveAttribute("aria-selected", "true");

    await userEvent.keyboard("{ArrowRight}");
    expect(onViewChange).toHaveBeenLastCalledWith("conversation");
    expect(screen.getByRole("tab", { name: "Разговор" })).toHaveFocus();

    await userEvent.keyboard("{ArrowLeft}");
    expect(onViewChange).toHaveBeenLastCalledWith("trace");

    await userEvent.keyboard("{Home}");
    expect(onViewChange).toHaveBeenLastCalledWith("conversation");

    await userEvent.keyboard("{End}");
    expect(onViewChange).toHaveBeenLastCalledWith("trace");
    expect(onViewChange).toHaveBeenCalledTimes(5);
  });

  it("слот справа стоит в строке вкладок, но не внутри списка вкладок", () => {
    renderTabs("trace", { trailing: true });

    const button = screen.getByRole("button", { name: "Инспектор" });
    expect(screen.getByRole("tablist").contains(button)).toBe(false);
    expect(button.closest("[data-session-views]")).toBe(screen.getByRole("tablist").closest("[data-session-views]"));
  });

  it("без слота справа строка вкладок остаётся одна", () => {
    renderTabs("conversation");

    expect(screen.queryByRole("button")).toBeNull();
  });
});
