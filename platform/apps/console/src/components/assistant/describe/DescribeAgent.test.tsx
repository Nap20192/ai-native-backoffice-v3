import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Event } from "../../../lib/events";
import { server } from "../../../mocks/server";
import { AssistantPanel } from "../AssistantPanel";
import { AssistantProvider } from "../AssistantProvider";
import { DescribeAgent } from "./DescribeAgent";

const managed = vi.hoisted(() => {
  const sessions = { events: { list: vi.fn(), stream: vi.fn() } };
  return { sessions, api: { sessions } };
});
vi.mock("../../../lib/useManagedApi", () => ({ useManagedApi: () => managed.api }));

const BUILDER_AGENT = { id: "agent_b", name: "Ассистент", version: 4, metadata: { oma_role: "builder" } };
const BUILDER_ENV = { id: "env_b", name: "Ассистент", metadata: { oma_role: "builder" } };

const YAML_A = "name: Сводка заявок\nmodel: qwen3.6-35b\nsystem: Пиши сводку\n";
const YAML_B = "name: Сводка заявок\nmodel: qwen3.6-35b\nsystem: Пиши короткую сводку\n";

interface World {
  installed: boolean;
  enabled: boolean;
  sessionBodies: Array<Record<string, any>>;
  eventBodies: Array<{ sessionId: string; body: Record<string, any> }>;
  agentPosts: Array<Record<string, any>>;
  createStatus: number;
  builderFails: boolean;
}

