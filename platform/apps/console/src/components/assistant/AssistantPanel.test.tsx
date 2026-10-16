import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Event } from "../../lib/events";
import { server } from "../../mocks/server";
import { AssistantPanel } from "./AssistantPanel";
import { AssistantProvider, useAssistant } from "./AssistantProvider";
import { mockPlatformMcp } from "./test-fixtures";

const managed = vi.hoisted(() => {
  const sessions = {
    events: {
      list: vi.fn(),
      stream: vi.fn(),
    },
  };
  return { sessions, api: { sessions } };
});

vi.mock("../../lib/useManagedApi", () => ({ useManagedApi: () => managed.api }));

const BUILDER_AGENT = { id: "agent_b", name: "Ассистент", version: 4, metadata: { oma_role: "builder" } };
const BUILDER_ENV = { id: "env_b", name: "Ассистент", metadata: { oma_role: "builder" } };

interface World {
  installed: boolean;
  enabled: boolean;
  canChange: boolean;
  sessionBodies: Array<Record<string, any>>;
  eventBodies: Array<{ sessionId: string; body: Record<string, any> }>;
  posted: Array<{ path: string; body: any }>;
  historyUrls: string[];
}

function setupWorld(over: Partial<World> = {}): World {
  const world: World = {
    installed: true,
    enabled: true,
    canChange: false,
    sessionBodies: [],
    eventBodies: [],
    posted: [],
    historyUrls: [],
    ...over,
  };
  server.use(
    http.get("*/v1/oma/platform-mcp/settings", () =>
      HttpResponse.json({ enabled: world.enabled, can_change: world.canChange, updated_by: null, updated_at: null }),
    ),
    http.post("*/v1/oma/platform-mcp/settings", async ({ request }) => {
      const body = (await request.json()) as { enabled: boolean };
      world.enabled = body.enabled;
      return HttpResponse.json({ enabled: world.enabled, can_change: true });
    }),
    http.get("*/v1/agents", () => HttpResponse.json({ data: world.installed ? [BUILDER_AGENT] : [] })),
    http.get("*/v1/agents/:id", () => HttpResponse.json({ id: "agent_x", name: "Сводка PR", version: 2 })),
    http.get("*/v1/environments", () => HttpResponse.json({ data: world.installed ? [BUILDER_ENV] : [] })),
    http.get("*/v1/oma/model_cards", () =>
      HttpResponse.json({ data: [{ id: "mc1", model_id: "qwen3.6-35b", model: "qwen", provider: "openai" }] }),
    ),
    http.get("*/v1/sessions", ({ request }) => {
      world.historyUrls.push(request.url);
      return HttpResponse.json({
        data: [
          { id: "sesn_old", title: "Старый разговор", created_at: "2026-10-15T10:00:00Z", metadata: { oma_assistant_chat: "1" } },
          { id: "sesn_other", title: "Не разговор с ассистентом", metadata: {} },
        ],
      });
    }),
    http.post("*/v1/sessions", async ({ request }) => {
      const body = (await request.json()) as Record<string, any>;
      world.sessionBodies.push(body);
      return HttpResponse.json({ id: `sesn_${world.sessionBodies.length}` });
    }),
    http.post("*/v1/sessions/:id/events", async ({ request, params }) => {
      world.eventBodies.push({ sessionId: String(params.id), body: (await request.json()) as Record<string, any> });
      return HttpResponse.json({ data: [] });
    }),
    http.get("*/v1/oma/platform-mcp/builder-bundle", () =>
      HttpResponse.json({
        environment: { name: "Ассистент", config: { type: "cloud" } },
        agent: { name: "Ассистент", model: "qwen3.6-35b" },
      }),
    ),
    http.post("*/v1/environments", async ({ request }) => {
      world.posted.push({ path: "/v1/environments", body: await request.json() });
      return HttpResponse.json({ id: "env_new", name: "Ассистент" });
    }),
    http.post("*/v1/agents", async ({ request }) => {
      world.posted.push({ path: "/v1/agents", body: await request.json() });
      world.installed = true;
      return HttpResponse.json({ id: "agent_new", name: "Ассистент", version: 1 });
    }),
    http.get("*/v1/oma/platform-mcp/actions", () => HttpResponse.json({ data: [] })),
  );
  return world;
}

