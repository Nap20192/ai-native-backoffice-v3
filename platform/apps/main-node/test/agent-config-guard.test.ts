import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes } from "@open-managed-agents/managed-agents-api";
import type {
  AgentsApplicationPort,
  CreateAgentCommand,
  UpdateAgentCommand,
} from "@open-managed-agents/managed-agents-application";
import {
  agentConfigGuard,
  type AgentConfigGuardDeps,
} from "../src/lib/agent-config-guard.js";
import {
  listHarnesses,
  type CatalogHarnessCard,
  type HarnessEntry,
  type HarnessReadiness,
} from "../src/lib/harness-catalog.js";
import type { ModelOption } from "../src/lib/model-options.js";

const READY: HarnessReadiness = {
  rootSecret: "root-secret",
  gatewayBaseUrl: "http://host.boxlite.internal:8795",
  sandboxProvider: "litebox",
};

const CLAUDE_BLOCK = {
  agent: {
    id: "claude-acp",
    command: "sh",
    args: ["-c", "mkdir -p \"$CLAUDE_CONFIG_DIR\" && printf '%s' \"$OMA_CLAUDE_SETTINGS\" > \"$CLAUDE_CONFIG_DIR/settings.json\" && exec claude-agent-acp"],
    cwd: "/mnt/session/outputs",
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      OMA_CLAUDE_SETTINGS: "{\"permissions\":{\"allow\":[\"Read\",\"Write\",\"Edit\"]}}",
    },
  },
  per_turn_timeout_ms: 600000,
};

const AIDER_CARD: CatalogHarnessCard = {
  id: "hcard_V1StGXR8Z5jdHi6B",
  harness_id: "aider-local",
  name: "Aider через ACP",
  command: "aider-acp",
  args: [],
  cwd: "/mnt/session/outputs",
  install: { npm: [], pip: ["aider-chat==0.86.1"] },
  protocols: ["openai-chat"],
  allowed_env: ["AIDER_AUTO_COMMITS", "AIDER_MODEL"],
  status: "unverified",
  created_at: "2026-10-16T10:00:00.000Z",
  archived_at: null,
};

const AIDER_BLOCK = { agent: { id: "aider-local", command: "aider-acp", args: [], cwd: "/mnt/session/outputs" } };

function option(handle: string, overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    handle,
    label: handle,
    source: "card",
    card_id: `mc_${handle}`,
    is_default: false,
    provider: "anthropic",
    wire_model: handle,
    api: "anthropic-messages",
    protocols: ["anthropic-messages"],
    context_window: null,
    max_output_tokens: null,
    effort_levels: [],
    speed_fast: false,
    harnesses: [],
    ...overrides,
  };
}

const MODELS: ModelOption[] = [
  option("verify-fake", { effort_levels: ["low", "medium", "high", "max"], speed_fast: true }),
  option("verify-oai", {
    provider: "openai",
    api: "openai-responses",
    protocols: ["openai-chat", "openai-responses"],
    effort_levels: ["low", "medium", "high"],
    speed_fast: true,
  }),
  option("verify-router", { provider: "openrouter", protocols: [] }),
  option("no-effort"),
];

type StoredAgent = Awaited<ReturnType<AgentConfigGuardDeps["loadAgent"]>>;

interface Setup {
  readiness?: HarnessReadiness;
  agents?: Record<string, StoredAgent>;
}

async function harnessesFor(readiness: HarnessReadiness): Promise<HarnessEntry[]> {
  return listHarnesses({ readiness, listHarnessCards: async () => [AIDER_CARD] }, "ws_1");
}

function makeDeps(setup: Setup = {}) {
  const loadAgent = vi.fn(async (workspaceId: string, agentId: string): Promise<StoredAgent> => {
    expect(workspaceId).toBe("ws_1");
    return setup.agents?.[agentId] ?? null;
  });
  const catalog = vi.fn(async (workspaceId: string) => {
    expect(workspaceId).toBe("ws_1");
    return { models: MODELS, harnesses: await harnessesFor(setup.readiness ?? READY) };
  });
  const deps: AgentConfigGuardDeps = { catalog, loadAgent };
  return { deps, loadAgent, catalog };
}

