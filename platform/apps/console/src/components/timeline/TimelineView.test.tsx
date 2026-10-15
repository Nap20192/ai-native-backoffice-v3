import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Event } from "../../lib/events";
import { TimelineView } from "./TimelineView";
import { eventTsMs, resolveTurnExpanded } from "./eventTime";

function turnEvents(turn: number, startIso: string): Event[] {
  const t0 = Date.parse(startIso);
  return [
    {
      type: "user.message",
      content: [{ type: "text", text: `msg-${turn}` }],
      processed_at: new Date(t0).toISOString(),
    },
    {
      type: "agent.message",
      content: [{ type: "text", text: `reply-${turn}` }],
      processed_at: new Date(t0 + 100).toISOString(),
    },
    {
      type: "session.status_idle",
      processed_at: new Date(t0 + 200).toISOString(),
    },
  ];
}

describe("eventTsMs", () => {
  it("parses ISO ts when processed_at is absent", () => {
    const ms = eventTsMs({
      type: "agent.message",
      ts: "2026-08-11T12:00:00.500Z",
    });
    expect(ms).toBe(Date.parse("2026-08-11T12:00:00.500Z"));
  });

  it("prefers processed_at over ts", () => {
    const ms = eventTsMs({
      type: "agent.message",
      processed_at: "2026-08-11T12:00:01.000Z",
      ts: "2026-08-11T12:00:00.000Z",
    });
    expect(ms).toBe(Date.parse("2026-08-11T12:00:01.000Z"));
  });

  it("treats numeric ts as unix seconds", () => {
    expect(eventTsMs({ type: "x", ts: 1_700_000_000 })).toBe(1_700_000_000 * 1000);
  });
});

describe("resolveTurnExpanded", () => {
  it("auto-expands only the latest turn", () => {
    expect(resolveTurnExpanded("t1", "t3", {})).toBe(false);
    expect(resolveTurnExpanded("t3", "t3", {})).toBe(true);
  });

  it("honors explicit user overrides", () => {
    expect(resolveTurnExpanded("t1", "t3", { t1: true })).toBe(true);
    expect(resolveTurnExpanded("t3", "t3", { t3: false })).toBe(false);
  });
});

describe("TimelineView live append", () => {
  it("keeps only the latest turn auto-expanded as turns append", async () => {
    const user = userEvent.setup();
    const first = turnEvents(1, "2026-08-11T10:00:00.000Z");
    const { rerender } = render(<TimelineView events={first} />);

    // One expand control; latest is open (▾).
    expect(screen.getAllByTitle("Свернуть")).toHaveLength(1);
    expect(screen.queryByTitle("Развернуть")).toBeNull();

    const two = [...first, ...turnEvents(2, "2026-08-11T10:01:00.000Z")];
    rerender(<TimelineView events={two} />);

    // Previous latest collapsed; new latest expanded.
    expect(screen.getAllByTitle("Развернуть")).toHaveLength(1);
    expect(screen.getAllByTitle("Свернуть")).toHaveLength(1);

    const three = [...two, ...turnEvents(3, "2026-08-11T10:02:00.000Z")];
    rerender(<TimelineView events={three} />);

    expect(screen.getAllByTitle("Развернуть")).toHaveLength(2);
    expect(screen.getAllByTitle("Свернуть")).toHaveLength(1);

    // Explicit override: keep an older turn open while latest stays open.
    await user.click(screen.getAllByTitle("Развернуть")[0]);
    expect(screen.getAllByTitle("Свернуть")).toHaveLength(2);
    expect(screen.getAllByTitle("Развернуть")).toHaveLength(1);
  });
});

describe("TimelineView по-русски", () => {
  it("называет вид запуска и статус хода словами, а не сырыми значениями", () => {
    render(<TimelineView events={turnEvents(1, "2026-08-11T10:00:00.000Z")} />);

    expect(screen.getAllByText("Сообщение пользователя").length).toBeGreaterThan(0);
    expect(screen.getByText("Завершён")).toBeInTheDocument();
    expect(screen.queryByText("completed")).toBeNull();
    expect(screen.queryByText("user message")).toBeNull();
  });

  it("называет строки графика по-русски и пишет длительность русскими единицами", () => {
    render(<TimelineView events={turnEvents(1, "2026-08-11T10:00:00.000Z")} />);

    expect(screen.getAllByText("Ответ агента").length).toBeGreaterThan(0);
    expect(screen.queryByText("agent.message")).toBeNull();
    expect(screen.queryByText(/\d\s?(ms|s)\b/)).toBeNull();
  });

  it("пустая хронология показывает пустое состояние", () => {
    render(<TimelineView events={[]} />);

    expect(screen.getByText("Хронология пока пуста")).toBeInTheDocument();
  });

  it("пока история грузится, вместо пустого состояния стоит скелетон", () => {
    render(<TimelineView events={[]} loading />);

    expect(screen.queryByText("Хронология пока пуста")).toBeNull();
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  });
});
