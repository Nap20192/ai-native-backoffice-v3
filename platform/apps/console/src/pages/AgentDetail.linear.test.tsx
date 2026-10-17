import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
import type { ModelOption } from "../lib/catalog-api";
import { AgentDetail } from "./AgentDetail";
import { formatDateTime } from "./agents/format";

const agent = {
  id: "agent-1",
  name: "OpenMA Demo Agent",
  model: "test-model",
  system: "You are a concise assistant.",
  tools: [],
  version: 2,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T11:00:00.000Z",
};

let agentResult: { data?: typeof agent; error?: Error } = { data: agent };

const ACP_BLOCK = {
  agent: { id: "claude-acp", command: "sh", args: ["-c", "exec claude-agent-acp"] },
  per_turn_timeout_ms: 600000,
};

const catalogModel: ModelOption = {
  handle: "verify-fake",
  label: "Claude Sonnet 4.6",
  source: "card",
  card_id: "mc_1",
  is_default: true,
  provider: "anthropic",
  wire_model: "claude-sonnet-4-6",
  api: "anthropic-messages",
  protocols: ["anthropic-messages"],
  context_window: 200000,
  max_output_tokens: 64000,
  effort_levels: ["low", "medium", "high"],
  speed_fast: true,
};

/** Как ответит сервер на запрос каталога моделей: данные, ошибка или молчание. */
let catalogMode: "ok" | "error" | "pending" = "ok";

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string | null) => {
    if (path === "/v1/agents/agent-1") return agentResult;
    if (path === "/v1/agents/agent-1/versions") return { data: { data: [agent] } };
    return { data: { data: [] } };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({
    api: vi.fn(async (path: string) => {
      if (path === "/v1/oma/model_options") {
        if (catalogMode === "pending") return new Promise(() => {});
        if (catalogMode === "error") throw new Error("Каталог недоступен");
        return { builtin_available: true, data: [catalogModel] };
      }
      return { data: [] };
    }),
  }),
}));

vi.mock("./agents/AgentFormDialog", () => ({ AgentFormDialog: () => null }));

const assistantMock = vi.hoisted(() => ({
  current: null as null | { open: boolean; setOpen: (open: boolean) => void; newConversation: () => void },
}));
vi.mock("../components/assistant/AssistantProvider", () => ({
  useOptionalAssistant: () => assistantMock.current,
}));

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/agents/agent-1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/agents/:id" element={<AgentDetail />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  agentResult = { data: agent };
  catalogMode = "ok";
});

describe("AgentDetail Linear rail", () => {
  it("opens with the entity title in the page header and keeps metadata in the rail", async () => {
    renderDetail();

    const title = await screen.findByRole("heading", { level: 1, name: "OpenMA Demo Agent" });
    expect(title.closest("header")).not.toBeNull();
    expect(screen.getByTestId("detail-body")).not.toContainElement(title);
    expect(screen.getByTestId("detail-layout")).toHaveAttribute("data-detail-layout", "rail");

    const rail = screen.getByTestId("detail-rail");
    expect(within(rail).getByText("ID")).toBeInTheDocument();
    expect(within(rail).getByText("test-model")).toBeInTheDocument();

    const body = screen.getByTestId("detail-body");
    expect(screen.queryByRole("heading", { name: "Интеграции" })).toBeNull();
    expect(screen.queryByText(/Linear|GitHub|Slack|Feishu/)).toBeNull();
    expect(within(body).getByRole("heading", { name: "Системный промпт" })).toBeInTheDocument();
    expect(within(body).getByRole("heading", { name: "История версий" })).toBeInTheDocument();
  });

  it("names the rail properties in Russian and writes dates as dd.MM.yyyy HH:mm", async () => {
    renderDetail();

    const rail = await screen.findByTestId("detail-rail");
    expect(within(rail).getByRole("heading", { name: "Свойства" })).toBeInTheDocument();
    for (const label of ["Модель", "Версия", "Инструменты", "Создан", "Обновлён"]) {
      expect(within(rail).getByText(label)).toBeInTheDocument();
    }
    expect(within(rail).getByText("v2")).toBeInTheDocument();
    expect(within(rail).getByText("Нет")).toBeInTheDocument();
    expect(within(rail).getByText(formatDateTime(agent.created_at))).toBeInTheDocument();
    expect(within(rail).getByText(formatDateTime(agent.updated_at))).toBeInTheDocument();
  });

  it("marks the current version in the history table", async () => {
    renderDetail();

    const body = await screen.findByTestId("detail-body");
    const history = within(body).getByRole("table");
    expect(within(history).getByRole("columnheader", { name: "Версия" })).toBeInTheDocument();
    expect(within(history).getByText("Текущая")).toBeInTheDocument();
  });

  it("asks through a dialog before archiving and lets the user back out", async () => {
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "В архив" }));

    const dialog = await screen.findByRole("dialog", { name: "Отправить агента в архив?" });
    expect(dialog).toHaveAccessibleDescription(/Можно вернуть из архива/);

    await userEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows a busy skeleton while the agent loads", () => {
    agentResult = {};
    renderDetail();

    expect(screen.getByRole("status")).toHaveTextContent("Загрузка…");
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("reports a load failure with a way back to the list", async () => {
    agentResult = { error: new Error("Сервер недоступен") };
    renderDetail();

    expect(await screen.findByText("Не удалось загрузить агента")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Сервер недоступен");
    expect(screen.getByRole("button", { name: "К списку агентов" })).toBeInTheDocument();
  });

  it("names the toolset in Russian and never prints the raw API type", async () => {
    agentResult = {
      data: { ...agent, tools: [{ type: "agent_toolset_20260401" }] } as unknown as typeof agent,
    };
    renderDetail();

    const rail = await screen.findByTestId("detail-rail");
    expect(within(rail).getByText("Базовый набор инструментов")).toBeInTheDocument();
    expect(within(rail).queryByText(/agent_toolset_20260401/)).toBeNull();
  });
});

