import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventsTab, copyEventsToClipboard, downloadEventsFile } from "./EventsTab";
import type { SessionEvent } from "../../../lib/session-stats";

const events: SessionEvent[] = [
  { type: "session.status_running", id: "status", ts: 1800000000 },
  { type: "user.message", id: "user", content: "Привет", ts: 1800000001 },
  { type: "span.model_request_start", id: "start", ts: 1800000002 },
  { type: "agent.message", id: "message", content: "Ответ", ts: 1800000003 },
  { type: "span.model_request_end", id: "end", ts: 1800000004, model_request_start_id: "start" },
];
const selection = { eventId: null, source: "url" as const, seq: 0 };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("EventsTab", () => {
  it("renders compact columns, framed requests, preview, time and family tokens", () => {
    const { container } = render(<EventsTab sessionId="s" events={events} selection={selection} onSelectEvent={vi.fn()} />);
    for (const label of ["Событие", "Кратко", "Время"]) expect(screen.getByRole("columnheader", { name: label })).toBeInTheDocument();
    const group = screen.getByRole("rowgroup", { name: "Запрос start" });
    expect(within(group).getAllByRole("row")).toHaveLength(3);
    expect(group).toHaveClass("rounded-lg");
    expect(screen.getByText("Привет")).toBeInTheDocument();
    expect(screen.getAllByText(/^\d{2}:\d{2}:\d{2}$/)).toHaveLength(events.length);
    expect(container.querySelector('[data-event-id="message"]')).toHaveClass("h-6");
    expect(container.querySelector('[data-event-family="agent"]')).toHaveStyle({ color: "var(--ddc-tone-info-fg)" });
    expect(container.querySelector('[data-event-id="status"]')).toHaveClass("text-ddc-text-muted");
  });

  it("selects rows and navigates with arrows", () => {
    const select = vi.fn();
    const { container } = render(<EventsTab sessionId="s" events={events} selection={{ ...selection, eventId: "user" }} onSelectEvent={select} />);
    fireEvent.click(container.querySelector('[data-event-id="message"]')!);
    expect(select).toHaveBeenLastCalledWith("message", "events");
    fireEvent.keyDown(screen.getByRole("table"), { key: "ArrowDown" });
    expect(select).toHaveBeenLastCalledWith("start", "events");
    fireEvent.keyDown(screen.getByRole("table"), { key: "ArrowUp" });
    expect(select).toHaveBeenLastCalledWith("status", "events");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть событие" }));
    expect(select).toHaveBeenLastCalledWith(null, "events");
  });

  it("filters types, searches the menu and retains selected JSON hidden by preset", () => {
    render(<EventsTab sessionId="s" events={events} selection={{ ...selection, eventId: "start" }} onSelectEvent={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Все события" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "События разговора" }));
    expect(screen.getByText("Событие скрыто фильтром")).toBeInTheDocument();
    const panel = screen.getByRole("region", { name: "Выбранное событие" });
    expect(panel).toHaveTextContent('"type": "span.model_request_start"');
    expect(panel.querySelector('[data-language="json"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "События разговора" }));
    fireEvent.click(screen.getByRole("button", { name: "Все события" }));
    fireEvent.click(screen.getByRole("button", { name: "Все события" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Поиск типов событий" }), { target: { value: "agent.message" } });
    expect(screen.getByRole("checkbox", { name: "agent.message" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "user.message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "agent.message" }));
    expect(screen.getByRole("table").querySelectorAll("[data-event-id]")).toHaveLength(1);
  });

  it("scrolls repeated external selections and retains details across thread changes", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const props = { sessionId: "s", events, selection: { ...selection, eventId: "message" }, onSelectEvent: vi.fn() };
    const { rerender } = render(<EventsTab {...props} />);
    expect(scroll).toHaveBeenCalled();
    scroll.mockClear();
    rerender(<EventsTab {...props} selection={{ ...props.selection, seq: 1 }} />);
    expect(scroll).toHaveBeenCalledOnce();
    rerender(<EventsTab {...props} events={events.slice(0, 2)} />);
    expect(screen.getByRole("region", { name: "Выбранное событие" })).toHaveTextContent('"type": "agent.message"');
    expect(screen.getByText("Событие скрыто фильтром")).toBeInTheDocument();
  });

  it("copies and downloads only the filtered events and reports copy failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const create = vi.fn().mockReturnValue("blob:events");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await copyEventsToClipboard(events);
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(events);
    downloadEventsFile("session", events);
    expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(click.mock.instances[0]).toHaveAttribute("download", "events-session.json");
    expect(revoke).toHaveBeenCalledWith("blob:events");
    render(<EventsTab sessionId="s" events={events} selection={selection} onSelectEvent={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Все события" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "События разговора" }));
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    expect(JSON.parse(writeText.mock.calls.at(-1)![0])).toEqual([events[1], events[3]]);
    fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
    expect(create).toHaveBeenCalledTimes(2);
    writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Копировать" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Не удалось скопировать события");
  });

  it("uses DDC tokens for JSON syntax and compact code spacing", async () => {
    const { container } = render(<EventsTab sessionId="s" events={events} selection={{ ...selection, eventId: "message" }} onSelectEvent={vi.fn()} />);
    await waitFor(() => {
      const tokens = [...container.querySelectorAll<HTMLElement>("code span[style]")];
      expect(tokens.some(token => token.textContent === '"Ответ"' && token.style.getPropertyValue("--ddc-json-token") === "var(--ddc-tone-success-fg)")).toBe(true);
    });
    expect(container.querySelector('[data-language="json"]')).toHaveClass("[&_pre]:!p-2");
  });

  it("starts with unchecked type filters and exposes missing clipboard as a rejected promise", async () => {
    render(<EventsTab sessionId="s" events={events} selection={selection} onSelectEvent={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Все события" }));
    expect(screen.getByRole("checkbox", { name: "agent.message" })).not.toBeChecked();
    vi.stubGlobal("navigator", {});
    await expect(copyEventsToClipboard(events)).rejects.toThrow();
  });
});
