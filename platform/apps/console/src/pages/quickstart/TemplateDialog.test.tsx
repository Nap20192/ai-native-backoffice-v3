import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { server } from "../../mocks/server";
import { BuilderTemplateDialog } from "./TemplateDialog";

const assistantMock = vi.hoisted(() => ({ current: null as null | { reload: () => void } }));
vi.mock("../../components/assistant/AssistantProvider", () => ({
  useOptionalAssistant: () => assistantMock.current,
}));

const clipboard = vi.hoisted(() => ({ writeText: vi.fn().mockResolvedValue(undefined) }));

const AGENT = {
  name: "Ассистент",
  description: "Настраивает платформу",
  system: "Ты ассистент платформы.",
  metadata: { oma_role: "builder" },
  mcp_servers: [{ type: "url", name: "platform", url: "http://localhost:8788/v1/oma/platform-mcp" }],
  tools: [
    { type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] },
    { type: "mcp_toolset", mcp_server_name: "platform", default_config: { enabled: true, permission_policy: { type: "always_ask" } } },
  ],
};

interface World {
  models: string[];
  bundleModels: Array<string | null>;
  posted: Array<{ path: string; body: any }>;
  bundleStatus: number;
}

function setup(over: Partial<World> = {}): World {
  const world: World = { models: ["qwen3.6-35b", "gpt-x"], bundleModels: [], posted: [], bundleStatus: 200, ...over };
  server.use(
    http.get("*/v1/oma/model_cards", () =>
      HttpResponse.json({ data: world.models.map((m) => ({ id: `mc_${m}`, model_id: m, provider: "openai" })) }),
    ),
    http.get("*/v1/oma/platform-mcp/builder-bundle", ({ request }) => {
      const model = new URL(request.url).searchParams.get("model");
      world.bundleModels.push(model);
      if (world.bundleStatus !== 200) return HttpResponse.json({ error: "нет" }, { status: world.bundleStatus });
      return HttpResponse.json({
        type: "builder_bundle",
        needs_model: model === null,
        environment: { name: "Ассистент", config: { type: "cloud", networking: { type: "limited", allow_mcp_servers: true } } },
        agent: model ? { ...AGENT, model } : AGENT,
        tool_groups: [
          { id: "read", title: "Чтение и поиск", confirm: false, tools: ["help", "list", "get"] },
          { id: "draft", title: "Черновик", confirm: false, tools: ["preview_change"] },
          { id: "write", title: "Создание и правка", confirm: true, tools: ["create_agent", "update_agent"] },
        ],
      });
    }),
    http.get("*/v1/environments", () => HttpResponse.json({ data: [] })),
    http.post("*/v1/environments", async ({ request }) => {
      world.posted.push({ path: "/v1/environments", body: await request.json() });
      return HttpResponse.json({ id: "env_new", name: "Ассистент" });
    }),
    http.post("*/v1/agents", async ({ request }) => {
      world.posted.push({ path: "/v1/agents", body: await request.json() });
      return HttpResponse.json({ id: "agent_new", name: "Ассистент", version: 1 });
    }),
  );
  return world;
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderDialog(onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/quickstart"]}>
      <Routes>
        <Route path="/quickstart" element={<BuilderTemplateDialog open onClose={onClose} />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => {
  assistantMock.current = null;
  clipboard.writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
});

describe("диалог шаблона «Конструктор»", () => {
  it("показывает описание, группы инструментов, сервер platform и YAML агента", async () => {
    setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Конструктор" });

    expect(dialog).toHaveTextContent("Управляет платформой");
    expect(await within(dialog).findByText("Чтение и поиск")).toBeInTheDocument();
    expect(within(dialog).getByText("Создание и правка")).toBeInTheDocument();
    expect(within(dialog).getByText(/спрашивают подтверждение/)).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "MCP-серверы" })).toBeInTheDocument();
    expect(within(dialog).getAllByText(/platform/).length).toBeGreaterThan(0);
    const yaml = await within(dialog).findByLabelText("Конфигурация агента");
    expect(yaml.textContent).toContain("oma_role: builder");
    expect(yaml.textContent).toContain("model: qwen3.6-35b");
  });

  it("предупреждает, что лишние инструменты, серверы и навыки ломают сессию", async () => {
    setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Конструктор" });
    expect(await within(dialog).findByText(/сервер не будет обслуживать такие сессии/)).toBeInTheDocument();
  });

  it("смена модели перестраивает конфигурацию", async () => {
    const world = setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Конструктор" });
    await within(dialog).findByLabelText("Конфигурация агента");
    await userEvent.selectOptions(within(dialog).getByLabelText("Модель"), "gpt-x");
    await waitFor(() => expect(within(dialog).getByLabelText("Конфигурация агента").textContent).toContain("model: gpt-x"));
    expect(world.bundleModels).toContain("gpt-x");
  });

  it("«Копировать» кладёт YAML в буфер", async () => {
    setup();
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Конструктор" });
    await within(dialog).findByLabelText("Конфигурация агента");
    await userEvent.click(within(dialog).getByRole("button", { name: "Копировать" }));
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("oma_role: builder"));
  });

  it("«Использовать шаблон» ставит окружение и агента и открывает агента", async () => {
    const world = setup();
    assistantMock.current = { reload: vi.fn() };
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Конструктор" });
    await within(dialog).findByLabelText("Конфигурация агента");
    await userEvent.click(within(dialog).getByRole("button", { name: "Использовать шаблон" }));

    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/agents/agent_new"));
    expect(world.posted.map((p) => p.path)).toEqual(["/v1/environments", "/v1/agents"]);
    expect(world.posted[1].body.model).toBe("qwen3.6-35b");
    expect(world.posted[1].body.metadata).toMatchObject({ oma_role: "builder" });
    expect(assistantMock.current.reload).toHaveBeenCalled();
  });

  it("без карточек моделей установить нельзя и сказано почему", async () => {
    setup({ models: [] });
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Конструктор" });
    expect(await within(dialog).findByText(/Нет карточек моделей/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Использовать шаблон" })).toBeDisabled();
  });

  it("если комплект не загрузился, показывает ошибку и даёт повторить", async () => {
    setup({ bundleStatus: 500 });
    renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Конструктор" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Не удалось загрузить шаблон");
    expect(within(dialog).getByRole("button", { name: "Повторить" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Использовать шаблон" })).toBeDisabled();
  });

  it("«Отмена» закрывает окно", async () => {
    setup();
    const onClose = renderDialog();
    const dialog = await screen.findByRole("dialog", { name: "Конструктор" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalled();
  });
});
