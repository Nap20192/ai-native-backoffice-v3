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
  checkHarnessFields,
  ONLY_PI_MESSAGE,
  storedAgentForGuard,
  type AgentConfigGuardDeps,
} from "../src/lib/agent-config-guard.js";
import type { ModelOption } from "../src/lib/model-options.js";

const CLAUDE_BLOCK = {
  agent: {
    id: "claude-acp",
    command: "sh",
    args: ["-c", "exec claude-agent-acp"],
    cwd: "/mnt/session/outputs",
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  },
  per_turn_timeout_ms: 600000,
};

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
    harnesses: ["pi"],
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

function makeDeps(agents: Record<string, StoredAgent> = {}) {
  const loadAgent = vi.fn(async (workspaceId: string, agentId: string): Promise<StoredAgent> => {
    expect(workspaceId).toBe("ws_1");
    return agents[agentId] ?? null;
  });
  const models = vi.fn(async (workspaceId: string) => {
    expect(workspaceId).toBe("ws_1");
    return MODELS;
  });
  const deps: AgentConfigGuardDeps = { models, loadAgent };
  return { deps, loadAgent, models };
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

async function create(body: Record<string, unknown>) {
  const { deps } = makeDeps();
  return post(guardedApp(deps), "/agents", { name: "verify-agent", ...body });
}

describe("checkHarnessFields (D41)", () => {
  it.each<[string, Record<string, unknown>]>([
    ["no harness", {}],
    ["harness default", { harness: "default" }],
    ["harness pi", { harness: "pi" }],
    ["null harness", { harness: null }],
    ["null acp", { harness: "pi", acp: null }],
    ["other _oma fields", { aux_model: "verify-fake", appendable_prompts: ["p"] }],
  ])("keeps %s on Pi", (_name, oma) => {
    expect(checkHarnessFields(oma)).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["acp-sandbox", { harness: "acp-sandbox" }],
    ["acp-proxy", { harness: "acp-proxy" }],
    ["ai-sdk", { harness: "ai-sdk" }],
    ["unknown harness", { harness: "custom-x" }],
    ["acp block without harness", { acp: CLAUDE_BLOCK }],
    ["acp block with harness pi", { harness: "pi", acp: CLAUDE_BLOCK }],
    ["empty acp block", { acp: {} }],
  ])("refuses %s", (_name, oma) => {
    expect(checkHarnessFields(oma)).toBe(ONLY_PI_MESSAGE);
  });
});

describe("agentConfigGuard on create", () => {
  it.each<[string, Record<string, unknown>]>([
    ["acp-sandbox with a block", { model: "verify-fake", _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } }],
    ["acp-sandbox without a block", { model: "verify-fake", _oma: { harness: "acp-sandbox" } }],
    ["acp-proxy", { model: "verify-fake", _oma: { harness: "acp-proxy" } }],
    ["ai-sdk", { model: "verify-fake", _oma: { harness: "ai-sdk" } }],
    ["unknown harness", { model: "verify-fake", _oma: { harness: "custom-x" } }],
    ["acp block alone", { model: "verify-fake", _oma: { acp: CLAUDE_BLOCK } }],
  ])("refuses a new agent with %s", async (_name, body) => {
    const { status, json } = await create(body);
    expect(status).toBe(400);
    expect(json).toEqual(rejection(ONLY_PI_MESSAGE));
  });

  it("refuses the harness before it looks at the model", async () => {
    const { deps, models } = makeDeps();
    const { json } = await post(guardedApp(deps), "/agents", {
      name: "verify-agent",
      model: "missing-model",
      _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK },
    });
    expect(json).toEqual(rejection(ONLY_PI_MESSAGE));
    expect(models).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "unknown model",
      { model: "missing-model" },
      "Модель «missing-model» не найдена. Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY",
    ],
    [
      "unknown model object",
      { model: { id: "missing-model", effort: "high" } },
      "Модель «missing-model» не найдена. Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY",
    ],
    [
      "effort level",
      { model: { id: "verify-fake", effort: "xhigh" } },
      "Модель «verify-fake» не поддерживает усилие «xhigh». Допустимо: low, medium, high, max",
    ],
    [
      "no effort at all",
      { model: { id: "no-effort", effort: { type: "low" } } },
      "Модель «no-effort» не поддерживает усилие",
    ],
    [
      "fast speed",
      { model: { id: "no-effort", speed: "fast" } },
      "Модель «no-effort» не поддерживает быструю скорость",
    ],
  ])("rejects %s", async (_name, body, message) => {
    const { status, json } = await create(body);
    expect(status).toBe(400);
    expect(json).toEqual(rejection(message));
  });

  it.each<[string, Record<string, unknown>]>([
    ["model as a string", { model: "verify-fake" }],
    ["model with effort and fast speed", { model: { id: "verify-fake", effort: "high", speed: "fast" } }],
    ["standard speed", { model: { id: "no-effort", speed: "standard" } }],
    ["null effort and speed", { model: { id: "verify-fake", effort: null, speed: null } }],
    ["a model without protocols", { model: "verify-router" }],
    ["harness default", { model: "verify-router", _oma: { harness: "default" } }],
    ["harness pi", { model: "verify-router", _oma: { harness: "pi" } }],
    ["null harness and acp", { model: "verify-fake", _oma: { harness: null, acp: null } }],
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
  // Stored before D41: such agents still read and run on Pi.
  const claudeAgent: StoredAgent = { model: "verify-fake" };
  const deletedCardAgent: StoredAgent = { model: "deleted-model" };
  const piAgent: StoredAgent = { model: { id: "verify-fake", effort: "high" } };
  const agents = { agt_claude: claudeAgent, agt_deleted: deletedCardAgent, agt_pi: piAgent };

  async function update(agentId: string, body: Record<string, unknown>) {
    const ctx = makeDeps(agents);
    const result = await post(guardedApp(ctx.deps), `/agents/${agentId}`, body);
    return { ...result, ...ctx };
  }

  it("does not check a rename and does not load the agent", async () => {
    const { status, loadAgent, models } = await update("agt_claude", { name: "renamed", _oma: { appendable_prompts: ["p"] } });
    expect(status).toBe(200);
    expect(loadAgent).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ["a switch to acp-sandbox", { _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } }],
    ["a switch to ai-sdk", { _oma: { harness: "ai-sdk" } }],
    ["an acp block alone", { _oma: { acp: CLAUDE_BLOCK } }],
    ["a full save that keeps an old acp harness", { name: "renamed", model: "verify-fake", _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } }],
  ])("refuses %s", async (_name, body) => {
    const { status, json, loadAgent } = await update("agt_claude", body);
    expect(status).toBe(400);
    expect(json).toEqual(rejection(ONLY_PI_MESSAGE));
    expect(loadAgent).not.toHaveBeenCalled();
  });

  it("lets null move an old agent to Pi", async () => {
    const { status } = await update("agt_claude", { _oma: { harness: null, acp: null } });
    expect(status).toBe(200);
  });

  it("lets an old agent switch to pi", async () => {
    const { status } = await update("agt_claude", { _oma: { harness: "pi" } });
    expect(status).toBe(200);
  });

  // A form or YAML save sends the stored model back with every change.
  it("passes a full save of an agent whose model card was deleted", async () => {
    const { status, json, models } = await update("agt_deleted", {
      name: "renamed",
      description: "new text",
      model: "deleted-model",
    });
    expect(status).toBe(200);
    expect(json.route).toBe("update");
    expect(models).not.toHaveBeenCalled();
  });

  it("rejects a model change to a missing model", async () => {
    const { status, json } = await update("agt_deleted", { model: "missing-model" });
    expect(status).toBe(400);
    expect(json.error.message).toMatch(/^Модель «missing-model» не найдена/);
  });

  it("reads the stored model the way the API returns it", async () => {
    const { status, models } = await update("agt_pi", {
      name: "renamed",
      model: { id: "verify-fake", effort: { type: "high" }, speed: "standard", max_tokens: 1024 },
    });
    expect(status).toBe(200);
    expect(models).not.toHaveBeenCalled();
  });

  it("checks a new model against its options", async () => {
    const { status, json } = await update("agt_pi", { model: { id: "verify-oai", effort: "max" } });
    expect(status).toBe(400);
    expect(json.error.message).toBe("Модель «verify-oai» не поддерживает усилие «max». Допустимо: low, medium, high");
  });

  it("leaves a missing agent to the route", async () => {
    const { status, json, models } = await update("agt_missing", { model: "missing-model" });
    expect(status).toBe(200);
    expect(json.route).toBe("update");
    expect(models).not.toHaveBeenCalled();
  });

  it("skips archive and other methods", async () => {
    const ctx = makeDeps(agents);
    const app = guardedApp(ctx.deps);
    expect((await post(app, "/agents/agt_claude/archive", { model: "missing-model", _oma: { harness: "acp-sandbox" } })).status).toBe(200);
    expect((await app.request("/agents/agt_claude")).status).toBe(200);
    expect(ctx.loadAgent).not.toHaveBeenCalled();
    expect(ctx.models).not.toHaveBeenCalled();
  });

  it("decodes the agent id from the path", async () => {
    const ctx = makeDeps({ "agt one": claudeAgent });
    await post(guardedApp(ctx.deps), "/agents/agt%20one", { model: "verify-oai" });
    expect(ctx.loadAgent).toHaveBeenCalledWith("ws_1", "agt one");
  });
});

