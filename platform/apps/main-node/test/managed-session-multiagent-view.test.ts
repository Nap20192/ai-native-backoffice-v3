// The Session snapshot of a multiagent block and the view the turn reads
// (docs/plans/multiagent.md, 3.2, slice 3). A Session keeps the type of the
// block it copied, with every listed agent in full. The codec, the delegation
// policy and the subagent lookup read one view of it, so `coordinator` and
// `multiagent_20261001` give the turn the same callable agents. SDK 0.120
// lacks the new type, so the requests go as plain JSON (API_LAYER.md,
// "Multiagent block").
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveMultiagent,
  listedSubagents,
  type Session,
} from "@open-managed-agents/managed-agents-application";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import { toLegacyHarnessAgentConfig } from "../src/lib/node-managed-agent-codec";
import { nodeManagedSubagentPolicy } from "../src/lib/node-managed-subagents";

const API_KEY = "test-static-api-key";
const MODEL = "claude-sonnet-4-6";
const ADVISOR_MODEL = "claude-opus-5-5";
const headers = { "x-api-key": API_KEY, "anthropic-beta": "managed-agents-2026-04-01" };

interface WireAgent {
  id: string;
  version: number;
}

interface WireSession {
  id: string;
  agent: { id: string; multiagent: Record<string, unknown> | null };
}

let cp: NodeControlPlane;
let dir: string;
let environmentId: string;
let child: WireAgent;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oma-multiagent-view-"));
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
  cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig(env)));
  environmentId = (await ok<{ id: string }>(call("POST", "/v1/environments", {
    name: "multiagent-view-env",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  }))).id;
  child = await ok<WireAgent>(createAgent({
    name: "checker",
    system: "You check the folder with bash.",
    tools: [{
      type: "agent_toolset_20260401",
      default_config: { enabled: false },
      configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_allow" } }],
    }],
  }));
}, 60_000);

afterAll(async () => {
  await cp?.stop("test");
  rmSync(dir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return cp.fetch(new Request(`http://cp${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function ok<T>(response: Response | Promise<Response>): Promise<T> {
  const answer = await response;
  const text = await answer.text();
  expect(answer.status, text).toBeLessThan(300);
  return JSON.parse(text) as T;
}

function createAgent(body: Record<string, unknown>): Promise<Response> {
  return call("POST", "/v1/agents", { model: MODEL, ...body });
}

async function createSession(multiagent: Record<string, unknown>, name: string): Promise<WireSession> {
  const agent = await ok<WireAgent>(createAgent({ name, multiagent }));
  return ok<WireSession>(call("POST", "/v1/sessions", { agent: agent.id, environment_id: environmentId }));
}

/** The Session as the runner loads it: the stored document. */
function storedSession(sessionId: string): Session {
  const db = new Database(join(dir, "oma.db"), { readonly: true });
  try {
    const row = db.prepare(
      "SELECT document, created_at, updated_at FROM managed_sessions WHERE id = ?",
    ).get(sessionId) as { document: string; created_at: number; updated_at: number };
    return {
      ...(JSON.parse(row.document) as Session),
      id: sessionId,
      archivedAt: null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  } finally {
    db.close();
  }
}

describe("Session snapshot of a multiagent block", () => {
  it("keeps the multiagent_20261001 type with every listed agent in full", async () => {
    const coordinator = await createSession({
      type: "coordinator",
      agents: [child.id, { type: "advisor", model: ADVISOR_MODEL }],
    }, "coordinator-parent");
    const snapshot = (coordinator.agent.multiagent?.agents as Array<Record<string, unknown>>)[0];
    expect(snapshot).toMatchObject({
      type: "agent",
      id: child.id,
      version: 1,
      name: "checker",
      system: "You check the folder with bash.",
    });

    const created = await createSession({
      type: "multiagent_20261001",
      subagents: { type: "enabled", predefined_agents: [child.id] },
      workflows: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [child.id] },
      advisor: { type: "enabled", model: ADVISOR_MODEL },
    }, "new-type-parent");
    const expected = {
      type: "multiagent_20261001",
      subagents: {
        type: "enabled",
        inline_agents: { type: "enabled" },
        predefined_agents: [snapshot],
      },
      workflows: {
        type: "enabled",
        inline_agents: { type: "disabled" },
        predefined_agents: [snapshot],
      },
      advisor: { type: "enabled", model: ADVISOR_MODEL },
    };
    expect(created.agent.multiagent).toEqual(expected);
    const read = await ok<WireSession>(call("GET", `/v1/sessions/${created.id}`));
    expect(read.agent.multiagent).toEqual(expected);
    expect(storedSession(created.id).agent.multiagent?.type).toBe("multiagent_20261001");

    // The coordinator form stays as the SDK has it.
    expect(coordinator.agent.multiagent).toEqual({
      type: "coordinator",
      agents: [snapshot, { type: "advisor", model: ADVISOR_MODEL }],
    });
  });

  it("gives the turn the same callable agents for coordinator and the new type", async () => {
    const coordinator = storedSession((await createSession({
      type: "coordinator",
      agents: [child.id, { type: "advisor", model: ADVISOR_MODEL }],
    }, "coordinator-view")).id);
    const newType = storedSession((await createSession({
      type: "multiagent_20261001",
      subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [child.id] },
      advisor: { type: "enabled", model: ADVISOR_MODEL },
    }, "new-type-view")).id);

    const coordinatorConfig = toLegacyHarnessAgentConfig(coordinator);
    const newTypeConfig = toLegacyHarnessAgentConfig(newType);
    expect(coordinatorConfig.callable_agents).toEqual([{ type: "agent", id: child.id, version: 1 }]);
    expect(newTypeConfig.callable_agents).toEqual(coordinatorConfig.callable_agents);
    expect(newTypeConfig.multiagent).toEqual(coordinatorConfig.multiagent);

    expect(nodeManagedSubagentPolicy(coordinator)).toEqual({ enabled: true, maxConcurrentSubagents: 6 });
    expect(nodeManagedSubagentPolicy(newType)).toEqual({ enabled: true, maxConcurrentSubagents: 6 });
    expect(listedSubagents(coordinator.agent.multiagent).map((agent) => agent.id)).toEqual([child.id]);
    expect(listedSubagents(newType.agent.multiagent)).toEqual(listedSubagents(coordinator.agent.multiagent));

    // coordinator reads as subagents without inline agents, no workflows,
    // and the advisor from its roster entry.
    const view = effectiveMultiagent(coordinator.agent.multiagent);
    expect(view).toEqual({
      subagents: {
        type: "enabled",
        inlineAgents: false,
        predefinedAgents: listedSubagents(coordinator.agent.multiagent),
      },
      workflows: { type: "disabled" },
      advisor: { type: "enabled", model: ADVISOR_MODEL },
    });
    expect(effectiveMultiagent(newType.agent.multiagent)).toEqual({
      ...view,
      workflows: { type: "enabled", inlineAgents: true, predefinedAgents: [] },
    });
    expect(effectiveMultiagent(null)).toBeNull();
  });

  it("makes no agent callable while subagents are off, even one in the workflows list", async () => {
    const session = storedSession((await createSession({
      type: "multiagent_20261001",
      subagents: { type: "disabled" },
      workflows: { type: "enabled", predefined_agents: [child.id] },
    }, "workflows-only")).id);

    const config = toLegacyHarnessAgentConfig(session);
    expect(config.callable_agents).toBeUndefined();
    expect(listedSubagents(session.agent.multiagent)).toEqual([]);
    expect(nodeManagedSubagentPolicy(session)).toEqual({ enabled: false, maxConcurrentSubagents: 6 });
  });
});