/** An app shaped like node-http: tenant set by auth, guard before the agent routes. */
function guardedApp(deps: AgentConfigGuardDeps) {
  const v1 = new Hono<{
    Variables: { tenant_id: string; user_id?: string; auth_credential?: unknown };
  }>();
  v1.use("*", async (c, next) => {
    c.set("tenant_id", "ws_1");
    await next();
  });
  v1.use("/agents/*", agentConfigGuard(deps));
  const routes = new Hono();
  routes.post("/", async (c) => c.json({ route: "create", body: await c.req.json() }, 201));
  routes.post("/:agentId/archive", (c) => c.json({ route: "archive" }, 200));
  routes.post("/:agentId", async (c) => c.json({ route: "update", body: await c.req.json() }, 200));
  routes.get("/:agentId", (c) => c.json({ route: "get" }, 200));
  v1.route("/agents", routes);
  return v1;
}

async function post(app: Hono<any>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, any> };
}

function rejection(message: string) {
  return { type: "error", error: { type: "invalid_request_error", message } };
}

async function create(body: Record<string, unknown>, setup: Setup = {}) {
  const { deps } = makeDeps(setup);
  return post(guardedApp(deps), "/agents", { name: "verify-agent", ...body });
}

const acp = (block: unknown = CLAUDE_BLOCK) => ({ _oma: { harness: "acp-sandbox", acp: block } });

