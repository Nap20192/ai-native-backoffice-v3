// Archive, restore and delete on the v1 routes (docs/plans/crud.md, 1.1,
// 1.2, 1.4): If-Match reaches the application, 412 and 409 come back with
// the right envelope, and restore answers like archive.
import { describe, expect, it } from "vitest";
import { deploymentView, makeDeploymentsPort } from "./deployment-fixtures";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { agentView, makeAgentsPort } from "./fixtures";
import { makeFilesPort } from "./file-fixtures";
import { makeMemoryStoresPort, memoryStoreView } from "./memory-fixtures";
import { makeSessionsPort, sessionView } from "./session-fixtures";
import { makeSkillVersionsPort, makeSkillsPort } from "./skill-fixtures";
import { makeVaultsPort } from "./vault-fixtures";
import {
  buildAgentsTestApi,
  buildDeploymentsTestApi,
  buildEnvironmentsTestApi,
  buildFilesTestApi,
  buildMemoryTestApi,
  buildSessionsTestApi,
  buildSkillsTestApi,
  buildVaultsTestApi,
} from "./test-api";

const BETAS =
  "managed-agents-2026-04-01,files-api-2025-04-14,skills-2025-10-02,agent-memory-2026-07-22";

const dependencies = {
  blocking: [{
    kind: "deployment" as const,
    id: "depl_01",
    name: "Утренний отчёт",
    status: "active",
    note: "запуски упадут",
  }],
  affected: [],
  truncated: false,
};
const blocked = {
  type: "dependency_conflict" as const,
  message: "Cannot archive: remove the blocking dependencies first",
  dependencies,
};

const environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" as const },
  createdAt: "2026-08-26T08:10:00.000Z",
  description: null,
  metadata: {},
  name: "base",
  updatedAt: "2026-08-26T08:10:00.000Z",
};

const vault = {
  id: "vlt_01",
  archivedAt: null,
  createdAt: "2026-08-26T08:10:00.000Z",
  displayName: "Secrets",
  metadata: {},
  updatedAt: "2026-08-26T08:10:00.000Z",
};

function request(path: string, method = "POST", ifMatch?: string): Request {
  return new Request(`http://openma.test${path}`, {
    method,
    headers: {
      "anthropic-beta": BETAS,
      ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
    },
  });
}

async function expectDependencyConflict(response: Response): Promise<void> {
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    type: "error",
    error: {
      type: "dependency_conflict_error",
      message: blocked.message,
      dependencies,
    },
  });
}

