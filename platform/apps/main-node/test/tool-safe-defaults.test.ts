// Подтверждение по умолчанию для MCP (docs/plans/cma-wave-1.md, 3.1, срез 2).
// Сервер MCP без явной политики спрашивает человека, как mcp_toolset в CMA.
// Встроенный набор по умолчанию разрешает. Сервер без набора и набор без
// сервера дают 400 и в итоговом агенте сессии после слияния.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const API_KEY = "test-static-api-key";
const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-tool-defaults-"));
  dirs.push(dir);
  const env: Record<string, string | undefined> = {
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    API_KEY,
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    PLATFORM_ROOT_SECRET: Buffer.alloc(32, 7).toString("base64"),
    ANTHROPIC_API_KEY: "sk-server-unused",
  };
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig(env)));
  created.push(cp);
  return cp;
}

const headers = { "x-api-key": API_KEY, "anthropic-beta": "managed-agents-2026-04-01" };

function call(cp: NodeControlPlane, method: string, path: string, body?: unknown) {
  return cp.fetch(new Request(`http://cp${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function ok<T>(response: Promise<Response>): Promise<T> {
  const answer = await response;
  expect(answer.status, await answer.clone().text()).toBeLessThan(300);
  return answer.json() as Promise<T>;
}

async function rejected(response: Promise<Response>, message: string): Promise<void> {
  const answer = await response;
  const text = await answer.clone().text();
  expect(answer.status, text).toBe(400);
  expect(await answer.json()).toEqual({
    type: "error",
    error: { type: "invalid_request_error", message },
  });
}

interface WireToolset {
  type: string;
  mcp_server_name?: string;
  default_config?: { enabled?: boolean; permission_policy?: { type: string } };
  configs?: Array<{ name: string; enabled?: boolean; permission_policy?: { type: string } }>;
}

interface WireAgent {
  id: string;
  version: number;
  tools: WireToolset[];
}

const IIKO = { type: "url", name: "iiko", url: "http://127.0.0.1:9/mcp" } as const;
const ODIN_C = { type: "url", name: "1c", url: "http://127.0.0.1:9/1c" } as const;

async function environment(cp: NodeControlPlane): Promise<{ id: string }> {
  return ok<{ id: string }>(call(cp, "POST", "/v1/environments", {
    name: "tool-defaults-env",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  }));
}

describe("MCP спрашивает по умолчанию", () => {
  it("агент с mcp_toolset без политики получает always_ask, встроенный набор always_allow", async () => {
    const cp = await boot();
    const agent = await ok<WireAgent>(call(cp, "POST", "/v1/agents", {
      name: "iiko-agent",
      model: "claude-sonnet-4-6",
      mcp_servers: [IIKO, ODIN_C],
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "mcp_toolset", mcp_server_name: "iiko", configs: [{ name: "read_report" }] },
        {
          type: "mcp_toolset",
          mcp_server_name: "1c",
          default_config: { permission_policy: { type: "always_allow" } },
        },
      ],
    }));

    expect(agent.tools[0]).toMatchObject({
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
    });
    expect(agent.tools[1]).toMatchObject({
      type: "mcp_toolset",
      mcp_server_name: "iiko",
      default_config: { enabled: true, permission_policy: { type: "always_ask" } },
      configs: [{ name: "read_report", enabled: true, permission_policy: { type: "always_ask" } }],
    });
    // Явный выбор владельца сервер не меняет.
    expect(agent.tools[2]?.default_config?.permission_policy).toEqual({ type: "always_allow" });

    const retrieved = await ok<WireAgent>(call(cp, "GET", `/v1/agents/${agent.id}`));
    expect(retrieved.tools).toEqual(agent.tools);

    // Правка агента новым набором без политики тоже спрашивает.
    const updated = await ok<WireAgent>(call(cp, "POST", `/v1/agents/${agent.id}`, {
      version: agent.version,
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "mcp_toolset", mcp_server_name: "iiko" },
        { type: "mcp_toolset", mcp_server_name: "1c" },
      ],
    }));
    expect(updated.tools[1]?.default_config?.permission_policy).toEqual({ type: "always_ask" });
    expect(updated.tools[2]?.default_config?.permission_policy).toEqual({ type: "always_ask" });
  });

  it("сессия получает always_ask у сервера из переопределения и у сервера агента", async () => {
    const cp = await boot();
    const env = await environment(cp);
    const agent = await ok<WireAgent>(call(cp, "POST", "/v1/agents", {
      name: "iiko-agent",
      model: "claude-sonnet-4-6",
      mcp_servers: [IIKO],
      tools: [{ type: "agent_toolset_20260401" }, { type: "mcp_toolset", mcp_server_name: "iiko" }],
    }));

    const plain = await ok<{ agent: WireAgent }>(call(cp, "POST", "/v1/sessions", {
      agent: agent.id,
      environment_id: env.id,
    }));
    expect(plain.agent.tools[1]?.default_config?.permission_policy).toEqual({ type: "always_ask" });

    const overridden = await ok<{ agent: WireAgent }>(call(cp, "POST", "/v1/sessions", {
      agent: {
        type: "agent_with_overrides",
        id: agent.id,
        mcp_servers: [IIKO, ODIN_C],
        tools: [
          { type: "agent_toolset_20260401" },
          { type: "mcp_toolset", mcp_server_name: "iiko" },
          { type: "mcp_toolset", mcp_server_name: "1c" },
        ],
      },
      environment_id: env.id,
    }));
    expect(overridden.agent.tools[2]).toMatchObject({
      mcp_server_name: "1c",
      default_config: { permission_policy: { type: "always_ask" } },
    });
  });

  it("сессия с сервером без набора получает 400 при создании и при правке", async () => {
    const cp = await boot();
    const env = await environment(cp);
    const agent = await ok<WireAgent>(call(cp, "POST", "/v1/agents", {
      name: "iiko-agent",
      model: "claude-sonnet-4-6",
      mcp_servers: [IIKO],
      tools: [{ type: "agent_toolset_20260401" }, { type: "mcp_toolset", mcp_server_name: "iiko" }],
    }));

    // Сервер 1c добавлен переопределением, набора у него нет: после слияния с
    // набором агента для iiko сервер 1c никто не описал.
    await rejected(call(cp, "POST", "/v1/sessions", {
      agent: { type: "agent_with_overrides", id: agent.id, mcp_servers: [IIKO, ODIN_C] },
      environment_id: env.id,
    }), "MCP server 1c must be referenced by an mcp_toolset");

    // Набор переопределения ссылается на сервер, которого у агента нет.
    await rejected(call(cp, "POST", "/v1/sessions", {
      agent: {
        type: "agent_with_overrides",
        id: agent.id,
        tools: [
          { type: "mcp_toolset", mcp_server_name: "iiko" },
          { type: "mcp_toolset", mcp_server_name: "1c" },
        ],
      },
      environment_id: env.id,
    }), "MCP toolset references unknown server 1c");

    const session = await ok<{ id: string }>(call(cp, "POST", "/v1/sessions", {
      agent: agent.id,
      environment_id: env.id,
    }));
    await rejected(call(cp, "POST", `/v1/sessions/${session.id}`, {
      agent: { mcp_servers: [IIKO, ODIN_C] },
    }), "MCP server 1c must be referenced by an mcp_toolset");
    await rejected(call(cp, "POST", `/v1/sessions/${session.id}`, {
      agent: { tools: [{ type: "agent_toolset_20260401" }] },
    }), "MCP server iiko must be referenced by an mcp_toolset");

    // Правка, в которой сервер и набор пришли вместе, проходит и спрашивает.
    const updated = await ok<{ agent: WireAgent }>(call(cp, "POST", `/v1/sessions/${session.id}`, {
      agent: {
        mcp_servers: [IIKO, ODIN_C],
        tools: [
          { type: "agent_toolset_20260401" },
          { type: "mcp_toolset", mcp_server_name: "iiko" },
          { type: "mcp_toolset", mcp_server_name: "1c" },
        ],
      },
    }));
    expect(updated.agent.tools[2]?.default_config?.permission_policy).toEqual({ type: "always_ask" });
  });

  // Решение 5: поток субагента нельзя подтвердить, его вызов MCP молча остался бы
  // без результата. Сессия с таким субагентом получает 400 при создании.
  it("мультиагентная сессия, где субагент спрашивает по MCP, получает 400", async () => {
    const cp = await boot();
    const env = await environment(cp);
    const writer = await ok<WireAgent>(call(cp, "POST", "/v1/agents", {
      name: "iiko-writer",
      model: "claude-sonnet-4-6",
      mcp_servers: [IIKO],
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "mcp_toolset",
          mcp_server_name: "iiko",
          configs: [{ name: "read_report", permission_policy: { type: "always_allow" } }],
        },
      ],
    }));
    const coordinator = await ok<WireAgent>(call(cp, "POST", "/v1/agents", {
      name: "coordinator",
      model: "claude-sonnet-4-6",
      multiagent: { type: "coordinator", agents: [{ type: "agent", id: writer.id }] },
    }));
    await rejected(call(cp, "POST", "/v1/sessions", {
      agent: coordinator.id,
      environment_id: env.id,
    }), `Subagent ${writer.id} cannot wait for a tool confirmation: MCP server iiko uses always_ask`);

    // Субагент, которому MCP разрешён целиком, и координатор, который сам
    // спрашивает: его поток подтверждает человек, сессия создаётся.
    const reader = await ok<WireAgent>(call(cp, "POST", "/v1/agents", {
      name: "iiko-reader",
      model: "claude-sonnet-4-6",
      mcp_servers: [IIKO],
      tools: [
        { type: "agent_toolset_20260401" },
        {
          type: "mcp_toolset",
          mcp_server_name: "iiko",
          default_config: { permission_policy: { type: "always_allow" } },
        },
      ],
    }));
    const asking = await ok<WireAgent>(call(cp, "POST", "/v1/agents", {
      name: "asking-coordinator",
      model: "claude-sonnet-4-6",
      mcp_servers: [IIKO],
      tools: [{ type: "agent_toolset_20260401" }, { type: "mcp_toolset", mcp_server_name: "iiko" }],
      multiagent: { type: "coordinator", agents: [{ type: "agent", id: reader.id }] },
    }));
    await ok(call(cp, "POST", "/v1/sessions", { agent: asking.id, environment_id: env.id }));

    // Координатор в своём составе (self) тоже идёт отдельным потоком.
    const selfAsking = await ok<WireAgent>(call(cp, "POST", "/v1/agents", {
      name: "self-coordinator",
      model: "claude-sonnet-4-6",
      mcp_servers: [IIKO],
      tools: [{ type: "agent_toolset_20260401" }, { type: "mcp_toolset", mcp_server_name: "iiko" }],
      multiagent: { type: "coordinator", agents: [{ type: "self" }] },
    }));
    await rejected(call(cp, "POST", "/v1/sessions", {
      agent: selfAsking.id,
      environment_id: env.id,
    }), `Subagent ${selfAsking.id} cannot wait for a tool confirmation: MCP server iiko uses always_ask`);
  });
});
