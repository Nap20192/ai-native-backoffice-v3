// Archive, restore and delete of every resource (docs/plans/crud.md, A5 to
// A12): If-Match, the dependency check and the cascades.
import { beforeEach, describe, expect, it } from "vitest";
import { AgentsApplicationService } from "../src/agents/application";
import { DeploymentsApplicationService } from "../src/deployments/application";
import { EnvironmentsApplicationService } from "../src/environments/application";
import { FilesApplicationService } from "../src/files/application";
import { MemoryStoresApplicationService } from "../src/memory-stores/application";
import { SessionsApplicationService } from "../src/sessions/application";
import { SkillsApplicationService } from "../src/skills/application";
import { SkillVersionsApplicationService } from "../src/skills/versions-application";
import { VaultsApplicationService } from "../src/vaults/application";
import {
  createCrudStores,
  dependencyService,
  seeder,
  WORKSPACE,
  type CrudStores,
} from "./crud-world";

const NOW = new Date("2026-10-05T00:00:00.000Z");
const clock = { now: () => NOW };

let stores: CrudStores;
let seed: ReturnType<typeof seeder>;

beforeEach(() => {
  stores = createCrudStores();
  seed = seeder(stores);
});

function agents() {
  return new AgentsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.agents,
    clock,
    ids: { nextAgentId: () => "agent_new" },
    dependencyCheck: dependencyService(stores),
  });
}

function environments() {
  return new EnvironmentsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.environments,
    clock,
    ids: { nextEnvironmentId: () => "env_new" },
    dependencyCheck: dependencyService(stores),
  });
}

function sessions(stopped: string[] = []) {
  return new SessionsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.sessions,
    agents: {} as never,
    environments: {} as never,
    resources: {} as never,
    lifecycle: {
      sessionStarted: async () => undefined,
      sessionStopped: async (input) => {
        const stored = await stores.sessions.findCurrent({
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        });
        stopped.push(`${input.sessionId}:${input.reason}:${stored === null ? "gone" : stored.session.archivedAt === null ? "live" : "archived"}`);
      },
    },
    clock,
    ids: { nextSessionId: () => "sesn_new" },
  });
}

function deployments() {
  return new DeploymentsApplicationService({
    workspaceId: WORKSPACE,
    agents: {
      find: async ({ selector }: { selector: { agentId: string } }) => stores.agents.findCurrent({ workspaceId: WORKSPACE, agentId: selector.agentId }),
    } as never,
    environments: {
      find: async ({ environmentId }: { environmentId: string }) =>
        (await stores.environments.find({ workspaceId: WORKSPACE, environmentId }))?.environment ?? null,
    } as never,
    files: {} as never,
    memoryStores: {} as never,
    store: stores.deployments,
    runs: {} as never,
    schedules: {} as never,
    sessions: {} as never,
    vaults: {} as never,
    clock,
    ids: { nextDeploymentId: () => "depl_new", nextDeploymentRunId: () => "run_new" },
  });
}

function files(deletedContent: string[] = []) {
  return new FilesApplicationService({
    workspaceId: WORKSPACE,
    store: stores.files,
    content: {
      put: async () => undefined,
      get: async () => null,
      delete: async ({ fileId }: { fileId: string }) => {
        deletedContent.push(fileId);
      },
    } as never,
    clock,
    ids: { nextFileId: () => "file_new" },
    dependencyCheck: dependencyService(stores),
  });
}

function skills() {
  return new SkillsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.skills,
    compiler: {} as never,
    clock,
    ids: { nextSkillId: () => "skill_new", nextSkillVersionId: () => "sv", nextSkillVersion: () => "1" },
    dependencyCheck: dependencyService(stores),
  });
}

function skillVersions() {
  return new SkillVersionsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.skills,
    compiler: {} as never,
    clock,
    ids: { nextSkillVersionId: () => "sv", nextSkillVersion: () => "9" },
    dependencyCheck: dependencyService(stores),
  });
}

function memoryStores() {
  return new MemoryStoresApplicationService({
    workspaceId: WORKSPACE,
    store: stores.memoryStores,
    memories: stores.memories,
    clock,
    ids: { nextMemoryStoreId: () => "memstore_new" },
    dependencyCheck: dependencyService(stores),
  });
}

function vaults() {
  return new VaultsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.vaults,
    credentials: stores.credentials,
    clock,
    ids: { nextVaultId: () => "vlt_new" },
    dependencyCheck: dependencyService(stores),
  });
}

