// Archive, restore and delete of every resource (docs/plans/crud.md, A5 to
// A12): If-Match, the dependency check and the cascades.
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentStore } from "@open-managed-agents/agent-store";
import type { CredentialStore } from "@open-managed-agents/credential-store";
import type { MemoryDocumentStore } from "@open-managed-agents/memory-document-store";
import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";
import type { VaultStore } from "@open-managed-agents/vault-store";
import { AgentsApplicationService } from "../src/agents/application";
import { DeploymentsApplicationService } from "../src/deployments/application";
import { EnvironmentsApplicationService } from "../src/environments/application";
import { FilesApplicationService } from "../src/files/application";
import { MemoryStoresApplicationService } from "../src/memory-stores/application";
import { SessionsApplicationService } from "../src/sessions/application";
import { SkillsApplicationService } from "../src/skills/application";
import { SkillVersionsApplicationService } from "../src/skills/versions-application";
import { VaultsApplicationService } from "../src/vaults/application";
import type { DependenciesApplicationPort } from "../src/ports/dependencies";
import type { FilesApplicationPort } from "../src/ports/files";
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

function agents(dependencyCheck: DependenciesApplicationPort = dependencyService(stores)) {
  return new AgentsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.agents,
    clock,
    ids: { nextAgentId: () => "agent_new" },
    dependencyCheck,
  });
}

function environments(dependencyCheck: DependenciesApplicationPort = dependencyService(stores)) {
  return new EnvironmentsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.environments,
    clock,
    ids: { nextEnvironmentId: () => "env_new" },
    dependencyCheck,
  });
}

/**
 * Each lifecycle call records the session id, the step and the stored row.
 * `duringStop` runs inside the stop, after the record, as a concurrent write.
 * `outputFiles` deletes the files of a deleted session.
 */
