import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectCanonicalChatTurns,
  type WireSessionEvent,
} from "@openma/common/session-events/managed";
import type { EventSelection } from "../../lib/session-stats";
import { ManagedSessionConversation } from "./ManagedSessionConversation";

// Лента прилипает к низу через use-stick-to-bottom. Пока прилипание включено,
// раскрытие вызова после выбора снаружи возвращает ленту вниз. Подменяем
// контекст, чтобы увидеть, снимает ли лента прилипание перед прокруткой.
const stick = vi.hoisted(() => ({
  stopScroll: vi.fn(),
  scrollToBottom: vi.fn(() => Promise.resolve(true)),
  isAtBottom: true,
  isNearBottom: true,
  escapedFromLock: false,
  scrollRef: { current: null },
  contentRef: { current: null },
  state: {},
}));

vi.mock("use-stick-to-bottom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("use-stick-to-bottom")>();
  return { ...actual, useStickToBottomContext: () => stick };
});

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function events(): WireSessionEvent[] {
  return [
    { type: "user.message", id: "u1", content: [{ type: "text", text: "выполни pwd" }], processed_at: at(0) },
    { type: "span.model_request_start", id: "r1", processed_at: at(1) },
    { type: "agent.tool_use", id: "t1", name: "bash", input: { command: "pwd" }, processed_at: at(2) },
    { type: "span.model_request_end", id: "r1e", model_request_start_id: "r1", processed_at: at(2) },
    { type: "agent.tool_result", id: "t1r", tool_use_id: "t1", content: [{ type: "text", text: "/workspace" }], processed_at: at(57) },
  ];
}

function renderWith(selection: EventSelection) {
  return render(
    <MemoryRouter>
      <ManagedSessionConversation
        agentName="Документовед"
        composer={null}
        onSelectEvent={vi.fn()}
        running={false}
        selection={selection}
        sessionId="session-1"
        turns={projectCanonicalChatTurns(events())}
      />
    </MemoryRouter>,
  );
}

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
  );
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  stick.stopScroll.mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
});

describe("ManagedSessionConversation: прилипание к низу", () => {
  it.each(["events", "tools", "minimap", "url"] as const)(
    "выбор из «%s» снимает прилипание до прокрутки к блоку",
    async (source) => {
      renderWith({ eventId: "t1", source, seq: 1 });

      expect(stick.stopScroll).toHaveBeenCalled();
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
      expect(stick.stopScroll.mock.invocationCallOrder[0]!).toBeLessThan(
        scrollIntoView.mock.invocationCallOrder[0]!,
      );
    },
  );

  it("плавная прокрутка ждёт, пока оболочка отработает новую высоту ленты", async () => {
    // Раскрытый вызов меняет высоту ленты. ResizeObserver оболочки в том же
    // кадре ставит scrollTop сам и обрывает плавную прокрутку, начатую раньше.
    renderWith({ eventId: "t1", source: "events", seq: 1 });

    expect(scrollIntoView).not.toHaveBeenCalled();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  it("выбор в самой ленте прилипание не трогает", () => {
    renderWith({ eventId: "t1", source: "transcript", seq: 1 });

    expect(stick.stopScroll).not.toHaveBeenCalled();
  });
});