function OpenButton() {
  const a = useAssistant();
  return (
    <button type="button" onClick={() => a.setOpen(true)}>
      открыть
    </button>
  );
}

function Draft() {
  const a = useAssistant();
  return (
    <button type="button" onClick={() => a.setDraftYaml("name: черновик\n")}>
      черновик
    </button>
  );
}

function renderPanel(path = "/agents", options: { strict?: boolean } = {}) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <AssistantProvider>
        <OpenButton />
        <Draft />
        <AssistantPanel />
      </AssistantProvider>
    </MemoryRouter>
  );
  // Консоль работает в StrictMode: React вызывает функции обновления состояния дважды.
  return render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** Поток событий, в который тест кладёт события сам. */
function controllableStream(): { push: (e: Event) => void } {
  const handle = { push: (_e: Event) => {} };
  managed.sessions.events.stream.mockImplementation(async () =>
    (async function* () {
      const queue: Event[] = [];
      let wake: (() => void) | null = null;
      handle.push = (e) => {
        queue.push(e);
        wake?.();
      };
      for (;;) {
        while (queue.length) yield queue.shift() as Event;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
  );
  return handle;
}

beforeEach(() => {
  managed.sessions.events.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.sessions.events.stream.mockReset().mockImplementation(async () =>
    (async function* () {
      await new Promise(() => {});
    })(),
  );
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("панель: открытие", () => {
  it("по умолчанию закрыта, Ctrl I открывает и закрывает", async () => {
    setupWorld();
    renderPanel();
    expect(screen.queryByRole("complementary", { name: "Ассистент" })).toBeNull();
    fireEvent.keyDown(window, { key: "i", ctrlKey: true });
    expect(await screen.findByRole("complementary", { name: "Ассистент" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "i", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Ассистент" })).toBeNull());
  });

  it("крестик закрывает панель", async () => {
    setupWorld();
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await user.click(await screen.findByRole("button", { name: "Закрыть панель" }));
    expect(screen.queryByRole("complementary", { name: "Ассистент" })).toBeNull();
  });

  it("на 390 px открывается нижним листом", async () => {
    setupWorld();
    vi.stubGlobal(
      "matchMedia",
      (query: string) => ({
        matches: query.includes("max-width: 640px"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }),
    );
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "открыть" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("data-side", "bottom");
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Закрыть панель" })).toBeInTheDocument();
  });
});

describe("панель: установка и выключатель", () => {
  it("без ассистента зовёт установить, после установки показывает подсказки", async () => {
    const world = setupWorld({ installed: false });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(await screen.findByText("Ассистента здесь ещё нет")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Установить" }));
    expect(await screen.findByText("Чем помочь?")).toBeInTheDocument();
    expect(world.posted.map((p) => p.path)).toEqual(["/v1/environments", "/v1/agents"]);
  });

  it("выключенный ассистент: текст и выключенное поле", async () => {
    setupWorld({ enabled: false });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(
      await screen.findByText("Ассистент выключен. Включить его может владелец или администратор пространства"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Сообщение ассистенту" })).toBeDisabled();
    expect(screen.queryByText("Чем помочь?")).toBeNull();
  });

  it("пункт выключателя видят только те, кому разрешил сервер", async () => {
    setupWorld({ canChange: false });
    const user = userEvent.setup();
    const { unmount } = renderPanel();
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await screen.findByText("Чем помочь?");
    expect(screen.queryByRole("button", { name: "Меню ассистента" })).toBeNull();
    unmount();

    setupWorld({ canChange: true });
    renderPanel();
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(await screen.findByRole("button", { name: "Меню ассистента" })).toBeInTheDocument();
  });

  it("владелец включает ассистента обратно из меню", async () => {
    const world = setupWorld({ enabled: false, canChange: true });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await user.click(await screen.findByRole("button", { name: "Меню ассистента" }));
    await user.click(await screen.findByRole("menuitem", { name: "Включить ассистента" }));
    await waitFor(() => expect(world.enabled).toBe(true));
    expect(await screen.findByText("Чем помочь?")).toBeInTheDocument();
  });

  it("ошибка загрузки настроек даёт «Повторить»", async () => {
    setupWorld();
    server.use(http.get("*/v1/oma/platform-mcp/settings", () => HttpResponse.json({}, { status: 500 })));
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(await screen.findByText("Не удалось загрузить ассистента")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeInTheDocument();
  });
});

describe("панель: разговор", () => {
  it("карточка подсказки создаёт сессию с явной версией и шлёт текст с контекстом страницы", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/agents/agent_x?version=2");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await user.click(await screen.findByRole("button", { name: "Улучшить системный промпт" }));
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    expect(world.sessionBodies[0].agent).toEqual({ type: "agent", id: "agent_b", version: 4 });
    expect(world.sessionBodies[0].environment_id).toBe("env_b");
    const text = world.eventBodies[0].body.events[0].content[0].text as string;
    expect(text).toContain("системный промпт");
    expect(text).toContain("<page_context>");
    expect(JSON.parse(text.slice(text.indexOf("<page_context>") + 14, -"</page_context>".length))).toMatchObject({
      kind: "agent",
      agent: "agent_x",
    });
    expect(world.eventBodies[0].sessionId).toBe("sesn_1");
    // реплика видна сразу и без блока контекста
    expect(await screen.findByText(/Предложи, как улучшить системный промпт/)).toBeInTheDocument();
    expect(screen.queryByText(/page_context/)).toBeNull();
  });

  it("подсказка поля называет объект страницы", async () => {
    setupWorld();
    const user = userEvent.setup();
    renderPanel("/agents/agent_x");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    const box = await screen.findByRole("textbox", { name: "Сообщение ассистенту" });
    await waitFor(() => expect(box).toHaveAttribute("placeholder", "Спросите про: Агент «Сводка PR», версия 2"));
    await user.click(screen.getByRole("button", { name: "Убрать контекст" }));
    expect(box).toHaveAttribute("placeholder", "Спросите или попросите что-нибудь настроить");
  });

  it("поле ввода: Enter отправляет, Shift Enter переносит строку", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    const box = await screen.findByRole("textbox", { name: "Сообщение ассистенту" });
    await user.type(box, "первая{Shift>}{Enter}{/Shift}вторая");
    expect(box).toHaveValue("первая\nвторая");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    expect(world.eventBodies[0].body.events[0].content[0].text).toContain("первая\nвторая");
    expect(box).toHaveValue("");
  });

  it("второе сообщение идёт в ту же сессию", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    const box = await screen.findByRole("textbox", { name: "Сообщение ассистенту" });
    await user.type(box, "раз{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    await user.type(box, "два{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(2));
    expect(world.sessionBodies).toHaveLength(1);
    expect(world.eventBodies[1].sessionId).toBe("sesn_1");
  });

  it("чип контекста можно убрать: сообщение уходит без page_context", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/agents/agent_x");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(await screen.findByText("Агент «Сводка PR», версия 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Убрать контекст" }));
    expect(screen.queryByText("Агент «Сводка PR», версия 2")).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Сообщение ассистенту" }), "привет{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    expect(world.eventBodies[0].body.events[0].content[0].text).toBe("привет");
  });

  it("черновик YAML с правой панели уходит в контексте", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/agents/new");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await screen.findByText("Чем помочь?");
    await user.click(screen.getByRole("button", { name: "черновик" }));
    await user.type(screen.getByRole("textbox", { name: "Сообщение ассистенту" }), "поправь{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    expect(world.eventBodies[0].body.events[0].content[0].text).toContain("name: черновик");
  });

  it("выбранная модель уходит в сессию через agent_with_overrides", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await screen.findByText("Чем помочь?");
    await user.selectOptions(await screen.findByRole("combobox", { name: "Модель" }), "qwen3.6-35b");
    await user.type(screen.getByRole("textbox", { name: "Сообщение ассистенту" }), "привет{Enter}");
    await waitFor(() => expect(world.sessionBodies).toHaveLength(1));
    expect(world.sessionBodies[0].agent).toEqual({
      type: "agent_with_overrides",
      id: "agent_b",
      version: 4,
      model: "qwen3.6-35b",
    });
  });

  it("«Новый разговор» очищает ленту и следующее сообщение открывает новую сессию", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    const box = await screen.findByRole("textbox", { name: "Сообщение ассистенту" });
    await user.type(box, "раз{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Новый разговор" }));
    expect(await screen.findByText("Чем помочь?")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Сообщение ассистенту" }), "два{Enter}");
    await waitFor(() => expect(world.sessionBodies).toHaveLength(2));
  });

  it("закрытие панели не теряет разговор", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await user.type(await screen.findByRole("textbox", { name: "Сообщение ассистенту" }), "сохрани{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Закрыть панель" }));
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(await screen.findByText("сохрани")).toBeInTheDocument();
    expect(world.sessionBodies).toHaveLength(1);
  });

  it("ошибка отправки не оставляет реплику и пишет причину", async () => {
    setupWorld();
    server.use(http.post("*/v1/sessions/:id/events", () => HttpResponse.json({}, { status: 500 })));
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await user.type(await screen.findByRole("textbox", { name: "Сообщение ассистенту" }), "привет{Enter}");
    expect(await screen.findByText("Не удалось отправить сообщение. Повторите")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("привет", { selector: "p" })).toBeNull());
  });

  it("восстанавливает прошлый разговор после перезагрузки страницы", async () => {
    setupWorld();
    const user = userEvent.setup();
    const first = renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await user.type(await screen.findByRole("textbox", { name: "Сообщение ассистенту" }), "привет{Enter}");
    await waitFor(() => expect(managed.sessions.events.list).toHaveBeenCalledWith("sesn_1", expect.anything()));
    first.unmount();

    managed.sessions.events.list.mockClear();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await waitFor(() => expect(managed.sessions.events.list).toHaveBeenCalledWith("sesn_1", expect.anything()));
  });
});

describe("панель: версия ассистента и история", () => {
  it("если версия выросла с прошлого разговора, показывает строку", async () => {
    setupWorld();
    localStorage.setItem("oma_assistant_seen_version:agent_b", "3");
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(await screen.findByText("Ассистента изменили: версия 3 стала 4")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Скрыть" }));
    expect(screen.queryByText("Ассистента изменили: версия 3 стала 4")).toBeNull();
    expect(localStorage.getItem("oma_assistant_seen_version:agent_b")).toBe("4");
  });

  it("в первый раз строки нет", async () => {
    setupWorld();
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await screen.findByText("Чем помочь?");
    expect(screen.queryByText(/Ассистента изменили/)).toBeNull();
  });

  it("«История» показывает прошлые разговоры и открывает выбранный", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await screen.findByText("Чем помочь?");
    await user.click(screen.getByRole("button", { name: "История" }));
    const old = await screen.findByRole("button", { name: /Старый разговор/ });
    expect(screen.queryByText("Не разговор с ассистентом")).toBeNull();
    expect(world.historyUrls[0]).toContain("agent_id=agent_b");
    await user.click(old);
    await waitFor(() => expect(managed.sessions.events.list).toHaveBeenCalledWith("sesn_old", expect.anything()));
  });

  it("вкладка «Изменения» открывается", async () => {
    setupWorld();
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await screen.findByText("Чем помочь?");
    await user.click(screen.getByRole("tab", { name: "Изменения" }));
    expect(await screen.findByText("В этом разговоре действий пока нет")).toBeInTheDocument();
  });
});

describe("панель: события сессии", () => {
  const events: Event[] = [
    { type: "user.message", id: "e1", content: [{ type: "text", text: "Сделай навык" }] },
    { type: "agent.message", id: "e2", content: [{ type: "text", text: "Готовлю черновик" }] },
    {
      type: "agent.mcp_tool_use",
      id: "tu_9",
      name: "create_skill",
      mcp_server_name: "platform",
      input: { display_title: "Навык PR", files: [] },
      evaluated_permission: "ask",
    },
    { type: "session.status_idle", id: "e4", stop_reason: { type: "requires_action", event_ids: ["tu_9"] } },
  ] as unknown as Event[];

  it("рисует ленту из событий, а карточка просит preview у сервера", async () => {
    setupWorld();
    const seen = mockPlatformMcp([
      {
        tool: "create_skill",
        preview_digest: "k1",
        operations: [{ index: 0, tool: "create_skill", kind: "skill", name: "Навык PR", class: "create", after_yaml: "display_title: Навык PR\n" }],
      },
    ]);
    managed.sessions.events.list.mockResolvedValue({ data: events, next_page: null });
    localStorage.setItem("oma_assistant_chat:default", "sesn_5");
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(await screen.findByText("Готовлю черновик")).toBeInTheDocument();
    expect(await screen.findByText("Создать навык «Навык PR»")).toBeInTheDocument();
    expect(seen.previews).toEqual([{ session_id: "sesn_5", tool_use_id: "tu_9" }]);
    expect(screen.queryByText("Чем помочь?")).toBeNull();
  });

  it("выключенный ассистент: лента разговора видна, карточка пишет причину, поле выключено", async () => {
    setupWorld({ enabled: false });
    mockPlatformMcp([{ disabled: true, tool: "create_skill", can_confirm: true, pending: true }]);
    managed.sessions.events.list.mockResolvedValue({ data: events, next_page: null });
    localStorage.setItem("oma_assistant_chat:default", "sesn_5");
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(
      await screen.findByText("Ассистент выключен. Включить его может владелец или администратор пространства"),
    ).toBeInTheDocument();
    expect(await screen.findByText("Готовлю черновик")).toBeInTheDocument();
    expect(await screen.findByText("Ассистент выключен в пространстве")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Сообщение ассистенту" })).toBeDisabled();
  });

  it("реплика пользователя видна один раз, когда её событие пришло из потока", async () => {
    const world = setupWorld();
    const stream = controllableStream();
    const user = userEvent.setup();
    renderPanel("/skills", { strict: true });
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await user.type(await screen.findByRole("textbox", { name: "Сообщение ассистенту" }), "сделай агента{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    await waitFor(() => expect(managed.sessions.events.stream).toHaveBeenCalled());
    const sent = world.eventBodies[0].body.events[0].content[0].text as string;
    await act(async () => {
      stream.push({ type: "user.message", id: "sev_1", content: [{ type: "text", text: sent }] } as Event);
      stream.push({ type: "agent.message", id: "sev_2", content: [{ type: "text", text: "Готово" }] } as Event);
    });
    expect(await screen.findByText("Готово")).toBeInTheDocument();
    expect(screen.getAllByText("сделай агента")).toHaveLength(1);
  });

  it("после применённой записи списки консоли обновляются", async () => {
    setupWorld();
    const stream = controllableStream();
    mockPlatformMcp([{ tool: "create_agent", preview_digest: "a1", operations: [] }]);
    managed.sessions.events.list.mockResolvedValue({
      data: [
        { type: "agent.mcp_tool_use", id: "tu_a", name: "create_agent", mcp_server_name: "platform", input: { config: { name: "Сводка" } } },
        { type: "user.tool_confirmation", id: "c1", tool_use_id: "tu_a", result: "allow" },
      ],
      next_page: null,
    });
    localStorage.setItem("oma_assistant_chat:default", "sesn_5");
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/agents"]}>
          <AssistantProvider>
            <OpenButton />
            <AssistantPanel />
          </AssistantProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "открыть" }));
    expect(await screen.findByText("Отправлено. Жду результат")).toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => {
      stream.push({
        type: "agent.mcp_tool_result",
        id: "r1",
        mcp_tool_use_id: "tu_a",
        content: [{ type: "text", text: "Создан агент «Сводка», id agent_7, версия 1" }],
      } as unknown as Event);
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    const predicate = invalidate.mock.calls[0][0]!.predicate!;
    expect(predicate({ queryKey: ["/v1/agents", "infinite"] } as never)).toBe(true);
  });

  it("живые события из потока добавляются в ленту", async () => {
    setupWorld();
    let push: (e: Event) => void = () => {};
    managed.sessions.events.stream.mockImplementation(async () =>
      (async function* () {
        const queue: Event[] = [];
        let wake: (() => void) | null = null;
        push = (e) => {
          queue.push(e);
          wake?.();
        };
        for (;;) {
          while (queue.length) yield queue.shift() as Event;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      })(),
    );
    const user = userEvent.setup();
    renderPanel("/skills");
    await user.click(screen.getByRole("button", { name: "открыть" }));
    await user.type(await screen.findByRole("textbox", { name: "Сообщение ассистенту" }), "привет{Enter}");
    await waitFor(() => expect(managed.sessions.events.stream).toHaveBeenCalled());
    await act(async () => {
      push({ type: "agent.message", id: "live1", content: [{ type: "text", text: "Здравствуйте, чем помочь?" }] });
    });
    expect(await screen.findByText("Здравствуйте, чем помочь?")).toBeInTheDocument();
  });
});
