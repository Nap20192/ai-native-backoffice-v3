import type { MemoryStore } from "@open-managed-agents/domain/memory-stores";

export interface StoredMemoryStore {
  memoryStore: MemoryStore;
  revision: number;
}

export interface MemoryStoreLocation {
  workspaceId: string;
  memoryStoreId: string;
}

export interface InsertMemoryStore {
  workspaceId: string;
  memoryStore: MemoryStore;
}

export interface ReplaceMemoryStore extends MemoryStoreLocation {
  expectedRevision: number;
  next: MemoryStore;
}

export type ReplaceMemoryStoreResult =
  | { type: "replaced"; record: StoredMemoryStore }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveMemoryStoreRecord extends MemoryStoreLocation {
  archivedAt: string;
  /**
   * When set, the write happens only while the stored revision equals it.
   * The check and the write are one atomic step. Another revision gives
   * revision_conflict and changes nothing.
   */
  expectedRevision?: number;
}

export type ArchiveMemoryStoreRecordResult =
  | { type: "archived"; record: StoredMemoryStore }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface DeleteMemoryStoreRecord extends MemoryStoreLocation {
  /**
   * Same guard as {@link ArchiveMemoryStoreRecord.expectedRevision}. A stale
   * revision keeps the memory store with its memories and versions.
   */
  expectedRevision?: number;
}

export type DeleteMemoryStoreRecordResult =
  | { type: "deleted" }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface MemoryStoreListPosition {
  createdAt: string;
  memoryStoreId: string;
}

export interface ListMemoryStoreRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  position?: MemoryStoreListPosition;
}

export interface MemoryStoreStore {
  insert(input: InsertMemoryStore): Promise<StoredMemoryStore>;
  find(input: MemoryStoreLocation): Promise<StoredMemoryStore | null>;
  replace(input: ReplaceMemoryStore): Promise<ReplaceMemoryStoreResult>;
  archive(
    input: ArchiveMemoryStoreRecord,
  ): Promise<ArchiveMemoryStoreRecordResult>;
  /**
   * Deletes the memory store row. An adapter that keeps the memories in the
   * same database deletes them and their versions in the same atomic step;
   * SQL does. An adapter without them deletes only the row. The caller
   * sweeps the memories afterwards with MemoryDocumentStore.deleteAllInStore.
   */
  delete(input: DeleteMemoryStoreRecord): Promise<DeleteMemoryStoreRecordResult>;
  list(input: ListMemoryStoreRecords): Promise<StoredMemoryStore[]>;
}
