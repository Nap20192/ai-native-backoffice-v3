import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { I18nProvider } from "../i18n";
import { AgentsList } from "./AgentsList";

const managed = vi.hoisted(() => ({
  agents: { list: vi.fn(), archive: vi.fn() },
  skills: { list: vi.fn() },
}));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managed }));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({ api: vi.fn(async () => ({ data: [] })) }),
}));

vi.mock("../lib/useApiQuery", () => ({
  useInfiniteApiQuery: () => ({
    items: [{ id: "agent-1", name: "Юрист", model: "qwen", created_at: "2026-10-01T10:00:00Z" }],
    isLoading: false,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("./agents/AgentFormDialog", () => ({ AgentFormDialog: () => null }));

const assistantMock = vi.hoisted(() => ({
  current: null as null | { open: boolean; setOpen: (open: boolean) => void },
}));
vi.mock("../components/assistant/AssistantProvider", () => ({
  useOptionalAssistant: () => assistantMock.current,
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  managed.agents.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.skills.list.mockReset().mockResolvedValue({ data: [] });
  assistantMock.current = null;
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname}</output>;
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={["/agents"]}>
      <I18nProvider>
        <Routes>
          <Route path="/agents" element={<AgentsList />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("AgentsList: ассистент", () => {
  it("кнопка «Описать агента» ведёт на /agents/new", async () => {
    renderList();
    await userEvent.click(await screen.findByRole("button", { name: "Описать агента" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/agents/new");
  });

  it("пункт строки «Править с ассистентом» открывает агента и панель", async () => {
    const setOpen = vi.fn();
    assistantMock.current = { open: false, setOpen };
    renderList();
    await screen.findByText("Юрист");
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.contextMenu(screen.getByText("Юрист"));

    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("Править с ассистентом");
    await userEvent.click(items[0]);

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/agents/agent-1"));
    expect(setOpen).toHaveBeenCalledWith(true);
  });

  it("без провайдера пункта нет", async () => {
    renderList();
    await screen.findByText("Юрист");
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.contextMenu(screen.getByText("Юрист"));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).not.toContain("Править с ассистентом");
  });
});
