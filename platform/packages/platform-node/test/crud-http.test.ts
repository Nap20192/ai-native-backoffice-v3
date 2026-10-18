// Table 1.3 of docs/plans/crud.md over HTTP: the Node platform wires the
// dependency check into every resource, so each archive and delete answers
// 409 dependency_conflict_error with the list while a blocking dependency
// exists and 200 once it is gone.
import { beforeEach, describe, expect, it } from "vitest";
import { providePort } from "@open-managed-agents/app";
import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";
import { dependenciesPort } from "@open-managed-agents/app/modules/dependencies";
import {
  deploymentAgentSourcePort,
  deploymentEnvironmentSourcePort,
  deploymentFileSourcePort,
  deploymentMemoryStoreSourcePort,
  deploymentSchedulePlannerPort,
  deploymentSessionLauncherPort,
  deploymentVaultSourcePort,
} from "@open-managed-agents/app/modules/deployments";
import {
  sessionAgentSourcePort,
  sessionEnvironmentSourcePort,
  sessionLifecyclePort,
  sessionResourceResolverPort,
} from "@open-managed-agents/app/modules/sessions";
import { skillPackageCompilerPort } from "@open-managed-agents/app/modules/skills";
import {
  buildAgentRoutes,
  buildDependencyRoutes,
  buildDeploymentRoutes,
  buildEnvironmentRoutes,
  buildFileRoutes,
  buildMemoryStoreRoutes,
  buildSessionRoutes,
  buildSkillRoutes,
  buildSkillVersionRoutes,
  buildVaultRoutes,
} from "../../managed-agents-api/src/index";
import {
  createCrudStores,
  seeder,
  WORKSPACE,
  type CrudStores,
} from "../../managed-agents-application/test/crud-world";
import { createNodePlatform } from "../src/index";

const BETAS = [
  "managed-agents-2026-04-01",
  "files-api-2025-04-14",
  "skills-2025-10-02",
  "agent-memory-2026-07-22",
].join(",");

let stores: CrudStores;
let seed: ReturnType<typeof seeder>;
let call: (route: string, method?: string, ifMatch?: string) => Promise<Response>;

function compose() {
  const platform = createNodePlatform({
    features: {
      preset: "none",
      agents: true,
      deployments: true,
      environments: true,
      files: true,
      memoryStores: true,
      sessions: true,
      skillVersions: true,
      skills: true,
      vaults: true,
    },
    stores: { ...stores },
    fileContent: {
      put: async () => undefined,
      get: async () => null,
      delete: async () => undefined,
    },
    modules: () => [
      providePort(deploymentAgentSourcePort, {
        find: async ({ workspaceId, selector }: { workspaceId: string; selector: { agentId: string } }) =>
          stores.agents.findCurrent({ workspaceId, agentId: selector.agentId }),
      } as never),
      providePort(deploymentEnvironmentSourcePort, {
        find: async (input: { workspaceId: string; environmentId: string }) =>
          (await stores.environments.find(input))?.environment ?? null,
      } as never),
      providePort(deploymentFileSourcePort, {} as never),
      providePort(deploymentMemoryStoreSourcePort, {} as never),
      providePort(deploymentSchedulePlannerPort, {} as never),
      providePort(deploymentSessionLauncherPort, {} as never),
      providePort(deploymentVaultSourcePort, {} as never),
      providePort(sessionAgentSourcePort, {} as never),
      providePort(sessionEnvironmentSourcePort, {} as never),
      providePort(sessionResourceResolverPort, {} as never),
      providePort(sessionLifecyclePort, {
        sessionStarted: async () => undefined,
        sessionStopped: async () => undefined,
        sessionDeleted: async () => undefined,
      }),
      providePort(skillPackageCompilerPort, {} as never),
    ],
  });
  const app = platform.app({ workspaceId: WORKSPACE });
  const tokens = managedAgentsPortTokens;
  const mounts: Array<[string, { request(path: string, init?: RequestInit): Response | Promise<Response> }]> = [
    ["/v1/oma/dependencies", buildDependencyRoutes(app.port(dependenciesPort))],
    ["/v1/agents", buildAgentRoutes(app.port(tokens.agents))],
    ["/v1/deployments", buildDeploymentRoutes(app.port(tokens.deployments))],
    ["/v1/environments", buildEnvironmentRoutes(app.port(tokens.environments))],
    ["/v1/files", buildFileRoutes(app.port(tokens.files))],
    ["/v1/memory_stores", buildMemoryStoreRoutes(app.port(tokens.memoryStores))],
    ["/v1/sessions", buildSessionRoutes(app.port(tokens.sessions))],
    ["/v1/skills/versions", buildSkillVersionRoutes(app.port(tokens.skillVersions))],
    ["/v1/skills", buildSkillRoutes(app.port(tokens.skills))],
    ["/v1/vaults", buildVaultRoutes(app.port(tokens.vaults))],
  ];
  return async (route: string, method = "POST", ifMatch?: string) => {
    const versions = /^\/v1\/skills\/([^/]+)\/versions\/(.+)$/u.exec(route);
    const [prefix, routes] = versions !== null
      ? mounts.find(([candidate]) => candidate === "/v1/skills/versions")!
      : mounts.find(([candidate]) => route.startsWith(candidate))!;
    const path = versions !== null
      ? `/${versions[1]}/versions/${versions[2]}`
      : route.slice(prefix.length) || "/";
    return routes.request(path, {
      method,
      headers: {
        "anthropic-beta": BETAS,
        ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
      },
    });
  };
}

