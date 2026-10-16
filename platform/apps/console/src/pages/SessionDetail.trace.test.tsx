import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { normalizeSpan } from "../lib/trace-api";
import { server } from "../mocks/server";
import { SessionDetail } from "./SessionDetail";

/**
 * Страница с настоящими вкладкой «Трейс» и инспектором «События»: проверяем
 * то, что в SessionDetail.layout.test.tsx закрыто заглушками, то есть путь
 * выбора события между трейсом, инспектором и разговором. Разговор остаётся
 * заглушкой, ему здесь нужен только выбор.
 */

type Frame = Record<string, unknown>;

const api = vi.hoisted(() => ({
  sessions: {
    retrieve: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    threads: { list: vi.fn() },
    events: { list: vi.fn(), stream: vi.fn(), send: vi.fn() },
    resources: { list: vi.fn(), add: vi.fn() },
  },
  environments: { retrieve: vi.fn() },
  vaults: { retrieve: vi.fn() },
  agents: { retrieve: vi.fn() },
  files: { upload: vi.fn() },
}));

vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => api }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

vi.mock("../components/session/ManagedSessionConversation", () => ({
  ManagedSessionConversation: (props: Record<string, any>) => (
    <div
      data-testid="conversation"
      data-selected={props.selection?.eventId ?? ""}
      data-source={props.selection?.source ?? ""}
    />
  ),
}));

const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const ISO = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

const SESSION = {
  id: "sesn_1",
  type: "session",
  status: "idle",
  title: "Проверка",
  created_at: ISO(-60_000),
  updated_at: ISO(13_000),
  archived_at: null,
  agent: { id: "agent_1", name: "Юрист", version: 1, description: null, model: { id: "m1" }, tools: [] },
  environment_id: "env_1",
  deployment_id: null,
  vault_ids: [],
  metadata: {},
  outcome_evaluations: [],
  resources: [],
};

const HISTORY: Frame[] = [
  { type: "user.message", id: "evt_1", content: [{ type: "text", text: "Привет" }], processed_at: ISO(0) },
  { type: "span.model_request_start", id: "evt_s1", processed_at: ISO(1_000) },
  { type: "span.model_request_end", id: "evt_e1", model_request_start_id: "evt_s1", processed_at: ISO(11_000) },
  { type: "agent.tool_use", id: "evt_use1", name: "bash", input: { command: "ls" }, processed_at: ISO(11_000) },
  { type: "agent.tool_result", id: "evt_res1", tool_use_id: "evt_use1", content: [{ type: "text", text: "a.txt" }], processed_at: ISO(11_500) },
  { type: "agent.message", id: "evt_2", content: [{ type: "text", text: "Готово" }], processed_at: ISO(12_000) },
  { type: "session.status_idle", id: "evt_idle", stop_reason: { type: "end_turn" }, processed_at: ISO(12_100) },
];

const TURN_ID = "a100000000000001";
const MODEL_ID = "a100000000000010";
const TOOL_ID = "a100000000000020";
const TURN = normalizeSpan({
  span_id: TURN_ID,
  turn_id: "evt_1",
  kind: "turn",
  name: "Юрист",
  harness: "pi",
  start_ms: T0,
  end_ms: T0 + 12_100,
  primary_event_id: "evt_1",
  event_ids: ["evt_1", "evt_idle"],
});
const OVERVIEW = {
  trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
  session_id: "sesn_1",
  turns: [
    {
      turn: TURN,
      state: "complete",
      partial: false,
      lost: [],
      coverage: { model_calls: "measured", tools: "measured", sandbox: "attempts" },
      span_count: 3,
      error_count: 0,
      waiting_count: 0,
      version: 1,
    },
  ],
  turns_before: null,
  spans: [
    TURN,
    normalizeSpan({
      span_id: MODEL_ID,
      parent_span_id: TURN_ID,
      turn_id: "evt_1",
      kind: "model_call",
      name: "m1",
      model: "m1",
      harness: "pi",
      usage: { input: 1_200, output: 340, cache_read: 0, cache_write: 0 },
      start_ms: T0 + 1_000,
      end_ms: T0 + 11_000,
      primary_event_id: "evt_s1",
      event_ids: ["evt_s1", "evt_e1"],
    }),
    normalizeSpan({
      span_id: TOOL_ID,
      parent_span_id: TURN_ID,
      turn_id: "evt_1",
      kind: "tool_call",
      name: "bash",
      harness: "pi",
      start_ms: T0 + 11_000,
      end_ms: T0 + 11_500,
      tool: { name: "bash", call_id: "evt_use1", kind: "builtin", mcp_server: null },
      primary_event_id: "evt_use1",
      event_ids: ["evt_use1", "evt_res1"],
    }),
  ],
  spans_next: null,
  cursor: "c1",
  collecting: false,
};

const traceRequests: string[] = [];

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function openPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
        </Routes>
        <LocationProbe />
      </I18nProvider>
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent ?? "";
const traceRow = (spanId: string) => document.querySelector<HTMLElement>(`[data-span-id="${spanId}"]`);
const eventRow = (eventId: string) =>
  document.querySelector<HTMLElement>(`[role="row"][data-event-id="${eventId}"]`);

