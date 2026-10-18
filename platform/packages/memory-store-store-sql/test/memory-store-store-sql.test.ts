import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStore } from "@open-managed-agents/domain/memory-stores";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlMemoryStoreStore } from "../src/index";

const SCHEMA = `
CREATE TABLE managed_memory_stores (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_memory_stores_workspace_created_id
  ON managed_memory_stores (workspace_id, created_at, id);
CREATE TABLE managed_memories (
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  path text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_memory_versions (
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  id text NOT NULL,
  memory_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  operation text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  created_at integer NOT NULL,
  redacted_at integer,
  PRIMARY KEY (workspace_id, id)
);
`;

const memoryStore = {
  id: "memstore_01",
  archivedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  description: "Durable project decisions",
  metadata: { owner: "workspace_01" },
  name: "Project memory",
  updatedAt: "2026-08-26T09:00:00.000Z",
} satisfies MemoryStore;

const W = "workspace_01";

/** Inserts one memory and its first version straight into the tables. */
async function insertMemory(
  client: SqlClient,
  memoryStoreId: string,
  memoryId: string,
): Promise<void> {
  await client.batch([
    client.prepare(
      `INSERT INTO managed_memories
        (workspace_id, memory_store_id, id, document, revision, path, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 1, ?, 0, 0)`,
    ).bind(W, memoryStoreId, memoryId, `/${memoryId}.md`),
    client.prepare(
      `INSERT INTO managed_memory_versions
        (workspace_id, memory_store_id, id, memory_id, document, revision,
         operation, actor_kind, actor_id, created_at)
       VALUES (?, ?, ?, ?, '{}', 1, 'created', 'api', 'key', 0)`,
    ).bind(W, memoryStoreId, `${memoryId}_v1`, memoryId),
  ]);
}

/** Row counts of one memory store: the store row, its memories and versions. */
async function rowsOf(client: SqlClient, memoryStoreId: string) {
  const count = async (sql: string) =>
    (await client.prepare(sql).bind(W, memoryStoreId).first<{ n: number }>())?.n;
  return {
    store: await count(
      "SELECT COUNT(*) AS n FROM managed_memory_stores WHERE workspace_id = ? AND id = ?",
    ),
    memories: await count(
      "SELECT COUNT(*) AS n FROM managed_memories WHERE workspace_id = ? AND memory_store_id = ?",
    ),
    versions: await count(
      "SELECT COUNT(*) AS n FROM managed_memory_versions WHERE workspace_id = ? AND memory_store_id = ?",
    ),
  };
}

describe("SqlMemoryStoreStore", () => {
  let client: SqlClient;
  let store: SqlMemoryStoreStore;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    store = new SqlMemoryStoreStore(client);
  });

  it("persists complete SDK-shaped records and replaces them under CAS", async () => {
    await expect(store.insert({ workspaceId: "workspace_01", memoryStore }))
      .resolves.toEqual({ memoryStore, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
    })).resolves.toEqual({ memoryStore, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_other",
      memoryStoreId: memoryStore.id,
    })).resolves.toBeNull();

    const renamed = {
      ...memoryStore,
      name: "Renamed memory",
      updatedAt: "2026-08-26T10:00:00.000Z",
    };
    await expect(store.replace({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
      expectedRevision: 1,
      next: renamed,
    })).resolves.toEqual({
      type: "replaced",
      record: { memoryStore: renamed, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
      expectedRevision: 1,
      next: memoryStore,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("uses inclusive SDK time filters, stable paging, archive, and delete", async () => {
    const second = {
      ...memoryStore,
      id: "memstore_02",
      createdAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T10:00:00.000Z",
    };
    await store.insert({ workspaceId: "workspace_01", memoryStore });
    await store.insert({ workspaceId: "workspace_01", memoryStore: second });

    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 10,
      createdAtOrAfter: memoryStore.createdAt,
      createdAtOrBefore: second.createdAt,
      position: {
        createdAt: memoryStore.createdAt,
        memoryStoreId: memoryStore.id,
      },
    })).resolves.toEqual([{ memoryStore: second, revision: 1 }]);
    await expect(store.archive({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
      archivedAt: "2026-08-26T11:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      record: {
        revision: 2,
        memoryStore: {
          archivedAt: "2026-08-26T11:00:00.000Z",
          updatedAt: "2026-08-26T11:00:00.000Z",
        },
      },
    });
    await expect(store.delete({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
    })).resolves.toEqual({ type: "deleted" });
  });
  it("deletes the store with its memories and versions and keeps another store", async () => {
    const other = { ...memoryStore, id: "memstore_02" };
    await store.insert({ workspaceId: W, memoryStore });
    await store.insert({ workspaceId: W, memoryStore: other });
    await insertMemory(client, memoryStore.id, "mem_1");
    await insertMemory(client, memoryStore.id, "mem_2");
    await insertMemory(client, other.id, "mem_3");

    await expect(store.delete({
      workspaceId: W,
      memoryStoreId: memoryStore.id,
      expectedRevision: 1,
    })).resolves.toEqual({ type: "deleted" });
    await expect(rowsOf(client, memoryStore.id))
      .resolves.toEqual({ store: 0, memories: 0, versions: 0 });
    await expect(rowsOf(client, other.id))
      .resolves.toEqual({ store: 1, memories: 1, versions: 1 });
    await expect(store.delete({ workspaceId: W, memoryStoreId: memoryStore.id }))
      .resolves.toEqual({ type: "not_found" });
    await expect(store.delete({
      workspaceId: W,
      memoryStoreId: memoryStore.id,
      expectedRevision: 1,
    })).resolves.toEqual({ type: "not_found" });
  });

  it("archive and delete with a stale revision keep the store and its memories", async () => {
    await store.insert({ workspaceId: W, memoryStore });
    await insertMemory(client, memoryStore.id, "mem_1");
    await store.replace({
      workspaceId: W,
      memoryStoreId: memoryStore.id,
      expectedRevision: 1,
      next: { ...memoryStore, name: "Renamed memory" },
    });

    await expect(store.archive({
      workspaceId: W,
      memoryStoreId: memoryStore.id,
      archivedAt: "2026-08-26T11:00:00.000Z",
      expectedRevision: 1,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.delete({
      workspaceId: W,
      memoryStoreId: memoryStore.id,
      expectedRevision: 1,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.find({ workspaceId: W, memoryStoreId: memoryStore.id }))
      .resolves.toMatchObject({ revision: 2, memoryStore: { archivedAt: null } });
    await expect(rowsOf(client, memoryStore.id))
      .resolves.toEqual({ store: 1, memories: 1, versions: 1 });

    await expect(store.archive({
      workspaceId: W,
      memoryStoreId: memoryStore.id,
      archivedAt: "2026-08-26T11:00:00.000Z",
      expectedRevision: 2,
    })).resolves.toMatchObject({ type: "archived", record: { revision: 3 } });
  });

  it("keeps the store, its memories and versions when the memory delete fails", async () => {
    await store.insert({ workspaceId: W, memoryStore });
    await insertMemory(client, memoryStore.id, "mem_1");
    await client.exec(`
      CREATE TRIGGER managed_memories_no_delete BEFORE DELETE ON managed_memories
      BEGIN SELECT RAISE(ABORT, 'memory delete refused'); END;
    `);

    await expect(store.delete({ workspaceId: W, memoryStoreId: memoryStore.id }))
      .rejects.toThrow("memory delete refused");
    await expect(rowsOf(client, memoryStore.id))
      .resolves.toEqual({ store: 1, memories: 1, versions: 1 });
  });
});