describe("agentConfigGuard on create", () => {
  it.each<[string, Record<string, unknown>, string, Setup?]>([
    [
      "1 acp-proxy",
      { model: "verify-fake", _oma: { harness: "acp-proxy" } },
      "acp-proxy на этом сервере не работает. Выберите harness из GET /v1/oma/harnesses",
    ],
    [
      "2 ai-sdk",
      { model: "verify-fake", _oma: { harness: "ai-sdk" } },
      "Harness ai-sdk устарел. Выберите встроенный цикл или ACP-агента из каталога",
    ],
    [
      "3 unknown harness",
      { model: "verify-fake", _oma: { harness: "custom-x" } },
      "Неизвестный harness «custom-x»",
    ],
    [
      "4 acp-sandbox without acp",
      { model: "verify-fake", _oma: { harness: "acp-sandbox" } },
      "Для acp-sandbox задайте _oma.acp.agent.command",
    ],
    [
      "4 acp-sandbox without command",
      { model: "verify-fake", ...acp({ agent: { id: "claude-acp" } }) },
      "Для acp-sandbox задайте _oma.acp.agent.command",
    ],
    [
      "5 id not in catalog",
      { model: "verify-fake", ...acp({ agent: { id: "aider", command: "aider-acp" } }) },
      "Harness «aider» не найден. Выберите вариант из GET /v1/oma/harnesses",
    ],
    [
      "5 built-in loop id is not an ACP entry",
      { model: "verify-fake", ...acp({ agent: { id: "pi", command: "pi" } }) },
      "Harness «pi» не найден. Выберите вариант из GET /v1/oma/harnesses",
    ],
    [
      "5 no id",
      { model: "verify-fake", ...acp({ agent: { command: "claude-agent-acp" } }) },
      "Для acp-sandbox задайте _oma.acp.agent.id. Выберите вариант из GET /v1/oma/harnesses",
    ],
    [
      "6 unavailable",
      { model: "verify-fake", ...acp() },
      "Harness «Claude Code в песочнице» недоступен: Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
      { readiness: { ...READY, rootSecret: null } },
    ],
    [
      "6 unavailable card",
      { model: "verify-oai", ...acp(AIDER_BLOCK) },
      "Harness «Aider через ACP» недоступен: Песочница этого сервера не запускает ACP-агентов",
      { readiness: { ...READY, sandboxProvider: "daytona" } },
    ],
    [
      "7 unknown model",
      { model: "missing-model" },
      "Модель «missing-model» не найдена. Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY",
    ],
    [
      "7 unknown model object",
      { model: { id: "missing-model", effort: "high" } },
      "Модель «missing-model» не найдена. Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY",
    ],
    [
      "8 protocol mismatch",
      { model: "verify-oai", ...acp() },
      "Модель «verify-oai» не подходит для «Claude Code в песочнице»: нужен протокол anthropic-messages, у модели openai-chat, openai-responses",
    ],
    [
      "8 model without protocols",
      { model: "verify-router", ...acp() },
      "Модель «verify-router» не подходит для «Claude Code в песочнице»: у модели нет протокола, который понимает прокси",
    ],
    [
      "8 card protocol mismatch",
      { model: "verify-fake", ...acp(AIDER_BLOCK) },
      "Модель «verify-fake» не подходит для «Aider через ACP»: нужен протокол openai-chat, у модели anthropic-messages",
    ],
    [
      "9 ACP effort",
      { model: { id: "verify-fake", effort: "high" }, ...acp() },
      "Claude Code в песочнице не принимает усилие: уберите model.effort",
    ],
    [
      "9 ACP effort object",
      { model: { id: "verify-fake", effort: { type: "low" } }, ...acp() },
      "Claude Code в песочнице не принимает усилие: уберите model.effort",
    ],
    [
      "10 ACP speed",
      { model: { id: "verify-fake", speed: "fast" }, ...acp() },
      "Claude Code в песочнице не принимает скорость: уберите model.speed",
    ],
    [
      "11 effort level",
      { model: { id: "verify-fake", effort: "xhigh" } },
      "Модель «verify-fake» не поддерживает усилие «xhigh». Допустимо: low, medium, high, max",
    ],
    [
      "11 no effort at all",
      { model: { id: "no-effort", effort: { type: "low" } } },
      "Модель «no-effort» не поддерживает усилие",
    ],
    [
      "12 fast speed",
      { model: { id: "no-effort", speed: "fast" } },
      "Модель «no-effort» не поддерживает быструю скорость",
    ],
    [
      "13 server name",
      { model: "verify-fake", ...acp({ ...CLAUDE_BLOCK, agent: { ...CLAUDE_BLOCK.agent, env: { ANTHROPIC_BASE_URL: "http://x" } } }) },
      "Переменную «ANTHROPIC_BASE_URL» задаёт сервер, уберите её из env агента",
    ],
    [
      "13 secret name",
      { model: "verify-fake", ...acp({ agent: { id: "claude-acp", command: "sh", env: { GITHUB_TOKEN: "x" } } }) },
      "Переменная «GITHUB_TOKEN» похожа на секрет. Ключи в env агента не кладите: модель подключается через прокси сервера",
    ],
    [
      "13 secret value",
      { model: "verify-fake", ...acp({ agent: { id: "claude-acp", command: "sh", env: { HELPER: "sk-ant-api03-x" } } }) },
      "Значение переменной «HELPER» похоже на ключ. Уберите его из env агента",
    ],
    [
      "13 bad name",
      { model: "verify-fake", ...acp({ agent: { id: "claude-acp", command: "sh", env: { "BAD-NAME": "1" } } }) },
      "Имя переменной «BAD-NAME» недопустимо: латиница, цифры и подчёркивание",
    ],
    [
      "13 not allowed by card",
      { model: "verify-oai", ...acp({ agent: { ...AIDER_BLOCK.agent, env: { OTHER: "1" } } }) },
      "Harness «Aider через ACP» не разрешает переменную «OTHER». Разрешены: AIDER_AUTO_COMMITS, AIDER_MODEL",
    ],
  ])("rejects case %s", async (_name, body, message, setup) => {
    const { status, json } = await create(body, setup);
    expect(status).toBe(400);
    expect(json).toEqual(rejection(message));
  });

  it("answers the first violation in table order", async () => {
    const { json } = await create({ model: "missing-model", _oma: { harness: "acp-proxy" } });
    expect(json.error.message).toMatch(/^acp-proxy/);
    const second = await create({ model: { id: "verify-oai", effort: "max" }, ...acp() });
    expect(second.json.error.message).toMatch(/не подходит/);
  });

  it.each<[string, Record<string, unknown>]>([
    ["model as a string", { model: "verify-fake" }],
    ["model with effort and fast speed", { model: { id: "verify-fake", effort: "high", speed: "fast" } }],
    ["standard speed anywhere", { model: { id: "no-effort", speed: "standard" }, ...acp() }],
    ["null effort on ACP", { model: { id: "verify-fake", effort: null, speed: null }, ...acp() }],
    ["harness default", { model: "verify-router", _oma: { harness: "default" } }],
    ["harness pi", { model: "verify-router", _oma: { harness: "pi" } }],
    ["W4 Claude Code recipe", { model: "verify-fake", ...acp() }],
    ["custom card with allowed env", {
      model: "verify-oai",
      ...acp({ agent: { ...AIDER_BLOCK.agent, env: { AIDER_AUTO_COMMITS: "false", AIDER_MODEL: null } } }),
    }],
    ["unverified built-in", { model: "verify-oai", ...acp({ agent: { id: "codex-acp", command: "codex-acp" } }) }],
    ["aux model is not checked", { model: "verify-fake", _oma: { aux_model: "missing-model" } }],
  ])("passes %s", async (_name, body) => {
    const { status, json } = await create(body);
    expect(status).toBe(201);
    expect(json).toEqual({ route: "create", body: { name: "verify-agent", ...body } });
  });

  it("leaves malformed fields to the route schema", async () => {
    const { status } = await create({ model: 42, _oma: { harness: 7 } });
    expect(status).toBe(201);
  });
});

