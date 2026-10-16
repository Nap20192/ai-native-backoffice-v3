import { describe, expect, it, vi } from "vitest";

import { fetchBuilderBundle, fetchModelChoices, installBuilder, type BuilderBundle } from "./install";

const bundle: BuilderBundle = {
  environment: { name: "Ассистент", config: { type: "cloud", networking: { type: "limited", allow_mcp_servers: true } } },
  agent: {
    name: "Ассистент",
    model: "qwen3.6-35b",
    system: "Ты ассистент.",
    metadata: { oma_role: "builder" },
    mcp_servers: [{ type: "url", name: "platform", url: "http://x/v1/oma/platform-mcp" }],
    tools: [],
  },
};

function makeApi(opts: { existingEnv?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path, method, body });
    if (path.startsWith("/v1/oma/platform-mcp/builder-bundle")) return bundle;
    if (path.startsWith("/v1/environments") && method === "GET") {
      return {
        data: opts.existingEnv
          ? [{ id: "env_old", name: "Ассистент", metadata: { oma_role: "builder" } }]
          : [],
      };
    }
    if (path === "/v1/environments") return { id: "env_new", name: "Ассистент" };
    if (path === "/v1/agents") return { id: "agent_new", name: "Ассистент", version: 1 };
    throw new Error(`неожиданный запрос ${method} ${path}`);
  });
  return { api, calls };
}

describe("installBuilder", () => {
  it("берёт комплект, ставит окружение и агента", async () => {
    const { api, calls } = makeApi();
    const ref = await installBuilder(api, { model: "qwen3.6-35b" });
    expect(ref).toEqual({
      agent: { id: "agent_new", name: "Ассистент", version: 1 },
      environment: { id: "env_new", name: "Ассистент" },
    });
    expect(calls[0].path).toBe("/v1/oma/platform-mcp/builder-bundle?model=qwen3.6-35b");
    const envPost = calls.find((c) => c.path === "/v1/environments" && c.method === "POST");
    expect(envPost?.body).toMatchObject({
      name: "Ассистент",
      metadata: { oma_role: "builder" },
      config: { networking: { type: "limited", allow_mcp_servers: true } },
    });
    const agentPost = calls.find((c) => c.path === "/v1/agents" && c.method === "POST");
    expect(agentPost?.body).toMatchObject({ model: "qwen3.6-35b", metadata: { oma_role: "builder" } });
  });

  it("не создаёт окружение второй раз", async () => {
    const { api, calls } = makeApi({ existingEnv: true });
    const ref = await installBuilder(api, { model: null });
    expect(ref.environment.id).toBe("env_old");
    expect(calls.some((c) => c.path === "/v1/environments" && c.method === "POST")).toBe(false);
    expect(calls[0].path).toBe("/v1/oma/platform-mcp/builder-bundle");
  });

  it("метку роли ставит, даже если комплект её не принёс", async () => {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const api = vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path.startsWith("/v1/oma/platform-mcp")) return { environment: { name: "Ассистент" }, agent: { name: "Ассистент", model: "m" } };
      if (method === "GET") return { data: [] };
      calls.push({ path, body: JSON.parse(init!.body as string) });
      return path === "/v1/agents" ? { id: "a", name: "А", version: 1 } : { id: "e", name: "А" };
    });
    await installBuilder(api, { model: null });
    for (const c of calls) expect(c.body?.metadata).toMatchObject({ oma_role: "builder" });
  });

  it("пустой комплект это ошибка", async () => {
    const api = vi.fn(async () => ({}));
    await expect(installBuilder(api, { model: null })).rejects.toThrow("комплект");
  });
});

describe("fetchModelChoices", () => {
  it("отдаёт карточки без архивных", async () => {
    const api = vi.fn(async () => ({
      data: [
        { id: "mc1", model_id: "qwen3.6-35b", model: "qwen", provider: "openai" },
        { id: "mc2", model_id: "old", model: "old", provider: "x", archived_at: "2026-01-01T00:00:00Z" },
        { id: "mc3", model: "no-handle" },
      ],
    }));
    expect(await fetchModelChoices(api)).toEqual([{ id: "qwen3.6-35b", label: "qwen3.6-35b", provider: "openai" }]);
  });
});

describe("fetchBuilderBundle", () => {
  const raw = {
    type: "builder_bundle",
    needs_model: false,
    environment: bundle.environment,
    agent: bundle.agent,
    tool_groups: [
      { id: "read", title: "Чтение и поиск", confirm: false, tools: ["help", "list"] },
      { id: "write", title: "Создание и правка", confirm: true, tools: ["create_agent"] },
      { id: "broken", title: 5 },
    ],
  };

  it("просит комплект с моделью и разбирает группы инструментов", async () => {
    const api = vi.fn(async () => raw);
    const info = await fetchBuilderBundle(api, "qwen3.6-35b");
    expect(api).toHaveBeenCalledWith("/v1/oma/platform-mcp/builder-bundle?model=qwen3.6-35b", { quiet: true });
    expect(info.needsModel).toBe(false);
    expect(info.agent).toEqual(bundle.agent);
    expect(info.toolGroups).toEqual([
      { id: "read", title: "Чтение и поиск", confirm: false, tools: ["help", "list"] },
      { id: "write", title: "Создание и правка", confirm: true, tools: ["create_agent"] },
    ]);
  });

  it("без модели не добавляет параметр и помнит needs_model", async () => {
    const api = vi.fn(async () => ({ ...raw, needs_model: true }));
    const info = await fetchBuilderBundle(api, null);
    expect(api).toHaveBeenCalledWith("/v1/oma/platform-mcp/builder-bundle", { quiet: true });
    expect(info.needsModel).toBe(true);
  });

  it("кодирует имя карточки в адресе", async () => {
    const api = vi.fn(async () => raw);
    await fetchBuilderBundle(api, "a b/c");
    expect(api).toHaveBeenCalledWith("/v1/oma/platform-mcp/builder-bundle?model=a%20b%2Fc", { quiet: true });
  });

  it("пустой ответ сервера это ошибка", async () => {
    const api = vi.fn(async () => ({}));
    await expect(fetchBuilderBundle(api, null)).rejects.toThrow("комплект");
  });
});
