import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { AgentDetail } from "./AgentDetail";

const managed = vi.hoisted(() => ({
  agents: { list: vi.fn(), update: vi.fn(), archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn() },
  skills: { list: vi.fn() },
}));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));

const AGENT_V3 = {
  id: "agent-1",
  name: "Юрист",
  model: "qwen",
  system: "Новый промпт",
  tools: [],
  version: 3,
  created_at: "2026-08-31T10:00:00.000Z",
  updated_at: "2026-08-31T11:00:00.000Z",
  archived_at: null as string | null,
};
const AGENT_V2 = { ...AGENT_V3, version: 2, system: "Старый промпт" };

const current = vi.hoisted(() => ({ agent: null as unknown, versions: [] as unknown[] }));

vi.mock("../lib/useApiQuery", () => ({
  useApiQuery: (path: string | null) => {
    if (path === "/v1/agents/agent-1") return { data: current.agent };
    if (path === "/v1/agents/agent-1/versions") return { data: { data: current.versions } };
    return { data: { data: [] } };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("./agents/AgentFormDialog", () => ({ AgentFormDialog: () => null }));
vi.mock("../components/assistant/AssistantProvider", () => ({ useOptionalAssistant: () => null }));

let dependencies: { blocking: unknown[]; affected: unknown[]; truncated: boolean };

beforeEach(() => {
  current.agent = AGENT_V3;
  current.versions = [AGENT_V3, AGENT_V2];
  dependencies = { blocking: [], affected: [], truncated: false };
  managed.agents.list.mockReset().mockResolvedValue({ data: [] });
  managed.agents.update.mockReset().mockResolvedValue({});
  managed.agents.archive.mockReset().mockResolvedValue({});
  managed.agents.unarchive.mockReset().mockResolvedValue({});
  managed.agents.delete.mockReset().mockResolvedValue({});
  managed.skills.list.mockReset().mockResolvedValue({ data: [] });
  server.use(
    http.get("*/v1/oma/model_cards", () => HttpResponse.json({ data: [] })),
    http.get("*/v1/oma/runtimes", () => HttpResponse.json({ runtimes: [] })),
    http.get("*/v1/oma/model_options", () => HttpResponse.json({ builtin_available: true, data: [] })),
    http.get("*/v1/oma/harnesses", () => HttpResponse.json({ data: [] })),
    http.get("*/v1/oma/dependencies/agent/:id", () => HttpResponse.json(dependencies)),
  );
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function renderDetail() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/agents/agent-1"]}>
        <I18nProvider>
          <Routes>
            <Route path="/agents/:id" element={<AgentDetail />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AgentDetail: удаление, восстановление, деплоймент", () => {
  it("«Удалить» с блокирующей сессией: кнопка выключена, «Это нельзя отменить»", async () => {
    dependencies = {
      blocking: [{ kind: "session", id: "sesn_1", name: "Заявка", status: "running", note: null }],
      affected: [],
      truncated: false,
    };
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить агента?" });
    expect(within(dialog).getByText(/Это нельзя отменить/)).toBeInTheDocument();
    expect(await within(dialog).findByText("Мешает")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeDisabled();
  });

  it("удаление без зависимостей шлёт If-Match с версией и ведёт к списку", async () => {
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Удалить" }));
    const dialog = await screen.findByRole("dialog", { name: "Удалить агента?" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Удалить" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(managed.agents.delete).toHaveBeenCalledWith("agent-1", { ifMatch: '"3"' }));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/agents"));
  });

  it("«Восстановить эту версию» шлёт поля старой версии и текущую version", async () => {
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Восстановить версию 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Восстановить версию 2?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Восстановить" }));

    await waitFor(() =>
      expect(managed.agents.update).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({ version: 3, system: "Старый промпт", model: "qwen" }),
      ),
    );
  });

  it("у текущей версии кнопки восстановления нет", async () => {
    renderDetail();
    await screen.findByRole("button", { name: "Восстановить версию 2" });
    expect(screen.queryByRole("button", { name: "Восстановить версию 3" })).toBeNull();
  });

  it("архивный агент возвращается кнопкой «Вернуть из архива» с If-Match", async () => {
    current.agent = { ...AGENT_V3, archived_at: "2026-10-05T00:00:00Z" };
    renderDetail();

    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Вернуть из архива" }));

    await waitFor(() => expect(managed.agents.unarchive).toHaveBeenCalledWith("agent-1", { ifMatch: '"3"' }));
  });

  it("«Создать деплоймент» открывает форму деплоймента с этим агентом", async () => {
    renderDetail();

    await userEvent.click(await screen.findByRole("button", { name: "Создать деплоймент" }));

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/deployments/new?agent=agent-1"));
  });
});
