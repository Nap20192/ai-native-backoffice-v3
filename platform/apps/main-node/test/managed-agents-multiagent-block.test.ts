// The `multiagent_20261001` block of an agent (docs/plans/multiagent.md, 3.2,
// slices 1 and 2). The /v1 wire takes it next to `coordinator`, the service
// checks it and pins every list entry, and the agent reads it back with every
// default filled in. An update of the same type follows the CMA edit rules.
// SDK 0.120 lacks the type, so the requests go as plain JSON (API_LAYER.md,
// "Multiagent block").
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const API_KEY = "test-static-api-key";
const MODEL = "claude-sonnet-4-6";
const headers = { "x-api-key": API_KEY, "anthropic-beta": "managed-agents-2026-04-01" };

interface WireAgent {
  id: string;
  version: number;
  multiagent: Record<string, unknown> | null;
}

let cp: NodeControlPlane;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oma-multiagent-block-"));
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

async function expectInvalid(response: Response, message: string): Promise<void> {
  const text = await response.text();
  expect(response.status, text).toBe(400);
  expect(JSON.parse(text)).toEqual({
    type: "error",
    error: { type: "invalid_request_error", message: expect.stringContaining(message) },
  });
}

const DEFAULT_SETTING = {
  type: "enabled",
  inline_agents: { type: "enabled" },
  predefined_agents: [],
};

const DEFAULT_BLOCK = {
  type: "multiagent_20261001",
  subagents: DEFAULT_SETTING,
  workflows: DEFAULT_SETTING,
  advisor: { type: "disabled" },
};

const antTool = {
  type: "custom",
  name: "ant__lookup",
  description: "Looks a record up",
  input_schema: { type: "object", properties: {} },
};