describe("agents", () => {
  it("GET carries the current version as ETag", async () => {
    const api = buildAgentsTestApi(makeAgentsPort({
      retrieveAgent: async () => ({ type: "found", agent: { ...agentView, version: 3 } }),
    }));
    const response = await api.fetch(request("/v1/agents/agent_01", "GET"));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"3"');
  });

  it("archive passes If-Match and maps 412 and 409", async () => {
    const commands: unknown[] = [];
    const answers = [
      { type: "precondition_failed" as const, message: "Agent agent_01 is at version 4, not 3" },
      blocked,
      { type: "archived" as const, agent: { ...agentView, version: 3 } },
    ];
    const api = buildAgentsTestApi(makeAgentsPort({
      archiveAgent: async (command) => {
        commands.push(command);
        return answers.shift()!;
      },
    }));
    const stale = await api.fetch(request("/v1/agents/agent_01/archive", "POST", '"3"'));
    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toMatchObject({ error: { type: "precondition_failed_error" } });
    await expectDependencyConflict(await api.fetch(request("/v1/agents/agent_01/archive")));
    const archived = await api.fetch(request("/v1/agents/agent_01/archive"));
    expect(archived.status).toBe(200);
    expect(archived.headers.get("etag")).toBe('"3"');
    expect(commands).toEqual([
      { agentId: "agent_01", expectedVersion: 3 },
      { agentId: "agent_01" },
      { agentId: "agent_01" },
    ]);
  });

  it("rejects an If-Match that is not one version", async () => {
    const api = buildAgentsTestApi(makeAgentsPort({}));
    const response = await api.fetch(request("/v1/agents/agent_01/archive", "POST", 'W/"3"'));
    expect(response.status).toBe(400);
  });

  it("unarchive answers with the agent", async () => {
    const api = buildAgentsTestApi(makeAgentsPort({
      unarchiveAgent: async (command) => {
        expect(command).toEqual({ agentId: "agent_01", expectedVersion: 2 });
        return { type: "unarchived", agent: { ...agentView, version: 2 } };
      },
    }));
    const response = await api.fetch(request("/v1/agents/agent_01/unarchive", "POST", '"2"'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: agentView.id, archived_at: null });
  });

  it("DELETE removes the agent or names the blocking dependencies", async () => {
    const answers = [
      blocked,
      { type: "precondition_failed" as const, message: "stale" },
      { type: "not_found" as const },
      { type: "deleted" as const, agentId: "agent_01" },
    ];
    const api = buildAgentsTestApi(makeAgentsPort({ deleteAgent: async () => answers.shift()! }));
    await expectDependencyConflict(await api.fetch(request("/v1/agents/agent_01", "DELETE")));
    expect((await api.fetch(request("/v1/agents/agent_01", "DELETE", '"1"'))).status).toBe(412);
    expect((await api.fetch(request("/v1/agents/agent_01", "DELETE"))).status).toBe(404);
    const deleted = await api.fetch(request("/v1/agents/agent_01", "DELETE"));
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ id: "agent_01", type: "agent_deleted" });
  });
});

describe("environments", () => {
  it("archive, unarchive and delete pass If-Match and map the answers", async () => {
    const commands: unknown[] = [];
    const api = buildEnvironmentsTestApi(makeEnvironmentsPort({
      archiveEnvironment: async (command) => {
        commands.push(command);
        return command.expectedRevision === 1 ? blocked : { type: "archived", environment, revision: 3 };
      },
      unarchiveEnvironment: async (command) => {
        commands.push(command);
        return command.expectedRevision === 9
          ? { type: "precondition_failed", message: "stale" }
          : { type: "unarchived", environment, revision: 4 };
      },
      deleteEnvironment: async (command) => {
        commands.push(command);
        return { type: "deleted", environmentId: command.environmentId };
      },
    }));
    await expectDependencyConflict(await api.fetch(request("/v1/environments/env_01/archive", "POST", '"1"')));
    const archived = await api.fetch(request("/v1/environments/env_01/archive", "POST", '"2"'));
    expect(archived.headers.get("etag")).toBe('"3"');
    expect((await api.fetch(request("/v1/environments/env_01/unarchive", "POST", '"9"'))).status).toBe(412);
    const restored = await api.fetch(request("/v1/environments/env_01/unarchive"));
    expect(restored.status).toBe(200);
    expect(restored.headers.get("etag")).toBe('"4"');
    expect((await api.fetch(request("/v1/environments/env_01", "DELETE", '"4"'))).status).toBe(200);
    expect(commands).toEqual([
      { environmentId: "env_01", expectedRevision: 1 },
      { environmentId: "env_01", expectedRevision: 2 },
      { environmentId: "env_01", expectedRevision: 9 },
      { environmentId: "env_01" },
      { environmentId: "env_01", expectedRevision: 4 },
    ]);
  });

  it("delete maps 409 and 412", async () => {
    const answers = [blocked, { type: "precondition_failed" as const, message: "stale" }];
    const api = buildEnvironmentsTestApi(makeEnvironmentsPort({
      deleteEnvironment: async () => answers.shift()!,
    }));
    await expectDependencyConflict(await api.fetch(request("/v1/environments/env_01", "DELETE")));
    expect((await api.fetch(request("/v1/environments/env_01", "DELETE", '"1"'))).status).toBe(412);
  });
});