describe("agents", () => {
  beforeEach(async () => {
    await seed.agent("agent_main");
  });

  it("archive refuses a stale version and an active deployment", async () => {
    await expect(agents().archiveAgent({ agentId: "agent_main", expectedVersion: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await seed.deployment("depl_active");
    await expect(agents().archiveAgent({ agentId: "agent_main", expectedVersion: 1 }))
      .resolves.toMatchObject({
        type: "dependency_conflict",
        dependencies: { blocking: [expect.objectContaining({ id: "depl_active" })] },
      });
    const current = await stores.agents.findCurrent({ workspaceId: WORKSPACE, agentId: "agent_main" });
    expect(current?.archivedAt).toBeNull();
  });

  it("unarchive keeps the version and leaves an agent out of the archive alone", async () => {
    await expect(agents().unarchiveAgent({ agentId: "agent_main" }))
      .resolves.toMatchObject({ type: "unarchived", agent: { archivedAt: null, version: 1, updatedAt: "2026-10-01T00:00:00.000Z" } });
    await agents().archiveAgent({ agentId: "agent_main" });
    await expect(agents().unarchiveAgent({ agentId: "agent_main", expectedVersion: 3 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(agents().unarchiveAgent({ agentId: "agent_main", expectedVersion: 1 }))
      .resolves.toMatchObject({ type: "unarchived", agent: { archivedAt: null, version: 1, updatedAt: NOW.toISOString() } });
    await expect(agents().unarchiveAgent({ agentId: "agent_x" })).resolves.toEqual({ type: "not_found" });
  });

  it("delete is blocked by a live session and then removes every version", async () => {
    await agents().updateAgent({ agentId: "agent_main", name: "second" });
    await seed.session("sesn_live");
    await expect(agents().deleteAgent({ agentId: "agent_main" }))
      .resolves.toMatchObject({ type: "dependency_conflict" });
    await stores.sessions.archiveCurrent({ workspaceId: WORKSPACE, sessionId: "sesn_live", archivedAt: NOW.toISOString() });
    await expect(agents().deleteAgent({ agentId: "agent_main", expectedVersion: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(agents().deleteAgent({ agentId: "agent_main", expectedVersion: 2 }))
      .resolves.toEqual({ type: "deleted", agentId: "agent_main" });
    await expect(agents().retrieveAgent({ agentId: "agent_main" })).resolves.toEqual({ type: "not_found" });
    await expect(stores.agents.findVersion({ workspaceId: WORKSPACE, agentId: "agent_main", version: 1 }))
      .resolves.toBeNull();
    // The archived session keeps its agent snapshot.
    await expect(stores.sessions.findCurrent({ workspaceId: WORKSPACE, sessionId: "sesn_live" }))
      .resolves.toMatchObject({ session: { agent: { id: "agent_main" } } });
  });
});

describe("environments", () => {
  beforeEach(async () => {
    await seed.environment("env_main");
  });

  it("archive checks the revision and an active deployment", async () => {
    await expect(environments().archiveEnvironment({ environmentId: "env_main", expectedRevision: 9 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await seed.deployment("depl_active");
    await expect(environments().archiveEnvironment({ environmentId: "env_main" }))
      .resolves.toMatchObject({ type: "dependency_conflict" });
    const found = (await stores.deployments.find({ workspaceId: WORKSPACE, deploymentId: "depl_active" }))!;
    await stores.deployments.replace({
      workspaceId: WORKSPACE,
      deploymentId: "depl_active",
      expectedRevision: found.revision,
      next: { deployment: { ...found.deployment, status: "paused" }, resourceSecrets: [] },
    });
    await expect(environments().archiveEnvironment({ environmentId: "env_main", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "archived", revision: 2, environment: { archivedAt: NOW.toISOString() } });
  });

  it("unarchive restores and keeps a live environment as it is", async () => {
    await expect(environments().unarchiveEnvironment({ environmentId: "env_main" }))
      .resolves.toMatchObject({ type: "unarchived", revision: 1 });
    await environments().archiveEnvironment({ environmentId: "env_main" });
    await expect(environments().unarchiveEnvironment({ environmentId: "env_main", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(environments().unarchiveEnvironment({ environmentId: "env_main", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "unarchived", revision: 3, environment: { archivedAt: null } });
  });

  it("delete is blocked by a live session and checks the revision", async () => {
    await seed.session("sesn_live");
    await expect(environments().deleteEnvironment({ environmentId: "env_main" }))
      .resolves.toMatchObject({ type: "dependency_conflict" });
    await stores.sessions.deleteCurrent({ workspaceId: WORKSPACE, sessionId: "sesn_live" });
    await expect(environments().deleteEnvironment({ environmentId: "env_main", expectedRevision: 5 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(environments().deleteEnvironment({ environmentId: "env_main", expectedRevision: 1 }))
      .resolves.toEqual({ type: "deleted", environmentId: "env_main" });
  });
});

describe("sessions", () => {
  it("archive stops the turn before the write and checks the revision", async () => {
    await seed.session("sesn_run", { status: "running" });
    const stopped: string[] = [];
    await expect(sessions(stopped).archiveSession({ sessionId: "sesn_run", expectedRevision: 4 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    expect(stopped).toEqual([]);
    await expect(sessions(stopped).archiveSession({ sessionId: "sesn_run", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "archived", revision: 2 });
    expect(stopped).toEqual(["sesn_run:archived:live"]);
  });

  it("delete stops the turn before the write and checks the revision", async () => {
    await seed.session("sesn_run", { status: "running" });
    const stopped: string[] = [];
    await expect(sessions(stopped).deleteSession({ sessionId: "sesn_run", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(sessions(stopped).deleteSession({ sessionId: "sesn_run", expectedRevision: 1 }))
      .resolves.toEqual({ type: "deleted", sessionId: "sesn_run" });
    expect(stopped).toEqual(["sesn_run:deleted:live"]);
  });

  it("unarchive keeps the status", async () => {
    await seed.session("sesn_done", { status: "terminated" });
    await expect(sessions().unarchiveSession({ sessionId: "sesn_done" }))
      .resolves.toMatchObject({ type: "unarchived", revision: 1 });
    await sessions().archiveSession({ sessionId: "sesn_done" });
    await expect(sessions().unarchiveSession({ sessionId: "sesn_done", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(sessions().unarchiveSession({ sessionId: "sesn_done", expectedRevision: 2 }))
      .resolves.toMatchObject({
        type: "unarchived",
        revision: 3,
        session: { archivedAt: null, status: "terminated" },
      });
  });
});

describe("deployments", () => {
  beforeEach(async () => {
    await seed.agent("agent_main");
    await seed.environment("env_main");
    await seed.deployment("depl_main");
  });

  it("unarchive brings an active deployment back paused", async () => {
    await deployments().archiveDeployment({ deploymentId: "depl_main" });
    await expect(deployments().unarchiveDeployment({ deploymentId: "depl_main", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(deployments().unarchiveDeployment({ deploymentId: "depl_main", expectedRevision: 2 }))
      .resolves.toMatchObject({
        type: "changed",
        revision: 3,
        deployment: { archivedAt: null, status: "paused", pausedReason: { kind: "manual" } },
      });
  });

  it("unarchive leaves a deployment out of the archive alone", async () => {
    await expect(deployments().unarchiveDeployment({ deploymentId: "depl_main" }))
      .resolves.toMatchObject({ type: "changed", revision: 1, deployment: { status: "active" } });
  });

  it("unarchive refuses an archived agent or environment", async () => {
    await deployments().archiveDeployment({ deploymentId: "depl_main" });
    await stores.agents.archiveCurrent({ workspaceId: WORKSPACE, agentId: "agent_main", archivedAt: NOW.toISOString() });
    await expect(deployments().unarchiveDeployment({ deploymentId: "depl_main" }))
      .resolves.toMatchObject({ type: "conflict", message: expect.stringContaining("agent_archived_error") });
    await stores.agents.unarchiveCurrent({ workspaceId: WORKSPACE, agentId: "agent_main", updatedAt: NOW.toISOString() });
    await stores.environments.archive({ workspaceId: WORKSPACE, environmentId: "env_main", archivedAt: NOW.toISOString() });
    await expect(deployments().unarchiveDeployment({ deploymentId: "depl_main" }))
      .resolves.toMatchObject({ type: "conflict", message: expect.stringContaining("environment_archived_error") });
  });
});

describe("files", () => {
  it("delete is blocked by a live session that mounts the file", async () => {
    await seed.file("file_a");
    await seed.session("sesn_file", {
      resources: [{ id: "res_1", type: "file", createdAt: NOW.toISOString(), fileId: "file_a", mountPath: "/mnt/a", updatedAt: NOW.toISOString() }],
    });
    const deleted: string[] = [];
    await expect(files(deleted).deleteFile({ fileId: "file_a" }))
      .resolves.toMatchObject({ type: "dependency_conflict" });
    expect(deleted).toEqual([]);
    await stores.sessions.archiveCurrent({ workspaceId: WORKSPACE, sessionId: "sesn_file", archivedAt: NOW.toISOString() });
    await expect(files(deleted).deleteFile({ fileId: "file_a" })).resolves.toEqual({ type: "deleted", fileId: "file_a" });
    expect(deleted).toEqual(["file_a"]);
  });
});

describe("skills", () => {
  beforeEach(async () => {
    await seed.skill("skill_a", ["1", "2"]);
  });

  it("skill delete checks the revision and agents", async () => {
    await expect(skills().deleteSkill({ skillId: "skill_a", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await seed.agent("agent_skill", { skills: [{ skillId: "skill_a", type: "custom", version: "latest" }] });
    await expect(skills().deleteSkill({ skillId: "skill_a" }))
      .resolves.toMatchObject({ type: "dependency_conflict" });
    await stores.agents.archiveCurrent({ workspaceId: WORKSPACE, agentId: "agent_skill", archivedAt: NOW.toISOString() });
    await expect(skills().deleteSkill({ skillId: "skill_a", expectedRevision: 2 }))
      .resolves.toEqual({ type: "deleted", skillId: "skill_a" });
  });

  it("version delete refuses the last version and a stale skill revision", async () => {
    await expect(skillVersions().deleteSkillVersion({ skillId: "skill_a", version: "2", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(skillVersions().deleteSkillVersion({ skillId: "skill_a", version: "2", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "deleted", version: "2", skillRevision: 3 });
    await expect(skillVersions().deleteSkillVersion({ skillId: "skill_a", version: "1" }))
      .resolves.toMatchObject({
        type: "dependency_conflict",
        dependencies: { blocking: [expect.objectContaining({ note: "Это последняя версия. Удалите навык целиком" })] },
      });
  });
});

describe("memory stores", () => {
  beforeEach(async () => {
    await seed.memoryStore("memstore_a");
    await seed.memoryStore("memstore_b");
    await seed.memory("memstore_a", "mem_1", "/a.md");
    await seed.memory("memstore_a", "mem_2", "/dir/b.md");
    await seed.memory("memstore_b", "mem_3", "/a.md");
  });

  it("archive and unarchive check the revision", async () => {
    await expect(memoryStores().archiveMemoryStore({ memoryStoreId: "memstore_a", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(memoryStores().archiveMemoryStore({ memoryStoreId: "memstore_a", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "archived", revision: 2 });
    await expect(memoryStores().unarchiveMemoryStore({ memoryStoreId: "memstore_a", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "unarchived", revision: 3, memoryStore: { archivedAt: null } });
  });

  it("delete is blocked by a live session and leaves no orphan memories", async () => {
    await seed.session("sesn_mem", { resources: [{ type: "memory_store", memoryStoreId: "memstore_a" }] });
    await expect(memoryStores().deleteMemoryStore({ memoryStoreId: "memstore_a" }))
      .resolves.toMatchObject({ type: "dependency_conflict" });
    await stores.sessions.deleteCurrent({ workspaceId: WORKSPACE, sessionId: "sesn_mem" });
    await expect(memoryStores().deleteMemoryStore({ memoryStoreId: "memstore_a", expectedRevision: 1 }))
      .resolves.toEqual({ type: "deleted", memoryStoreId: "memstore_a" });
    const page = await stores.memories.listCurrent({
      workspaceId: WORKSPACE, memoryStoreId: "memstore_a", limit: 10, depth: 10, pathPrefix: "/",
    });
    expect(page.items).toEqual([]);
    await expect(stores.memories.listVersions({ workspaceId: WORKSPACE, memoryStoreId: "memstore_a", limit: 10 }))
      .resolves.toEqual([]);
    await expect(stores.memories.findCurrent({ workspaceId: WORKSPACE, memoryStoreId: "memstore_b", memoryId: "mem_3" }))
      .resolves.not.toBeNull();
  });
});

describe("vaults", () => {
  beforeEach(async () => {
    await seed.vault("vlt_a");
    await seed.credential("vlt_a", "cred_1");
  });

  it("archive is blocked by an active deployment, unarchive restores", async () => {
    await seed.deployment("depl_vault", { vaultIds: ["vlt_a"] });
    await expect(vaults().archiveVault({ vaultId: "vlt_a" })).resolves.toMatchObject({ type: "dependency_conflict" });
    await seed.vault("vlt_b");
    await vaults().archiveVault({ vaultId: "vlt_b" });
    await expect(vaults().unarchiveVault({ vaultId: "vlt_b" }))
      .resolves.toMatchObject({ type: "unarchived", vault: { archivedAt: null } });
  });

  it("delete removes the credentials with the vault", async () => {
    await expect(vaults().deleteVault({ vaultId: "vlt_a" })).resolves.toEqual({ type: "deleted", vaultId: "vlt_a" });
    await expect(stores.credentials.list({ workspaceId: WORKSPACE, vaultId: "vlt_a", limit: 10, includeArchived: true }))
      .resolves.toEqual([]);
  });
});
