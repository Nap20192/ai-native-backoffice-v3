// Write preconditions (docs/plans/builder-agent.md, 2.5 step 8, unit BP1):
// reads return the stored revision, writes take an optional expectedRevision,
// compare it with the revision they read and replace with that same revision.
import { describe, expect, it } from "vitest";
import { MemoryDeploymentStore } from "../../deployment-store-memory/src/index";
import { MemoryEnvironmentStore } from "../../environment-store-memory/src/index";
import { InMemoryMemoryStoreStore } from "../../memory-store-store-memory/src/index";
import { MemorySkillStore } from "../../skill-store-memory/src/index";
import type { Agent } from "../src/domain/agent";
import type { Deployment } from "../src/domain/deployment";
import type { Environment } from "../src/domain/environment";
import { DeploymentsApplicationService } from "../src/deployments/application";
import { EnvironmentsApplicationService } from "../src/environments/application";
import { MemoryStoresApplicationService } from "../src/memory-stores/application";
import { SessionsApplicationService } from "../src/sessions/application";
import { SkillsApplicationService } from "../src/skills/application";
import { SkillVersionsApplicationService } from "../src/skills/versions-application";

const WORKSPACE = "workspace_bp1";
const clock = { now: () => new Date("2026-10-16T10:00:00.000Z") };

const environment: Environment = {
  id: "env_bp1",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-10-16T09:00:00.000Z",
  description: null,
  metadata: {},
  name: "Base",
  updatedAt: "2026-10-16T09:00:00.000Z",
};

const agent: Agent = {
  id: "agent_bp1",
  archivedAt: null,
  createdAt: "2026-10-16T09:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "qwen3.6-35b" },
  multiagent: null,
  name: "Agent",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-10-16T09:00:00.000Z",
  version: 2,
};

/** Runs `hook` once, right after the first `find` of the wrapped store. */
function afterFirstFind<Store extends { find(input: never): Promise<unknown> }>(
  store: Store,
  hook: () => Promise<void>,
): Store {
  let fired = false;
  const find = store.find.bind(store);
  return Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
    async find(input: never) {
      const found = await find(input);
      if (!fired) {
        fired = true;
        await hook();
      }
      return found;
    },
  }) as Store;
}

async function environmentsWith(store = new MemoryEnvironmentStore()) {
  const ids = ["env_bp1"];
  const service = new EnvironmentsApplicationService({
    workspaceId: WORKSPACE,
    store,
    clock,
    ids: { nextEnvironmentId: () => ids.shift() ?? "env_other" },
  });
  return { service, store };
}

describe("environments: revision and expectedRevision", () => {
  it("create, retrieve and update return the stored revision", async () => {
    const { service } = await environmentsWith();
    const created = await service.createEnvironment({ name: "Base" });
    expect(created).toMatchObject({ type: "created", revision: 1 });
    await expect(service.retrieveEnvironment({ environmentId: "env_bp1" }))
      .resolves.toMatchObject({ type: "found", revision: 1 });
    await expect(service.updateEnvironment({ environmentId: "env_bp1", name: "Next" }))
      .resolves.toMatchObject({ type: "updated", revision: 2 });
  });

  it("a matching expectedRevision writes, another one fails and writes nothing", async () => {
    const { service, store } = await environmentsWith();
    await service.createEnvironment({ name: "Base" });

    await expect(service.updateEnvironment({
      environmentId: "env_bp1",
      name: "Stale",
      expectedRevision: 7,
    })).resolves.toEqual({
      type: "precondition_failed",
      message: "Environment env_bp1 is at revision 1, not 7",
    });
    const unchanged = await store.find({ workspaceId: WORKSPACE, environmentId: "env_bp1" });
    expect(unchanged).toMatchObject({ revision: 1, environment: { name: "Base" } });

    await expect(service.updateEnvironment({
      environmentId: "env_bp1",
      name: "Fresh",
      expectedRevision: 1,
    })).resolves.toMatchObject({ type: "updated", revision: 2, environment: { name: "Fresh" } });
  });

  it("an edit between the read and replace gives a version conflict", async () => {
    const base = new MemoryEnvironmentStore();
    await base.insert({ workspaceId: WORKSPACE, environment });
    const store = afterFirstFind(base, async () => {
      await base.replace({
        workspaceId: WORKSPACE,
        environmentId: "env_bp1",
        expectedRevision: 1,
        next: { ...environment, name: "Third party" },
      });
    });
    const { service } = await environmentsWith(store);

    await expect(service.updateEnvironment({
      environmentId: "env_bp1",
      name: "Assistant",
      expectedRevision: 1,
    })).resolves.toMatchObject({ type: "version_conflict" });
    await expect(base.find({ workspaceId: WORKSPACE, environmentId: "env_bp1" }))
      .resolves.toMatchObject({ revision: 2, environment: { name: "Third party" } });
  });
});