describe("storedAgentForGuard", () => {
  it("keeps the model fields the guard compares", () => {
    expect(storedAgentForGuard({ model: { id: "verify-fake", effort: "high", speed: "fast" } }))
      .toEqual({ model: { id: "verify-fake", effort: "high", speed: "fast" } });
    expect(storedAgentForGuard({ model: { id: "verify-fake" } })).toEqual({ model: { id: "verify-fake" } });
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

  it("refuses a new ACP agent before the application port", async () => {
    const { deps } = makeDeps();
    const { v1, created } = managedApp(deps);
    const body = { name: "verify-agent", model: { id: "verify-fake" }, _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } };
    const res = await v1.request("/agents", { method: "POST", headers, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(rejection(ONLY_PI_MESSAGE));
    expect(created).toHaveLength(0);
  });

  it("hands the route the same create body after the guard read it", async () => {
    const { deps, models } = makeDeps();
    const { v1, created } = managedApp(deps);
    const body = { name: "verify-agent", model: { id: "verify-fake" }, _oma: { harness: "pi" } };
    const res = await v1.request("/agents", { method: "POST", headers, body: JSON.stringify(body) });
    expect(models).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(rejection("captured"));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: "verify-agent", model: { id: "verify-fake" }, openma: { harness: "pi" } });
  });

  it("hands the route the same update body after the guard read it", async () => {
    const { deps, loadAgent } = makeDeps({ agt_1: { model: "verify-fake" } });
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
    const { deps, models } = makeDeps();
    const { v1, created } = managedApp(deps);
    const res = await v1.request("/agents", { method: "POST", headers, body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(rejection("Request body must be valid JSON"));
    expect(models).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("stops a bad model before the application port", async () => {
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