async function pageReady() {
  await screen.findByRole("heading", { level: 1, name: "Проверка" });
  await waitFor(() => expect(api.sessions.events.list).toHaveBeenCalled());
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

beforeEach(() => {
  localStorage.clear();
  traceRequests.length = 0;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;

  api.sessions.retrieve.mockReset().mockResolvedValue(SESSION);
  api.sessions.threads.list.mockReset().mockResolvedValue({ data: [] });
  api.sessions.events.list.mockReset().mockResolvedValue({ data: HISTORY, next_page: null });
  api.sessions.events.stream.mockReset().mockImplementation(
    async (_id: string, _params: unknown, options?: { signal?: AbortSignal }) => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<Frame>>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve({ value: undefined, done: true }));
            }),
        };
      },
    }),
  );
  api.environments.retrieve.mockReset().mockResolvedValue({ id: "env_1", name: "Основное", created_at: ISO(-120_000) });

  server.use(
    http.get("*/v1/oma/sessions/sesn_1/trace", ({ request }) => {
      traceRequests.push(new URL(request.url).search);
      return HttpResponse.json(OVERVIEW);
    }),
  );
});

describe("SessionDetail с настоящим трейсом", () => {
  it("в разговоре за трейсом не ходит, во вкладке «Трейс» грузит его и рисует строки", async () => {
    openPage("/sessions/sesn_1?inspector=events");
    await pageReady();
    await screen.findByTestId("conversation");
    expect(traceRequests).toEqual([]);

    await userEvent.click(screen.getByRole("tab", { name: "Трейс" }));

    expect(await screen.findByRole("treegrid", { name: "Трейс" })).toBeInTheDocument();
    expect(traceRequests).toEqual([""]);
    expect(traceRow(TOOL_ID)).not.toBeNull();
    expect(within(traceRow(TOOL_ID)!).getByText("bash")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation")).toBeNull();
  });

  it("клик по узлу выделяет его событие во вкладке «События» и пишет ?event=", async () => {
    openPage("/sessions/sesn_1?view=trace&inspector=events");
    await pageReady();
    await screen.findByRole("treegrid", { name: "Трейс" });
    await waitFor(() => expect(eventRow("evt_use1")).not.toBeNull());

    await userEvent.click(traceRow(TOOL_ID)!);

    expect(location()).toContain("event=evt_use1");
    expect(eventRow("evt_use1")).toHaveAttribute("aria-selected", "true");
    expect(traceRow(TOOL_ID)).toHaveAttribute("aria-selected", "true");
  });

  it("строка во вкладке «События» выделяет узел трейса, а узел с другим событием теряет выделение", async () => {
    openPage("/sessions/sesn_1?view=trace&inspector=events&event=evt_use1");
    await pageReady();
    await screen.findByRole("treegrid", { name: "Трейс" });
    await waitFor(() => expect(traceRow(TOOL_ID)).toHaveAttribute("aria-selected", "true"));

    await userEvent.click(eventRow("evt_s1")!);

    expect(location()).toContain("event=evt_s1");
    await waitFor(() => expect(traceRow(MODEL_ID)).toHaveAttribute("aria-selected", "true"));
    expect(traceRow(TOOL_ID)).toHaveAttribute("aria-selected", "false");
  });

  it("«В разговоре» открывает разговор с выбранным событием, а возврат в трейс снова показывает узел", async () => {
    openPage("/sessions/sesn_1?view=trace&inspector=events");
    await pageReady();
    await screen.findByRole("treegrid", { name: "Трейс" });
    await userEvent.click(traceRow(TOOL_ID)!);

    await userEvent.click(await screen.findByRole("button", { name: "В разговоре" }));

    const conversation = await screen.findByTestId("conversation");
    expect(conversation).toHaveAttribute("data-selected", "evt_use1");
    expect(conversation).toHaveAttribute("data-source", "trace");
    expect(location()).toContain("view=conversation");
    expect(location()).toContain("event=evt_use1");
    expect(screen.queryByRole("treegrid", { name: "Трейс" })).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Трейс" }));

    await screen.findByRole("treegrid", { name: "Трейс" });
    await waitFor(() => expect(traceRow(TOOL_ID)).toHaveAttribute("aria-selected", "true"));
    expect(eventRow("evt_use1")).toHaveAttribute("aria-selected", "true");
  });

  it("токены есть только в деталях вызова модели, стоимости и итоговых сумм в трейсе нет", async () => {
    openPage("/sessions/sesn_1?view=trace&inspector=events");
    await pageReady();
    await screen.findByRole("treegrid", { name: "Трейс" });

    await userEvent.click(traceRow(MODEL_ID)!);

    const details = await screen.findByRole("region", { name: "Детали узла" });
    expect(within(details).getByText("Токены на входе")).toBeInTheDocument();
    expect(within(details).getByText("Токены на выходе")).toBeInTheDocument();

    await userEvent.click(traceRow(TURN_ID)!);
    const turnDetails = await screen.findByRole("region", { name: "Детали узла" });
    expect(within(turnDetails).queryByText(/токен/i)).toBeNull();

    const trace = document.querySelector<HTMLElement>("[data-trace-view]")!;
    expect(trace).not.toHaveTextContent(/стоимост|цен[аы]|\$|итого|всего|бюджет/i);
  });
});
