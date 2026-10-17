// Table 1.3 of docs/plans/crud.md: what blocks archive and delete of each
// object and what the operation affects.
import { beforeEach, describe, expect, it } from "vitest";
import type { DependencyReport } from "../src/ports/dependencies";
import {
  createCrudStores,
  dependencyService,
  seeder,
  type CrudStores,
} from "./crud-world";

let stores: CrudStores;
let seed: ReturnType<typeof seeder>;

beforeEach(() => {
  stores = createCrudStores();
  seed = seeder(stores);
});

async function check(
  kind: Parameters<ReturnType<typeof dependencyService>["checkDependencies"]>[0]["kind"],
  id: string,
  operation: "archive" | "delete",
  version?: string,
): Promise<DependencyReport> {
  const result = await dependencyService(stores).checkDependencies({
    kind,
    id,
    operation,
    ...(version === undefined ? {} : { version }),
  });
  if (result.type !== "report") throw new Error(`expected a report, got ${result.type}`);
  return result.report;
}

function ids(entries: DependencyReport["blocking"]): string[] {
  return entries.map((entry) => `${entry.kind}:${entry.id}`);
}

describe("agent", () => {
  beforeEach(async () => {
    await seed.agent("agent_main");
    await seed.deployment("depl_active", { status: "active" });
    await seed.deployment("depl_paused", { status: "paused" });
    await seed.deployment("depl_archived", { archivedAt: "2026-10-02T00:00:00.000Z" });
    await seed.session("sesn_live", { status: "running" });
    await seed.session("sesn_done", { status: "terminated" });
    await seed.session("sesn_archived", { archivedAt: "2026-10-02T00:00:00.000Z" });
    await seed.deployment("depl_other", { agent: { id: "agent_other", version: 1 } });
  });

  it("archive is blocked by an active deployment and affects paused ones and live sessions", async () => {
    const report = await check("agent", "agent_main", "archive");
    expect(ids(report.blocking)).toEqual(["deployment:depl_active"]);
    expect(ids(report.affected)).toEqual(["deployment:depl_paused", "session:sesn_live"]);
    expect(report.blocking[0]).toMatchObject({
      name: "Deployment depl_active",
      status: "active",
      note: expect.any(String),
    });
    expect(report.truncated).toBe(false);
  });

  it("delete is blocked by live deployments and live sessions", async () => {
    const report = await check("agent", "agent_main", "delete");
    expect(ids(report.blocking)).toEqual([
      "deployment:depl_active",
      "deployment:depl_paused",
      "session:sesn_live",
    ]);
    expect(ids(report.affected)).toEqual([
      "deployment:depl_archived",
      "session:sesn_archived",
      "session:sesn_done",
    ]);
  });

  it("has no dependencies without references", async () => {
    await seed.agent("agent_free");
    await expect(check("agent", "agent_free", "delete")).resolves.toEqual({
      blocking: [],
      affected: [],
      truncated: false,
    });
  });

  it("answers not_found for a missing agent", async () => {
    await expect(dependencyService(stores).checkDependencies({
      kind: "agent", id: "agent_missing", operation: "archive",
    })).resolves.toEqual({ type: "not_found" });
  });
});

describe("environment", () => {
  beforeEach(async () => {
    await seed.environment("env_main");
    await seed.deployment("depl_active");
    await seed.deployment("depl_paused", { status: "paused" });
    await seed.deployment("depl_archived", { archivedAt: "2026-10-02T00:00:00.000Z" });
    await seed.session("sesn_live");
    await seed.session("sesn_done", { status: "terminated" });
    await seed.environmentWork("env_main", "work_open", "active");
    await seed.environmentWork("env_main", "work_closed", "stopped");
  });

  it("archive is blocked by an active deployment only", async () => {
    const report = await check("environment", "env_main", "archive");
    expect(ids(report.blocking)).toEqual(["deployment:depl_active"]);
    expect(ids(report.affected)).toEqual(["deployment:depl_paused", "session:sesn_live"]);
  });

  it("delete is blocked by live deployments, live sessions and open work", async () => {
    const report = await check("environment", "env_main", "delete");
    expect(ids(report.blocking)).toEqual([
      "deployment:depl_active",
      "deployment:depl_paused",
      "environment_work:work_open",
      "session:sesn_live",
    ]);
    expect(ids(report.affected)).toEqual(["deployment:depl_archived", "session:sesn_done"]);
  });
});

