import type { Environment } from "@open-managed-agents/domain/environments";

export type EnvironmentRecord = Environment;

export interface StoredEnvironment {
  environment: EnvironmentRecord;
  revision: number;
}

export interface EnvironmentLocation {
  workspaceId: string;
  environmentId: string;
}

export interface InsertEnvironment {
  workspaceId: string;
  environment: EnvironmentRecord;
}

export interface ReplaceEnvironment extends EnvironmentLocation {
  expectedRevision: number;
  next: EnvironmentRecord;
}

export type ReplaceEnvironmentResult =
  | { type: "replaced"; record: StoredEnvironment }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveEnvironmentRecord extends EnvironmentLocation {
  archivedAt: string;
  /**
   * When set, the write happens only while the stored revision equals it.
   * The check and the write are one atomic step. Another revision gives
   * revision_conflict and changes nothing.
   */
  expectedRevision?: number;
}

export type ArchiveEnvironmentRecordResult =
  | { type: "archived"; record: StoredEnvironment }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface DeleteEnvironmentRecord extends EnvironmentLocation {
  /** Same guard as {@link ArchiveEnvironmentRecord.expectedRevision}. */
  expectedRevision?: number;
}

export type DeleteEnvironmentRecordResult =
  | { type: "deleted" }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface EnvironmentListPosition {
  createdAt: string;
  environmentId: string;
}

export interface ListEnvironmentRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  position?: EnvironmentListPosition;
}

export interface EnvironmentStore {
  insert(input: InsertEnvironment): Promise<StoredEnvironment>;
  find(input: EnvironmentLocation): Promise<StoredEnvironment | null>;
  replace(input: ReplaceEnvironment): Promise<ReplaceEnvironmentResult>;
  archive(input: ArchiveEnvironmentRecord): Promise<ArchiveEnvironmentRecordResult>;
  delete(input: DeleteEnvironmentRecord): Promise<DeleteEnvironmentRecordResult>;
  list(input: ListEnvironmentRecords): Promise<StoredEnvironment[]>;
}
