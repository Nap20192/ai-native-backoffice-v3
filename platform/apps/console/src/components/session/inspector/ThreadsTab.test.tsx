import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "../../../lib/session-stats";

const api = vi.hoisted(() => ({ agents: { retrieve: vi.fn() } }));
vi.mock("../../../lib/useManagedApi", () => ({ useManagedApi: () => api }));

import { ThreadsTab, type ThreadsTabProps } from "./ThreadsTab";

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
  api.agents.retrieve.mockReset().mockResolvedValue({ created_at: "2026-10-15T11:39:27.000Z" });
});

const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const agent = {
  id: "agent_main",
  name: "Исследователь",
  version: 1,
  description: null,
  model: { id: "claude-opus-5", effort: { type: "low" } },
};

const session = {
  id: "sesn_1",
  status: "idle",
  created_at: iso(-60_000),
  updated_at: iso(400_000),
  agent,
} as unknown as ThreadsTabProps["session"];

const primary = {
  id: "sthr_primary",
  type: "session_thread",
  agent,
  status: "idle",
  parent_thread_id: null,
  created_at: iso(-60_000),
} as unknown as ThreadsTabProps["threads"][number];

const worker = {
  id: "sthr_2",
  type: "session_thread",
  agent: { ...agent, id: "agent_w", name: "Проверяющий", version: 3, model: { id: "model-w" } },
  status: "running",
  parent_thread_id: "sthr_primary",
  created_at: iso(10_000),
} as unknown as ThreadsTabProps["threads"][number];

function end(id: string, start: string, at: number, usage: Record<string, number>, thread?: string): SessionEvent {
  return {
    type: "span.model_request_end",
    id,
    model_request_start_id: start,
    processed_at: iso(at),
    model_usage: usage,
    ...(thread ? { session_thread_id: thread } : {}),
  } as SessionEvent;
}

const events: SessionEvent[] = [
  { type: "session.thread_status_running", id: "r1", processed_at: iso(0) } as SessionEvent,
  { type: "span.model_request_start", id: "s1", processed_at: iso(1_000) } as SessionEvent,
  end("e1", "s1", 11_000, {
    input_tokens: 100,
    output_tokens: 800,
    cache_read_input_tokens: 20_000,
    cache_creation_input_tokens: 6_000,
  }),
  { type: "session.thread_status_idle", id: "i1", processed_at: iso(309_000) } as SessionEvent,
  { type: "span.model_request_start", id: "ws1", processed_at: iso(20_000), session_thread_id: "sthr_2" } as SessionEvent,
  end("we1", "ws1", 30_000, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, "sthr_2"),
];

function props(overrides: Partial<ThreadsTabProps> = {}): ThreadsTabProps {
  return {
    session,
    threads: [primary, worker],
    events,
    activeThreadId: "sthr_primary",
    onSelectThread: vi.fn(),
    ...overrides,
  };
}

function renderTab(overrides: Partial<ThreadsTabProps> = {}) {
  const p = props(overrides);
  const view = render(
    <MemoryRouter>
      <ThreadsTab {...p} />
    </MemoryRouter>,
  );
  return { ...view, props: p };
}

function threadRow(name: string): HTMLElement {
  const table = screen.getByRole("table", { name: "Потоки" });
  return within(table).getByRole("row", { name: new RegExp(name) });
}

