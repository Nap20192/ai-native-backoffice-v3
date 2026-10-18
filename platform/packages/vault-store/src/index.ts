import type { Vault } from "@open-managed-agents/domain/vaults";

export interface StoredVault {
  vault: Vault;
  revision: number;
}

export interface VaultLocation {
  workspaceId: string;
  vaultId: string;
}

export interface InsertVault {
  workspaceId: string;
  vault: Vault;
}

export interface ReplaceVault extends VaultLocation {
  expectedRevision: number;
  next: Vault;
}

export type ReplaceVaultResult =
  | { type: "replaced"; record: StoredVault }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveVaultRecord extends VaultLocation {
  archivedAt: string;
  /**
   * When set, the write happens only while the stored revision equals it.
   * The check and the write are one atomic step. Another revision gives
   * revision_conflict and changes nothing.
   */
  expectedRevision?: number;
}

export type ArchiveVaultRecordResult =
  | { type: "archived"; record: StoredVault }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface DeleteVaultRecord extends VaultLocation {
  /**
   * Same guard as {@link ArchiveVaultRecord.expectedRevision}. A stale
   * revision keeps the vault with its credentials.
   */
  expectedRevision?: number;
}

export type DeleteVaultRecordResult =
  | { type: "deleted" }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface VaultListPosition {
  createdAt: string;
  vaultId: string;
}

export interface ListVaultRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  position?: VaultListPosition;
}

export interface VaultStore {
  insert(input: InsertVault): Promise<StoredVault>;
  find(input: VaultLocation): Promise<StoredVault | null>;
  replace(input: ReplaceVault): Promise<ReplaceVaultResult>;
  archive(input: ArchiveVaultRecord): Promise<ArchiveVaultRecordResult>;
  /**
   * Deletes the vault row. An adapter that keeps the credentials in the same
   * database deletes them in the same atomic step; SQL does. An adapter
   * without them deletes only the row. The caller sweeps the credentials
   * afterwards with CredentialStore.deleteAllInVault.
   */
  delete(input: DeleteVaultRecord): Promise<DeleteVaultRecordResult>;
  list(input: ListVaultRecords): Promise<StoredVault[]>;
}
