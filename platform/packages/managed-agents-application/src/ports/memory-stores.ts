import type { DependencyConflict } from "./dependencies";
import type { MemoryStore } from "../domain/memory-store";

export type MemoryStoreView = MemoryStore;

export interface CreateMemoryStoreCommand {
  name: string;
  description?: string;
  metadata?: Record<string, string>;
}

export interface RetrieveMemoryStoreQuery {
  memoryStoreId: string;
}

export interface UpdateMemoryStoreCommand {
  memoryStoreId: string;
  description?: string | null;
  metadata?: Record<string, string | null> | null;
  name?: string | null;
  /**
   * Write only over this stored revision (the `If-Match` header). A different
   * revision gives `precondition_failed` and writes nothing.
   */
  expectedRevision?: number;
}

export interface ListMemoryStoresQuery {
  pageSize?: number;
  cursor?: string;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  includeArchived?: boolean;
}

export interface MemoryStoresPage {
  memoryStores: MemoryStoreView[];
  nextCursor: string | null;
}

export interface DeleteMemoryStoreCommand {
  memoryStoreId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export interface ArchiveMemoryStoreCommand {
  memoryStoreId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export interface UnarchiveMemoryStoreCommand {
  memoryStoreId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export type CreateMemoryStoreResult =
  | { type: "created"; memoryStore: MemoryStoreView; revision?: number }
  | { type: "invalid_request"; message: string };

export type RetrieveMemoryStoreResult =
  | { type: "found"; memoryStore: MemoryStoreView; revision?: number }
  | { type: "not_found" };

export type UpdateMemoryStoreResult =
  | { type: "updated"; memoryStore: MemoryStoreView; revision?: number }
  | { type: "invalid_request"; message: string }
  | { type: "precondition_failed"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type ListMemoryStoresResult =
  | { type: "page"; page: MemoryStoresPage }
  | { type: "invalid_request"; message: string };

/** Deleting a store deletes its memories and memory versions too. */
export type DeleteMemoryStoreResult =
  | { type: "deleted"; memoryStoreId: string }
  | { type: "precondition_failed"; message: string }
  | DependencyConflict
  | { type: "not_found" };

export type ArchiveMemoryStoreResult =
  | { type: "archived"; memoryStore: MemoryStoreView; revision?: number }
  | { type: "precondition_failed"; message: string }
  | DependencyConflict
  | { type: "not_found" };

export type UnarchiveMemoryStoreResult =
  | { type: "unarchived"; memoryStore: MemoryStoreView; revision?: number }
  | { type: "precondition_failed"; message: string }
  | { type: "not_found" };

export interface MemoryStoresApplicationPort {
  createMemoryStore(command: CreateMemoryStoreCommand): Promise<CreateMemoryStoreResult>;
  retrieveMemoryStore(query: RetrieveMemoryStoreQuery): Promise<RetrieveMemoryStoreResult>;
  updateMemoryStore(command: UpdateMemoryStoreCommand): Promise<UpdateMemoryStoreResult>;
  listMemoryStores(query: ListMemoryStoresQuery): Promise<ListMemoryStoresResult>;
  deleteMemoryStore(command: DeleteMemoryStoreCommand): Promise<DeleteMemoryStoreResult>;
  archiveMemoryStore(command: ArchiveMemoryStoreCommand): Promise<ArchiveMemoryStoreResult>;
  unarchiveMemoryStore(command: UnarchiveMemoryStoreCommand): Promise<UnarchiveMemoryStoreResult>;
}