describe("sessions", () => {
  it("archive, unarchive and delete read If-Match", async () => {
    const commands: unknown[] = [];
    const api = buildSessionsTestApi(makeSessionsPort({
      archiveSession: async (command) => {
        commands.push(command);
        return { type: "precondition_failed", message: "stale" };
      },
      unarchiveSession: async (command) => {
        commands.push(command);
        return { type: "unarchived", session: sessionView, revision: 6 };
      },
      deleteSession: async (command) => {
        commands.push(command);
        return { type: "deleted", sessionId: command.sessionId };
      },
    }));
    expect((await api.fetch(request("/v1/sessions/sesn_01/archive", "POST", '"4"'))).status).toBe(412);
    const restored = await api.fetch(request("/v1/sessions/sesn_01/unarchive", "POST", '"5"'));
    expect(restored.status).toBe(200);
    expect(restored.headers.get("etag")).toBe('"6"');
    expect((await api.fetch(request("/v1/sessions/sesn_01", "DELETE", '"6"'))).status).toBe(200);
    expect(commands).toEqual([
      { sessionId: "sesn_01", expectedRevision: 4 },
      { sessionId: "sesn_01", expectedRevision: 5 },
      { sessionId: "sesn_01", expectedRevision: 6 },
    ]);
  });
});

describe("deployments", () => {
  it("unarchive, pause and unpause pass If-Match", async () => {
    const commands: unknown[] = [];
    const api = buildDeploymentsTestApi({
      deployments: makeDeploymentsPort({
        unarchiveDeployment: async (command) => {
          commands.push(command);
          return { type: "changed", deployment: { ...deploymentView, status: "paused" }, revision: 5 };
        },
        pauseDeployment: async (command) => {
          commands.push(command);
          return { type: "precondition_failed", message: "stale" };
        },
        unpauseDeployment: async (command) => {
          commands.push(command);
          return { type: "conflict", message: "Deployment depl_01 is not ready: agent_archived_error" };
        },
      }),
    });
    const restored = await api.fetch(request("/v1/deployments/depl_01/unarchive", "POST", '"4"'));
    expect(restored.status).toBe(200);
    expect(restored.headers.get("etag")).toBe('"5"');
    await expect(restored.json()).resolves.toMatchObject({ status: "paused" });
    expect((await api.fetch(request("/v1/deployments/depl_01/pause", "POST", '"2"'))).status).toBe(412);
    expect((await api.fetch(request("/v1/deployments/depl_01/unpause", "POST", '"3"'))).status).toBe(409);
    expect(commands).toEqual([
      { deploymentId: "depl_01", expectedRevision: 4 },
      { deploymentId: "depl_01", expectedRevision: 2 },
      { deploymentId: "depl_01", expectedRevision: 3 },
    ]);
  });
});

describe("files, skills and skill versions", () => {
  it("file delete maps a dependency conflict", async () => {
    const api = buildFilesTestApi(makeFilesPort({ deleteFile: async () => blocked }));
    await expectDependencyConflict(await api.fetch(request("/v1/files/file_01", "DELETE")));
  });

  it("skill delete passes If-Match and maps 412 and 409", async () => {
    const commands: unknown[] = [];
    const answers = [{ type: "precondition_failed" as const, message: "stale" }, blocked];
    const api = buildSkillsTestApi(
      makeSkillsPort({
        deleteSkill: async (command) => {
          commands.push(command);
          return answers.shift()!;
        },
      }),
      makeSkillVersionsPort({}),
    );
    expect((await api.fetch(request("/v1/skills/skill_01", "DELETE", '"2"'))).status).toBe(412);
    await expectDependencyConflict(await api.fetch(request("/v1/skills/skill_01", "DELETE")));
    expect(commands).toEqual([
      { skillId: "skill_01", expectedRevision: 2 },
      { skillId: "skill_01" },
    ]);
  });

  it("skill version delete passes the skill revision and answers with the new one", async () => {
    const commands: unknown[] = [];
    const answers = [blocked, { type: "deleted" as const, version: "2", skillRevision: 4 }];
    const api = buildSkillsTestApi(
      makeSkillsPort({}),
      makeSkillVersionsPort({
        deleteSkillVersion: async (command) => {
          commands.push(command);
          return answers.shift()!;
        },
      }),
    );
    await expectDependencyConflict(await api.fetch(request("/v1/skills/skill_01/versions/1", "DELETE")));
    const deleted = await api.fetch(request("/v1/skills/skill_01/versions/2", "DELETE", '"3"'));
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("etag")).toBe('"4"');
    expect(commands).toEqual([
      { skillId: "skill_01", version: "1" },
      { skillId: "skill_01", version: "2", expectedRevision: 3 },
    ]);
  });
});