describe("agentConfigGuard on update", () => {
  const claudeAgent: StoredAgent = {
    model: "verify-fake",
    _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK },
  };
  const deletedCardAgent: StoredAgent = {
    model: "verify-oai",
    _oma: { harness: "acp-sandbox", acp: { agent: { id: "deleted-card", command: "deleted-acp" } } },
  };
  const aiSdkAgent: StoredAgent = { model: "verify-fake", _oma: { harness: "ai-sdk" } };
  const piAgent: StoredAgent = { model: { id: "verify-fake", effort: "high" } };
  // Saved by W4 before the guard: the server-set ANTHROPIC_BASE_URL sits in env.
  const w4Agent: StoredAgent = {
    model: { id: "verify-fake", speed: "standard" },
    _oma: {
      harness: "acp-sandbox",
      acp: { agent: { ...CLAUDE_BLOCK.agent, env: { ...CLAUDE_BLOCK.agent.env, ANTHROPIC_BASE_URL: "http://fake.test" } } },
    },
  };
  const agents = { agt_claude: claudeAgent, agt_deleted: deletedCardAgent, agt_aisdk: aiSdkAgent, agt_pi: piAgent, agt_w4: w4Agent };

  async function update(agentId: string, body: Record<string, unknown>) {
    const ctx = makeDeps({ agents });
    const result = await post(guardedApp(ctx.deps), `/agents/${agentId}`, body);
    return { ...result, ...ctx };
  }

  it("does not check a rename and does not load the agent", async () => {
    const { status, loadAgent, catalog } = await update("agt_deleted", { name: "renamed", _oma: { appendable_prompts: ["p"] } });
    expect(status).toBe(200);
    expect(loadAgent).not.toHaveBeenCalled();
    expect(catalog).not.toHaveBeenCalled();
  });

  it("rejects a model change on an agent whose card was deleted", async () => {
    const { status, json } = await update("agt_deleted", { model: "verify-fake" });
    expect(status).toBe(400);
    expect(json).toEqual(rejection("Harness «deleted-card» не найден. Выберите вариант из GET /v1/oma/harnesses"));
  });

  // A form save (the console, YAML) sends every field back, the stored model,
  // harness and ACP agent too. Such a body changes nothing the guard checks.
  it("passes a full save of an agent whose card was deleted", async () => {
    const { status, json, catalog } = await update("agt_deleted", {
      name: "renamed",
      description: "new text",
      model: "verify-oai",
      _oma: { harness: "acp-sandbox", acp: { agent: { id: "deleted-card", command: "deleted-acp" } } },
    });
    expect(status).toBe(200);
    expect(json.route).toBe("update");
    expect(catalog).not.toHaveBeenCalled();
  });

  it("passes a full save of an old W4 agent with the server variable in env", async () => {
    const { status, catalog } = await update("agt_w4", {
      name: "renamed",
      model: { id: "verify-fake" },
      _oma: { harness: "acp-sandbox", acp: structuredClone(w4Agent!._oma!.acp) },
    });
    expect(status).toBe(200);
    expect(catalog).not.toHaveBeenCalled();
  });

  it("reads the stored model the way the API returns it", async () => {
    const { status, catalog } = await update("agt_pi", {
      name: "renamed",
      model: { id: "verify-fake", effort: { type: "high" }, speed: "standard", max_tokens: 1024 },
    });
    expect(status).toBe(200);
    expect(catalog).not.toHaveBeenCalled();
  });

  it("checks a full save that changes the ACP env", async () => {
    const acpBlock = structuredClone(w4Agent!._oma!.acp) as { agent: { env: Record<string, string> } };
    acpBlock.agent.env.GITHUB_TOKEN = "ghp_new";
    const { status, json } = await update("agt_w4", {
      name: "renamed",
      model: { id: "verify-fake" },
      _oma: { harness: "acp-sandbox", acp: acpBlock },
    });
    expect(status).toBe(400);
    expect(json).toEqual(rejection("Переменную «ANTHROPIC_BASE_URL» задаёт сервер, уберите её из env агента"));
  });

  it("checks a full save that changes the model", async () => {
    const { status, json } = await update("agt_deleted", {
      name: "renamed",
      model: { id: "verify-oai", effort: "high" },
      _oma: { harness: "acp-sandbox", acp: { agent: { id: "deleted-card", command: "deleted-acp" } } },
    });
    expect(status).toBe(400);
    expect(json).toEqual(rejection("Harness «deleted-card» не найден. Выберите вариант из GET /v1/oma/harnesses"));
  });

  it("checks the stored harness against a new model", async () => {
    const { status, json } = await update("agt_claude", { model: "verify-oai" });
    expect(status).toBe(400);
    expect(json.error.message).toBe(
      "Модель «verify-oai» не подходит для «Claude Code в песочнице»: нужен протокол anthropic-messages, у модели openai-chat, openai-responses",
    );
  });

  it("checks the stored model against a new harness", async () => {
    const { json } = await update("agt_pi", acp());
    expect(json.error.message).toBe("Claude Code в песочнице не принимает усилие: уберите model.effort");
  });

  it("lets null remove the ACP harness", async () => {
    const { status } = await update("agt_claude", { model: "verify-oai", _oma: { harness: null, acp: null } });
    expect(status).toBe(200);
  });

  it("replaces the acp block when the body has one", async () => {
    const { status } = await update("agt_claude", { model: "verify-oai", _oma: { acp: AIDER_BLOCK } });
    expect(status).toBe(200);
  });

  it("passes an old ai-sdk agent that keeps its harness", async () => {
    expect((await update("agt_aisdk", { model: "verify-oai" })).status).toBe(200);
    expect((await update("agt_aisdk", { model: "verify-fake", _oma: { harness: "ai-sdk" } })).status).toBe(200);
    const unknownModel = await update("agt_aisdk", { model: "missing-model" });
    expect(unknownModel.json.error.message).toMatch(/^Модель «missing-model» не найдена/);
  });

  it("rejects a switch to ai-sdk", async () => {
    const { status, json } = await update("agt_pi", { _oma: { harness: "ai-sdk" } });
    expect(status).toBe(400);
    expect(json).toEqual(rejection("Harness ai-sdk устарел. Выберите встроенный цикл или ACP-агента из каталога"));
  });

  it("leaves a missing agent to the route", async () => {
    const { status, json, catalog } = await update("agt_missing", { model: "missing-model" });
    expect(status).toBe(200);
    expect(json.route).toBe("update");
    expect(catalog).not.toHaveBeenCalled();
  });

  it("skips archive and other methods", async () => {
    const ctx = makeDeps({ agents });
    const app = guardedApp(ctx.deps);
    expect((await post(app, "/agents/agt_claude/archive", { model: "missing-model" })).status).toBe(200);
    expect((await app.request("/agents/agt_claude")).status).toBe(200);
    expect(ctx.loadAgent).not.toHaveBeenCalled();
    expect(ctx.catalog).not.toHaveBeenCalled();
  });

  it("decodes the agent id from the path", async () => {
    const ctx = makeDeps({ agents: { "agt one": claudeAgent } });
    await post(guardedApp(ctx.deps), "/agents/agt%20one", { model: "verify-fake" });
    expect(ctx.loadAgent).toHaveBeenCalledWith("ws_1", "agt one");
  });
});