beforeEach(async () => {
  stores = createCrudStores();
  seed = seeder(stores);
  call = compose();
  await seed.agent("agent_main");
  await seed.environment("env_main");
});

async function expectBlocked(response: Response, ids: string[]): Promise<void> {
  expect(response.status).toBe(409);
  const body = await response.json() as {
    error: { type: string; dependencies: { blocking: Array<{ id: string }> } };
  };
  expect(body.error.type).toBe("dependency_conflict_error");
  expect(body.error.dependencies.blocking.map((entry) => entry.id)).toEqual(ids);
}

async function pause(deploymentId: string): Promise<void> {
  const found = (await stores.deployments.find({ workspaceId: WORKSPACE, deploymentId }))!;
  await stores.deployments.replace({
    workspaceId: WORKSPACE,
    deploymentId,
    expectedRevision: found.revision,
    next: { deployment: { ...found.deployment, status: "paused" }, resourceSecrets: [] },
  });
}

async function archiveDeployment(deploymentId: string): Promise<void> {
  expect((await call(`/v1/deployments/${deploymentId}/archive`)).status).toBe(200);
}

describe("agent", () => {
  it("archive: 409 while a deployment is active, 200 once it is paused", async () => {
    await seed.deployment("depl_active");
    await expectBlocked(await call("/v1/agents/agent_main/archive"), ["depl_active"]);
    await pause("depl_active");
    const archived = await call("/v1/agents/agent_main/archive");
    expect(archived.status).toBe(200);
    expect(archived.headers.get("etag")).toBe('"1"');
  });

  it("delete: 409 while a session lives; the archived session still reads after the delete", async () => {
    await seed.session("sesn_live", { status: "running" });
    await expectBlocked(await call("/v1/agents/agent_main", "DELETE"), ["sesn_live"]);
    expect((await call("/v1/sessions/sesn_live/archive")).status).toBe(200);
    const deleted = await call("/v1/agents/agent_main", "DELETE");
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ id: "agent_main", type: "agent_deleted" });
    expect((await call("/v1/agents/agent_main", "GET")).status).toBe(404);
    const session = await call("/v1/sessions/sesn_live", "GET");
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({ agent: { id: "agent_main" } });
  });

  it("unarchive of an agent out of the archive answers 200 and writes nothing", async () => {
    const response = await call("/v1/agents/agent_main/unarchive");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ archived_at: null, version: 1 });
  });
});

