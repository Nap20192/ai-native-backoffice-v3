import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../mocks/server";
import { SuggestOutcomeButton } from "./SuggestOutcomeButton";

const managed = vi.hoisted(() => {
  const sessions = { events: { list: vi.fn(), stream: vi.fn() } };
  return { sessions, api: { sessions } };
});
vi.mock("../../lib/useManagedApi", () => ({ useManagedApi: () => managed.api }));
vi.mock("../../lib/auth", () => ({ useAuth: () => ({ user: { id: "user_1" } }) }));

const BUILDER_AGENT = { id: "agent_b", name: "Ассистент", version: 4, metadata: { oma_role: "builder" } };
const BUILDER_ENV = { id: "env_b", name: "Ассистент", metadata: { oma_role: "builder" } };

interface World {
  enabled: boolean;
  installed: boolean;
  sessionBodies: Array<Record<string, any>>;
  messages: string[];
}

function setup(over: Partial<World> = {}): World {
  const world: World = { enabled: true, installed: true, sessionBodies: [], messages: [], ...over };
  server.use(
    http.get("*/v1/oma/platform-mcp/settings", () =>
      HttpResponse.json({ enabled: world.enabled, can_change: false }),
    ),
    http.get("*/v1/agents", () => HttpResponse.json({ data: world.installed ? [BUILDER_AGENT] : [] })),
    http.get("*/v1/environments", () => HttpResponse.json({ data: world.installed ? [BUILDER_ENV] : [] })),
    http.post("*/v1/sessions", async ({ request }) => {
      world.sessionBodies.push((await request.json()) as Record<string, any>);
      return HttpResponse.json({ id: "sesn_draft" });
    }),
    http.post("*/v1/sessions/:id/events", async ({ request }) => {
      const body = (await request.json()) as { events: Array<{ content: Array<{ text: string }> }> };
      world.messages.push(body.events[0].content[0].text);
      return HttpResponse.json({ data: [] });
    }),
  );
  return world;
}

const DRAFT_EVENTS = [
  {
    id: "tu_1",
    type: "agent.mcp_tool_use",
    mcp_server_name: "platform",
    name: "mcp__platform__preview_change",
    input: { kind: "outcome", body: {} },
  },
  {
    id: "res_1",
    type: "agent.mcp_tool_result",
    mcp_tool_use_id: "tu_1",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kind: "outcome",
          after_yaml: "description: План миграции\nrubric:\n  type: text\n  content: Есть откат\nmax_iterations: 5\n",
        }),
      },
    ],
  },
];

beforeEach(() => {
  managed.sessions.events.list.mockReset().mockResolvedValue({ data: [], next_page: null });
  managed.sessions.events.stream.mockReset().mockImplementation(async () =>
    (async function* () {
      await new Promise(() => {});
    })(),
  );
});

function renderButton(onSuggested = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/sessions/sesn_1"]}>
      <SuggestOutcomeButton sessionId="sesn_1" onSuggested={onSuggested} />
    </MemoryRouter>,
  );
  return onSuggested;
}

describe("SuggestOutcomeButton", () => {
  it("создаёт сессию в наборе «черновик», просит результат и отдаёт его диалогу", async () => {
    const world = setup();
    managed.sessions.events.list.mockResolvedValue({ data: DRAFT_EVENTS, next_page: null });
    const onSuggested = renderButton();

    await userEvent.click(screen.getByRole("button", { name: "Предложить результат" }));

    await waitFor(() =>
      expect(onSuggested).toHaveBeenCalledWith({ description: "План миграции", rubric: "Есть откат", maxIterations: 5 }),
    );
    const agent = world.sessionBodies[0].agent;
    expect(agent.type).toBe("agent_with_overrides");
    const toolset = agent.tools.find((t: any) => t.type === "mcp_toolset");
    expect(toolset.configs.filter((c: any) => c.enabled).map((c: any) => c.name).sort()).toEqual(
      ["get", "help", "list", "preview_change"],
    );
    expect(world.messages[0]).toContain("sesn_1");
    expect(world.messages[0]).toContain("<page_context>");
  });

  it("пока ассистент думает, кнопка занята", async () => {
    setup();
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Предложить результат" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Ассистент готовит черновик");
    expect(screen.getByRole("button", { name: "Предложить результат" })).toBeDisabled();
  });

  it("без ассистента подсказывает, где его поставить", async () => {
    setup({ installed: false });
    const onSuggested = renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Предложить результат" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ассистента здесь ещё нет");
    expect(onSuggested).not.toHaveBeenCalled();
  });

  it("выключенный ассистент даёт понятную причину", async () => {
    setup({ enabled: false });
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Предложить результат" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Ассистент выключен");
  });

  it("если ассистент ответил без черновика, сообщает об этом", async () => {
    setup();
    managed.sessions.events.list.mockResolvedValue({
      data: [{ id: "m1", type: "agent.message", content: [{ type: "text", text: "Не получилось" }] }, { id: "i1", type: "session.status_idle", stop_reason: { type: "end_turn" } }],
      next_page: null,
    });
    renderButton();
    await userEvent.click(screen.getByRole("button", { name: "Предложить результат" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("не подготовил черновик");
    expect(screen.getByRole("button", { name: "Предложить результат" })).toBeEnabled();
  });
});