describe("agentConfigGuard with the managed agent routes", () => {
  function managedApp(deps: AgentConfigGuardDeps) {
    const created: CreateAgentCommand[] = [];
    const updated: UpdateAgentCommand[] = [];
    const port = {
      createAgent: async (command: CreateAgentCommand) => {
        created.push(command);
        return { type: "invalid_request" as const, message: "captured" };
      },
      updateAgent: async (command: UpdateAgentCommand) => {
        updated.push(command);
        return { type: "not_found" as const };
      },
    } as unknown as AgentsApplicationPort;
    const v1 = new Hono<{ Variables: { tenant_id: string } }>();
    v1.use("*", async (c, next) => {
      c.set("tenant_id", "ws_1");
      await next();
    });
    v1.use("/agents/*", agentConfigGuard(deps));
    v1.route("/agents", buildAgentRoutes(() => port));
    return { v1, created, updated };
  }

  const headers = {
    "content-type": "application/json",
    "anthropic-beta": "managed-agents-2026-04-01",
  };

  it("hands the route the same create body after the guard read it", async () => {
    const { deps, catalog } = makeDeps();
    const { v1, created } = managedApp(deps);
    const body = { name: "verify-agent", model: { id: "verify-fake" }, _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } };
    const res = await v1.request("/agents", { method: "POST", headers, body: JSON.stringify(body) });
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(rejection("captured"));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: "verify-agent",
      model: { id: "verify-fake" },
      openma: { harness: "acp-sandbox", acp: { agent: { id: "claude-acp", command: "sh", env: CLAUDE_BLOCK.agent.env } } },
    });
  });

  it("hands the route the same update body after the guard read it", async () => {
    const { deps, loadAgent } = makeDeps({ agents: { agt_1: { model: "verify-fake" } } });
    const { v1, updated } = managedApp(deps);
    const res = await v1.request("/agents/agt_1", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "verify-oai", name: "renamed" }),
    });
    expect(loadAgent).toHaveBeenCalledWith("ws_1", "agt_1");
    expect(res.status).toBe(404);
    expect(updated).toEqual([expect.objectContaining({ agentId: "agt_1", model: "verify-oai", name: "renamed" })]);
  });

  it("leaves a body that is not JSON to the route", async () => {
    const { deps, catalog } = makeDeps();
    const { v1, created } = managedApp(deps);
    const res = await v1.request("/agents", { method: "POST", headers, body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(rejection("Request body must be valid JSON"));
    expect(catalog).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("stops a bad body before the application port", async () => {
    const { deps } = makeDeps();
    const { v1, created } = managedApp(deps);
    const res = await v1.request("/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "a", model: "missing-model" }),
    });
    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });
});
