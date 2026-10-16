import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import type { ThreadItem } from "../../lib/assistant/events";
import { server } from "../../mocks/server";
import { QuickstartWizard } from "./QuickstartWizard";

const describeProps = vi.hoisted(() => ({ last: null as null | Record<string, any> }));
vi.mock("../../components/assistant/describe/DescribeAgent", () => ({
  DescribeAgent: (props: Record<string, any>) => {
    describeProps.last = props;
    return (
      <div data-testid="describe">
        <button type="button" onClick={() => props.onCreated?.({ id: "agent_1", name: "Сводка заявок" })}>
          stub-created
        </button>
        <button type="button" onClick={() => props.onCancel?.()}>
          stub-cancel
        </button>
      </div>
    );
  },
}));

const assistant = vi.hoisted(() => ({
  current: null as null | Record<string, any>,
}));
vi.mock("../../components/assistant/AssistantProvider", () => ({
  useOptionalAssistant: () => assistant.current,
}));
vi.mock("../../components/assistant/AssistantThread", () => ({
  AssistantThread: ({ items }: { items: ThreadItem[] }) => <div data-testid="thread">{items.length} в ленте</div>,
}));

function makeAssistant(over: Record<string, any> = {}) {
  return {
    status: "ready",
    thread: [] as ThreadItem[],
    sessionId: "sesn_chat",
    running: false,
    sending: false,
    sendError: null,
    send: vi.fn().mockResolvedValue(undefined),
    newConversation: vi.fn(),
    reload: vi.fn(),
    setOpen: vi.fn(),
    ...over,
  };
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function renderWizard(state: unknown = { prompt: "Сводка заявок" }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/quickstart/new", state }]}>
      <Routes>
        <Route path="/quickstart/new" element={<QuickstartWizard />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

beforeEach(() => {
  describeProps.last = null;
  assistant.current = makeAssistant();
  clipboard.writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
});

const envApplied: ThreadItem = {
  kind: "proposal",
  id: "tu_env",
  tool: "create_environment",
  input: {},
  phase: "applied",
  applied: [{ tool: "create_environment", kind: "environment", id: "env_1", name: "Основное", version: null, action: "create" }],
};

async function createAgent() {
  await userEvent.click(screen.getByRole("button", { name: "stub-created" }));
}

describe("мастер /quickstart/new", () => {
  it("без текста из быстрого старта возвращает на /quickstart", () => {
    renderWizard(null);
    expect(screen.getByTestId("where")).toHaveTextContent("/quickstart");
  });

  it("шаг 1 запускает «Описать агента» с текстом и показывает ход", () => {
    renderWizard();
    expect(describeProps.last).toMatchObject({ initialPrompt: "Сводка заявок", autoStart: true });
    const steps = screen.getByRole("list", { name: "Ход" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("Создать агента"),
      expect.stringContaining("Настроить окружение"),
      expect.stringContaining("Начать сессию"),
      expect.stringContaining("Подключить"),
    ]);
    expect(within(steps).getByText("Создать агента").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("после создания агента передаёт разговор ассистенту: новая беседа и просьба предложить окружение", async () => {
    renderWizard();
    await createAgent();

    expect(assistant.current!.newConversation).toHaveBeenCalled();
    await waitFor(() => expect(assistant.current!.send).toHaveBeenCalledTimes(1));
    const text = assistant.current!.send.mock.calls[0][0] as string;
    expect(text).toContain("Сводка заявок");
    expect(text).toContain("agent_1");
    expect(text).toMatch(/окружени/);
    expect(screen.getByTestId("thread")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Сводка заявок" })).toHaveAttribute("href", "/agents/agent_1");
    const steps = screen.getByRole("list", { name: "Ход" });
    expect(within(steps).getByText("Настроить окружение").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("ждёт готовности ассистента, прежде чем писать ему, и запускает его загрузку", async () => {
    assistant.current = makeAssistant({ status: "idle" });
    renderWizard();
    await createAgent();
    expect(assistant.current!.reload).toHaveBeenCalled();
    expect(assistant.current!.send).not.toHaveBeenCalled();
  });

  it("окружение из применённой карточки попадает в «Ресурсы» и закрывает шаг 2", async () => {
    assistant.current = makeAssistant({ thread: [envApplied] });
    renderWizard();
    await createAgent();
    const resources = screen.getByRole("region", { name: "Ресурсы" });
    expect(within(resources).getByRole("link", { name: "Основное" })).toHaveAttribute("href", "/environments/env_1");
    const steps = screen.getByRole("list", { name: "Ход" });
    expect(within(steps).getByText("Начать сессию").closest("li")).toHaveAttribute("aria-current", "step");
  });

  it("«Начать тестовую сессию» выключена без окружения", async () => {
    renderWizard();
    await createAgent();
    expect(screen.getByRole("button", { name: "Начать тестовую сессию" })).toBeDisabled();
  });

  it("«Начать тестовую сессию» создаёт сессию без ассистента и открывает её", async () => {
    assistant.current = makeAssistant({ thread: [envApplied] });
    const bodies: any[] = [];
    server.use(
      http.post("*/v1/sessions", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: "sesn_new" });
      }),
      http.get("*/v1/agents/agent_1", () => HttpResponse.json({ id: "agent_1", name: "Сводка заявок", version: 3 })),
    );
    renderWizard();
    await createAgent();
    await userEvent.click(screen.getByRole("button", { name: "Начать тестовую сессию" }));

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sesn_new"));
    expect(bodies[0]).toMatchObject({ agent: { type: "agent", id: "agent_1" }, environment_id: "env_1" });
    expect(assistant.current!.send).toHaveBeenCalledTimes(1);
  });

  it("«Экспорт кодом» показывает команду curl и копирует её", async () => {
    assistant.current = makeAssistant({ thread: [envApplied] });
    renderWizard();
    await createAgent();
    await userEvent.click(screen.getByRole("button", { name: "Экспорт кодом" }));
    const dialog = await screen.findByRole("dialog", { name: "Экспорт кодом" });
    expect(dialog).toHaveTextContent("/v1/sessions");
    expect(dialog).toHaveTextContent("env_1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Копировать" }));
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("agent_1"));
  });

  it("шаг «Подключить» ведёт к API-ключам", async () => {
    renderWizard();
    await createAgent();
    expect(screen.getByRole("link", { name: "API-ключи" })).toHaveAttribute("href", "/api-keys");
  });

  it("без ассистента на странице пишет, что чат недоступен", async () => {
    assistant.current = null;
    renderWizard();
    await createAgent();
    expect(screen.getByText(/Чат с ассистентом недоступен/)).toBeInTheDocument();
  });

  it("отмена шага 1 возвращает на /quickstart", async () => {
    renderWizard();
    await userEvent.click(screen.getByRole("button", { name: "stub-cancel" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/quickstart");
  });
});