describe("ThreadsTab: таблица потоков", () => {
  it("колонки «Поток» и «Статус», колонок про контекст и стоимость нет", () => {
    renderTab();

    const table = screen.getByRole("table", { name: "Потоки" });
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Поток",
      "Статус",
    ]);
  });

  it("строка потока: имя агента и статус, число токенов и цена не рисуются", () => {
    renderTab();

    const cells = within(threadRow("Исследователь")).getAllByRole("cell");
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent("Исследователь");
    expect(cells[1]).toHaveTextContent("Ожидает");
    expect(threadRow("Исследователь")).not.toHaveTextContent(/тыс\.|\$|нет цены/);
  });

  it("у второго потока тоже имя и статус", () => {
    renderTab();

    const cells = within(threadRow("Проверяющий")).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent("Проверяющий");
    expect(cells[1]).toHaveTextContent("Выполняется");
  });

  it("выбранный поток отмечен, клик по другому сообщает его id", async () => {
    const { props: p } = renderTab();

    expect(threadRow("Исследователь")).toHaveAttribute("aria-selected", "true");
    expect(threadRow("Проверяющий")).toHaveAttribute("aria-selected", "false");

    await userEvent.click(within(threadRow("Проверяющий")).getByText("Проверяющий"));

    expect(p.onSelectThread).toHaveBeenCalledWith("sthr_2");
  });

  it("если основного потока нет в списке, строка берётся из снимка сессии", () => {
    renderTab({ threads: [worker] });

    expect(threadRow("Исследователь")).toBeInTheDocument();
    expect(threadRow("Проверяющий")).toBeInTheDocument();
  });

  it("у сессии без потоков в списке всё равно одна строка основного", () => {
    renderTab({ threads: [] });

    expect(threadRow("Исследователь")).toHaveAttribute("aria-selected", "true");
  });
});

describe("ThreadsTab: деталь потока", () => {
  it("деталь стоит снизу на половину высоты, как в «Событиях» и «Инструментах», над ней прокручивается список", () => {
    renderTab();

    const detail = screen.getByRole("region", { name: "Поток Исследователь" });
    expect(detail).toHaveClass("h-1/2", "shrink-0");
    expect(screen.getByRole("table", { name: "Потоки" }).closest("[data-threads-list]")).toHaveClass("flex-1", "overflow-y-auto");
    expect(within(detail).getByText("Поток", { exact: true })).toHaveClass("text-ddc-text-muted");
  });

  it("заголовок с именем, подробности и активное время выбранного потока", () => {
    renderTab();

    const detail = screen.getByRole("region", { name: "Поток Исследователь" });
    expect(within(detail).getByText("Подробности")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: /Исследователь/ })).toHaveAttribute(
      "href",
      "/agents/agent_main",
    );
    expect(within(detail).getByText("v1")).toBeInTheDocument();
    expect(within(detail).getByText("claude-opus-5")).toHaveClass("font-mono");
    expect(within(detail).getByText("Низкое усилие")).toBeInTheDocument();

    const table = within(detail).getByRole("table", { name: "Использование" });
    expect(within(table).getByRole("columnheader", { name: "Этот поток" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]!).getAllByRole("cell")[0]).toHaveTextContent("Активное время");
    expect(within(rows[1]!).getAllByRole("cell")[1]).toHaveTextContent("5 мин 9 с");
  });

  it("контекста, графика, стоимости и токенов нет, хотя события потока их несут", () => {
    const { container } = renderTab();

    expect(screen.queryByText("Контекст")).toBeNull();
    expect(screen.queryByRole("img", { name: "График контекста" })).toBeNull();
    expect(container.querySelector("[data-chart-plot]")).toBeNull();
    expect(container).not.toHaveTextContent(/токен|стоимост|кэш|контекст|нет цены|\$/i);
  });

  it("деталь следует за выбранным потоком", () => {
    renderTab({ activeThreadId: "sthr_2" });

    const detail = screen.getByRole("region", { name: "Поток Проверяющий" });
    expect(within(detail).getByText("v3")).toBeInTheDocument();
    expect(within(detail).getByText("model-w")).toBeInTheDocument();
    const table = within(detail).getByRole("table", { name: "Использование" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  it("поток без событий: активное время прочерк", () => {
    renderTab({ events: [], activeThreadId: "sthr_primary" });

    const detail = screen.getByRole("region", { name: "Поток Исследователь" });
    const cells = within(within(detail).getByRole("row", { name: /^Активное время/ })).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("–");
  });
});