function deploymentsWith(store: MemoryDeploymentStore | ReturnType<typeof afterFirstFind<MemoryDeploymentStore>>) {
  const unexpected = (what: string) => async () => {
    throw new Error(`unexpected ${what}`);
  };
  return new DeploymentsApplicationService({
    workspaceId: WORKSPACE,
    agents: { find: async () => agent },
    environments: { find: async () => environment },
    files: { find: unexpected("file") },
    memoryStores: { find: unexpected("memory store") },
    store,
    runs: {
      beginManual: unexpected("run"),
      finalize: unexpected("run"),
      find: unexpected("run"),
      list: unexpected("run"),
    },
    schedules: {
      plan: async (input) => ({
        type: "planned" as const,
        schedule: {
          expression: input.expression,
          timezone: input.timezone,
          upcomingRunsAt: ["2026-10-17T09:00:00.000Z"],
        },
      }),
    },
    sessions: { launch: unexpected("launch") },
    vaults: { find: unexpected("vault") },
    clock,
    ids: { nextDeploymentId: () => "depl_bp1", nextDeploymentRunId: () => "drun_bp1" },
  } as ConstructorParameters<typeof DeploymentsApplicationService>[0]);
}

const createDeployment = {
  agent: { kind: "versioned" as const, agentId: "agent_bp1", version: 2 },
  environmentId: "env_bp1",
  initialEvents: [
    { type: "user.message" as const, content: [{ type: "text" as const, text: "Check" }] },
  ],
  name: "nightly",
  schedule: { expression: "0 9 * * *", timezone: "UTC" },
};