function sessions(
  stopped: string[] = [],
  duringStop?: (sessionId: string) => Promise<void>,
  outputFiles: FilesApplicationPort = files(),
) {
  const stored = async (sessionId: string) => {
    const current = await stores.sessions.findCurrent({ workspaceId: WORKSPACE, sessionId });
    return current === null ? "gone" : current.session.archivedAt === null ? "live" : "archived";
  };
  return new SessionsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.sessions,
    agents: {} as never,
    environments: {} as never,
    resources: {} as never,
    lifecycle: {
      sessionStarted: async () => undefined,
      sessionStopped: async (input) => {
        stopped.push(`${input.sessionId}:${input.reason}:${await stored(input.sessionId)}`);
        await duringStop?.(input.sessionId);
      },
      sessionDeleted: async (input) => {
        stopped.push(`${input.sessionId}:cleanup:${await stored(input.sessionId)}`);
      },
    },
    clock,
    ids: { nextSessionId: () => "sesn_new" },
    files: outputFiles,
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

/** `failingContent` names a file whose content delete throws. */
function files(deletedContent: string[] = [], failingContent?: string) {
  return new FilesApplicationService({
    workspaceId: WORKSPACE,
    store: stores.files,
    content: {
      put: async () => undefined,
      get: async () => null,
      delete: async ({ fileId }: { fileId: string }) => {
        if (fileId === failingContent) throw new Error(`content of ${fileId} is unreachable`);
        deletedContent.push(fileId);
      },
    } as never,
    clock,
    ids: { nextFileId: () => "file_new" },
    dependencyCheck: dependencyService(stores),
  });
}

function skills(dependencyCheck: DependenciesApplicationPort = dependencyService(stores)) {
  return new SkillsApplicationService({
    workspaceId: WORKSPACE,
    store: stores.skills,
    compiler: {} as never,
    clock,
    ids: { nextSkillId: () => "skill_new", nextSkillVersionId: () => "sv", nextSkillVersion: () => "1" },
    dependencyCheck,
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

function memoryStores(overrides: {
  store?: MemoryStoreStore;
  memories?: MemoryDocumentStore;
  dependencyCheck?: DependenciesApplicationPort;
} = {}) {
  return new MemoryStoresApplicationService({
    workspaceId: WORKSPACE,
    store: overrides.store ?? stores.memoryStores,
    memories: overrides.memories ?? stores.memories,
    clock,
    ids: { nextMemoryStoreId: () => "memstore_new" },
    dependencyCheck: overrides.dependencyCheck ?? dependencyService(stores),
  });
}

function vaults(overrides: {
  store?: VaultStore;
  credentials?: CredentialStore;
  dependencyCheck?: DependenciesApplicationPort;
} = {}) {
  return new VaultsApplicationService({
    workspaceId: WORKSPACE,
    store: overrides.store ?? stores.vaults,
    credentials: overrides.credentials ?? stores.credentials,
    clock,
    ids: { nextVaultId: () => "vlt_new" },
    dependencyCheck: overrides.dependencyCheck ?? dependencyService(stores),
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

  it("archive and delete answer 412 when the agent is edited during the dependency check", async () => {
    const editDuringCheck: DependenciesApplicationPort = {
      checkDependencies: async (query) => {
        await editAgent("agent_main");
        return dependencyService(stores).checkDependencies(query);
      },
    };
    const racing = agents(editDuringCheck);
    await expect(racing.archiveAgent({ agentId: "agent_main", expectedVersion: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("version 2") });
    await expect(stores.agents.findCurrent({ workspaceId: WORKSPACE, agentId: "agent_main" }))
      .resolves.toMatchObject({ archivedAt: null, version: 2 });

    await expect(racing.deleteAgent({ agentId: "agent_main", expectedVersion: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("version 3") });
    await expect(stores.agents.findCurrent({ workspaceId: WORKSPACE, agentId: "agent_main" }))
      .resolves.toMatchObject({ version: 3 });
    await expect(stores.agents.findVersion({ workspaceId: WORKSPACE, agentId: "agent_main", version: 1 }))
      .resolves.not.toBeNull();
  });

  it("unarchive answers 412 when the agent is restored, edited and archived again after the read", async () => {
    await stores.agents.archiveCurrent({ workspaceId: WORKSPACE, agentId: "agent_main", archivedAt: NOW.toISOString() });
    const store = stores.agents;
    let fired = false;
    const racingStore: AgentStore = Object.create(store);
    racingStore.findCurrent = async (input) => {
      const found = await store.findCurrent(input);
      if (!fired) {
        fired = true;
        await store.unarchiveCurrent({ workspaceId: WORKSPACE, agentId: "agent_main", updatedAt: NOW.toISOString() });
        await editAgent("agent_main");
        await store.archiveCurrent({ workspaceId: WORKSPACE, agentId: "agent_main", archivedAt: NOW.toISOString() });
      }
      return found;
    };
    const racing = new AgentsApplicationService({
      workspaceId: WORKSPACE,
      store: racingStore,
      clock,
      ids: { nextAgentId: () => "agent_new" },
      dependencyCheck: dependencyService(stores),
    });
    await expect(racing.unarchiveAgent({ agentId: "agent_main", expectedVersion: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("version 2") });
    await expect(stores.agents.findCurrent({ workspaceId: WORKSPACE, agentId: "agent_main" }))
      .resolves.toMatchObject({ archivedAt: NOW.toISOString(), version: 2 });
  });
});

/** Saves the next version of the agent, as a concurrent update would. */
async function editAgent(agentId: string): Promise<void> {
  const current = await stores.agents.findCurrent({ workspaceId: WORKSPACE, agentId });
  if (current === null) throw new Error(`Agent ${agentId} is missing`);
  const replaced = await stores.agents.replaceCurrent({
    workspaceId: WORKSPACE,
    agentId,
    expectedVersion: current.version,
    next: { ...current, name: `edit ${current.version + 1}`, version: current.version + 1 },
  });
  if (replaced.type !== "replaced") throw new Error(`Concurrent edit failed: ${replaced.type}`);
}

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

  it("archive and delete answer 412 when the environment is edited during the dependency check", async () => {
    const editDuringCheck: DependenciesApplicationPort = {
      checkDependencies: async (query) => {
        await editEnvironment("env_main");
        return dependencyService(stores).checkDependencies(query);
      },
    };
    const racing = environments(editDuringCheck);
    await expect(racing.archiveEnvironment({ environmentId: "env_main", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 2") });
    await expect(stores.environments.find({ workspaceId: WORKSPACE, environmentId: "env_main" }))
      .resolves.toMatchObject({ revision: 2, environment: { archivedAt: null } });

    await expect(racing.deleteEnvironment({ environmentId: "env_main", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 3") });
    await expect(stores.environments.find({ workspaceId: WORKSPACE, environmentId: "env_main" }))
      .resolves.toMatchObject({ revision: 3, environment: { archivedAt: null } });
  });
});

/** Saves the next revision of the environment, as a concurrent update would. */
async function editEnvironment(environmentId: string): Promise<void> {
  const current = await stores.environments.find({ workspaceId: WORKSPACE, environmentId });
  if (current === null) throw new Error(`Environment ${environmentId} is missing`);
  const replaced = await stores.environments.replace({
    workspaceId: WORKSPACE,
    environmentId,
    expectedRevision: current.revision,
    next: { ...current.environment, name: `edit ${current.revision + 1}` },
  });
  if (replaced.type !== "replaced") throw new Error(`Concurrent edit failed: ${replaced.type}`);
}

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

  it("delete stops the turn, deletes the rows and only then cleans up", async () => {
    await seed.session("sesn_run", { status: "running" });
    const stopped: string[] = [];
    await expect(sessions(stopped).deleteSession({ sessionId: "sesn_run", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    expect(stopped).toEqual([]);
    await expect(sessions(stopped).deleteSession({ sessionId: "sesn_run", expectedRevision: 1 }))
      .resolves.toEqual({ type: "deleted", sessionId: "sesn_run" });
    expect(stopped).toEqual(["sesn_run:deleted:live", "sesn_run:cleanup:gone"]);
  });

  it("archive and delete answer 412 when the session is edited during the stop", async () => {
    await seed.session("sesn_run", { status: "running" });
    const stopped: string[] = [];
    const racing = sessions(stopped, editSession);
    await expect(racing.archiveSession({ sessionId: "sesn_run", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 2") });
    await expect(stores.sessions.findCurrent({ workspaceId: WORKSPACE, sessionId: "sesn_run" }))
      .resolves.toMatchObject({ revision: 2, session: { archivedAt: null } });

    await expect(racing.deleteSession({ sessionId: "sesn_run", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 3") });
    await expect(stores.sessions.findCurrent({ workspaceId: WORKSPACE, sessionId: "sesn_run" }))
      .resolves.toMatchObject({ revision: 3, session: { archivedAt: null } });
    // The refused delete keeps the files: no cleanup after the stop.
    expect(stopped).toEqual(["sesn_run:archived:live", "sesn_run:deleted:live"]);
  });

  it("archive never cleans up", async () => {
    await seed.session("sesn_run", { status: "running" });
    const stopped: string[] = [];
    await sessions(stopped).archiveSession({ sessionId: "sesn_run" });
    expect(stopped).toEqual(["sesn_run:archived:live"]);
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

/** Saves the next revision of the session, as a concurrent update would. */
async function editSession(sessionId: string): Promise<void> {
  const current = await stores.sessions.findCurrent({ workspaceId: WORKSPACE, sessionId });
  if (current === null) throw new Error(`Session ${sessionId} is missing`);
  const replaced = await stores.sessions.replaceCurrent({
    workspaceId: WORKSPACE,
    sessionId,
    expectedRevision: current.revision,
    next: { ...current.session, title: `edit ${current.revision + 1}` },
  });
  if (replaced.type !== "replaced") throw new Error(`Concurrent edit failed: ${replaced.type}`);
}

// F4 of docs/plans/crud-fixes.md: the output files (scope_id of the session)
// go with the session, except a file another live session or deployment mounts.
describe("session output files", () => {
  const mount = (fileId: string) => ({
    id: `res_${fileId}`,
    type: "file" as const,
    createdAt: NOW.toISOString(),
    fileId,
    mountPath: `/mnt/${fileId}`,
    updatedAt: NOW.toISOString(),
  });

  it("delete removes the files of the session and keeps other files", async () => {
    await seed.session("sesn_out");
    await seed.file("file_out_1", "sesn_out");
    await seed.file("file_out_2", "sesn_out");
    await seed.file("file_other", "sesn_other");
    await seed.file("file_upload");
    const content: string[] = [];
    await expect(sessions([], undefined, files(content)).deleteSession({ sessionId: "sesn_out" }))
      .resolves.toEqual({ type: "deleted", sessionId: "sesn_out" });
    expect(await fileIdsOf()).toEqual(["file_other", "file_upload"]);
    expect(content.sort()).toEqual(["file_out_1", "file_out_2"]);
  });

  it("delete keeps a file that a live session or deployment mounts", async () => {
    await seed.session("sesn_out");
    for (const id of ["file_by_session", "file_by_deployment", "file_by_old_session", "file_free"]) {
      await seed.file(id, "sesn_out");
    }
    await seed.session("sesn_reader", { resources: [mount("file_by_session")] });
    await seed.session("sesn_old", { resources: [mount("file_by_old_session")], status: "terminated" });
    await seed.deployment("depl_reader", { resources: [{ kind: "file", fileId: "file_by_deployment" }] });
    const content: string[] = [];
    await expect(sessions([], undefined, files(content)).deleteSession({ sessionId: "sesn_out" }))
      .resolves.toEqual({ type: "deleted", sessionId: "sesn_out" });
    expect(await fileIdsOf("sesn_out")).toEqual(["file_by_deployment", "file_by_session"]);
    expect(content.sort()).toEqual(["file_by_old_session", "file_free"]);
  });

  it("delete goes through every page of 100 past the files it keeps", async () => {
    await seed.session("sesn_out");
    const ids = Array.from({ length: 150 }, (_, index) => `file_${String(index).padStart(3, "0")}`);
    for (const id of ids) await seed.file(id, "sesn_out");
    // The list runs from file_149 down: file_120 sits in the first page,
    // file_010 in the second.
    await seed.session("sesn_reader", { resources: [mount("file_120"), mount("file_010")] });
    const content: string[] = [];
    await expect(sessions([], undefined, files(content)).deleteSession({ sessionId: "sesn_out" }))
      .resolves.toEqual({ type: "deleted", sessionId: "sesn_out" });
    expect(await fileIdsOf("sesn_out")).toEqual(["file_010", "file_120"]);
    expect(content).toHaveLength(148);
  });

  it("a refused delete keeps the files", async () => {
    await seed.session("sesn_out", { status: "running" });
    await seed.file("file_out", "sesn_out");
    const content: string[] = [];
    await expect(sessions([], undefined, files(content)).deleteSession({ sessionId: "sesn_out", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(sessions([], editSession, files(content)).deleteSession({ sessionId: "sesn_out", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    expect(await fileIdsOf("sesn_out")).toEqual(["file_out"]);
    expect(content).toEqual([]);
  });

  it("a failed file delete stops the sweep, still cleans up and answers with the error", async () => {
    await seed.session("sesn_out");
    // The list runs newest first: file_b goes before file_a.
    await seed.file("file_a", "sesn_out");
    await seed.file("file_b", "sesn_out");
    const stopped: string[] = [];
    const content: string[] = [];
    await expect(sessions(stopped, undefined, files(content, "file_b")).deleteSession({ sessionId: "sesn_out" }))
      .rejects.toThrow("content of file_b is unreachable");
    expect(stopped).toEqual(["sesn_out:deleted:live", "sesn_out:cleanup:gone"]);
    expect(await fileIdsOf("sesn_out")).toEqual(["file_a"]);
    expect(content).toEqual([]);
  });
});

/** Ids of the files left, sorted; with a session id only its output files. */
async function fileIdsOf(scopeId?: string): Promise<string[]> {
  const left = await stores.files.list({
    workspaceId: WORKSPACE,
    limit: 1_000,
    ...(scopeId === undefined ? {} : { scopeId }),
  });
  return left.map((file) => file.id).sort();
}

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

  it("skill delete answers 412 when a version is added during the dependency check", async () => {
    const editDuringCheck: DependenciesApplicationPort = {
      checkDependencies: async (query) => {
        await editSkill("skill_a");
        return dependencyService(stores).checkDependencies(query);
      },
    };
    await expect(skills(editDuringCheck).deleteSkill({ skillId: "skill_a", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 3") });
    await expect(stores.skills.findSkill({ workspaceId: WORKSPACE, skillId: "skill_a" }))
      .resolves.toMatchObject({ revision: 3 });
    await expect(stores.skills.listVersions({ workspaceId: WORKSPACE, skillId: "skill_a", limit: 10 }))
      .resolves.toHaveLength(3);
  });
});

/** Adds the next version of the skill, as a concurrent upload would. */
async function editSkill(skillId: string): Promise<void> {
  const current = await stores.skills.findSkill({ workspaceId: WORKSPACE, skillId });
  if (current === null) throw new Error(`Skill ${skillId} is missing`);
  const value = `edit-${current.revision + 1}`;
  const appended = await stores.skills.appendVersion({
    workspaceId: WORKSPACE,
    skillId,
    expectedSkillRevision: current.revision,
    nextSkill: { ...current.skill, latestVersion: value, updatedAt: NOW.toISOString() },
    version: {
      id: `skillver_${skillId}_${value}`,
      createdAt: NOW.toISOString(),
      description: "skill",
      directory: skillId,
      name: skillId,
      skillId,
      version: value,
    },
    archive: { content: new Uint8Array([2]), filename: `${skillId}.zip`, mediaType: "application/zip" },
  });
  if (appended.type !== "appended") throw new Error(`Concurrent edit failed: ${appended.type}`);
}

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

  it("archive and delete answer 412 when the memory store is edited during the dependency check", async () => {
    const editDuringCheck: DependenciesApplicationPort = {
      checkDependencies: async (query) => {
        await editMemoryStore("memstore_a");
        return dependencyService(stores).checkDependencies(query);
      },
    };
    const racing = memoryStores({ dependencyCheck: editDuringCheck });
    await expect(racing.archiveMemoryStore({ memoryStoreId: "memstore_a", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 2") });
    await expect(stores.memoryStores.find({ workspaceId: WORKSPACE, memoryStoreId: "memstore_a" }))
      .resolves.toMatchObject({ revision: 2, memoryStore: { archivedAt: null } });

    await expect(racing.deleteMemoryStore({ memoryStoreId: "memstore_a", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 3") });
    await expect(stores.memoryStores.find({ workspaceId: WORKSPACE, memoryStoreId: "memstore_a" }))
      .resolves.toMatchObject({ revision: 3 });
    await expect(memoryIdsOf("memstore_a")).resolves.toEqual(["mem_1", "mem_2"]);
  });

  it("delete removes the store first and only then sweeps its memories", async () => {
    const swept: string[] = [];
    const memories: MemoryDocumentStore = Object.create(stores.memories);
    memories.deleteAllInStore = async (input) => {
      const parent = await stores.memoryStores.find(input);
      swept.push(`${input.memoryStoreId}:${parent === null ? "gone" : "live"}`);
      return stores.memories.deleteAllInStore(input);
    };
    await expect(memoryStores({ memories }).deleteMemoryStore({ memoryStoreId: "memstore_a", expectedRevision: 1 }))
      .resolves.toEqual({ type: "deleted", memoryStoreId: "memstore_a" });
    expect(swept).toEqual(["memstore_a:gone"]);
    await expect(memoryIdsOf("memstore_a")).resolves.toEqual([]);
  });

  it("a failed store delete keeps the memories", async () => {
    const store: MemoryStoreStore = Object.create(stores.memoryStores);
    store.delete = async () => {
      throw new Error("store delete failed");
    };
    await expect(memoryStores({ store }).deleteMemoryStore({ memoryStoreId: "memstore_a" }))
      .rejects.toThrow("store delete failed");
    await expect(stores.memoryStores.find({ workspaceId: WORKSPACE, memoryStoreId: "memstore_a" }))
      .resolves.not.toBeNull();
    await expect(memoryIdsOf("memstore_a")).resolves.toEqual(["mem_1", "mem_2"]);
  });
});

/** Saves the next revision of the memory store, as a concurrent update would. */
async function editMemoryStore(memoryStoreId: string): Promise<void> {
  const current = await stores.memoryStores.find({ workspaceId: WORKSPACE, memoryStoreId });
  if (current === null) throw new Error(`Memory store ${memoryStoreId} is missing`);
  const replaced = await stores.memoryStores.replace({
    workspaceId: WORKSPACE,
    memoryStoreId,
    expectedRevision: current.revision,
    next: { ...current.memoryStore, name: `edit ${current.revision + 1}` },
  });
  if (replaced.type !== "replaced") throw new Error(`Concurrent edit failed: ${replaced.type}`);
}

/** Ids of the current memories of one memory store, sorted. */
async function memoryIdsOf(memoryStoreId: string): Promise<string[]> {
  const page = await stores.memories.listCurrent({
    workspaceId: WORKSPACE, memoryStoreId, limit: 10, depth: 10, pathPrefix: "/",
  });
  return page.items
    .flatMap((item) => (item.kind === "memory" ? [item.record.memory.id] : []))
    .sort();
}

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

  it("archive and delete of a missing vault answer 404 before the dependency check", async () => {
    const checked: string[] = [];
    const spy: DependenciesApplicationPort = {
      checkDependencies: async (query) => {
        checked.push(`${query.operation}:${query.id}`);
        return dependencyService(stores).checkDependencies(query);
      },
    };
    await expect(vaults({ dependencyCheck: spy }).archiveVault({ vaultId: "vlt_missing" }))
      .resolves.toEqual({ type: "not_found" });
    await expect(vaults({ dependencyCheck: spy }).deleteVault({ vaultId: "vlt_missing", expectedRevision: 1 }))
      .resolves.toEqual({ type: "not_found" });
    expect(checked).toEqual([]);
  });

  it("archive, unarchive and delete check the revision and answer with it", async () => {
    await expect(vaults().archiveVault({ vaultId: "vlt_a", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 1, not 2") });
    await expect(vaults().archiveVault({ vaultId: "vlt_a", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "archived", revision: 2 });
    await expect(vaults().unarchiveVault({ vaultId: "vlt_a", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(vaults().unarchiveVault({ vaultId: "vlt_a", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "unarchived", revision: 3, vault: { archivedAt: null } });
    await expect(vaults().retrieveVault({ vaultId: "vlt_a" }))
      .resolves.toMatchObject({ type: "found", revision: 3 });
    await expect(vaults().deleteVault({ vaultId: "vlt_a", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed" });
    await expect(credentialIdsOf("vlt_a")).resolves.toEqual(["cred_1"]);
    await expect(vaults().deleteVault({ vaultId: "vlt_a", expectedRevision: 3 }))
      .resolves.toEqual({ type: "deleted", vaultId: "vlt_a" });
  });

  it("archive and delete answer 412 when the vault is edited during the dependency check", async () => {
    const editDuringCheck: DependenciesApplicationPort = {
      checkDependencies: async (query) => {
        await editVault("vlt_a");
        return dependencyService(stores).checkDependencies(query);
      },
    };
    const racing = vaults({ dependencyCheck: editDuringCheck });
    await expect(racing.archiveVault({ vaultId: "vlt_a", expectedRevision: 1 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 2") });
    await expect(stores.vaults.find({ workspaceId: WORKSPACE, vaultId: "vlt_a" }))
      .resolves.toMatchObject({ revision: 2, vault: { archivedAt: null } });

    await expect(racing.deleteVault({ vaultId: "vlt_a", expectedRevision: 2 }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 3") });
    await expect(stores.vaults.find({ workspaceId: WORKSPACE, vaultId: "vlt_a" }))
      .resolves.toMatchObject({ revision: 3 });
    await expect(credentialIdsOf("vlt_a")).resolves.toEqual(["cred_1"]);
  });

  it("unarchive answers 412 when the vault is edited after the read", async () => {
    await vaults().archiveVault({ vaultId: "vlt_a" });
    const store: VaultStore = Object.create(stores.vaults);
    store.replace = async (input) => {
      await editVault("vlt_a");
      return stores.vaults.replace(input);
    };
    await expect(vaults({ store }).unarchiveVault({ vaultId: "vlt_a" }))
      .resolves.toMatchObject({ type: "precondition_failed", message: expect.stringContaining("revision 3") });
  });

  it("delete removes the vault first and only then sweeps its credentials", async () => {
    const swept: string[] = [];
    const credentials: CredentialStore = Object.create(stores.credentials);
    credentials.deleteAllInVault = async (input) => {
      const parent = await stores.vaults.find(input);
      swept.push(`${input.vaultId}:${parent === null ? "gone" : "live"}`);
      return stores.credentials.deleteAllInVault(input);
    };
    await expect(vaults({ credentials }).deleteVault({ vaultId: "vlt_a", expectedRevision: 1 }))
      .resolves.toEqual({ type: "deleted", vaultId: "vlt_a" });
    expect(swept).toEqual(["vlt_a:gone"]);
    await expect(credentialIdsOf("vlt_a")).resolves.toEqual([]);
  });

  it("a failed vault delete keeps the credentials", async () => {
    const store: VaultStore = Object.create(stores.vaults);
    store.delete = async () => {
      throw new Error("vault delete failed");
    };
    await expect(vaults({ store }).deleteVault({ vaultId: "vlt_a" }))
      .rejects.toThrow("vault delete failed");
    await expect(stores.vaults.find({ workspaceId: WORKSPACE, vaultId: "vlt_a" }))
      .resolves.not.toBeNull();
    await expect(credentialIdsOf("vlt_a")).resolves.toEqual(["cred_1"]);
  });
});

/** Saves the next revision of the vault, as a concurrent update would. */
async function editVault(vaultId: string): Promise<void> {
  const current = await stores.vaults.find({ workspaceId: WORKSPACE, vaultId });
  if (current === null) throw new Error(`Vault ${vaultId} is missing`);
  const replaced = await stores.vaults.replace({
    workspaceId: WORKSPACE,
    vaultId,
    expectedRevision: current.revision,
    next: { ...current.vault, displayName: `edit ${current.revision + 1}` },
  });
  if (replaced.type !== "replaced") throw new Error(`Concurrent edit failed: ${replaced.type}`);
}

/** Ids of the credentials of one vault, archived ones too, sorted. */
async function credentialIdsOf(vaultId: string): Promise<string[]> {
  const records = await stores.credentials.list({
    workspaceId: WORKSPACE, vaultId, limit: 10, includeArchived: true,
  });
  return records.map((record) => record.credential.id).sort();
}
