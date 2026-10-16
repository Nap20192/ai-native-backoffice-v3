import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { server } from "../mocks/server";
import { SessionDetail } from "./SessionDetail";

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

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

/** Разговор, вкладки «События» и «Инструменты» чужие: проверяем, что страница
 *  отдаёт им и что от них принимает. */
const seen = vi.hoisted(() => ({
  conversation: null as null | Record<string, any>,
  events: null as null | Record<string, any>,
  tools: null as null | Record<string, any>,
  trace: null as null | Record<string, any>,
}));

vi.mock("../components/session/ManagedSessionConversation", () => ({
  ManagedSessionConversation: (props: Record<string, any>) => {
    seen.conversation = props;
    return (
      <div
        data-testid="conversation"
        data-agent-name={props.agentName}
        data-running={String(props.running)}
        data-selected={props.selection?.eventId ?? ""}
        data-source={props.selection?.source ?? ""}
        data-seq={props.selection?.seq ?? ""}
        data-turns={props.turns?.length ?? 0}
      >
        <div data-session-toolbar>{props.toolbarTrailing}</div>
        {props.overlay ? <div data-testid="conversation-overlay">{props.overlay}</div> : null}
        {props.empty}
        {props.composer}
      </div>
    );
  },
}));

vi.mock("../components/session/inspector/EventsTab", () => ({
  EventsTab: (props: Record<string, any>) => {
    seen.events = props;
    return (
      <div data-testid="events-tab" data-count={props.events.length} data-selected={props.selection.eventId ?? ""}>
        <button type="button" onClick={() => props.onSelectEvent("evt_2", "events")}>
          Выбрать событие
        </button>
      </div>
    );
  },
  copyEventsToClipboard: vi.fn().mockResolvedValue(undefined),
  downloadEventsFile: vi.fn(),
}));

vi.mock("../components/session/inspector/ToolsTab", () => ({
  ToolsTab: (props: Record<string, any>) => {
    seen.tools = props;
    return (
      <div data-testid="tools-tab" data-selected={props.selection.eventId ?? ""}>
        <button type="button" onClick={() => props.onSelectEvent("tool_1", "tools")}>
          Выбрать вызов
        </button>
      </div>
    );
  },
}));

/** Вкладка «Трейс» чужая: проверяем, что страница ей отдаёт и что от неё принимает. */
vi.mock("../components/session/trace/TraceView", () => ({
  TraceView: (props: Record<string, any>) => {
    seen.trace = props;
    return (
      <div
        data-testid="trace-view"
        data-session-id={props.sessionId}
        data-running={String(props.running)}
        data-events={props.events.length}
        data-selected={props.selection?.eventId ?? ""}
        data-source={props.selection?.source ?? ""}
        data-seq={props.selection?.seq ?? ""}
      >
        <input aria-label="Найти в трейсе" ref={props.searchInputRef} />
        <button type="button" onClick={() => props.onSelectEvent("evt_2", "trace")}>
          Выбрать узел
        </button>
        <button type="button" onClick={() => props.onSelectEvent(null, "trace")}>
          Выбрать узел без события
        </button>
        <button type="button" onClick={() => props.onShowInTranscript("evt_2")}>
          Показать узел в разговоре
        </button>
        <button type="button" onClick={() => props.onShowInTranscript("evt_w2")}>
          Показать узел потока в разговоре
        </button>
        <button type="button" onClick={() => props.onOpenThread?.("sthr_2")}>
          Открыть поток узла
        </button>
      </div>
    );
  },
}));

import * as eventsTabModule from "../components/session/inspector/EventsTab";

const SESSION = {
  id: "sesn_1",
  type: "session",
  status: "idle",
  title: "Проверка",
  created_at: "2026-10-15T11:39:27.000Z",
  updated_at: "2026-10-16T01:41:27.000Z",
  archived_at: null,
  agent: {
    id: "agent_1",
    name: "Юрист",
    version: 2,
    description: null,
    model: { id: "m1" },
    tools: [{ type: "agent_toolset_20260401" }],
  },
  environment_id: "env_1",
  deployment_id: null,
  vault_ids: [],
  metadata: {},
  budget: { type: "limit", max_list_cost: { amount: "500", currency: "USD" } },
  outcome_evaluations: [],
  resources: [],
};

/** Основной поток и поток сабагента «Проверяющий», в котором идут события evt_ws1 и evt_w2. */
const THREADS = [
  {
    id: "sthr_primary",
    type: "session_thread",
    agent: SESSION.agent,
    status: "idle",
    parent_thread_id: null,
  },
  {
    id: "sthr_2",
    type: "session_thread",
    agent: { id: "agent_w", name: "Проверяющий", version: 1, model: { id: "m2" }, tools: [] },
    status: "idle",
    parent_thread_id: "sthr_primary",
  },
];

const ISO = (offsetMs: number) => new Date(Date.parse("2026-10-15T12:00:00.000Z") + offsetMs).toISOString();