function withAgent(overrides: Record<string, unknown>) {
  agentResult = { data: { ...agent, ...overrides } as unknown as typeof agent };
}

describe("AgentDetail: модель", () => {
  it("показывает модель названием, handle, усилием, скоростью и источником", async () => {
    withAgent({ model: { id: "verify-fake", effort: { type: "high" }, speed: "fast" } });
    renderDetail();

    const rail = await screen.findByTestId("detail-rail");
    await waitFor(() => expect(within(rail).getByText("Карточка")).toBeInTheDocument());
    expect(within(rail).getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    expect(within(rail).getByText("verify-fake")).toHaveClass("font-mono");
    expect(within(rail).getByText("Усилие: высокое")).toBeInTheDocument();
    expect(within(rail).getByText("Быстрая")).toBeInTheDocument();
  });

  it("усилие, заданное строкой, читается так же, как объект", async () => {
    withAgent({ model: { id: "verify-fake", effort: "max" } });
    renderDetail();

    const rail = await screen.findByTestId("detail-rail");
    expect(within(rail).getByText("Усилие: максимальное")).toBeInTheDocument();
    expect(within(rail).queryByText("Быстрая")).toBeNull();
  });

  it("пока каталог грузится, показывает значения из агента", async () => {
    catalogMode = "pending";
    withAgent({ model: { id: "verify-fake", effort: { type: "low" }, speed: "fast" } });
    renderDetail();

    const rail = await screen.findByTestId("detail-rail");
    expect(within(rail).getByText("verify-fake")).toBeInTheDocument();
    expect(within(rail).getByText("Усилие: низкое")).toBeInTheDocument();
    expect(within(rail).queryByText("Claude Sonnet 4.6")).toBeNull();
    expect(within(rail).queryByText("Карточка")).toBeNull();
  });

  it("при ошибке каталога остаётся значение из агента", async () => {
    catalogMode = "error";
    renderDetail();

    const rail = await screen.findByTestId("detail-rail");
    await waitFor(() => expect(within(rail).getByText("test-model")).toBeInTheDocument());
    expect(within(rail).queryByText("Карточка")).toBeNull();
  });

  it("строки Harness нет, старый ACP-агент открывается без ошибок", async () => {
    withAgent({ _oma: { harness: "acp-sandbox", acp: ACP_BLOCK } });
    renderDetail();

    const rail = await screen.findByTestId("detail-rail");
    expect(within(rail).getByText("test-model")).toBeInTheDocument();
    expect(within(rail).queryByText("Harness")).toBeNull();
    expect(within(rail).queryByText("claude-acp")).toBeNull();
  });
});

describe("AgentDetail: «Править с ассистентом»", () => {
  it("первой кнопкой в шапке открывает панель с контекстом агента", async () => {
    const setOpen = vi.fn();
    assistantMock.current = { open: false, setOpen, newConversation: vi.fn() };
    renderDetail();

    const button = await screen.findByRole("button", { name: "Править с ассистентом" });
    const header = button.closest("header")!;
    expect(within(header).getAllByRole("button")[0]).toBe(button);
    await userEvent.click(button);

    expect(setOpen).toHaveBeenCalledWith(true);
    assistantMock.current = null;
  });

  it("не показывается без провайдера ассистента", async () => {
    assistantMock.current = null;
    renderDetail();
    await screen.findByRole("heading", { level: 1, name: "OpenMA Demo Agent" });
    expect(screen.queryByRole("button", { name: "Править с ассистентом" })).toBeNull();
  });

  it("у архивного агента кнопки нет", async () => {
    assistantMock.current = { open: false, setOpen: vi.fn(), newConversation: vi.fn() };
    agentResult = { data: { ...agent, archived_at: "2026-10-01T00:00:00Z" } as typeof agent };
    renderDetail();
    await screen.findByRole("heading", { level: 1, name: /OpenMA Demo Agent/ });
    expect(screen.queryByRole("button", { name: "Править с ассистентом" })).toBeNull();
    assistantMock.current = null;
  });
});