describe("session", () => {
  it("never blocks and lists the stopped turn, the deployment and output files", async () => {
    await seed.deployment("depl_main");
    await seed.session("sesn_run", { status: "running", deploymentId: "depl_main" });
    await seed.file("file_out", "sesn_run");
    const report = await check("session", "sesn_run", "delete");
    expect(report.blocking).toEqual([]);
    expect(ids(report.affected)).toEqual([
      "deployment:depl_main",
      "file:file_out",
      "session:sesn_run",
    ]);
    expect(report.affected.find((entry) => entry.kind === "session")?.note).toBe("ход остановится");
  });

  it("lists nothing for an idle session without outputs", async () => {
    await seed.session("sesn_idle");
    await expect(check("session", "sesn_idle", "archive")).resolves.toEqual({
      blocking: [], affected: [], truncated: false,
    });
  });
});

describe("deployment", () => {
  it("archive lists the run in progress", async () => {
    await seed.deployment("depl_main");
    await seed.session("sesn_run", { status: "running", deploymentId: "depl_main" });
    await seed.session("sesn_idle", { deploymentId: "depl_main" });
    const report = await check("deployment", "depl_main", "archive");
    expect(report.blocking).toEqual([]);
    expect(ids(report.affected)).toEqual(["session:sesn_run"]);
  });
});

describe("file", () => {
  it("delete is blocked by live deployments and sessions that mount the file", async () => {
    await seed.file("file_a");
    const resource = { id: "res_1", type: "file" as const, createdAt: "2026-10-01T00:00:00.000Z", fileId: "file_a", mountPath: "/mnt/a", updatedAt: "2026-10-01T00:00:00.000Z" };
    await seed.deployment("depl_file", { resources: [{ kind: "file", fileId: "file_a" }] });
    await seed.session("sesn_file", { resources: [resource] });
    await seed.session("sesn_old", { resources: [resource], status: "terminated" });
    const report = await check("file", "file_a", "delete");
    expect(ids(report.blocking)).toEqual(["deployment:depl_file", "session:sesn_file"]);
    expect(ids(report.affected)).toEqual(["session:sesn_old"]);
  });
});

describe("skill and skill version", () => {
  beforeEach(async () => {
    await seed.skill("skill_a", ["1", "2"]);
    await seed.agent("agent_pinned", { skills: [{ skillId: "skill_a", type: "custom", version: "1" }] });
    await seed.agent("agent_latest", { skills: [{ skillId: "skill_a", type: "custom", version: "latest" }] });
    await seed.agent("agent_archived", {
      skills: [{ skillId: "skill_a", type: "custom", version: "1" }],
      archivedAt: "2026-10-02T00:00:00.000Z",
    });
  });

  it("skill delete is blocked by agents out of the archive", async () => {
    const report = await check("skill", "skill_a", "delete");
    expect(ids(report.blocking)).toEqual(["agent:agent_latest", "agent:agent_pinned"]);
    expect(ids(report.affected)).toEqual(["agent:agent_archived"]);
  });

  it("version delete is blocked by pinned agents", async () => {
    const report = await check("skill_version", "skill_a", "delete", "1");
    expect(ids(report.blocking)).toEqual(["agent:agent_pinned"]);
    expect(report.affected).toEqual([]);
  });

  it("deleting the newest version affects agents on latest", async () => {
    const report = await check("skill_version", "skill_a", "delete", "2");
    expect(report.blocking).toEqual([]);
    expect(ids(report.affected)).toEqual(["agent:agent_latest"]);
  });

  it("the last version cannot go alone", async () => {
    await seed.skill("skill_single", ["1"]);
    const report = await check("skill_version", "skill_single", "delete", "1");
    expect(report.blocking).toEqual([expect.objectContaining({
      kind: "skill_version",
      id: "1",
      note: "Это последняя версия. Удалите навык целиком",
    })]);
  });

  it("asks for the version", async () => {
    await expect(dependencyService(stores).checkDependencies({
      kind: "skill_version", id: "skill_a", operation: "delete",
    })).resolves.toMatchObject({ type: "invalid_request" });
  });
});