describe("deployments: created paused, revision and expectedRevision", () => {
  it("initialStatus paused writes one paused deployment with a manual reason", async () => {
    const store = new MemoryDeploymentStore();
    const inserts: unknown[] = [];
    const insert = store.insert.bind(store);
    store.insert = async (input) => {
      inserts.push(input);
      return insert(input);
    };
    const replace = store.replace.bind(store);
    let replaces = 0;
    store.replace = async (input) => {
      replaces += 1;
      return replace(input);
    };
    const service = deploymentsWith(store);

    const created = await service.createDeployment({ ...createDeployment, initialStatus: "paused" });

    expect(created).toMatchObject({
      type: "created",
      revision: 1,
      deployment: { status: "paused", pausedReason: { kind: "manual" } },
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      record: { deployment: { status: "paused", pausedReason: { kind: "manual" } } },
    });
    expect(replaces).toBe(0);
    if (created.type !== "created") throw new Error("not created");
    expect(created.deployment.updatedAt).toBe(created.deployment.createdAt);
  });

  it("without initialStatus the deployment is active as before", async () => {
    const service = deploymentsWith(new MemoryDeploymentStore());
    await expect(service.createDeployment(createDeployment)).resolves.toMatchObject({
      type: "created",
      deployment: { status: "active", pausedReason: null },
    });
  });

  it("update and pause compare expectedRevision with the stored revision", async () => {
    const store = new MemoryDeploymentStore();
    const service = deploymentsWith(store);
    await service.createDeployment({ ...createDeployment, initialStatus: "paused" });
    await expect(service.retrieveDeployment({ deploymentId: "depl_bp1" }))
      .resolves.toMatchObject({ type: "found", revision: 1 });

    await expect(service.updateDeployment({
      deploymentId: "depl_bp1",
      name: "stale",
      expectedRevision: 3,
    })).resolves.toEqual({
      type: "precondition_failed",
      message: "Deployment depl_bp1 is at revision 1, not 3",
    });
    await expect(store.find({ workspaceId: WORKSPACE, deploymentId: "depl_bp1" }))
      .resolves.toMatchObject({ revision: 1, deployment: { name: "nightly" } });

    await expect(service.updateDeployment({
      deploymentId: "depl_bp1",
      name: "fresh",
      expectedRevision: 1,
    })).resolves.toMatchObject({ type: "updated", revision: 2, deployment: { name: "fresh" } });

    await expect(service.unpauseDeployment({ deploymentId: "depl_bp1", expectedRevision: 1 }))
      .resolves.toEqual({
        type: "precondition_failed",
        message: "Deployment depl_bp1 is at revision 2, not 1",
      });
    await expect(service.unpauseDeployment({ deploymentId: "depl_bp1", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "changed", revision: 3, deployment: { status: "active" } });
    await expect(service.pauseDeployment({ deploymentId: "depl_bp1", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(service.pauseDeployment({ deploymentId: "depl_bp1", expectedRevision: 3 }))
      .resolves.toMatchObject({ type: "changed", revision: 4, deployment: { status: "paused" } });
  });

  it("an edit between the read and replace gives a version conflict", async () => {
    const base = new MemoryDeploymentStore();
    await deploymentsWith(base).createDeployment({ ...createDeployment, initialStatus: "paused" });
    const record = await base.find({ workspaceId: WORKSPACE, deploymentId: "depl_bp1" });
    const store = afterFirstFind(base, async () => {
      await base.replace({
        workspaceId: WORKSPACE,
        deploymentId: "depl_bp1",
        expectedRevision: 1,
        next: {
          deployment: { ...(record!.deployment as Deployment), name: "third-party" },
          resourceSecrets: [],
        },
      });
    });

    await expect(deploymentsWith(store).updateDeployment({
      deploymentId: "depl_bp1",
      name: "assistant",
      expectedRevision: 1,
    })).resolves.toMatchObject({ type: "version_conflict" });
    await expect(base.find({ workspaceId: WORKSPACE, deploymentId: "depl_bp1" }))
      .resolves.toMatchObject({ revision: 2, deployment: { name: "third-party" } });
  });
});

describe("memory stores: revision and expectedRevision", () => {
  it("retrieve and update return the revision, a stale one writes nothing", async () => {
    const store = new InMemoryMemoryStoreStore();
    const service = new MemoryStoresApplicationService({
      workspaceId: WORKSPACE,
      store,
      clock,
      ids: { nextMemoryStoreId: () => "memstore_bp1" },
    });
    await expect(service.createMemoryStore({ name: "Facts" }))
      .resolves.toMatchObject({ type: "created", revision: 1 });
    await expect(service.retrieveMemoryStore({ memoryStoreId: "memstore_bp1" }))
      .resolves.toMatchObject({ type: "found", revision: 1 });

    await expect(service.updateMemoryStore({
      memoryStoreId: "memstore_bp1",
      name: "Stale",
      expectedRevision: 2,
    })).resolves.toEqual({
      type: "precondition_failed",
      message: "Memory store memstore_bp1 is at revision 1, not 2",
    });
    await expect(store.find({ workspaceId: WORKSPACE, memoryStoreId: "memstore_bp1" }))
      .resolves.toMatchObject({ revision: 1, memoryStore: { name: "Facts" } });

    await expect(service.updateMemoryStore({
      memoryStoreId: "memstore_bp1",
      name: "Fresh",
      expectedRevision: 1,
    })).resolves.toMatchObject({ type: "updated", revision: 2, memoryStore: { name: "Fresh" } });
  });
});

describe("skills: skill revision and expectedRevision of a new version", () => {
  function skillServices() {
    const store = new MemorySkillStore();
    const versions = ["1", "2", "3"];
    const versionIds = ["skillver_1", "skillver_2", "skillver_3"];
    const ids = {
      nextSkillId: () => "skill_bp1",
      nextSkillVersionId: () => versionIds.shift()!,
      nextSkillVersion: () => versions.shift()!,
    };
    const compiler = {
      compile: async () => ({
        type: "compiled" as const,
        package: {
          archive: { content: new Uint8Array([1]), filename: "s.zip", mediaType: "application/zip" },
          description: "Skill",
          directory: "skill",
          name: "skill",
        },
      }),
    };
    const files = [{ filename: "skill/SKILL.md", mimeType: "text/markdown", content: new Uint8Array([1]) }];
    return {
      store,
      files,
      skills: new SkillsApplicationService({ workspaceId: WORKSPACE, store, compiler, clock, ids }),
      versions: new SkillVersionsApplicationService({ workspaceId: WORKSPACE, store, compiler, clock, ids }),
    };
  }

  it("retrieveSkill returns the skill revision, a new version returns the next one", async () => {
    const { skills, versions, files } = skillServices();
    await skills.createSkill({ files });
    await expect(skills.retrieveSkill({ skillId: "skill_bp1" }))
      .resolves.toMatchObject({ type: "found", revision: 1 });
    await expect(versions.createSkillVersion({ skillId: "skill_bp1", files, expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "created", skillRevision: 2, version: { version: "2" } });
  });

  it("a stale expectedRevision adds no version", async () => {
    const { skills, versions, files, store } = skillServices();
    await skills.createSkill({ files });
    await expect(versions.createSkillVersion({ skillId: "skill_bp1", files, expectedRevision: 4 }))
      .resolves.toEqual({
        type: "precondition_failed",
        message: "Skill skill_bp1 is at revision 1, not 4",
      });
    await expect(store.findSkill({ workspaceId: WORKSPACE, skillId: "skill_bp1" }))
      .resolves.toMatchObject({ revision: 1, skill: { latestVersion: "1" } });
  });
});

describe("sessions: retrieve returns the session revision", () => {
  it("found carries the revision of the current record", async () => {
    const unexpected = async () => {
      throw new Error("unexpected call");
    };
    const session = { id: "sesn_bp1" };
    const service = new SessionsApplicationService({
      workspaceId: WORKSPACE,
      store: {
        findCurrent: async () => ({ session, revision: 5 }),
      },
      agents: { find: unexpected },
      environments: { find: unexpected },
      resources: { resolve: unexpected },
      lifecycle: {},
      clock,
      ids: { nextSessionId: () => "sesn_bp1" },
    } as unknown as ConstructorParameters<typeof SessionsApplicationService>[0]);

    await expect(service.retrieveSession({ sessionId: "sesn_bp1" }))
      .resolves.toEqual({ type: "found", session, revision: 5 });
  });
});
