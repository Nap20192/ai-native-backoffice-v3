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
        data-cursor={props.externalCursorMs ?? ""}
      >
        {props.toolbarTrailing}
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

  server.use(
    http.get("*/v1/sessions/sesn_1/outputs", () => HttpResponse.json({ data: [], has_more: false })),
    http.get("*/v1/oma/model_cards", () => HttpResponse.json({ data: [] })),
    http.get("*/v1/oma/analytics/sessions/sesn_1", () =>
      HttpResponse.json({ error: { type: "not_found_error", message: "нет" } }, { status: 404 }),
    ),
  );
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

  it("старых вкладок «Разговор» и «Хронология» и кнопок «Файлы» и «Траектория» в шапке нет", async () => {
    openPage();
    await pageReady();

    expect(screen.queryByRole("tab", { name: "Разговор" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Хронология" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Файлы сессии" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Траектория" })).toBeNull();
  });

  it("стоимость без карточки модели и без аналитики: «нет цены», бюджет рядом", async () => {
    openPage();
    await pageReady();

    expect((await screen.findAllByText("нет цены", { selector: "span" })).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("/ $5,00").length).toBeGreaterThanOrEqual(1);
  });

  it("стоимость по карточке модели, когда аналитика отвечает 404", async () => {
    server.use(
      http.get("*/v1/oma/model_cards", () =>
        HttpResponse.json({
          data: [{ id: "c1", model_id: "m1", pi_config: { cost: { input: 3, output: 15 } } }],
        }),
      ),
    );
    openPage();
    await pageReady();

    // 20 вход. по $3 и 10 выход. по $15: 210 миллионных долей доллара.
    expect((await screen.findAllByText("$0,0002", { selector: "span" })).length).toBeGreaterThanOrEqual(1);
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

  it("«Потоки» приглушены, пока других потоков нет", async () => {
    openPage();
    await pageReady();

    expect(await screen.findByRole("tab", { name: "Потоки" })).toHaveClass("text-ddc-text-muted");
  });

  it("выбор потока во вкладке «Потоки» переключает ленту и вкладку «События»", async () => {
    state.threads = [
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

describe("SessionDetail: график стоимости и мини-карта", () => {
  it("наведение на график передаёт время ленте, уход курсора снимает метку", async () => {
    server.use(
      http.get("*/v1/oma/model_cards", () =>
        HttpResponse.json({
          data: [{ id: "c1", model_id: "m1", pi_config: { cost: { input: 3, output: 15 } } }],
        }),
      ),
    );
    openPage();
    await pageReady();
    await screen.findByRole("img", { name: "График стоимости" });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const plot = document.querySelector("[data-chart-plot]") as HTMLElement;

    fireEvent.pointerMove(plot, { clientX: 100 });

    await waitFor(() => expect(screen.getByTestId("conversation").getAttribute("data-cursor")).not.toBe(""));

    fireEvent.pointerLeave(plot);

    await waitFor(() => expect(screen.getByTestId("conversation").getAttribute("data-cursor")).toBe(""));
  });
});

describe("SessionDetail: действия", () => {
  it("«Изменить бюджет» сохраняет бюджет в центах и снимает его пустым полем", async () => {
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Изменить бюджет" }));
    const field = await screen.findByRole("textbox", { name: "Бюджет" });
    expect(field).toHaveValue("5,00");
    await userEvent.clear(field);
    await userEvent.type(field, "7,5");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(api.sessions.update).toHaveBeenCalledWith("sesn_1", {
        budget: { type: "limit", max_list_cost: { amount: "750", currency: "USD" } },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Изменить бюджет" })).toBeNull());
    expect((await screen.findAllByText("/ $7,50")).length).toBeGreaterThanOrEqual(1);

    await userEvent.click(screen.getByRole("button", { name: "Действия" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Изменить бюджет" }));
    await userEvent.clear(await screen.findByRole("textbox", { name: "Бюджет" }));
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(api.sessions.update).toHaveBeenLastCalledWith("sesn_1", { budget: null }));
  });

  it("карандаш во вкладке «Сессия» открывает то же окно бюджета", async () => {
    openPage();
    await pageReady();

    await userEvent.click(await screen.findByRole("button", { name: "Изменить бюджет" }));

    expect(await screen.findByRole("dialog", { name: "Изменить бюджет" })).toBeInTheDocument();
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

  it("«Траектория» открывает окно и грузит траекторию по запросу", async () => {
    server.use(
      http.get("*/v1/sessions/sesn_1/trajectory", () =>
        HttpResponse.json({
          schema_version: "oma.trajectory.v1",
          trajectory_id: "traj_1",
          session_id: "sesn_1",
          outcome: "success",
          events: [],
        }),
      ),
    );
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Траектория" }));

    expect(await screen.findByRole("dialog", { name: "Траектория" })).toBeInTheDocument();
    expect(await screen.findByText(/traj_1/, { selector: "pre" })).toBeInTheDocument();
  });

  it("если траектории нет, окно объясняет это", async () => {
    server.use(
      http.get("*/v1/sessions/sesn_1/trajectory", () =>
        HttpResponse.json({ error: { type: "not_found_error", message: "нет" } }, { status: 404 }),
      ),
    );
    openPage();
    await pageReady();

    await userEvent.click(screen.getByRole("button", { name: "Ещё" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Траектория" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Траектория недоступна");
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