describe("memory store", () => {
  beforeEach(async () => {
    await seed.memoryStore("memstore_a");
    const resources = [{ kind: "memory_store" as const, memoryStoreId: "memstore_a" }];
    await seed.deployment("depl_active", { resources });
    await seed.deployment("depl_paused", { resources, status: "paused" });
    await seed.session("sesn_live", {
      resources: [{ type: "memory_store", memoryStoreId: "memstore_a" }],
    });
    await seed.memory("memstore_a", "mem_1", "/notes.md");
  });

  it("archive is blocked by an active deployment", async () => {
    const report = await check("memory_store", "memstore_a", "archive");
    expect(ids(report.blocking)).toEqual(["deployment:depl_active"]);
    expect(ids(report.affected)).toEqual(["deployment:depl_paused", "session:sesn_live"]);
  });

  it("delete is blocked by live deployments and sessions and lists the memories", async () => {
    const report = await check("memory_store", "memstore_a", "delete");
    expect(ids(report.blocking)).toEqual([
      "deployment:depl_active",
      "deployment:depl_paused",
      "session:sesn_live",
    ]);
    expect(ids(report.affected)).toEqual(["memory:mem_1"]);
  });
});

describe("model and harness", () => {
  beforeEach(async () => {
    await seed.agent("agent_live", {
      model: { id: "card-model" },
      openma: { harness: "acp-sandbox", acp: { agent: { id: "my-harness", command: "run" } } },
    });
    await seed.agent("agent_old", {
      model: { id: "card-model" },
      archivedAt: "2026-10-02T00:00:00.000Z",
      openma: { harness: "acp-sandbox", acp: { agent: { id: "my-harness", command: "run" } } },
    });
  });

  it("model archive and delete are blocked by agents out of the archive", async () => {
    for (const operation of ["archive", "delete"] as const) {
      const report = await check("model", "card-model", operation);
      expect(ids(report.blocking)).toEqual(["agent:agent_live"]);
      expect(ids(report.affected)).toEqual(["agent:agent_old"]);
    }
  });

  it("harness archive looks at live agents, delete at every agent", async () => {
    expect(ids((await check("harness", "my-harness", "archive")).blocking)).toEqual(["agent:agent_live"]);
    expect(ids((await check("harness", "my-harness", "delete")).blocking)).toEqual([
      "agent:agent_live",
      "agent:agent_old",
    ]);
  });

  it("harness delete sees an old version of an agent", async () => {
    const current = await stores.agents.findCurrent({ workspaceId: "workspace_crud", agentId: "agent_live" });
    await stores.agents.replaceCurrent({
      workspaceId: "workspace_crud",
      agentId: "agent_live",
      expectedVersion: 1,
      next: { ...current!, openma: {}, version: 2 },
    });
    await stores.agents.deleteCurrent({ workspaceId: "workspace_crud", agentId: "agent_old" });
    expect(ids((await check("harness", "my-harness", "archive")).blocking)).toEqual([]);
    expect(ids((await check("harness", "my-harness", "delete")).blocking)).toEqual(["agent:agent_live"]);
  });
});

describe("vault", () => {
  beforeEach(async () => {
    await seed.vault("vlt_a");
    await seed.deployment("depl_active", { vaultIds: ["vlt_a"] });
    await seed.session("sesn_live", { vaultIds: ["vlt_a"] });
    await seed.credential("vlt_a", "cred_1");
  });

  it("archive is blocked by an active deployment", async () => {
    const report = await check("vault", "vlt_a", "archive");
    expect(ids(report.blocking)).toEqual(["deployment:depl_active"]);
    expect(ids(report.affected)).toEqual(["session:sesn_live"]);
  });

  it("delete is blocked by deployments and sessions and lists the credentials", async () => {
    const report = await check("vault", "vlt_a", "delete");
    expect(ids(report.blocking)).toEqual(["deployment:depl_active", "session:sesn_live"]);
    expect(ids(report.affected)).toEqual(["credential:cred_1"]);
  });
});

describe("limits", () => {
  it("keeps 50 rows per list and marks the cut", async () => {
    await seed.agent("agent_main");
    for (let index = 0; index < 55; index += 1) {
      await seed.session(`sesn_${String(index).padStart(2, "0")}`);
    }
    const report = await check("agent", "agent_main", "delete");
    expect(report.blocking).toHaveLength(50);
    expect(report.blocking[0]?.id).toBe("sesn_00");
    expect(report.truncated).toBe(true);
  });

  it("memories and session resources have no dependencies", async () => {
    await expect(check("memory", "mem_x", "delete")).resolves.toEqual({
      blocking: [], affected: [], truncated: false,
    });
    await expect(check("session_resource", "res_x", "delete")).resolves.toEqual({
      blocking: [], affected: [], truncated: false,
    });
  });
});
