import type { SqlClient } from "@open-managed-agents/sql-client";
import type { MemoryStore } from "@open-managed-agents/domain/memory-stores";
import type {
  ArchiveMemoryStoreRecord,
  ArchiveMemoryStoreRecordResult,
  DeleteMemoryStoreRecord,
  DeleteMemoryStoreRecordResult,
  InsertMemoryStore,
  ListMemoryStoreRecords,
  MemoryStoreLocation,
  MemoryStoreStore,
  ReplaceMemoryStore,
  ReplaceMemoryStoreResult,
  StoredMemoryStore,
} from "@open-managed-agents/memory-store-store";

interface MemoryStoreRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid memory store timestamp: ${value}`);
  }
  return milliseconds;
}

function toStoredMemoryStore(row: MemoryStoreRow): StoredMemoryStore {
  const memoryStore = JSON.parse(row.document) as MemoryStore;
  return {
    revision: Number(row.revision),
    memoryStore: {
      ...memoryStore,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      archivedAt: row.archived_at === null
        ? null
        : new Date(Number(row.archived_at)).toISOString(),
    },
  };
}

/** SQL condition and its parameter for an optional expected revision. */
function revisionGuard(expectedRevision: number | undefined): {
  condition: string;
  parameters: number[];
} {
  return expectedRevision === undefined
    ? { condition: "", parameters: [] }
    : { condition: " AND revision = ?", parameters: [expectedRevision] };
}

/**
 * Tables that hold the rows of one memory store besides managed_memory_stores.
 * SqlMemoryDocumentStore writes them; versions go first, as in its
 * deleteAllInStore.
 */
const MEMORY_STORE_CHILD_TABLES = [
  "managed_memory_versions",
  "managed_memories",
] as const;

export class SqlMemoryStoreStore implements MemoryStoreStore {
  constructor(private readonly client: SqlClient) {}

  async insert(input: InsertMemoryStore): Promise<StoredMemoryStore> {
    const value = input.memoryStore;
    const result = await this.client.prepare(
      `INSERT INTO managed_memory_stores
        (workspace_id, id, document, revision, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.workspaceId,
      value.id,
      JSON.stringify(value),
      1,
      timestamp(value.createdAt),
      timestamp(value.updatedAt),
      value.archivedAt === null ? null : timestamp(value.archivedAt),
    ).run();
    if (result.meta.changes !== 1) {
      throw new Error(`Memory store insertion affected ${result.meta.changes} rows`);
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      memoryStoreId: value.id,
    });
    if (inserted === null) throw new Error("Memory store vanished after insert");
    return inserted;
  }

  async find(input: MemoryStoreLocation): Promise<StoredMemoryStore | null> {
    const row = await this.client.prepare(
      `SELECT id, document, revision, created_at, updated_at, archived_at
         FROM managed_memory_stores
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, input.memoryStoreId).first<MemoryStoreRow>();
    return row === null ? null : toStoredMemoryStore(row);
  }

  async replace(input: ReplaceMemoryStore): Promise<ReplaceMemoryStoreResult> {
    if (input.next.id !== input.memoryStoreId) {
      throw new Error("Replacement memory store ID does not match the target");
    }
    const result = await this.client.prepare(
      `UPDATE managed_memory_stores
          SET document = ?, revision = revision + 1,
              updated_at = ?, archived_at = ?
        WHERE workspace_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(input.next),
      timestamp(input.next.updatedAt),
      input.next.archivedAt === null ? null : timestamp(input.next.archivedAt),
      input.workspaceId,
      input.memoryStoreId,
      input.expectedRevision,
    ).run();
    if (result.meta.changes === 0) {
      const current = await this.find(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`Memory store replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Memory store vanished after replacement");
    return { type: "replaced", record };
  }

  async archive(
    input: ArchiveMemoryStoreRecord,
  ): Promise<ArchiveMemoryStoreRecordResult> {
    const archivedAt = timestamp(input.archivedAt);
    const guard = revisionGuard(input.expectedRevision);
    const result = await this.client.prepare(
      `UPDATE managed_memory_stores
          SET archived_at = ?, updated_at = ?, revision = revision + 1
        WHERE workspace_id = ? AND id = ?${guard.condition}`,
    ).bind(
      archivedAt,
      archivedAt,
      input.workspaceId,
      input.memoryStoreId,
      ...guard.parameters,
    ).run();
    if (result.meta.changes === 0) return this.unchanged(input);
    if (result.meta.changes !== 1) {
      throw new Error(`Memory store archive affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Memory store vanished after archive");
    return { type: "archived", record };
  }

  /**
   * One batch deletes the memory store, its memory versions and memories.
   * It starts with the guarded store row, so on Postgres it locks the row
   * before the child rows go. The child rows go only when the store row is
   * gone: a stale revision leaves the store, its memories and versions as
   * they were, and a failed child delete rolls the store row back.
   */
  async delete(
    input: DeleteMemoryStoreRecord,
  ): Promise<DeleteMemoryStoreRecordResult> {
    const guard = revisionGuard(input.expectedRevision);
    const results = await this.client.batch([
      this.client.prepare(
        `DELETE FROM managed_memory_stores
          WHERE workspace_id = ? AND id = ?${guard.condition}`,
      ).bind(input.workspaceId, input.memoryStoreId, ...guard.parameters),
      ...MEMORY_STORE_CHILD_TABLES.map((table) =>
        this.client.prepare(
          `DELETE FROM ${table}
            WHERE workspace_id = ? AND memory_store_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM managed_memory_stores
                 WHERE workspace_id = ? AND id = ?
              )`,
        ).bind(
          input.workspaceId,
          input.memoryStoreId,
          input.workspaceId,
          input.memoryStoreId,
        )),
    ]);
    const storeChanges = results[0]?.meta.changes;
    if (storeChanges === 0) return this.unchanged(input);
    if (storeChanges !== 1) {
      throw new Error(
        `Memory store deletion affected ${storeChanges ?? "missing"} rows`,
      );
    }
    return { type: "deleted" };
  }

  /** The answer of a guarded write that touched no memory store row. */
  private async unchanged(input: DeleteMemoryStoreRecord): Promise<
    { type: "not_found" } | { type: "revision_conflict"; actualRevision: number }
  > {
    if (input.expectedRevision === undefined) return { type: "not_found" };
    const current = await this.find(input);
    return current === null
      ? { type: "not_found" }
      : { type: "revision_conflict", actualRevision: current.revision };
  }

  async list(input: ListMemoryStoreRecords): Promise<StoredMemoryStore[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Memory store list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.createdAtOrAfter !== undefined) {
      conditions.push("created_at >= ?");
      parameters.push(timestamp(input.createdAtOrAfter));
    }
    if (input.createdAtOrBefore !== undefined) {
      conditions.push("created_at <= ?");
      parameters.push(timestamp(input.createdAtOrBefore));
    }
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      parameters.push(createdAt, createdAt, input.position.memoryStoreId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT id, document, revision, created_at, updated_at, archived_at
         FROM managed_memory_stores
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    ).bind(...parameters).all<MemoryStoreRow>();
    return (rows.results ?? []).map(toStoredMemoryStore);
  }
}
