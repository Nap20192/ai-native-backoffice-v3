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
    // Как в образце: процент только у ошибок, выполненные идут числом.
    expect(within(summary).getByText("11")).toBeInTheDocument();
    expect(within(summary).queryByText("11 (65 %)")).not.toBeInTheDocument();
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
    const detail = screen.getByRole("region", { name: "Инструмент bash" });
    expect(within(detail).getByText("Инструмент")).toHaveClass("text-ddc-text-muted");
    expect(within(detail).getAllByText("bash")[0]).toHaveClass("font-mono");
    const calls = screen.getByRole("table", { name: "Вызовы bash" });
    for (const name of ["Время", "Ввод", "Статус", "Длительность"]) expect(within(calls).getByRole("columnheader", { name })).toBeInTheDocument();
    expect(within(calls).getByRole("columnheader", { name: "Длительность" })).toHaveClass("text-right");
    expect(within(calls).getAllByRole("row")).toHaveLength(7);
    expect(within(calls).getAllByText("выполнен")).toHaveLength(6);
    const row = within(calls).getAllByRole("row")[1];
    expect(row).toHaveAttribute("aria-selected", "true");
    fireEvent.click(row);
    expect(select).toHaveBeenLastCalledWith("bash0", "tools");
    fireEvent.click(screen.getByRole("button", { name: "Закрыть инструмент" }));
    expect(screen.getByRole("region", { name: "Сводка" })).toBeInTheDocument();
  });

  it("читает разрешение из объекта политики для MCP и встроенных инструментов", () => {
    // Харнесс называет MCP-вызов mcp__<сервер>__<инструмент>, у набора MCP часто есть только default_config.
    const agentTools = [
      { type: "agent_toolset_20260401", default_config: { permission_policy: { type: "always_allow" } }, configs: [{ name: "bash", permission_policy: { type: "always_ask" } }] },
      { type: "mcp_toolset", mcp_server_name: "crm", default_config: { permission_policy: { type: "always_ask" } } },
    ];
    const mcpEvents: SessionEvent[] = [
      { type: "agent.mcp_tool_use", id: "m1", name: "mcp__crm__write_act", mcp_server_name: "crm", ts: 1800000000000, input: { id: 7 } },
      { type: "agent.mcp_tool_result", id: "m1r", mcp_tool_use_id: "m1", ts: 1800000000500 },
    ];
    render(<ToolsTab {...props} events={mcpEvents} agentTools={agentTools} />);

    const table = screen.getByRole("table", { name: "Инструменты" });
    const permissionOf = (name: string) => within(within(table).getByText(name).closest("tr")!).getAllByRole("cell")[1];
    expect(permissionOf("write_act")).toHaveTextContent("Спросить");
    expect(permissionOf("bash")).toHaveTextContent("Спросить");
    expect(permissionOf("read")).toHaveTextContent("Авто");
    const permissions = within(table).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[1].textContent);
    expect(permissions).toHaveLength(9);
    expect(permissions).not.toContain("–");
  });

  it("shows empty data without invalid ring values", () => {
    const { container } = render(<ToolsTab {...props} events={[]} agentTools={undefined} />);
    expect(screen.getByText("0 инструментов, 0 использовано, 0 вызовов")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("NaN");
    expect(screen.getByText("Инструменты не найдены")).toBeInTheDocument();
  });
});