const HISTORY: Frame[] = [
  { type: "user.message", id: "evt_1", content: [{ type: "text", text: "Привет" }], processed_at: ISO(0) },
  { type: "span.model_request_start", id: "evt_s1", processed_at: ISO(1_000) },
  {
    type: "span.model_request_end",
    id: "evt_e1",
    model_request_start_id: "evt_s1",
    processed_at: ISO(11_000),
    model_usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
  { type: "agent.message", id: "evt_2", content: [{ type: "text", text: "Здравствуйте" }], processed_at: ISO(12_000) },
  { type: "span.model_request_start", id: "evt_ws1", processed_at: ISO(20_000), session_thread_id: "sthr_2" },
  { type: "agent.message", id: "evt_w2", content: [{ type: "text", text: "Из потока" }], processed_at: ISO(21_000), session_thread_id: "sthr_2" },
];

const state = vi.hoisted(() => ({
  history: [] as Frame[],
  threads: [] as unknown[],
  status: "idle",
  narrow: false,
}));

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function openPage(path = "/sessions/sesn_1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <I18nProvider>
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/sessions" element={<p>Список сессий</p>} />
        </Routes>
        <LocationProbe />
      </I18nProvider>
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId("location").textContent;

async function pageReady() {
  await screen.findByRole("heading", { level: 1, name: "Проверка" });
  await waitFor(() => expect(api.sessions.events.list).toHaveBeenCalled());
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

beforeEach(() => {
  localStorage.clear();
  state.history = HISTORY;
  state.threads = [];
  state.status = "idle";
  state.narrow = false;
  seen.conversation = null;
  seen.events = null;
  seen.tools = null;
  seen.trace = null;
  for (const fn of Object.values(toast)) fn.mockReset();
  vi.mocked(eventsTabModule.copyEventsToClipboard).mockClear();
  vi.mocked(eventsTabModule.downloadEventsFile).mockClear();

  window.matchMedia = ((query: string) => ({
    matches: state.narrow && query.includes("max-width"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;

  api.sessions.retrieve.mockReset().mockImplementation(async () => ({ ...SESSION, status: state.status }));
  api.sessions.update.mockReset().mockImplementation(async (_id: string, body: Record<string, unknown>) => ({
    ...SESSION,
    ...body,
  }));
  api.sessions.archive.mockReset().mockResolvedValue({ ...SESSION, archived_at: "2026-10-16T02:00:00.000Z" });
  api.sessions.threads.list.mockReset().mockImplementation(async () => ({ data: state.threads }));
  api.sessions.events.list.mockReset().mockImplementation(async () => ({ data: state.history, next_page: null }));
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
  api.sessions.events.send.mockReset().mockResolvedValue({ data: [] });
  api.sessions.resources.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  api.sessions.resources.add.mockReset().mockResolvedValue({});
  api.environments.retrieve.mockReset().mockResolvedValue({
    id: "env_1",
    name: "Основное",
    scope: "organization",
    config: { type: "cloud" },
    created_at: "2026-10-15T00:00:00.000Z",
  });
  api.vaults.retrieve.mockReset().mockResolvedValue({ id: "vlt_1", display_name: "Ключи" });
  api.agents.retrieve.mockReset().mockResolvedValue({ id: "agent_1", created_at: "2026-10-15T00:00:00.000Z" });
  api.files.upload.mockReset().mockResolvedValue({ id: "file_1" });

  server.use(http.get("*/v1/sessions/sesn_1/outputs", () => HttpResponse.json({ data: [], has_more: false })));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionDetail: шапка", () => {
  it("рисует ID, название, статус, агента и окружение", async () => {
    openPage();
    await pageReady();

    expect(screen.getAllByText("sesn_1").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Ожидает", { selector: "span" }).length).toBeGreaterThanOrEqual(1);
    const header = within(screen.getByRole("banner", { hidden: true }));
    expect(await header.findByRole("link", { name: /Юрист/ })).toHaveAttribute("href", "/agents/agent_1");
    expect(await header.findByRole("link", { name: /Основное/ })).toHaveAttribute("href", "/environments/env_1");
  });

  it("переименование идёт в POST /v1/sessions/:id с title", async () => {
    openPage();
    await pageReady();

    await userEvent.click(within(screen.getByRole("heading", { level: 1 })).getByRole("button"));
    const field = screen.getByRole("textbox", { name: "Название сессии" });
    await userEvent.clear(field);
    await userEvent.type(field, "Новое имя{Enter}");

    await waitFor(() => expect(api.sessions.update).toHaveBeenCalledWith("sesn_1", { title: "Новое имя" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Новое имя" })).toBeInTheDocument();
  });

  it("«Хронологии» и кнопок «Файлы» и «Траектория» в шапке нет, вид переключают вкладки над лентой", async () => {
    openPage();
    await pageReady();

    expect(screen.queryByRole("tab", { name: "Хронология" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Файлы сессии" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Траектория" })).toBeNull();
    const header = screen.getByRole("banner", { hidden: true });
    expect(within(header).queryByRole("tablist")).toBeNull();
    const views = screen.getByRole("tablist", { name: "Вид сессии" });
    expect(within(views).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Разговор", "Трейс"]);
  });

  it("шапка и вкладка «Сессия» не показывают токены, стоимость и бюджет", async () => {
    openPage();
    await pageReady();

    const header = screen.getByRole("banner", { hidden: true });
    const inspector = await screen.findByRole("complementary", { name: "Инспектор сессии" });
    // Сессия несёт бюджет $5, события несут токены: на экране от них ничего нет.
    for (const area of [header, inspector]) {
      expect(area).not.toHaveTextContent(/токен|стоимост|бюджет|нет цены|кэш|\$/i);
    }
    expect(document.querySelector('[data-session-chip="tokens"]')).toBeNull();
    expect(document.querySelector('[data-session-chip="cost"]')).toBeNull();
    expect(screen.queryByRole("img", { name: "График стоимости" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Изменить бюджет" })).toBeNull();
    // Длительность и активность остаются.
    expect(header.querySelector('[data-session-chip="duration"]')).not.toBeNull();
    expect(header.querySelector('[data-session-chip="activity"]')).not.toBeNull();
  });

  it("страница не ходит за аналитикой и ценами моделей", async () => {
    const requested: string[] = [];
    const onStart = ({ request }: { request: Request }) => {
      requested.push(new URL(request.url).pathname);
    };
    server.events.on("request:start", onStart);
    try {
      openPage("/sessions/sesn_1?inspector=thread");
      await pageReady();
      await screen.findByRole("table", { name: "Потоки" });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    } finally {
      server.events.removeListener("request:start", onStart);
    }

    expect(requested.filter((path) => /\/v1\/oma\/(analytics|model_cards)/.test(path))).toEqual([]);
  });
});

describe("SessionDetail: загрузка", () => {
  it("пока сессия и история не пришли, в шапке и в ленте стоят скелетоны", async () => {
    api.sessions.retrieve.mockReturnValue(new Promise(() => {}));
    api.sessions.events.list.mockReturnValue(new Promise(() => {}));
    openPage();

    const loading = await screen.findAllByRole("status");
    const texts = loading.map((node) => node.textContent);
    expect(texts.filter((text) => text?.includes("Загрузка сессии…")).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("пока история грузится, «События» и «Инструменты» показывают скелетон, а не пустой список", async () => {
    api.sessions.events.list.mockReturnValue(new Promise(() => {}));
    openPage("/sessions/sesn_1?inspector=events");

    const inspector = await screen.findByRole("complementary", { name: "Инспектор сессии" });
    const panel = within(inspector).getByRole("tabpanel");
    expect(within(panel).getByRole("status")).toHaveTextContent("Загрузка сессии…");
    expect(screen.queryByTestId("events-tab")).toBeNull();

    await userEvent.click(screen.getByRole("tab", { name: "Инструменты" }));
    expect(within(within(inspector).getByRole("tabpanel")).getByRole("status")).toBeInTheDocument();
    expect(screen.queryByTestId("tools-tab")).toBeNull();
  });

  it("после загрузки истории скелетон ленты уходит", async () => {
    openPage();
    await pageReady();

    await waitFor(() => expect(screen.queryAllByText("Загрузка сессии…")).toHaveLength(0));
  });
});

describe("SessionDetail: инспектор", () => {
  it("на десктопе открыт на вкладке «Сессия»", async () => {
    openPage();
    await pageReady();

    const inspector = await screen.findByRole("complementary", { name: "Инспектор сессии" });
    expect(inspector).toHaveAttribute("data-layout", "side");
    expect(within(inspector).getByRole("tab", { name: "Сессия" })).toHaveAttribute("aria-selected", "true");
    expect(within(inspector).getByText("Использование")).toBeInTheDocument();
  });

  it("?inspector=events&event=<id> при загрузке открывает вкладку и выбирает событие", async () => {
    openPage("/sessions/sesn_1?inspector=events&event=evt_2");
    await pageReady();

    const inspector = await screen.findByRole("complementary", { name: "Инспектор сессии" });
    expect(within(inspector).getByRole("tab", { name: "События" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("events-tab")).toHaveAttribute("data-selected", "evt_2");
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-selected", "evt_2");
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-source", "url");
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-seq", "0");
  });

  it("параметр inspector открывает инспектор, даже если в прошлый раз его закрыли", async () => {
    localStorage.setItem("oma.session.inspector", JSON.stringify({ open: false, width: 480 }));
    openPage("/sessions/sesn_1?inspector=tools");
    await pageReady();

    expect(await screen.findByTestId("tools-tab")).toBeInTheDocument();
  });

  it("клик по вкладке пишет её в адрес и показывает содержимое", async () => {
    openPage();
    await pageReady();

    await userEvent.click(await screen.findByRole("tab", { name: "Инструменты" }));

    expect(location()).toContain("inspector=tools");
    expect(screen.getByTestId("tools-tab")).toBeInTheDocument();
    expect(seen.tools?.agentTools).toEqual(SESSION.agent.tools);
  });

  it("вкладки показывают события выбранного потока, а не всех", async () => {
    openPage("/sessions/sesn_1?inspector=events");
    await pageReady();

    expect(await screen.findByTestId("events-tab")).toHaveAttribute("data-count", "4");
  });

  it("выбор события во вкладке пишет ?event= с заменой записи и поднимает seq", async () => {
    openPage("/sessions/sesn_1?inspector=events");
    await pageReady();

    await userEvent.click(await screen.findByRole("button", { name: "Выбрать событие" }));

    expect(location()).toContain("event=evt_2");
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-selected", "evt_2");
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-source", "events");
    const seq = Number(screen.getByTestId("conversation").getAttribute("data-seq"));
    expect(seq).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Выбрать событие" }));
    expect(Number(screen.getByTestId("conversation").getAttribute("data-seq"))).toBeGreaterThan(seq);
  });

  it("выбор в ленте или на мини-карте доходит до вкладки, снятие выбора убирает параметр", async () => {
    openPage("/sessions/sesn_1?inspector=events");
    await pageReady();
    await screen.findByTestId("events-tab");

    act(() => seen.conversation!.onSelectEvent("evt_s1", "minimap"));
    expect(screen.getByTestId("events-tab")).toHaveAttribute("data-selected", "evt_s1");
    expect(location()).toContain("event=evt_s1");

    act(() => seen.conversation!.onSelectEvent(null, "transcript"));
    expect(location()).not.toContain("event=");
    expect(screen.getByTestId("events-tab")).toHaveAttribute("data-selected", "");
  });

  it("крестик закрывает инспектор и убирает параметр, кнопка «Инспектор» открывает на прежней вкладке", async () => {
    openPage("/sessions/sesn_1?inspector=tools");
    await pageReady();

    await userEvent.click(await screen.findByRole("button", { name: "Закрыть инспектор" }));

    expect(screen.queryByRole("complementary", { name: "Инспектор сессии" })).toBeNull();
    expect(location()).not.toContain("inspector=");
    expect(JSON.parse(localStorage.getItem("oma.session.inspector") ?? "{}").open).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Инспектор" }));

    expect(await screen.findByTestId("tools-tab")).toBeInTheDocument();
    expect(location()).toContain("inspector=tools");
  });

  it("клавиша D закрывает и снова открывает инспектор с прежней вкладкой", async () => {
    openPage("/sessions/sesn_1?inspector=events");
    await pageReady();
    await screen.findByTestId("events-tab");

    await userEvent.keyboard("d");
    expect(screen.queryByRole("complementary", { name: "Инспектор сессии" })).toBeNull();

    await userEvent.keyboard("d");
    expect(await screen.findByTestId("events-tab")).toBeInTheDocument();
  });

  it("D не срабатывает в поле ввода", async () => {
    openPage();
    await pageReady();
    await userEvent.click(within(screen.getByRole("heading", { level: 1 })).getByRole("button"));

    await userEvent.type(screen.getByRole("textbox", { name: "Название сессии" }), "dd");

    expect(screen.getByRole("complementary", { name: "Инспектор сессии" })).toBeInTheDocument();
  });

  it("ширина меняется перетаскиванием, держится в 360..720 и переживает перезагрузку", async () => {
    const first = openPage();
    await pageReady();
    const handle = await screen.findByRole("separator", { name: "Изменить ширину инспектора" });

    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 940, pointerId: 1 });
    expect(screen.getByRole("complementary", { name: "Инспектор сессии" })).toHaveStyle({ width: "540px" });
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 });
    expect(screen.getByRole("complementary", { name: "Инспектор сессии" })).toHaveStyle({ width: "720px" });
    fireEvent.pointerMove(window, { clientX: 940, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(JSON.parse(localStorage.getItem("oma.session.inspector") ?? "{}").width).toBe(540);
    first.unmount();

    openPage();
    await pageReady();
    expect(await screen.findByRole("complementary", { name: "Инспектор сессии" })).toHaveStyle({ width: "540px" });
  });

  it("на узком экране инспектор закрыт, а открытый встаёт нижним листом", async () => {
    state.narrow = true;
    openPage();
    await pageReady();

    expect(screen.queryByRole("complementary", { name: "Инспектор сессии" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Инспектор" }));

    expect(await screen.findByRole("complementary", { name: "Инспектор сессии" })).toHaveAttribute(
      "data-layout",
      "sheet",
    );
  });

  it("нижний лист встаёт на место ленты под поиском и мини-картой", async () => {
    state.narrow = true;
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Инспектор" }));

    const sheet = await screen.findByRole("complementary", { name: "Инспектор сессии" });
    expect(within(screen.getByTestId("conversation-overlay")).getByRole("complementary")).toBe(sheet);
  });

  it("на широком экране инспектор стоит справа, а не поверх ленты", async () => {
    openPage();
    await pageReady();

    expect(await screen.findByRole("complementary", { name: "Инспектор сессии" })).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-overlay")).toBeNull();
  });

  it("«Потоки» приглушены, пока других потоков нет", async () => {
    openPage();
    await pageReady();

    expect(await screen.findByRole("tab", { name: "Потоки" })).toHaveClass("text-ddc-text-muted");
  });

  it("выбор потока во вкладке «Потоки» переключает ленту и вкладку «События»", async () => {
    state.threads = THREADS;
    openPage("/sessions/sesn_1?inspector=thread");
    await pageReady();

    const table = await screen.findByRole("table", { name: "Потоки" });
    expect(screen.getByRole("tab", { name: "Потоки" })).not.toHaveClass("text-ddc-text-muted");
    expect(screen.getByTestId("conversation")).toHaveAttribute("data-agent-name", "Юрист");

    await userEvent.click(within(table).getByText("Проверяющий"));

    await waitFor(() =>
      expect(screen.getByTestId("conversation")).toHaveAttribute("data-agent-name", "Проверяющий"),
    );
    await userEvent.click(screen.getByRole("tab", { name: "События" }));
    expect(await screen.findByTestId("events-tab")).toHaveAttribute("data-count", "2");
  });
});

describe("SessionDetail: вид «Трейс»", () => {
  const seq = () => Number(screen.getByTestId("trace-view").getAttribute("data-seq"));

  it("по умолчанию открыт разговор, а трейс не монтируется", async () => {
    openPage();
    await pageReady();

    expect(screen.getByRole("tab", { name: "Разговор" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Трейс" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "Разговор" })).toContainElement(screen.getByTestId("conversation"));
    expect(screen.queryByTestId("trace-view")).toBeNull();
    expect(seen.trace).toBeNull();
  });

  it("?view=trace открывает трейс на месте разговора, инспектор остаётся справа", async () => {
    openPage("/sessions/sesn_1?view=trace");
    await pageReady();

    const trace = await screen.findByTestId("trace-view");
    expect(screen.getByRole("tab", { name: "Трейс" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Трейс" })).toContainElement(trace);
    expect(screen.queryByTestId("conversation")).toBeNull();
    const inspector = screen.getByRole("complementary", { name: "Инспектор сессии" });
    expect(inspector).toHaveAttribute("data-layout", "side");
    expect(screen.getByRole("tabpanel", { name: "Трейс" })).not.toContainElement(inspector);
  });

  it("неизвестное значение view открывает разговор", async () => {
    openPage("/sessions/sesn_1?view=timeline");
    await pageReady();

    expect(screen.getByTestId("conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-view")).toBeNull();
  });

  it("трейс получает id сессии, все события сессии и признак выполнения", async () => {
    state.status = "running";
    openPage("/sessions/sesn_1?view=trace&inspector=events");
    await pageReady();

    const trace = await screen.findByTestId("trace-view");
    expect(trace).toHaveAttribute("data-session-id", "sesn_1");
    expect(trace).toHaveAttribute("data-running", "true");
    // Трейс несёт и потоки сабагентов, поэтому ему нужны события всех потоков: 6, а не 4 основного.
    await waitFor(() => expect(screen.getByTestId("trace-view")).toHaveAttribute("data-events", String(HISTORY.length)));
    expect(await screen.findByTestId("events-tab")).toHaveAttribute("data-count", "4");
  });

  it("вкладки над лентой пишут ?view= и не трогают остальные параметры", async () => {
    openPage("/sessions/sesn_1?inspector=events&event=evt_2");
    await pageReady();

    await userEvent.click(screen.getByRole("tab", { name: "Трейс" }));

    expect(await screen.findByTestId("trace-view")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation")).toBeNull();
    expect(location()).toContain("view=trace");
    expect(location()).toContain("inspector=events");
    expect(location()).toContain("event=evt_2");

    await userEvent.click(screen.getByRole("tab", { name: "Разговор" }));

    expect(await screen.findByTestId("conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("trace-view")).toBeNull();
    expect(location()).toContain("view=conversation");
    expect(location()).not.toContain("view=trace");
    expect(location()).toContain("inspector=events");
    expect(location()).toContain("event=evt_2");
  });

  it("вкладка инспектора не сбрасывает вид", async () => {
    openPage("/sessions/sesn_1?view=trace");
    await pageReady();

    await userEvent.click(await screen.findByRole("tab", { name: "Инструменты" }));

    expect(location()).toContain("view=trace");
    expect(location()).toContain("inspector=tools");
    expect(screen.getByTestId("trace-view")).toBeInTheDocument();
  });

  describe("клавиша T", () => {
    it("переключает разговор и трейс", async () => {
      openPage("/sessions/sesn_1?inspector=events");
      await pageReady();
      await screen.findByTestId("events-tab");

      await userEvent.keyboard("t");
      expect(await screen.findByTestId("trace-view")).toBeInTheDocument();
      expect(location()).toContain("view=trace");

      await userEvent.keyboard("T");
      expect(await screen.findByTestId("conversation")).toBeInTheDocument();
      expect(screen.queryByTestId("trace-view")).toBeNull();
      expect(location()).not.toContain("view=trace");
    });

    it("работает на русской раскладке: клавишу узнаёт по коду", async () => {
      openPage();
      await pageReady();

      fireEvent.keyDown(document.body, { key: "е", code: "KeyT" });

      expect(await screen.findByTestId("trace-view")).toBeInTheDocument();
    });

    it("не срабатывает в поле ввода", async () => {
      openPage();
      await pageReady();
      await userEvent.click(within(screen.getByRole("heading", { level: 1 })).getByRole("button"));

      await userEvent.type(screen.getByRole("textbox", { name: "Название сессии" }), "tt");

      expect(screen.getByTestId("conversation")).toBeInTheDocument();
      expect(location()).not.toContain("view=");
    });

    it("не срабатывает при открытом окне и вместе с Ctrl", async () => {
      openPage();
      await pageReady();

      await userEvent.keyboard("{Control>}t{/Control}");
      expect(screen.queryByTestId("trace-view")).toBeNull();

      await userEvent.keyboard("?");
      await screen.findByRole("dialog", { name: "Горячие клавиши" });
      await userEvent.keyboard("t");
      expect(screen.queryByTestId("trace-view")).toBeNull();
      expect(location()).not.toContain("view=");
    });
  });

  it("клавиша / в трейсе ставит фокус в поле поиска трейса", async () => {
    openPage("/sessions/sesn_1?view=trace");
    await pageReady();
    const field = await screen.findByRole("textbox", { name: "Найти в трейсе" });
    expect(field).not.toHaveFocus();

    await userEvent.keyboard("/");

    expect(field).toHaveFocus();
    expect(field).toHaveValue("");
  });

  describe("общий выбор события", () => {
    it("узел трейса пишет ?event= и выделяет строку во вкладке «События»", async () => {
      openPage("/sessions/sesn_1?view=trace&inspector=events");
      await pageReady();
      await screen.findByTestId("events-tab");

      await userEvent.click(await screen.findByRole("button", { name: "Выбрать узел" }));

      expect(location()).toContain("event=evt_2");
      expect(screen.getByTestId("events-tab")).toHaveAttribute("data-selected", "evt_2");
      expect(seen.events?.selection).toMatchObject({ eventId: "evt_2", source: "trace" });
      expect(screen.getByTestId("trace-view")).toHaveAttribute("data-selected", "evt_2");
      expect(screen.getByTestId("trace-view")).toHaveAttribute("data-source", "trace");
      expect(seq()).toBeGreaterThan(0);
    });

    it("узел без события снимает выбор и убирает параметр", async () => {
      openPage("/sessions/sesn_1?view=trace&inspector=events&event=evt_2");
      await pageReady();
      await screen.findByTestId("events-tab");
      expect(screen.getByTestId("events-tab")).toHaveAttribute("data-selected", "evt_2");

      await userEvent.click(await screen.findByRole("button", { name: "Выбрать узел без события" }));

      expect(location()).not.toContain("event=");
      expect(screen.getByTestId("events-tab")).toHaveAttribute("data-selected", "");
      expect(screen.getByTestId("trace-view")).toHaveAttribute("data-selected", "");
    });

    it("выбор в «Событиях» доходит до трейса", async () => {
      openPage("/sessions/sesn_1?view=trace&inspector=events");
      await pageReady();
      await screen.findByTestId("events-tab");

      await userEvent.click(screen.getByRole("button", { name: "Выбрать событие" }));

      expect(screen.getByTestId("trace-view")).toHaveAttribute("data-selected", "evt_2");
      expect(screen.getByTestId("trace-view")).toHaveAttribute("data-source", "events");
    });

    it("?event= из адреса доходит до трейса", async () => {
      openPage("/sessions/sesn_1?view=trace&event=evt_2");
      await pageReady();

      const trace = await screen.findByTestId("trace-view");
      expect(trace).toHaveAttribute("data-selected", "evt_2");
      expect(trace).toHaveAttribute("data-source", "url");
    });

    it("выбор в ленте переживает переход в трейс", async () => {
      openPage("/sessions/sesn_1");
      await pageReady();
      await screen.findByTestId("conversation");
      act(() => seen.conversation!.onSelectEvent("evt_s1", "minimap"));

      await userEvent.keyboard("t");

      const trace = await screen.findByTestId("trace-view");
      expect(trace).toHaveAttribute("data-selected", "evt_s1");
      expect(trace).toHaveAttribute("data-source", "minimap");
      expect(location()).toContain("event=evt_s1");
    });

    it("выбор в трейсе переживает возврат в разговор: лента получает источник «trace» и прокручивается к блоку", async () => {
      openPage("/sessions/sesn_1?view=trace");
      await pageReady();
      await userEvent.click(await screen.findByRole("button", { name: "Выбрать узел" }));

      await userEvent.click(screen.getByRole("tab", { name: "Разговор" }));

      const conversation = await screen.findByTestId("conversation");
      expect(conversation).toHaveAttribute("data-selected", "evt_2");
      expect(conversation).toHaveAttribute("data-source", "trace");
    });
  });

  describe("«В разговоре»", () => {
    it("открывает разговор и выбирает то же событие, адрес получает вид и событие одной записью", async () => {
      openPage("/sessions/sesn_1?view=trace&inspector=events");
      await pageReady();
      await screen.findByTestId("events-tab");

      await userEvent.click(await screen.findByRole("button", { name: "Показать узел в разговоре" }));

      const conversation = await screen.findByTestId("conversation");
      expect(screen.queryByTestId("trace-view")).toBeNull();
      expect(conversation).toHaveAttribute("data-selected", "evt_2");
      expect(conversation).toHaveAttribute("data-source", "trace");
      expect(location()).toContain("view=conversation");
      expect(location()).toContain("event=evt_2");
      expect(location()).not.toContain("view=trace");
      expect(screen.getByTestId("events-tab")).toHaveAttribute("data-selected", "evt_2");
    });

    it("повторяет выбор уже выбранного узла: seq растёт, и лента прокручивается снова", async () => {
      openPage("/sessions/sesn_1?view=trace");
      await pageReady();
      await userEvent.click(await screen.findByRole("button", { name: "Выбрать узел" }));
      const before = seq();

      await userEvent.click(screen.getByRole("button", { name: "Показать узел в разговоре" }));

      const conversation = await screen.findByTestId("conversation");
      expect(Number(conversation.getAttribute("data-seq"))).toBeGreaterThan(before);
    });

    it("событие сабагента переключает ленту на его поток", async () => {
      state.threads = THREADS;
      openPage("/sessions/sesn_1?view=trace");
      await pageReady();
      await screen.findByTestId("trace-view");

      await userEvent.click(screen.getByRole("button", { name: "Показать узел потока в разговоре" }));

      const conversation = await screen.findByTestId("conversation");
      await waitFor(() => expect(conversation).toHaveAttribute("data-agent-name", "Проверяющий"));
      expect(conversation).toHaveAttribute("data-selected", "evt_w2");
      expect(conversation).toHaveAttribute("data-source", "trace");
      expect(location()).toContain("event=evt_w2");
    });

    it("событие основного потока возвращает ленту и вкладку «События» к основному потоку", async () => {
      state.threads = THREADS;
      openPage("/sessions/sesn_1?view=trace&inspector=thread");
      await pageReady();
      await userEvent.click(within(await screen.findByRole("table", { name: "Потоки" })).getByText("Проверяющий"));
      await userEvent.click(screen.getByRole("tab", { name: "События" }));
      expect(await screen.findByTestId("events-tab")).toHaveAttribute("data-count", "2");

      await userEvent.click(screen.getByRole("button", { name: "Показать узел в разговоре" }));

      const conversation = await screen.findByTestId("conversation");
      await waitFor(() => expect(conversation).toHaveAttribute("data-agent-name", "Юрист"));
      expect(screen.getByTestId("events-tab")).toHaveAttribute("data-count", "4");
    });
  });

  it("«Открыть поток» открывает разговор с потоком сабагента", async () => {
    state.threads = THREADS;
    openPage("/sessions/sesn_1?view=trace");
    await pageReady();

    await userEvent.click(await screen.findByRole("button", { name: "Открыть поток узла" }));

    const conversation = await screen.findByTestId("conversation");
    await waitFor(() => expect(conversation).toHaveAttribute("data-agent-name", "Проверяющий"));
    expect(screen.queryByTestId("trace-view")).toBeNull();
    expect(location()).toContain("view=conversation");
  });

  describe("кнопка «Инспектор»", () => {
    it("в разговоре стоит в строке поиска, а не в строке вкладок", async () => {
      openPage("/sessions/sesn_1?inspector=tools");
      await pageReady();
      await userEvent.click(await screen.findByRole("button", { name: "Закрыть инспектор" }));

      const button = screen.getByRole("button", { name: "Инспектор" });

      expect(button.closest("[data-session-toolbar]")).not.toBeNull();
      expect(button.closest("[data-session-views]")).toBeNull();
    });

    it("в трейсе стоит в строке вкладок и возвращает прежнюю вкладку инспектора", async () => {
      openPage("/sessions/sesn_1?view=trace&inspector=tools");
      await pageReady();
      await userEvent.click(await screen.findByRole("button", { name: "Закрыть инспектор" }));

      const button = screen.getByRole("button", { name: "Инспектор" });
      expect(button.closest("[data-session-views]")).toBe(
        screen.getByRole("tablist", { name: "Вид сессии" }).closest("[data-session-views]"),
      );
      expect(screen.getAllByRole("button", { name: "Инспектор" })).toHaveLength(1);

      await userEvent.click(button);

      expect(await screen.findByTestId("tools-tab")).toBeInTheDocument();
      expect(location()).toContain("inspector=tools");
      expect(location()).toContain("view=trace");
      expect(screen.queryByRole("button", { name: "Инспектор" })).toBeNull();
    });

    it("на узком экране лист инспектора встаёт поверх трейса, вкладки вида остаются доступны", async () => {
      state.narrow = true;
      openPage("/sessions/sesn_1?view=trace");
      await pageReady();
      await screen.findByTestId("trace-view");
      expect(screen.queryByRole("complementary", { name: "Инспектор сессии" })).toBeNull();

      await userEvent.click(screen.getByRole("button", { name: "Инспектор" }));

      const sheet = await screen.findByRole("complementary", { name: "Инспектор сессии" });
      expect(sheet).toHaveAttribute("data-layout", "sheet");
      expect(screen.getByRole("tabpanel", { name: "Трейс" })).toContainElement(sheet);
      expect(sheet.closest("[data-session-overlay]")).not.toBeNull();
      expect(screen.getByRole("tablist", { name: "Вид сессии" })).not.toContainElement(sheet);
      expect(screen.getByTestId("trace-view")).toBeInTheDocument();
    });
  });
});

describe("SessionDetail: действия", () => {
  it("в меню «Действия» нет бюджета, а сессия бюджет не получает", async () => {
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));

    expect(await screen.findByRole("menuitem", { name: "Прервать" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /бюджет/i })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Изменить бюджет" })).toBeNull();
    expect(api.sessions.update).not.toHaveBeenCalled();
  });

  it("«Задать результат…» отправляет user.define_outcome", async () => {
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Задать результат…" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Описание" }), "Отчёт");
    await userEvent.type(screen.getByRole("textbox", { name: "Критерии" }), "С цитатами");
    await userEvent.click(screen.getByRole("button", { name: "Задать результат" }));

    await waitFor(() =>
      expect(api.sessions.events.send).toHaveBeenCalledWith("sesn_1", {
        events: [
          {
            type: "user.define_outcome",
            description: "Отчёт",
            rubric: { type: "text", content: "С цитатами" },
          },
        ],
      }),
    );
  });

  it("«Прервать» шлёт user.interrupt, пока сессия выполняется", async () => {
    state.status = "running";
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Прервать" }));

    await waitFor(() =>
      expect(api.sessions.events.send).toHaveBeenCalledWith("sesn_1", { events: [{ type: "user.interrupt" }] }),
    );
  });

  it("«Архивировать» спрашивает подтверждение, архивирует и ведёт к списку", async () => {
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Архивировать" }));
    expect(api.sessions.archive).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Архивировать" }));

    await waitFor(() => expect(api.sessions.archive).toHaveBeenCalledWith("sesn_1"));
    expect(await screen.findByText("Список сессий")).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Сессия архивирована");
  });

  it("«Копировать все события» и «Скачать все события» берут все события сессии", async () => {
    openPage();
    await pageReady();
    await waitFor(() => expect(screen.getByTestId("conversation")).toHaveAttribute("data-turns", "1"));

    await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Копировать все события" }));
    await waitFor(() => expect(eventsTabModule.copyEventsToClipboard).toHaveBeenCalled());
    const copied = vi.mocked(eventsTabModule.copyEventsToClipboard).mock.calls[0]![0];
    expect(copied.map((event) => event.id)).toEqual(HISTORY.map((event) => event.id));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("События скопированы"));

    await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Скачать все события" }));
    expect(eventsTabModule.downloadEventsFile).toHaveBeenCalledWith("sesn_1", expect.any(Array));
  });

  it("«Горячие клавиши» из меню и по клавише ?", async () => {
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Горячие клавиши" }));
    expect(await screen.findByRole("dialog", { name: "Горячие клавиши" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Горячие клавиши" })).toBeNull());

    await userEvent.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "Горячие клавиши" })).toBeInTheDocument();
  });

  it("в меню «Ещё» нет пункта «Траектория», страница не просит траекторию", async () => {
    const requested: string[] = [];
    const onStart = ({ request }: { request: Request }) => {
      requested.push(new URL(request.url).pathname);
    };
    server.events.on("request:start", onStart);
    try {
      openPage();
      await pageReady();
      await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
      await screen.findByRole("menuitem", { name: "Скачать трейс" });
    } finally {
      server.events.removeListener("request:start", onStart);
    }

    expect(screen.queryByRole("menuitem", { name: "Траектория" })).toBeNull();
    expect(requested.filter((path) => path.endsWith("/trajectory"))).toEqual([]);
  });

  describe("«Скачать трейс»", () => {
    const originals = new Map<string, PropertyDescriptor | undefined>();

    /** jsdom не сохраняет файлы: подменяем адреса blob и щелчок по ссылке. */
    function stubBrowserDownload() {
      const created: Blob[] = [];
      const clicks: Array<{ download: string; href: string }> = [];
      const replace = (name: "createObjectURL" | "revokeObjectURL", value: unknown) => {
        if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(URL, name));
        Object.defineProperty(URL, name, { configurable: true, writable: true, value });
      };
      replace("createObjectURL", (blob: Blob) => {
        created.push(blob);
        return "blob:trace";
      });
      replace("revokeObjectURL", () => {});
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push({ download: this.download, href: this.href });
      });
      return { created, clicks };
    }

    afterEach(() => {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(URL, name, descriptor);
        else Reflect.deleteProperty(URL, name);
      }
      originals.clear();
    });

    async function chooseDownloadTrace() {
      await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
      await userEvent.click(await screen.findByRole("menuitem", { name: "Скачать трейс" }));
    }

    it("берёт весь трейс файлом OTLP и сохраняет его под именем сессии", async () => {
      const browser = stubBrowserDownload();
      const requested: string[] = [];
      const body = { resourceSpans: [{ scopeSpans: [] }] };
      server.use(
        http.get("*/v1/oma/sessions/sesn_1/trace/otlp.json", ({ request }) => {
          requested.push(new URL(request.url).pathname);
          return HttpResponse.json(body);
        }),
      );
      openPage();
      await pageReady();

      await chooseDownloadTrace();

      await waitFor(() => expect(browser.clicks).toHaveLength(1));
      expect(requested).toEqual(["/v1/oma/sessions/sesn_1/trace/otlp.json"]);
      expect(browser.clicks[0]).toEqual({ download: "trace-sesn_1.otlp.json", href: "blob:trace" });
      expect(JSON.parse(await browser.created[0]!.text())).toEqual(body);
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("если трейс скачать не удалось, страница сообщает об этом и файл не сохраняет", async () => {
      const browser = stubBrowserDownload();
      vi.spyOn(console, "error").mockImplementation(() => {});
      server.use(
        http.get("*/v1/oma/sessions/sesn_1/trace/otlp.json", () =>
          HttpResponse.json({ error: { type: "not_found_error", message: "нет" } }, { status: 404 }),
        ),
      );
      openPage();
      await pageReady();

      await chooseDownloadTrace();

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Не удалось скачать трейс"));
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(browser.clicks).toEqual([]);
    });
  });
});

describe("SessionDetail: источник сессии", () => {
  it("метка Linear и Slack встают строками «Источник» во вкладке «Сессия»", async () => {
    api.sessions.retrieve.mockResolvedValue({
      ...SESSION,
      metadata: {
        linear: JSON.stringify({ issueIdentifier: "ABC-1", workspaceId: "ws" }),
        slack: JSON.stringify({ channelId: "C123", threadTs: "1.2" }),
      },
    });
    openPage();
    await pageReady();

    const inspector = await screen.findByRole("complementary", { name: "Инспектор сессии" });
    expect(await within(inspector).findByText(/ABC-1/)).toBeInTheDocument();
    expect(within(inspector).getByText(/C123/)).toBeInTheDocument();
    expect(within(inspector).getAllByText("Источник", { selector: "dt" })).toHaveLength(2);
  });
});