function setupWorld(over: Partial<World> = {}): World {
  const world: World = {
    installed: true,
    enabled: true,
    sessionBodies: [],
    eventBodies: [],
    agentPosts: [],
    createStatus: 200,
    builderFails: false,
    ...over,
  };
  server.use(
    http.get("*/v1/oma/platform-mcp/settings", () => HttpResponse.json({ enabled: world.enabled, can_change: false })),
    http.get("*/v1/agents", () => {
      if (world.builderFails) return HttpResponse.json({}, { status: 500 });
      return HttpResponse.json({ data: world.installed ? [BUILDER_AGENT] : [] });
    }),
    http.get("*/v1/environments", () => HttpResponse.json({ data: world.installed ? [BUILDER_ENV] : [] })),
    http.get("*/v1/oma/model_cards", () =>
      HttpResponse.json({ data: [{ id: "mc1", model_id: "qwen3.6-35b", model: "qwen", provider: "openai" }] }),
    ),
    http.get("*/v1/oma/platform-mcp/builder-bundle", () =>
      HttpResponse.json({ environment: { name: "Ассистент", config: { type: "cloud" } }, agent: { name: "Ассистент", model: "m" } }),
    ),
    http.post("*/v1/environments", () => HttpResponse.json({ id: "env_b", name: "Ассистент" })),
    http.post("*/v1/sessions", async ({ request }) => {
      world.sessionBodies.push((await request.json()) as Record<string, any>);
      return HttpResponse.json({ id: `sesn_${world.sessionBodies.length}` });
    }),
    http.post("*/v1/sessions/:id/events", async ({ request, params }) => {
      world.eventBodies.push({ sessionId: String(params.id), body: (await request.json()) as Record<string, any> });
      return HttpResponse.json({ data: [] });
    }),
    http.post("*/v1/agents", async ({ request }) => {
      const body = (await request.json()) as Record<string, any>;
      if (body.metadata?.oma_role === "builder") {
        world.installed = true;
        return HttpResponse.json({ id: "agent_b", name: "Ассистент", version: 1 });
      }
      world.agentPosts.push(body);
      if (world.createStatus !== 200) {
        return HttpResponse.json({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, { status: world.createStatus });
      }
      return HttpResponse.json({ id: "agent_new", name: body.name, version: 1 });
    }),
  );
  return world;
}

/** Очередь живых событий сессии: тест кладёт событие, поток его отдаёт. */
function liveEvents() {
  const queue: Event[] = [];
  let wake: (() => void) | null = null;
  managed.sessions.events.stream.mockImplementation(async () =>
    (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift() as Event;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
  );
  return (event: Event) => {
    queue.push(event);
    wake?.();
  };
}

const use = (id: string, input: Record<string, unknown>): Event => ({
  type: "agent.mcp_tool_use",
  id,
  name: "mcp__platform__preview_change",
  mcp_server_name: "platform",
  input,
});
const resultOf = (id: string, yaml: string): Event => ({
  type: "agent.mcp_tool_result",
  id: `res_${id}`,
  mcp_tool_use_id: id,
  content: [
    {
      type: "text",
      text: JSON.stringify({
        tool: "preview_change",
        preview_digest: "d",
        operations: [{ index: 0, tool: "create_agent", kind: "agent", class: "create", after_yaml: yaml, warnings: [] }],
      }),
    },
  ],
});

function renderDescribe(props: Partial<Parameters<typeof DescribeAgent>[0]> = {}, withProvider = false) {
  const routes = (
    <>
      <Routes>
        <Route path="/agents/new" element={<DescribeAgent {...props} />} />
        <Route path="/agents/:id" element={<p>Страница агента</p>} />
      </Routes>
      {withProvider ? <AssistantPanel /> : null}
    </>
  );
  return render(
    <MemoryRouter initialEntries={["/agents/new"]}>
      {withProvider ? <AssistantProvider>{routes}</AssistantProvider> : routes}
    </MemoryRouter>,
  );
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

const PROMPT = "Агент, который раз в день собирает новые заявки из файла и пишет сводку";

async function generate(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Опишите, что должен делать агент"), PROMPT);
  await user.click(screen.getByRole("button", { name: "Сгенерировать" }));
}

describe("DescribeAgent: начало", () => {
  it("«Сгенерировать» выключена, пока поле пустое, и ничего не запрашивает", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderDescribe();
    const button = screen.getByRole("button", { name: "Сгенерировать" });
    expect(button).toBeDisabled();
    expect(screen.getByLabelText("Опишите, что должен делать агент")).toHaveAttribute("placeholder", expect.stringContaining("заявки"));
    await user.type(screen.getByLabelText("Опишите, что должен делать агент"), "  ");
    expect(button).toBeDisabled();
    expect(world.sessionBodies).toHaveLength(0);
  });

  it("поле заполнено текстом из initialPrompt", () => {
    setupWorld();
    renderDescribe({ initialPrompt: "Сделай бота" });
    expect(screen.getByLabelText("Опишите, что должен делать агент")).toHaveValue("Сделай бота");
    expect(screen.getByRole("button", { name: "Сгенерировать" })).toBeEnabled();
  });

  it("«Сгенерировать» создаёт сессию набора «черновик» и шлёт запрос с контекстом", async () => {
    const world = setupWorld();
    const user = userEvent.setup();
    renderDescribe();
    await generate(user);
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    const agent = world.sessionBodies[0].agent;
    expect(agent).toMatchObject({ type: "agent_with_overrides", id: "agent_b", version: 4 });
    expect(agent.tools[0]).toMatchObject({ type: "agent_toolset_20260401", default_config: { enabled: false } });
    const configs = agent.tools[1].configs.map((c: { name: string }) => c.name);
    expect(configs).toEqual(["help", "list", "get", "preview_change"]);
    const text: string = world.eventBodies[0].body.events[0].content[0].text;
    expect(text.startsWith(PROMPT)).toBe(true);
    expect(text).toContain('"kind":"agent_new"');
    expect(screen.getByRole("heading", { name: "Конфигурация агента" })).toBeInTheDocument();
    expect(screen.getByText(PROMPT)).toBeInTheDocument();
  });

  it("autoStart начинает сразу с текста initialPrompt", async () => {
    const world = setupWorld();
    renderDescribe({ initialPrompt: "Сделай бота", autoStart: true });
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    expect(world.eventBodies[0].body.events[0].content[0].text).toContain("Сделай бота");
  });
});

describe("DescribeAgent: ассистент недоступен", () => {
  it("без ассистента предлагает установить и после установки продолжает", async () => {
    const world = setupWorld({ installed: false });
    const user = userEvent.setup();
    renderDescribe();
    await generate(user);
    expect(await screen.findByText("Ассистента здесь ещё нет")).toBeInTheDocument();
    expect(world.sessionBodies).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Установить" }));
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
    expect(world.eventBodies[0].body.events[0].content[0].text).toContain(PROMPT);
  });

  it("выключенный ассистент: объяснение и ни одной сессии", async () => {
    const world = setupWorld({ enabled: false });
    const user = userEvent.setup();
    renderDescribe();
    await generate(user);
    expect(await screen.findByText(/Ассистент выключен/)).toBeInTheDocument();
    expect(world.sessionBodies).toHaveLength(0);
  });

  it("сбой загрузки даёт «Повторить»", async () => {
    const world = setupWorld({ builderFails: true });
    const user = userEvent.setup();
    renderDescribe();
    await generate(user);
    expect(await screen.findByText("Не удалось загрузить ассистента")).toBeInTheDocument();
    world.builderFails = false;
    await user.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(world.eventBodies).toHaveLength(1));
  });
});

describe("DescribeAgent: черновик", () => {
  it("панель строится из preview_change, следующий черновик подсвечивает изменения", async () => {
    setupWorld();
    const push = liveEvents();
    const user = userEvent.setup();
    renderDescribe();
    await generate(user);
    await screen.findByRole("heading", { name: "Конфигурация агента" });
    expect(screen.getByText(/Черновик появится/)).toBeInTheDocument();

    push(use("tu1", { kind: "agent", config: YAML_A }));
    push(resultOf("tu1", YAML_A));
    expect(await screen.findByLabelText("Название")).toHaveValue("Сводка заявок");
    expect(screen.getByLabelText("Системный промпт")).toHaveValue("Пиши сводку");
    expect(screen.queryByText(/Изменилось/)).toBeNull();
    expect(screen.getByText("Собрал черновик: агент")).toBeInTheDocument();

    push(use("tu2", { kind: "agent", config: YAML_B }));
    push(resultOf("tu2", YAML_B));
    expect(await screen.findByText("Изменилось: system")).toBeInTheDocument();
    expect(screen.getByLabelText("Системный промпт")).toHaveValue("Пиши короткую сводку");
  });

  it("ручная правка YAML уходит в контекст следующего сообщения", async () => {
    const world = setupWorld();
    const push = liveEvents();
    const user = userEvent.setup();
    renderDescribe();
    await generate(user);
    await screen.findByRole("heading", { name: "Конфигурация агента" });
    push(use("tu1", { kind: "agent" }));
    push(resultOf("tu1", YAML_A));
    await screen.findByLabelText("Название");

    await user.click(screen.getByRole("tab", { name: "YAML" }));
    fireEvent.change(screen.getByLabelText("Конфигурация в виде текста"), {
      target: { value: "name: Моя правка\nmodel: qwen3.6-35b\n" },
    });
    await user.type(screen.getByLabelText("Сообщение ассистенту"), "Добавь описание{Enter}");
    await waitFor(() => expect(world.eventBodies).toHaveLength(2));
    const text: string = world.eventBodies[1].body.events[0].content[0].text;
    expect(text.startsWith("Добавь описание")).toBe(true);
    const ctx = JSON.parse(text.slice(text.indexOf("<page_context>") + 14, text.indexOf("</page_context>")));
    expect(ctx.draftYaml).toBe("name: Моя правка\nmodel: qwen3.6-35b\n");
    expect(world.sessionBodies).toHaveLength(1);
  });
});

describe("DescribeAgent: создание", () => {
  async function withDraft(over: Partial<World> = {}, props: Partial<Parameters<typeof DescribeAgent>[0]> = {}, provider = false) {
    const world = setupWorld(over);
    const push = liveEvents();
    const user = userEvent.setup();
    renderDescribe(props, provider);
    await generate(user);
    await screen.findByRole("heading", { name: "Конфигурация агента" });
    return { world, push, user };
  }

  it("пока черновика нет, «Создать агента» выключена", async () => {
    await withDraft();
    expect(screen.getByRole("button", { name: "Создать агента" })).toBeDisabled();
  });

  it("«Создать агента» шлёт POST /v1/agents с YAML панели и открывает агента", async () => {
    const { world, push, user } = await withDraft();
    push(use("tu1", { kind: "agent" }));
    push(resultOf("tu1", YAML_A));
    await screen.findByLabelText("Название");
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    fireEvent.change(screen.getByLabelText("Конфигурация в виде текста"), {
      target: { value: "name: Правка руками\nmodel: qwen3.6-35b\nsystem: Пиши\n" },
    });
    await user.click(screen.getByRole("button", { name: "Создать агента" }));
    expect(await screen.findByText("Страница агента")).toBeInTheDocument();
    expect(world.agentPosts).toEqual([
      { name: "Правка руками", model: "qwen3.6-35b", system: "Пиши", tools: [{ type: "agent_toolset_20260401" }] },
    ]);
  });

  it("onCreated заменяет переход, а ассистент ничего не пишет", async () => {
    const onCreated = vi.fn();
    const { world, push, user } = await withDraft({}, { onCreated });
    push(use("tu1", { kind: "agent" }));
    push(resultOf("tu1", YAML_A));
    await screen.findByLabelText("Название");
    await user.click(screen.getByRole("button", { name: "Создать агента" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: "agent_new", name: "Сводка заявок" }));
    expect(screen.queryByText("Страница агента")).toBeNull();
    expect(world.agentPosts).toHaveLength(1);
  });

  it("битый YAML: причина на панели, кнопка выключена, запроса нет", async () => {
    const { world, push, user } = await withDraft();
    push(use("tu1", { kind: "agent" }));
    push(resultOf("tu1", YAML_A));
    await screen.findByLabelText("Название");
    await user.click(screen.getByRole("tab", { name: "YAML" }));
    fireEvent.change(screen.getByLabelText("Конфигурация в виде текста"), { target: { value: "name: [" } });
    expect(screen.getByRole("button", { name: "Создать агента" })).toBeDisabled();
    expect(within(screen.getByRole("region", { name: "Конфигурация агента" })).getByRole("alert").textContent).toMatch(/YAML/);
    expect(world.agentPosts).toHaveLength(0);
  });

  it("ошибка сервера остаётся на странице с причиной, кнопку можно нажать снова", async () => {
    const { world, push, user } = await withDraft({ createStatus: 400 });
    push(use("tu1", { kind: "agent" }));
    push(resultOf("tu1", YAML_A));
    await screen.findByLabelText("Название");
    await user.click(screen.getByRole("button", { name: "Создать агента" }));
    expect(await screen.findByText(/Не удалось создать агента/)).toBeInTheDocument();
    expect(screen.queryByText("Страница агента")).toBeNull();
    expect(screen.getByRole("button", { name: "Создать агента" })).toBeEnabled();
    world.createStatus = 200;
    await user.click(screen.getByRole("button", { name: "Создать агента" }));
    expect(await screen.findByText("Страница агента")).toBeInTheDocument();
  });

  it("«Отмена» зовёт onCancel", async () => {
    const onCancel = vi.fn();
    const { user } = await withDraft({}, { onCancel });
    await user.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("с провайдером после создания открывается панель ассистента с контекстом нового агента", async () => {
    const { push, user } = await withDraft({}, {}, true);
    push(use("tu1", { kind: "agent" }));
    push(resultOf("tu1", YAML_A));
    await screen.findByLabelText("Название");
    await user.click(screen.getByRole("button", { name: "Создать агента" }));
    expect(await screen.findByText("Страница агента")).toBeInTheDocument();
    expect(await screen.findByRole("complementary", { name: "Ассистент" })).toBeInTheDocument();
  });
});
