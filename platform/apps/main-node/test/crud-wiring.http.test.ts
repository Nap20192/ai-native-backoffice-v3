// CRUD wiring on a booted main-node (docs/plans/crud.md, A4, A13, A14,
// A15): the dependency route, archive and delete of agents, environments
// and cards see the real session rows of the SQL store.
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
  const dir = mkdtempSync(join(tmpdir(), "oma-crud-"));
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

async function created201<T>(response: Promise<Response>): Promise<T> {
  const answer = await response;
  expect(answer.status, await answer.clone().text()).toBeLessThan(300);
  return answer.json() as Promise<T>;
}

async function world(cp: NodeControlPlane, model = "claude-sonnet-4-6") {
  const environment = await created201<{ id: string }>(call(cp, "POST", "/v1/environments", {
    name: "crud-env",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  }));
  const agent = await created201<{ id: string }>(call(cp, "POST", "/v1/agents", {
    name: "crud", model, system: "hi",
  }));
  const session = await created201<{ id: string }>(call(cp, "POST", "/v1/sessions", {
    agent: agent.id, environment_id: environment.id,
  }));
  return { environment, agent, session };
}

describe("CRUD wiring on main-node", () => {
  it("a live session blocks the agent delete until the session is archived", async () => {
    const cp = await boot();
    const { agent, session, environment } = await world(cp);

    const report = await call(cp, "GET", `/v1/oma/dependencies/agent/${agent.id}?operation=delete`);
    expect(report.status).toBe(200);
    await expect(report.json()).resolves.toMatchObject({
      blocking: [expect.objectContaining({ kind: "session", id: session.id })],
    });
    const blocked = await call(cp, "DELETE", `/v1/agents/${agent.id}`);
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { type: "dependency_conflict_error" },
    });
    expect((await call(cp, "DELETE", `/v1/environments/${environment.id}`)).status).toBe(409);

    expect((await call(cp, "POST", `/v1/sessions/${session.id}/archive`)).status).toBe(200);
    expect((await call(cp, "DELETE", `/v1/agents/${agent.id}`)).status).toBe(200);
    const archived = await call(cp, "GET", `/v1/sessions/${session.id}`);
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ agent: { id: agent.id } });
  });

  it("an agent on a model card blocks the card archive", async () => {
    const cp = await boot();
    const card = await created201<{ id: string }>(call(cp, "POST", "/v1/oma/model_cards", {
      model_id: "card-model",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      api_key: "sk-card-secret",
      base_url: "http://127.0.0.1:9",
    }));
    const { agent } = await world(cp, "card-model");
    const report = await call(cp, "GET", `/v1/oma/dependencies/model_card/${card.id}?operation=archive`);
    expect(report.status).toBe(200);
    await expect(report.json()).resolves.toMatchObject({
      blocking: [expect.objectContaining({ kind: "agent", id: agent.id })],
      affected: [expect.objectContaining({ kind: "model_card", note: "Снова включится ключ ANTHROPIC_API_KEY" })],
    });
    expect((await call(cp, "POST", `/v1/oma/model_cards/${card.id}/archive`)).status).toBe(409);
    expect((await call(cp, "DELETE", `/v1/oma/model_cards/${card.id}`)).status).toBe(409);
  });

  it("answers 400 for an unknown operation and 404 for a missing card", async () => {
    const cp = await boot();
    expect((await call(cp, "GET", "/v1/oma/dependencies/agent/agent_x?operation=pause")).status).toBe(400);
    expect((await call(cp, "GET", "/v1/oma/dependencies/model_card/mdl_x?operation=delete")).status).toBe(404);
    // Harness cards are gone (D41): harness_card is an unknown kind now.
    expect((await call(cp, "GET", "/v1/oma/dependencies/harness_card/hcard_x?operation=delete")).status).toBe(400);
  });
});