describe("multiagent_20261001 block on /v1/agents", () => {
  it("stores the bare block with its defaults and reads it back the same", async () => {
    const created = await ok<WireAgent>(createAgent({
      name: "defaults",
      multiagent: { type: "multiagent_20261001" },
    }));
    expect(created.multiagent).toEqual(DEFAULT_BLOCK);
    expect(await ok<WireAgent>(call("GET", `/v1/agents/${created.id}`))).toEqual(created);

    // null takes the default as well; a disabled setting reads back bare.
    const nulls = await ok<WireAgent>(createAgent({
      name: "nulls",
      multiagent: {
        type: "multiagent_20261001",
        subagents: { type: "enabled", inline_agents: null, predefined_agents: null },
        workflows: { type: "disabled" },
        advisor: null,
      },
    }));
    expect(nulls.multiagent).toEqual({ ...DEFAULT_BLOCK, workflows: { type: "disabled" } });
  });

  it("pins every entry form, reads self back as the agent itself and keeps the lists apart", async () => {
    const child = await ok<WireAgent>(createAgent({ name: "child" }));
    const childV2 = await ok<WireAgent>(call("POST", `/v1/agents/${child.id}`, { system: "v2" }));
    expect(childV2.version).toBe(2);

    const parent = await ok<WireAgent>(createAgent({
      name: "parent",
      multiagent: {
        type: "multiagent_20261001",
        subagents: {
          type: "enabled",
          inline_agents: { type: "disabled" },
          predefined_agents: [child.id, { type: "self" }],
        },
        workflows: {
          type: "enabled",
          predefined_agents: [{ type: "agent", id: child.id, version: 1 }, { type: "self" }],
        },
        advisor: { type: "enabled", model: "claude-opus-5-5" },
      },
    }));
    expect(parent.multiagent).toEqual({
      type: "multiagent_20261001",
      subagents: {
        type: "enabled",
        inline_agents: { type: "disabled" },
        predefined_agents: [
          { type: "agent", id: child.id, version: 2 },
          { type: "agent", id: parent.id, version: 1 },
        ],
      },
      workflows: {
        type: "enabled",
        inline_agents: { type: "enabled" },
        predefined_agents: [
          { type: "agent", id: child.id, version: 1 },
          { type: "agent", id: parent.id, version: 1 },
        ],
      },
      advisor: { type: "enabled", model: "claude-opus-5-5" },
    });
    expect(await ok<WireAgent>(call("GET", `/v1/agents/${parent.id}`))).toEqual(parent);
  });

  it("keeps the coordinator type as it was, and an update to the new type replaces the block", async () => {
    const child = await ok<WireAgent>(createAgent({ name: "coordinated" }));
    const coordinator = await ok<WireAgent>(createAgent({
      name: "coordinator",
      multiagent: { type: "coordinator", agents: [child.id, { type: "advisor", model: "claude-opus-5-5" }] },
    }));
    expect(coordinator.multiagent).toEqual({
      type: "coordinator",
      agents: [
        { type: "agent", id: child.id, version: 1 },
        { type: "advisor", model: "claude-opus-5-5" },
      ],
    });

    const moved = await ok<WireAgent>(call("POST", `/v1/agents/${coordinator.id}`, {
      multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: [child.id] } },
    }));
    expect(moved.multiagent).toEqual({
      ...DEFAULT_BLOCK,
      subagents: { ...DEFAULT_SETTING, predefined_agents: [{ type: "agent", id: child.id, version: 1 }] },
    });
  });

  it("creates a session of an agent with the new block", async () => {
    const environment = await ok<{ id: string }>(call("POST", "/v1/environments", {
      name: "multiagent-env",
      config: { type: "cloud", networking: { type: "unrestricted" } },
    }));
    const child = await ok<WireAgent>(createAgent({ name: "session-child" }));
    const agent = await ok<WireAgent>(createAgent({
      name: "session-parent",
      multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: [child.id] } },
    }));
    // The Session keeps the type (slice 3, managed-session-multiagent-view.test.ts).
    const session = await ok<{ agent: { multiagent: {
      type: string;
      subagents: { predefined_agents: Array<{ id: string }> };
    } | null } }>(
      call("POST", "/v1/sessions", { agent: agent.id, environment_id: environment.id }),
    );
    expect(session.agent.multiagent?.type).toBe("multiagent_20261001");
    expect(session.agent.multiagent?.subagents.predefined_agents.map((member) => member.id))
      .toEqual([child.id]);
  });

  describe("answers 400", () => {
    it("on more than 20 agents in one list", async () => {
      const ids = Array.from({ length: 21 }, (_, index) => `agent_missing_${index}`);
      await expectInvalid(await createAgent({
        name: "too-many",
        multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: ids } },
      }), "subagents.predefined_agents may list at most 20 agents");
    });

    it("on the same agent twice in one list", async () => {
      const child = await ok<WireAgent>(createAgent({ name: "twice" }));
      await expectInvalid(await createAgent({
        name: "twice-parent",
        multiagent: {
          type: "multiagent_20261001",
          workflows: { type: "enabled", predefined_agents: [child.id, { type: "agent", id: child.id }] },
        },
      }), "workflows.predefined_agents must list distinct agents");
      await expectInvalid(await createAgent({
        name: "self-twice",
        multiagent: {
          type: "multiagent_20261001",
          subagents: { type: "enabled", predefined_agents: [{ type: "self" }, { type: "self" }] },
        },
      }), "subagents.predefined_agents must list distinct agents");
    });

    it("on a listed agent that has its own multiagent block", async () => {
      const nested = await ok<WireAgent>(createAgent({
        name: "nested",
        multiagent: { type: "multiagent_20261001" },
      }));
      await expectInvalid(await createAgent({
        name: "nested-parent",
        multiagent: { type: "multiagent_20261001", workflows: { type: "enabled", predefined_agents: [nested.id] } },
      }), `workflows.predefined_agents agent ${nested.id} has its own multiagent block`);
    });

    it("on inline agents turned off with no listed agent", async () => {
      await expectInvalid(await createAgent({
        name: "no-agents",
        multiagent: {
          type: "multiagent_20261001",
          subagents: { type: "enabled", inline_agents: { type: "disabled" } },
        },
      }), "subagents.inline_agents is disabled, so subagents.predefined_agents needs at least one agent");
    });

    it("on a listed agent that does not exist", async () => {
      await expectInvalid(await createAgent({
        name: "missing",
        multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: ["agent_missing"] } },
      }), "subagents.predefined_agents agent agent_missing was not found");
    });

    it("on a listed agent named anthropic.advisor while the advisor is on", async () => {
      const named = await ok<WireAgent>(createAgent({ name: "anthropic.advisor" }));
      const block = {
        type: "multiagent_20261001",
        subagents: { type: "enabled", predefined_agents: [named.id] },
      };
      await expectInvalid(await createAgent({
        name: "advised",
        multiagent: { ...block, advisor: { type: "enabled", model: "claude-opus-5-5" } },
      }), "anthropic.advisor is reserved");
      // Without the advisor the name is free.
      await ok(createAgent({ name: "unadvised", multiagent: block }));
    });

    it("on an own custom tool named ant__ while workflows are on", async () => {
      await expectInvalid(await createAgent({
        name: "ant-tool",
        tools: [antTool],
        multiagent: { type: "multiagent_20261001" },
      }), "ant__lookup");
      // Workflows off frees the prefix.
      const off = await ok<WireAgent>(createAgent({
        name: "ant-tool-off",
        tools: [antTool],
        multiagent: { type: "multiagent_20261001", workflows: { type: "disabled" } },
      }));
      // An update that leaves the block alone checks the tools it sends.
      const on = await ok<WireAgent>(createAgent({
        name: "ant-tool-later",
        multiagent: { type: "multiagent_20261001" },
      }));
      await expectInvalid(await call("POST", `/v1/agents/${on.id}`, { tools: [antTool] }), "ant__lookup");
      expect(off.multiagent).toMatchObject({ workflows: { type: "disabled" } });
    });

    it("on an enabled advisor without a model", async () => {
      await expectInvalid(await createAgent({
        name: "advisor-no-model",
        multiagent: { type: "multiagent_20261001", advisor: { type: "enabled" } },
      }), "Invalid request field multiagent.advisor.model");
    });
  });
});

