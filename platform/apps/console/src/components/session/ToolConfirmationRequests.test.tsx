import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Event } from "../../lib/events";
import { AGENT_EDIT_PREVIEW, mockPlatformMcp, renderInRouter } from "../assistant/test-fixtures";
import { ToolConfirmationRequests, pendingConfirmations } from "./ToolConfirmationRequests";

const SID = "sesn_1";

const platformCall = (over: Partial<Event> = {}): Event => ({
  id: "p1",
  type: "agent.mcp_tool_use",
  mcp_server_name: "platform",
  name: "mcp__platform__create_agent",
  input: {},
  evaluated_permission: "ask",
  ...over,
});

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
    const { container } = render(<ToolConfirmationRequests sessionId={SID} events={[]} onDecide={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("показывает инструмент, аргументы и две кнопки", () => {
    render(<ToolConfirmationRequests sessionId={SID} events={[bash()]} onDecide={vi.fn()} />);
    const box = screen.getByRole("group", { name: "Ожидает подтверждения" });
    expect(within(box).getByText("bash")).toBeInTheDocument();
    expect(box).toHaveTextContent("rm -rf build");
    expect(within(box).getByRole("button", { name: "Разрешить" })).toBeEnabled();
    expect(within(box).getByRole("button", { name: "Отклонить" })).toBeEnabled();
  });

  it("«Разрешить» шлёт allow без причины", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ToolConfirmationRequests sessionId={SID} events={[bash()]} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Разрешить" }));
    expect(onDecide).toHaveBeenCalledWith({ toolUseId: "tu_bash", result: "allow", threadId: null });
    expect(await screen.findByText("Решение отправлено")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Разрешить" })).toBeNull();
  });

  it("«Отклонить» шлёт deny с причиной, если её ввели", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ToolConfirmationRequests sessionId={SID} events={[bash({ session_thread_id: "sthr_2" })]} onDecide={onDecide} />);
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
    render(<ToolConfirmationRequests sessionId={SID} events={[bash()]} onDecide={onDecide} />);
    await userEvent.click(screen.getByRole("button", { name: "Разрешить" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Разрешить" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось отправить решение");
  });

  // Раньше вызов записи платформы получал здесь только «Отклонить» и подсказку
  // про панель ассистента. Панель рисует карточки только своей сессии, поэтому
  // на странице другой сессии подтвердить было нечем. Теперь здесь та же
  // карточка, что в панели, и старая подсказка ушла.
  it("вызов записи платформы получает карточку: «Применить» шлёт confirm с отпечатком, блок своё решение не шлёт", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([AGENT_EDIT_PREVIEW]);
    const onDecide = vi.fn().mockResolvedValue(undefined);
    renderInRouter(
      <ToolConfirmationRequests
        sessionId={SID}
        events={[platformCall({ name: "mcp__platform__update_agent", input: { agent_id: "agent_1" } })]}
        onDecide={onDecide}
      />,
    );
    const card = await screen.findByRole("article", { name: "Изменить агента «Сводка PR», версия 3 станет 4" });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Применить" })).toBeEnabled());
    expect(seen.previews).toEqual([{ session_id: SID, tool_use_id: "p1" }]);
    expect(screen.queryByRole("button", { name: "Разрешить" })).toBeNull();
    expect(screen.queryByText(/панели ассистента/)).toBeNull();

    await user.click(within(card).getByRole("button", { name: "Применить" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toEqual({ session_id: SID, tool_use_id: "p1", result: "allow", preview_digest: "d1" });
    expect(await within(card).findByText("Отправлено. Жду результат")).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("отказ по карточке платформы тоже идёт через confirm, а не через блок", async () => {
    const user = userEvent.setup();
    const seen = mockPlatformMcp([AGENT_EDIT_PREVIEW]);
    const onDecide = vi.fn().mockResolvedValue(undefined);
    renderInRouter(
      <ToolConfirmationRequests
        sessionId={SID}
        events={[platformCall({ name: "mcp__platform__update_agent" })]}
        onDecide={onDecide}
      />,
    );
    const card = await screen.findByRole("article", { name: "Изменить агента «Сводка PR», версия 3 станет 4" });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Применить" })).toBeEnabled());
    await user.click(within(card).getByRole("button", { name: "Отклонить" }));
    await waitFor(() => expect(seen.decisions).toHaveLength(1));
    expect(seen.decisions[0]).toMatchObject({ tool_use_id: "p1", result: "deny", preview_digest: "d1" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("не владелец сессии видит карточку без кнопок и имя владельца", async () => {
    mockPlatformMcp([{ ...AGENT_EDIT_PREVIEW, can_confirm: false, owner_name: "Анна" }]);
    renderInRouter(
      <ToolConfirmationRequests
        sessionId={SID}
        events={[platformCall({ name: "mcp__platform__update_agent" })]}
        onDecide={vi.fn()}
      />,
    );
    expect(await screen.findByText("Подтвердить может только Анна")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Применить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отклонить" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Разрешить" })).toBeNull();
  });

  // Чтение платформы подтверждения не просит. Для другого вызова платформы без
  // записи карточки нет: остаётся «Отклонить» с короткой верной подсказкой.
  it("вызов платформы без записи: только «Отклонить» и подсказка без отсылки к панели", async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(
      <ToolConfirmationRequests
        sessionId={SID}
        events={[platformCall({ name: "mcp__platform__get" })]}
        onDecide={onDecide}
      />,
    );
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByRole("button", { name: "Разрешить" })).toBeNull();
    expect(screen.getByText("У этого вызова платформы нет карточки подтверждения. Его можно только отклонить")).toBeInTheDocument();
    expect(screen.queryByText(/панели ассистента/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Отклонить" }));
    expect(onDecide).toHaveBeenCalledWith({ toolUseId: "p1", result: "deny", threadId: null });
  });

  // Имя send_message есть в списке записи платформы. Карточку получает только
  // вызов сервера platform, у другого MCP-сервера остаётся обычная строка.
  it("MCP-вызов не платформы с именем записи получает «Разрешить», а не карточку", async () => {
    const seen = mockPlatformMcp([AGENT_EDIT_PREVIEW]);
    const onDecide = vi.fn().mockResolvedValue(undefined);
    renderInRouter(
      <ToolConfirmationRequests
        sessionId={SID}
        events={[
          {
            id: "m1",
            type: "agent.mcp_tool_use",
            mcp_server_name: "slack",
            name: "send_message",
            input: { text: "привет" },
            evaluated_permission: "ask",
          },
        ]}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByRole("button", { name: "Разрешить" })).toBeEnabled();
    expect(screen.queryByRole("article")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Разрешить" }));
    expect(onDecide).toHaveBeenCalledWith({ toolUseId: "m1", result: "allow", threadId: null });
    expect(seen.previews).toEqual([]);
    expect(seen.decisions).toEqual([]);
  });

  it("длинные аргументы обрезаются, чтобы не растягивать страницу", () => {
    const long = "x".repeat(5000);
    render(<ToolConfirmationRequests sessionId={SID} events={[bash({ input: { command: long } })]} onDecide={vi.fn()} />);
    const text = screen.getByRole("group").textContent ?? "";
    expect(text.length).toBeLessThan(1500);
  });
});
