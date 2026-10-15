import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";

import { I18nProvider } from "../i18n";
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

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string | null) => {
    if (path === "/v1/agents/agent-1") return agentResult;
    if (path === "/v1/agents/agent-1/versions") return { data: { data: [agent] } };
    return { data: { data: [] } };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("../lib/api", () => ({
  useApi: () => ({
    api: vi.fn(async (path: string) =>
      path === "/v1/oma/runtimes" ? { runtimes: [] } : { data: [] },
    ),
  }),
}));

vi.mock("./agents/AgentFormDialog", () => ({ AgentFormDialog: () => null }));

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/agents/agent-1"]}>
      <I18nProvider>
        <Routes>
          <Route path="/agents/:id" element={<AgentDetail />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  agentResult = { data: agent };
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
    expect(dialog).toHaveAccessibleDescription(/Действие нельзя отменить/);

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
