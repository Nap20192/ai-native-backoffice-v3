// Models and harness on a booted main-node (docs/plans/models-harness.md, WIRE):
// the model catalog route and the agent guard through the real HTTP stack.
// Only the built-in Pi loop runs agents (D41): the harness catalog, harness
// cards and the inference proxy for agents in the VM are gone.

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import { ONLY_PI_MESSAGE } from "../src/lib/agent-config-guard";

const ROOT_SECRET = Buffer.alloc(32, 7).toString("base64");
const API_KEY = "test-static-api-key";
const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(overrides: Record<string, string | undefined> = {}): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-models-harness-"));
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
    PLATFORM_ROOT_SECRET: ROOT_SECRET,
    ANTHROPIC_API_KEY: "sk-server-unused",
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig(env)));
  created.push(cp);
  return cp;
}

const headers = { "x-api-key": API_KEY, "anthropic-beta": "managed-agents-2026-04-01" };

function call(cp: NodeControlPlane, method: string, path: string, body?: unknown, extra: Record<string, string> = headers) {
  return cp.fetch(new Request(`http://cp${path}`, {
    method,
    headers: { ...extra, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function json<T = Record<string, unknown>>(response: Response | Promise<Response>): Promise<T> {
  return (await response).json() as Promise<T>;
}

async function createCard(cp: NodeControlPlane, body: Record<string, unknown>) {
  const response = await call(cp, "POST", "/v1/oma/model_cards", {
    api_key: "sk-card-secret",
    base_url: "http://127.0.0.1:9",
    ...body,
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

function guardError(message: string) {
  return { type: "error", error: { type: "invalid_request_error", message } };
}

describe("GET /v1/oma/model_options", () => {
  it("lists the workspace card first, then the server-key models, without any key", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic", is_default: true });
    const response = await call(cp, "GET", "/v1/oma/model_options");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("sk-card-secret");
    expect(text).not.toContain("sk-server-unused");
    const body = JSON.parse(text) as { builtin_available: boolean; data: Array<Record<string, unknown>> };
    expect(body.builtin_available).toBe(true);
    expect(body.data[0]).toMatchObject({
      handle: "verify-fake",
      source: "card",
      is_default: true,
      wire_model: "claude-sonnet-4-6",
      protocols: ["anthropic-messages"],
      harnesses: ["pi"],
    });
    expect(body.data.slice(1).every((option) => option.source === "builtin")).toBe(true);
    expect(body.data.some((option) => option.handle === "claude-sonnet-4-6")).toBe(true);
  });

  it("has no built-in models without a server key", async () => {
    const cp = await boot({ ANTHROPIC_API_KEY: undefined });
    expect(await json(call(cp, "GET", "/v1/oma/model_options"))).toEqual({ builtin_available: false, data: [] });
  });
});

describe("removed harness routes (D41)", () => {
  it("answers 404 for the harness catalog, harness cards and the inference proxy", async () => {
    const cp = await boot();
    for (const [method, path] of [
      ["GET", "/v1/oma/harnesses"],
      ["GET", "/v1/oma/harness_cards"],
      ["POST", "/v1/oma/harness_cards"],
      ["POST", "/v1/oma/inference-proxy/sesn_x/anthropic/v1/messages"],
    ] as const) {
      const response = await call(cp, method, path, method === "POST" ? {} : undefined);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("agent guard on /v1/agents", () => {
  const claude = {
    harness: "acp-sandbox",
    acp: { agent: { id: "claude-acp", command: "sh", args: ["-c", "exec claude-agent-acp"] } },
  };

  it("refuses a new agent with another harness or an acp block", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic", is_default: true });
    for (const oma of [
      claude,
      { harness: "acp-sandbox" },
      { harness: "acp-proxy" },
      { harness: "ai-sdk" },
      { harness: "foo" },
      { acp: claude.acp },
    ]) {
      const response = await call(cp, "POST", "/v1/agents", { name: "guarded", model: "verify-fake", _oma: oma });
      expect(response.status, JSON.stringify(oma)).toBe(400);
      expect(await response.json(), JSON.stringify(oma)).toEqual(guardError(ONLY_PI_MESSAGE));
    }
    const list = await json<{ data: unknown[] }>(call(cp, "GET", "/v1/agents"));
    expect(list.data).toEqual([]);
  });

  it("rejects model problems with their text", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-plain", model: "vendor/unknown-model", provider: "openrouter", is_default: true });
    const cases: Array<[unknown, string]> = [
      [{ model: "missing-model" }, "Модель «missing-model» не найдена. Добавьте карточку модели или задайте на сервере ANTHROPIC_API_KEY"],
      [{ model: { id: "verify-plain", effort: "max" } }, "Модель «verify-plain» не поддерживает усилие"],
      [{ model: { id: "verify-plain", speed: "fast" } }, "Модель «verify-plain» не поддерживает быструю скорость"],
    ];
    for (const [body, message] of cases) {
      const response = await call(cp, "POST", "/v1/agents", { name: "guarded", ...(body as object) });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json(), JSON.stringify(body)).toEqual(guardError(message));
    }
  });

  it("creates a Pi agent, renames it and refuses a later switch to ACP", async () => {
    const cp = await boot();
    await createCard(cp, { model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic", is_default: true });
    for (const oma of [undefined, { harness: "pi" }, { harness: "default" }]) {
      const response = await call(cp, "POST", "/v1/agents", { name: "pi", model: "verify-fake", ...(oma ? { _oma: oma } : {}) });
      expect(response.status, JSON.stringify(oma)).toBeLessThan(300);
    }
    const plain = await call(cp, "POST", "/v1/agents", { name: "plain", model: "claude-sonnet-4-6" });
    expect(plain.status).toBeLessThan(300);
    const { id } = await plain.json() as { id: string };

    const version = (await json<{ version: number }>(call(cp, "GET", `/v1/agents/${id}`))).version;
    const renamed = await call(cp, "POST", `/v1/agents/${id}`, { version, name: "plain-renamed" });
    expect(renamed.status).toBeLessThan(300);
    expect(await renamed.json()).toMatchObject({ name: "plain-renamed" });

    const current = (await json<{ version: number }>(call(cp, "GET", `/v1/agents/${id}`))).version;
    const toAcp = await call(cp, "POST", `/v1/agents/${id}`, { version: current, _oma: claude });
    expect(toAcp.status).toBe(400);
    expect(await toAcp.json()).toEqual(guardError(ONLY_PI_MESSAGE));
    expect((await call(cp, "POST", `/v1/agents/${id}/archive`, {})).status).toBeLessThan(300);
  });
});

describe("agent stored before D41", () => {
  const legacyAcp = {
    agent: {
      id: "claude-acp",
      command: "sh",
      args: ["-c", "exec claude-agent-acp"],
      env: { CLAUDE_FLAG: "legacy-acp-env" },
    },
  };

  /** Rewrites the stored document the way an agent saved with an ACP
   * harness looks in an old database. */
  function storeAsLegacyAcp(databasePath: string, agentId: string) {
    const db = new Database(databasePath);
    try {
      const row = db.prepare("SELECT document FROM managed_agents WHERE id = ?").get(agentId) as { document: string };
      const document = JSON.parse(row.document) as { openma?: Record<string, unknown> };
      document.openma = {
        ...document.openma,
        harness: "acp-sandbox",
        acp: legacyAcp,
        runtimeBinding: { runtimeId: "runtime_legacy", acpAgentId: "claude-acp" },
      };
      const changed = db.prepare("UPDATE managed_agents SET document = ? WHERE id = ?").run(JSON.stringify(document), agentId);
      expect(changed.changes).toBe(1);
    } finally {
      db.close();
    }
  }

  it("reads it through GET /v1/agents/:id without the acp fields and saves it on Pi", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-legacy-acp-"));
    dirs.push(dir);
    const databasePath = join(dir, "legacy.db");
    const cp = await boot({ DATABASE_PATH: databasePath });
    await createCard(cp, { model_id: "verify-fake", model: "claude-sonnet-4-6", provider: "anthropic", is_default: true });
    const createdAgent = await call(cp, "POST", "/v1/agents", { name: "legacy", model: "verify-fake" });
    expect(createdAgent.status).toBeLessThan(300);
    const { id } = await createdAgent.json() as { id: string };
    storeAsLegacyAcp(databasePath, id);

    const read = await call(cp, "GET", `/v1/agents/${id}`);
    expect(read.status).toBe(200);
    const readText = await read.text();
    expect(readText).not.toContain("claude-agent-acp");
    expect(readText).not.toContain("legacy-acp-env");
    const agent = JSON.parse(readText) as { version: number; _oma?: Record<string, unknown> };
    expect(agent._oma).toEqual({ harness: "acp-sandbox" });

    const list = await call(cp, "GET", "/v1/agents");
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).toContain(id);
    expect(listText).not.toContain("claude-agent-acp");

    // The console sends harness "pi" and no acp block when it saves an old agent.
    const saved = await call(cp, "POST", `/v1/agents/${id}`, {
      version: agent.version,
      name: "legacy-renamed",
      model: "verify-fake",
      _oma: { harness: "pi" },
    });
    expect(saved.status).toBeLessThan(300);
    const savedAgent = await saved.json() as { name: string; _oma?: Record<string, unknown> };
    expect(savedAgent).toMatchObject({ name: "legacy-renamed", _oma: { harness: "pi" } });
    expect(savedAgent._oma).not.toHaveProperty("acp");

    const versions = await call(cp, "GET", `/v1/agents/${id}/versions`);
    expect(versions.status).toBe(200);
    const versionsText = await versions.text();
    expect(versionsText).toContain("legacy-renamed");
    expect(versionsText).not.toContain("claude-agent-acp");
  });
});
