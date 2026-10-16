import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Event } from "../../lib/events";
import { ToolConfirmationRequests, pendingConfirmations } from "./ToolConfirmationRequests";

const bash = (over: Partial<Event> = {}): Event => ({
  id: "tu_bash",
  type: "agent.tool_use",
  name: "bash",
  input: { command: "rm -rf build" },
  evaluated_permission: "ask",
  ...over,
});

describe("pendingConfirmations", () => {
  it("берёт вызов с ask, на который нет ни решения, ни результата", () => {
    const events: Event[] = [
      bash(),
      bash({ id: "tu_done", evaluated_permission: "ask" }),
      { id: "r1", type: "agent.tool_result", tool_use_id: "tu_done" },
      bash({ id: "tu_allowed" }),
      { id: "c1", type: "user.tool_confirmation", tool_use_id: "tu_allowed", result: "allow" },
      bash({ id: "tu_auto", evaluated_permission: "allow" }),
      { id: "m1", type: "agent.mcp_tool_use", mcp_server_name: "crm", name: "find", input: {}, evaluated_permission: "ask" },
      { id: "m2", type: "agent.mcp_tool_use", mcp_server_name: "crm", name: "done", input: {}, evaluated_permission: "ask" },
      { id: "mr", type: "agent.mcp_tool_result", mcp_tool_use_id: "m2" },
    ];
    expect(pendingConfirmations(events).map((p) => p.id)).toEqual(["tu_bash", "m1"]);
  });

  it("помнит поток, в котором ждёт вызов", () => {
    const [one] = pendingConfirmations([bash({ session_thread_id: "sthr_2" })]);
    expect(one.threadId).toBe("sthr_2");
  });

  it("узнаёт платформенный вызов ассистента", () => {
    const [one] = pendingConfirmations([
      { id: "p1", type: "agent.mcp_tool_use", mcp_server_name: "platform", name: "create_agent", input: {}, evaluated_permission: "ask" },
    ]);
    expect(one.platform).toBe(true);
  });
});

describe("ToolConfirmationRequests", () => {
  it("ничего не рисует, когда ждать нечего", () => {
    const { container } = render(<ToolConfirmationRequests events={[]} onDecide={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("показывает инструмент, аргументы и две кнопки", () => {
    render(<ToolConfirmationRequests events={[bash()]} onDecide={vi.fn()} />);
    const box = screen.getByRole("group", { name: "Ожидает подтверждения" });
    expect(within(box).getByText("bash")).toBeInTheDocument();
    expect(box).toHaveTextContent("rm -rf build");
    expect(within(box).getByRole("button", { name: "Разрешить" })).toBeEnabled();
    expect(within(box).getByRole("button", { name: "Отклонить" })).toBeEnabled();
  });

  it("«Разрешить» шлёт allow без причины", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ToolConfirmationRequests events={[bash()]} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Разрешить" }));
    expect(onDecide).toHaveBeenCalledWith({ toolUseId: "tu_bash", result: "allow", threadId: null });
    expect(await screen.findByText("Решение отправлено")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Разрешить" })).toBeNull();
  });

  it("«Отклонить» шлёт deny с причиной, если её ввели", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ToolConfirmationRequests events={[bash({ session_thread_id: "sthr_2" })]} onDecide={onDecide} />);
    await userEvent.type(screen.getByLabelText("Причина отказа"), "Не трогайте build");
    await userEvent.click(screen.getByRole("button", { name: "Отклонить" }));
    expect(onDecide).toHaveBeenCalledWith({
      toolUseId: "tu_bash",
      result: "deny",
      threadId: "sthr_2",
      denyMessage: "Не трогайте build",
    });
  });

  it("при ошибке кнопки возвращаются и есть что нажать снова", async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error("нет связи"));
    render(<ToolConfirmationRequests events={[bash()]} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Разрешить" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Разрешить" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось отправить решение");
  });

  it("у платформенного вызова нет «Разрешить»: его подтверждают карточкой ассистента", () => {
    render(
      <ToolConfirmationRequests
        events={[{ id: "p1", type: "agent.mcp_tool_use", mcp_server_name: "platform", name: "create_agent", input: {}, evaluated_permission: "ask" }]}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Разрешить" })).toBeNull();
    expect(screen.getByRole("button", { name: "Отклонить" })).toBeEnabled();
    expect(screen.getByText(/карточк/i)).toBeInTheDocument();
  });

  it("длинные аргументы обрезаются, чтобы не растягивать страницу", () => {
    const long = "x".repeat(5000);
    render(<ToolConfirmationRequests events={[bash({ input: { command: long } })]} onDecide={vi.fn()} />);
    const text = screen.getByRole("group").textContent ?? "";
    expect(text.length).toBeLessThan(1500);
  });
});
