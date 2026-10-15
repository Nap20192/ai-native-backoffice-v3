import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolsTab } from "./ToolsTab";
import type { SessionEvent } from "../../../lib/session-stats";

const events: SessionEvent[] = [];
for (const [name, count, failed, duration] of [["bash", 6, false, 384], ["web_search", 5, true, 119], ["edit", 4, false, 1100], ["write", 1, false, 366], ["web_fetch", 1, true, 1000]] as const) {
  for (let i = 0; i < count; i++) events.push({ type: "agent.tool_use", id: `${name}${i}`, name, ts: 1800000000000, input: { command: "ls /mnt", query: "research", file_path: "/file" } }, { type: "agent.tool_result", id: `${name}${i}r`, tool_use_id: `${name}${i}`, ts: 1800000000000 + duration, is_error: failed });
}
const props = { events, agentTools: [{ type: "agent_toolset_20260401" }], selection: { eventId: null, source: "url" as const, seq: 0 }, onSelectEvent: vi.fn() };
afterEach(cleanup);

describe("ToolsTab", () => {
  it("renders every reference column, zero rows, summary, SVG ring and durations", () => {
    render(<ToolsTab {...props} />);
    for (const name of ["Название", "Разрешение", "Вызовы", "Ошибки", "p50"]) expect(screen.getAllByRole("columnheader", { name }).length).toBeGreaterThan(0);
    const table = screen.getByRole("table", { name: "Инструменты" });
    expect(within(table).getAllByRole("row")).toHaveLength(9);
    expect(within(table).getByText("384 мс")).toBeInTheDocument();
    expect(within(table).getByText("5 (100 %)" )).toHaveClass("text-ddc-danger-text");
    expect(within(table).getByText("read").closest("tr")).toHaveClass("text-ddc-text-muted");
    expect(screen.getByText("8 инструментов, 5 использовано, 17 вызовов")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Статусы вызовов" }).tagName.toLowerCase()).toBe("svg");
    const summary = screen.getByRole("region", { name: "Сводка" });
    expect(within(summary).getByText("6 (35 %)" )).toBeInTheDocument();
    expect(within(summary).getByText("11 (65 %)" )).toBeInTheDocument();
    for (const text of ["Отклонено", "Прервано", "Выполнено", "Время в инструментах", "Всего", "Выполнение", "Ожидание вас", "Длительность"]) expect(within(summary).getByText(text)).toBeInTheDocument();
    expect(within(summary).getAllByText("нет")).toHaveLength(2);
  });

  it("filters table names without changing session summary", () => {
    render(<ToolsTab {...props} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Найти инструмент" }), { target: { value: "BASH" } });
    expect(within(screen.getByRole("table", { name: "Инструменты" })).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("8 инструментов, 5 использовано, 17 вызовов")).toBeInTheDocument();
  });

  it("opens tool detail, lists calls and selects the transcript call without expanding", () => {
    const select = vi.fn();
    render(<ToolsTab {...props} onSelectEvent={select} selection={{ ...props.selection, eventId: "bash0" }} />);
    fireEvent.click(screen.getByText("bash"));
    expect(screen.getByText("Инструмент bash")).toBeInTheDocument();
    const calls = screen.getByRole("table", { name: "Вызовы bash" });
    for (const name of ["Время", "Ввод", "Статус", "Длительность"]) expect(within(calls).getByRole("columnheader", { name })).toBeInTheDocument();
    expect(within(calls).getAllByRole("row")).toHaveLength(7);
    expect(within(calls).getAllByText("выполнен")).toHaveLength(6);
    const row = within(calls).getAllByRole("row")[1];
    expect(row).toHaveAttribute("aria-selected", "true");
    fireEvent.click(row);
    expect(select).toHaveBeenLastCalledWith("bash0", "tools");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть инструмент" }));
    expect(screen.getByRole("region", { name: "Сводка" })).toBeInTheDocument();
  });

  it("shows empty data without invalid ring values", () => {
    const { container } = render(<ToolsTab {...props} events={[]} agentTools={undefined} />);
    expect(screen.getByText("0 инструментов, 0 использовано, 0 вызовов")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("NaN");
    expect(screen.getByText("Инструменты не найдены")).toBeInTheDocument();
  });
});