describe("environment", () => {
  it("archive: 409 while a deployment is active, 412 on a stale If-Match", async () => {
    await seed.deployment("depl_active");
    await expectBlocked(await call("/v1/environments/env_main/archive"), ["depl_active"]);
    await pause("depl_active");
    expect((await call("/v1/environments/env_main/archive", "POST", '"7"')).status).toBe(412);
    expect((await call("/v1/environments/env_main/archive", "POST", '"1"')).status).toBe(200);
    const restored = await call("/v1/environments/env_main/unarchive", "POST", '"2"');
    expect(restored.status).toBe(200);
    expect(restored.headers.get("etag")).toBe('"3"');
  });

  it("delete: 409 while work is open, 200 once it stops", async () => {
    await seed.environmentWork("env_main", "work_open", "active");
    await expectBlocked(await call("/v1/environments/env_main", "DELETE"), ["work_open"]);
    const work = (await stores.environmentWork.find({
      workspaceId: WORKSPACE, environmentId: "env_main", workId: "work_open",
    }))!;
    await stores.environmentWork.replace({
      workspaceId: WORKSPACE,
      environmentId: "env_main",
      workId: "work_open",
      expectedRevision: work.revision,
      next: { ...work, work: { ...work.work, state: "stopped" } },
    });
    expect((await call("/v1/environments/env_main", "DELETE")).status).toBe(200);
  });
});

describe("session", () => {
  it("archive and delete never block; the report names the stopped turn", async () => {
    await seed.session("sesn_run", { status: "running" });
    const report = await call("/v1/oma/dependencies/session/sesn_run?operation=delete", "GET");
    expect(report.status).toBe(200);
    await expect(report.json()).resolves.toMatchObject({
      blocking: [],
      affected: [{ kind: "session", id: "sesn_run", note: "ход остановится" }],
    });
    expect((await call("/v1/sessions/sesn_run/archive", "POST", '"1"')).status).toBe(200);
    expect((await call("/v1/sessions/sesn_run/unarchive", "POST", '"2"')).status).toBe(200);
    expect((await call("/v1/sessions/sesn_run", "DELETE", '"2"')).status).toBe(412);
    expect((await call("/v1/sessions/sesn_run", "DELETE", '"3"')).status).toBe(200);
  });
});

describe("deployment", () => {
  it("archive never blocks and unarchive brings it back paused", async () => {
    await seed.deployment("depl_main");
    await archiveDeployment("depl_main");
    const restored = await call("/v1/deployments/depl_main/unarchive");
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ status: "paused", archived_at: null });
  });
});

describe("file", () => {
  it("delete: 409 while a deployment mounts the file", async () => {
    await seed.file("file_a");
    await seed.deployment("depl_file", { resources: [{ kind: "file", fileId: "file_a" }] });
    await expectBlocked(await call("/v1/files/file_a", "DELETE"), ["depl_file"]);
    await archiveDeployment("depl_file");
    expect((await call("/v1/files/file_a", "DELETE")).status).toBe(200);
  });
});

describe("skill and skill version", () => {
  beforeEach(async () => {
    await seed.skill("skill_a", ["1", "2"]);
  });

  it("skill delete: 409 while an agent out of the archive uses it", async () => {
    await seed.agent("agent_skill", { skills: [{ skillId: "skill_a", type: "custom", version: "1" }] });
    await expectBlocked(await call("/v1/skills/skill_a", "DELETE"), ["agent_skill"]);
    expect((await call("/v1/agents/agent_skill/archive")).status).toBe(200);
    expect((await call("/v1/skills/skill_a", "DELETE")).status).toBe(200);
  });

  it("version delete: 409 for a pinned agent and for the last version", async () => {
    await seed.agent("agent_pinned", { skills: [{ skillId: "skill_a", type: "custom", version: "1" }] });
    await expectBlocked(await call("/v1/skills/skill_a/versions/1", "DELETE"), ["agent_pinned"]);
    expect((await call("/v1/skills/skill_a/versions/2", "DELETE")).status).toBe(200);
    expect((await call("/v1/agents/agent_pinned/archive")).status).toBe(200);
    await expectBlocked(await call("/v1/skills/skill_a/versions/1", "DELETE"), ["1"]);
  });
});