describe("memory stores and vaults", () => {
  it("memory store archive, unarchive and delete", async () => {
    const commands: unknown[] = [];
    const api = buildMemoryTestApi({
      memoryStores: makeMemoryStoresPort({
        archiveMemoryStore: async (command) => {
          commands.push(command);
          return blocked;
        },
        unarchiveMemoryStore: async (command) => {
          commands.push(command);
          return { type: "unarchived", memoryStore: memoryStoreView, revision: 3 };
        },
        deleteMemoryStore: async (command) => {
          commands.push(command);
          return { type: "precondition_failed", message: "stale" };
        },
      }),
    });
    await expectDependencyConflict(await api.fetch(request("/v1/memory_stores/memstore_01/archive", "POST", '"1"')));
    const restored = await api.fetch(request("/v1/memory_stores/memstore_01/unarchive"));
    expect(restored.headers.get("etag")).toBe('"3"');
    expect((await api.fetch(request("/v1/memory_stores/memstore_01", "DELETE", '"2"'))).status).toBe(412);
    expect(commands).toEqual([
      { memoryStoreId: "memstore_01", expectedRevision: 1 },
      { memoryStoreId: "memstore_01" },
      { memoryStoreId: "memstore_01", expectedRevision: 2 },
    ]);
  });

  it("vault unarchive, archive and delete", async () => {
    const api = buildVaultsTestApi(makeVaultsPort({
      unarchiveVault: async () => ({ type: "unarchived", vault }),
      archiveVault: async () => blocked,
      deleteVault: async () => blocked,
    }));
    const restored = await api.fetch(request("/v1/vaults/vlt_01/unarchive"));
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ id: "vlt_01", archived_at: null });
    await expectDependencyConflict(await api.fetch(request("/v1/vaults/vlt_01/archive")));
    await expectDependencyConflict(await api.fetch(request("/v1/vaults/vlt_01", "DELETE")));
  });

  it("vault archive, unarchive and delete pass If-Match, map 412 and carry ETag", async () => {
    const commands: unknown[] = [];
    const api = buildVaultsTestApi(makeVaultsPort({
      archiveVault: async (command) => {
        commands.push(command);
        return { type: "archived", vault, revision: 2 };
      },
      unarchiveVault: async (command) => {
        commands.push(command);
        return { type: "precondition_failed", message: "stale" };
      },
      deleteVault: async (command) => {
        commands.push(command);
        return { type: "precondition_failed", message: "stale" };
      },
    }));
    const archived = await api.fetch(request("/v1/vaults/vlt_01/archive", "POST", '"1"'));
    expect(archived.status).toBe(200);
    expect(archived.headers.get("etag")).toBe('"2"');
    expect((await api.fetch(request("/v1/vaults/vlt_01/unarchive", "POST", '"3"'))).status).toBe(412);
    const stale = await api.fetch(request("/v1/vaults/vlt_01", "DELETE", '"2"'));
    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toEqual({
      type: "error",
      error: { type: "precondition_failed_error", message: "stale" },
    });
    expect((await api.fetch(request("/v1/vaults/vlt_01", "DELETE", "W/\"2\""))).status).toBe(400);
    expect(commands).toEqual([
      { vaultId: "vlt_01", expectedRevision: 1 },
      { vaultId: "vlt_01", expectedRevision: 3 },
      { vaultId: "vlt_01", expectedRevision: 2 },
    ]);
  });
});
