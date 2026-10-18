import { describe, expect, it } from "vitest";
import type { EnvironmentRecord } from "@open-managed-agents/environment-store";
import { MemoryEnvironmentStore } from "../src/index";

function environment(id: string, createdAt: string): EnvironmentRecord {
  return {
    id,
    archivedAt: null,
    config: { type: "self_hosted" },
    createdAt,
    description: null,
    metadata: {},
    name: id,
    updatedAt: createdAt,
  };
}

describe("MemoryEnvironmentStore", () => {
  it("isolates identical IDs by workspace", async () => {
    const store = new MemoryEnvironmentStore();
    await store.insert({
      workspaceId: "workspace_a",
      environment: environment("env_01", "2026-01-01T00:00:00.000Z"),
    });
    await store.insert({
      workspaceId: "workspace_b",
      environment: environment("env_01", "2026-01-02T00:00:00.000Z"),
    });

    expect((await store.find({
      workspaceId: "workspace_a",
      environmentId: "env_01",
    }))?.environment.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect((await store.find({
      workspaceId: "workspace_b",
      environmentId: "env_01",
    }))?.environment.createdAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("uses revisions for replacement and preserves archive state", async () => {
    const store = new MemoryEnvironmentStore();
    const current = await store.insert({
      workspaceId: "workspace_a",
      environment: environment("env_01", "2026-01-01T00:00:00.000Z"),
    });
    expect(await store.replace({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      expectedRevision: 0,
      next: { ...current.environment, name: "stale" },
    })).toEqual({ type: "revision_conflict", actualRevision: 1 });

    const archived = await store.archive({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      archivedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(archived).toMatchObject({
      type: "archived",
      record: { revision: 2, environment: { archivedAt: "2026-01-03T00:00:00.000Z" } },
    });
  });

  it("archive and delete with a stale revision change nothing", async () => {
    const store = new MemoryEnvironmentStore();
    const inserted = await store.insert({
      workspaceId: "workspace_a",
      environment: environment("env_01", "2026-01-01T00:00:00.000Z"),
    });
    await store.replace({
      workspaceId: "workspace_a",
      environmentId: "env_01",
      expectedRevision: 1,
      next: { ...inserted.environment, name: "edited" },
    });
    const location = { workspaceId: "workspace_a", environmentId: "env_01" };

    expect(await store.archive({
      ...location,
      archivedAt: "2026-01-03T00:00:00.000Z",
      expectedRevision: 1,
    })).toEqual({ type: "revision_conflict", actualRevision: 2 });
    expect(await store.delete({ ...location, expectedRevision: 1 }))
      .toEqual({ type: "revision_conflict", actualRevision: 2 });
    expect(await store.find(location)).toMatchObject({
      revision: 2,
      environment: { name: "edited", archivedAt: null },
    });

    expect(await store.archive({
      ...location,
      archivedAt: "2026-01-03T00:00:00.000Z",
      expectedRevision: 2,
    })).toMatchObject({ type: "archived", record: { revision: 3 } });
    expect(await store.delete({ ...location, expectedRevision: 3 }))
      .toEqual({ type: "deleted" });
    expect(await store.delete({ ...location, expectedRevision: 3 }))
      .toEqual({ type: "not_found" });
  });

  it("orders, pages, filters archived records, and deletes", async () => {
    const store = new MemoryEnvironmentStore();
    for (const [id, createdAt] of [
      ["env_b", "2026-01-02T00:00:00.000Z"],
      ["env_a", "2026-01-01T00:00:00.000Z"],
      ["env_c", "2026-01-03T00:00:00.000Z"],
    ] as const) {
      await store.insert({
        workspaceId: "workspace_a",
        environment: environment(id, createdAt),
      });
    }
    await store.archive({
      workspaceId: "workspace_a",
      environmentId: "env_b",
      archivedAt: "2026-01-04T00:00:00.000Z",
    });

    expect((await store.list({
      workspaceId: "workspace_a",
      limit: 1,
      includeArchived: false,
      position: {
        createdAt: "2026-01-01T00:00:00.000Z",
        environmentId: "env_a",
      },
    })).map((record) => record.environment.id)).toEqual(["env_c"]);
    expect(await store.delete({
      workspaceId: "workspace_a",
      environmentId: "env_c",
    })).toEqual({ type: "deleted" });
  });
});