describe("memory store", () => {
  beforeEach(async () => {
    await seed.memoryStore("memstore_a");
    await seed.memory("memstore_a", "mem_1", "/notes.md");
    await seed.memory("memstore_a", "mem_2", "/deep/notes.md");
  });

  it("archive: 409 while a deployment is active", async () => {
    await seed.deployment("depl_mem", { resources: [{ kind: "memory_store", memoryStoreId: "memstore_a" }] });
    await expectBlocked(await call("/v1/memory_stores/memstore_a/archive"), ["depl_mem"]);
    await pause("depl_mem");
    expect((await call("/v1/memory_stores/memstore_a/archive")).status).toBe(200);
    expect((await call("/v1/memory_stores/memstore_a/unarchive")).status).toBe(200);
  });

  it("delete: 409 while a session mounts it, then no orphan memories", async () => {
    await seed.session("sesn_mem", { resources: [{ type: "memory_store", memoryStoreId: "memstore_a" }] });
    await expectBlocked(await call("/v1/memory_stores/memstore_a", "DELETE"), ["sesn_mem"]);
    expect((await call("/v1/sessions/sesn_mem/archive")).status).toBe(200);
    expect((await call("/v1/memory_stores/memstore_a", "DELETE")).status).toBe(200);
    const page = await stores.memories.listCurrent({
      workspaceId: WORKSPACE, memoryStoreId: "memstore_a", limit: 10, depth: 10, pathPrefix: "/",
    });
    expect(page.items).toEqual([]);
    await expect(stores.memories.listVersions({ workspaceId: WORKSPACE, memoryStoreId: "memstore_a", limit: 10 }))
      .resolves.toEqual([]);
  });
});

describe("memory and session resource", () => {
  it("have no dependencies", async () => {
    for (const kind of ["memory", "session_resource"]) {
      const response = await call(`/v1/oma/dependencies/${kind}/x_1?operation=delete`, "GET");
      await expect(response.json()).resolves.toEqual({ blocking: [], affected: [], truncated: false });
    }
  });
});

describe("vault", () => {
  it("archive and delete: 409 while a deployment is active, delete takes the credentials", async () => {
    await seed.vault("vlt_a");
    await seed.credential("vlt_a", "cred_1");
    await seed.deployment("depl_vault", { vaultIds: ["vlt_a"] });
    await expectBlocked(await call("/v1/vaults/vlt_a/archive"), ["depl_vault"]);
    await expectBlocked(await call("/v1/vaults/vlt_a", "DELETE"), ["depl_vault"]);
    await archiveDeployment("depl_vault");
    expect((await call("/v1/vaults/vlt_a/archive")).status).toBe(200);
    expect((await call("/v1/vaults/vlt_a/unarchive")).status).toBe(200);
    expect((await call("/v1/vaults/vlt_a", "DELETE")).status).toBe(200);
    await expect(stores.credentials.list({ workspaceId: WORKSPACE, vaultId: "vlt_a", limit: 10, includeArchived: true }))
      .resolves.toEqual([]);
  });

  it("reads and writes carry ETag; archive, unarchive and delete answer 412 on a stale If-Match", async () => {
    await seed.vault("vlt_a");
    await seed.credential("vlt_a", "cred_1");
    const read = await call("/v1/vaults/vlt_a", "GET");
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe('"1"');
    expect((await call("/v1/vaults/vlt_a/archive", "POST", 'W/"1"')).status).toBe(400);
    expect((await call("/v1/vaults/vlt_a/archive", "POST", '"7"')).status).toBe(412);
    const archived = await call("/v1/vaults/vlt_a/archive", "POST", '"1"');
    expect(archived.status).toBe(200);
    expect(archived.headers.get("etag")).toBe('"2"');
    expect((await call("/v1/vaults/vlt_a/unarchive", "POST", '"1"')).status).toBe(412);
    const restored = await call("/v1/vaults/vlt_a/unarchive", "POST", '"2"');
    expect(restored.status).toBe(200);
    expect(restored.headers.get("etag")).toBe('"3"');

    const stale = await call("/v1/vaults/vlt_a", "DELETE", '"2"');
    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toMatchObject({ error: { type: "precondition_failed_error" } });
    await expect(stores.credentials.list({ workspaceId: WORKSPACE, vaultId: "vlt_a", limit: 10, includeArchived: true }))
      .resolves.toHaveLength(1);
    expect((await call("/v1/vaults/vlt_a", "DELETE", '"3"')).status).toBe(200);
    expect((await call("/v1/vaults/vlt_a", "DELETE", '"3"')).status).toBe(404);
    expect((await call("/v1/vaults/vlt_a/archive", "POST")).status).toBe(404);
  });
});
