import type {
  Session,
  SessionBootstrapEvent,
  SessionStatus,
} from "@open-managed-agents/domain/sessions";

export interface SessionResourceSecret {
  type: "github_token";
  resourceId: string;
  authorizationToken: string;
}

export interface StoredSession {
  session: Session;
  revision: number;
}

export interface InsertSessionRecord {
  workspaceId: string;
  session: Session;
  initialEvents: SessionBootstrapEvent[];
  resourceSecrets: SessionResourceSecret[];
}

export interface FindCurrentSessionRecord {
  workspaceId: string;
  sessionId: string;
}

export interface ReplaceSessionRecord extends FindCurrentSessionRecord {
  expectedRevision: number;
  next: Session;
}

export type ReplaceSessionRecordResult =
  | { type: "replaced"; record: StoredSession }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveSessionRecord extends FindCurrentSessionRecord {
  archivedAt: string;
  /**
   * When set, the write happens only while the stored revision equals it.
   * The check and the write are one atomic step. Another revision gives
   * revision_conflict and changes nothing.
   */
  expectedRevision?: number;
}

export type ArchiveSessionRecordResult =
  | { type: "archived"; record: StoredSession }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface DeleteSessionRecord extends FindCurrentSessionRecord {
  /**
   * Same guard as {@link ArchiveSessionRecord.expectedRevision}. A stale
   * revision keeps the Session with its events, threads and other rows.
   */
  expectedRevision?: number;
}

export type DeleteSessionRecordResult =
  | { type: "deleted" }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface SessionListPosition {
  createdAt: string;
  sessionId: string;
  direction: "next" | "previous";
}

export interface ListSessionRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  order: "asc" | "desc";
  agentId?: string;
  agentVersion?: number;
  createdAfter?: string;
  createdAtOrAfter?: string;
  createdBefore?: string;
  createdAtOrBefore?: string;
  deploymentId?: string;
  /** Sessions in this environment (docs/plans/crud.md, 1.3). */
  environmentId?: string;
  /** Sessions with a `file` resource of this file. */
  fileId?: string;
  memoryStoreId?: string;
  statuses?: SessionStatus[];
  /** Sessions that list this vault in `vaultIds`. */
  vaultId?: string;
  position?: SessionListPosition;
}

export interface SessionStore {
  insert(input: InsertSessionRecord): Promise<StoredSession>;
  findCurrent(input: FindCurrentSessionRecord): Promise<StoredSession | null>;
  replaceCurrent(input: ReplaceSessionRecord): Promise<ReplaceSessionRecordResult>;
  archiveCurrent(input: ArchiveSessionRecord): Promise<ArchiveSessionRecordResult>;
  deleteCurrent(input: DeleteSessionRecord): Promise<DeleteSessionRecordResult>;
  listCurrent(input: ListSessionRecords): Promise<StoredSession[]>;
}