describe("update of a multiagent_20261001 block", () => {
  const ADVISOR = { type: "enabled", model: "claude-opus-5-5" };
  const ADVISOR_ENTRY = { type: "advisor", model: "claude-opus-5-5" };

  function update(agentId: string, multiagent: unknown): Promise<Response> {
    return call("POST", `/v1/agents/${agentId}`, { multiagent });
  }

  it("changes only what it sends: a setting or field left out keeps its value", async () => {
    const child = await ok<WireAgent>(createAgent({ name: "edit-child" }));
    const parent = await ok<WireAgent>(createAgent({
      name: "edit-parent",
      multiagent: {
        type: "multiagent_20261001",
        subagents: {
          type: "enabled",
          inline_agents: { type: "disabled" },
          predefined_agents: [child.id, { type: "self" }],
        },
        workflows: { type: "enabled", predefined_agents: [child.id] },
        advisor: ADVISOR,
      },
    }));
    const pinnedSubagents = {
      type: "enabled",
      inline_agents: { type: "disabled" },
      predefined_agents: [
        { type: "agent", id: child.id, version: 1 },
        { type: "agent", id: parent.id, version: 1 },
      ],
    };
    expect(parent.multiagent).toMatchObject({ subagents: pinnedSubagents });
    // The child moves on to version 2 after the parent pinned version 1.
    await ok(call("POST", `/v1/agents/${child.id}`, { system: "v2" }));

    // Subagents and the advisor are left out; workflows sends one field.
    const first = await ok<WireAgent>(update(parent.id, {
      type: "multiagent_20261001",
      workflows: { type: "enabled", inline_agents: { type: "disabled" } },
    }));
    expect(first.version).toBe(2);
    expect(first.multiagent).toEqual({
      type: "multiagent_20261001",
      // A kept list keeps its pins: the child stays at 1, self at 1.
      subagents: pinnedSubagents,
      workflows: {
        type: "enabled",
        inline_agents: { type: "disabled" },
        predefined_agents: [{ type: "agent", id: child.id, version: 1 }],
      },
      advisor: ADVISOR,
    });

    // A sent list replaces the old one whole; inline_agents left out stays off.
    const second = await ok<WireAgent>(update(parent.id, {
      type: "multiagent_20261001",
      subagents: { type: "enabled", predefined_agents: [child.id] },
    }));
    expect(second.multiagent).toEqual({
      ...first.multiagent,
      subagents: {
        type: "enabled",
        inline_agents: { type: "disabled" },
        predefined_agents: [{ type: "agent", id: child.id, version: 2 }],
      },
    });
    expect(await ok<WireAgent>(call("GET", `/v1/agents/${parent.id}`))).toEqual(second);
  });

  it("takes the default for null and replaces a setting of another type with defaults", async () => {
    const child = await ok<WireAgent>(createAgent({ name: "reset-child" }));
    const parent = await ok<WireAgent>(createAgent({
      name: "reset-parent",
      multiagent: {
        type: "multiagent_20261001",
        subagents: {
          type: "enabled",
          inline_agents: { type: "disabled" },
          predefined_agents: [child.id],
        },
        workflows: { type: "disabled" },
        advisor: ADVISOR,
      },
    }));
    const pinnedChild = [{ type: "agent", id: child.id, version: 1 }];

    // null resets the advisor and inline_agents; the list stays.
    const reset = await ok<WireAgent>(update(parent.id, {
      type: "multiagent_20261001",
      subagents: { type: "enabled", inline_agents: null },
      advisor: null,
    }));
    expect(reset.multiagent).toEqual({
      type: "multiagent_20261001",
      subagents: { ...DEFAULT_SETTING, predefined_agents: pinnedChild },
      workflows: { type: "disabled" },
      advisor: { type: "disabled" },
    });

    // A setting of another type is replaced with its defaults.
    const swapped = await ok<WireAgent>(update(parent.id, {
      type: "multiagent_20261001",
      subagents: { type: "disabled" },
      workflows: { type: "enabled" },
    }));
    expect(swapped.multiagent).toEqual({
      ...DEFAULT_BLOCK,
      subagents: { type: "disabled" },
    });

    // null on a whole setting takes the default setting.
    const back = await ok<WireAgent>(update(parent.id, {
      type: "multiagent_20261001",
      subagents: null,
    }));
    expect(back.multiagent).toEqual(DEFAULT_BLOCK);
  });

  it("replaces the whole block when the block type changes", async () => {
    const child = await ok<WireAgent>(createAgent({ name: "type-child" }));
    const parent = await ok<WireAgent>(createAgent({
      name: "type-parent",
      multiagent: {
        type: "multiagent_20261001",
        subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [child.id] },
        workflows: { type: "disabled" },
        advisor: ADVISOR,
      },
    }));

    const coordinator = await ok<WireAgent>(update(parent.id, { type: "coordinator", agents: [child.id] }));
    expect(coordinator.multiagent).toEqual({
      type: "coordinator",
      agents: [{ type: "agent", id: child.id, version: 1 }],
    });

    // Nothing of the coordinator, its advisor included, carries over.
    await ok(update(parent.id, { type: "coordinator", agents: [child.id, ADVISOR_ENTRY] }));
    const fresh = await ok<WireAgent>(update(parent.id, { type: "multiagent_20261001" }));
    expect(fresh.multiagent).toEqual(DEFAULT_BLOCK);
  });

  describe("checks the block as it stands after the update", () => {
    it("answers 400 on inline agents off over an empty list", async () => {
      const child = await ok<WireAgent>(createAgent({ name: "inline-child" }));
      const parent = await ok<WireAgent>(createAgent({
        name: "inline-parent",
        multiagent: {
          type: "multiagent_20261001",
          subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [child.id] },
        },
      }));
      // The kept inline_agents is off, and null empties the list.
      await expectInvalid(await update(parent.id, {
        type: "multiagent_20261001",
        subagents: { type: "enabled", predefined_agents: null },
      }), "subagents.inline_agents is disabled, so subagents.predefined_agents needs at least one agent");

      const bare = await ok<WireAgent>(createAgent({
        name: "inline-bare",
        multiagent: { type: "multiagent_20261001" },
      }));
      await expectInvalid(await update(bare.id, {
        type: "multiagent_20261001",
        workflows: { type: "enabled", inline_agents: { type: "disabled" } },
      }), "workflows.inline_agents is disabled, so workflows.predefined_agents needs at least one agent");
      expect((await ok<WireAgent>(call("GET", `/v1/agents/${parent.id}`))).version).toBe(1);
    });

    it("answers 400 on the advisor turned on over a kept agent named anthropic.advisor", async () => {
      const named = await ok<WireAgent>(createAgent({ name: "anthropic.advisor" }));
      const parent = await ok<WireAgent>(createAgent({
        name: "kept-named-parent",
        multiagent: {
          type: "multiagent_20261001",
          workflows: { type: "enabled", predefined_agents: [named.id] },
        },
      }));
      await expectInvalid(
        await update(parent.id, { type: "multiagent_20261001", advisor: ADVISOR }),
        `workflows.predefined_agents agent ${named.id} is named anthropic.advisor`,
      );
      const kept = await ok<WireAgent>(call("GET", `/v1/agents/${parent.id}`));
      expect(kept.version).toBe(1);
      expect(kept.multiagent).toMatchObject({ advisor: { type: "disabled" } });
    });

    it("checks the ant__ prefix against the workflows the update leaves", async () => {
      const parent = await ok<WireAgent>(createAgent({
        name: "kept-workflows-off",
        tools: [antTool],
        multiagent: { type: "multiagent_20261001", workflows: { type: "disabled" } },
      }));
      // Workflows stay off when the update leaves them out.
      const advised = await ok<WireAgent>(update(parent.id, { type: "multiagent_20261001", advisor: ADVISOR }));
      expect(advised.multiagent).toMatchObject({ workflows: { type: "disabled" }, advisor: ADVISOR });
      await expectInvalid(
        await update(parent.id, { type: "multiagent_20261001", workflows: { type: "enabled" } }),
        "ant__lookup",
      );
    });
  });
});
