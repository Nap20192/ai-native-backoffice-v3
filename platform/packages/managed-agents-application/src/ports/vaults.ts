import type { DependencyConflict } from "./dependencies";
import type { Vault } from "../domain/vault";

export type VaultView = Vault;

export interface CreateVaultCommand {
  displayName: string;
  metadata?: Record<string, string>;
}

export interface RetrieveVaultQuery {
  vaultId: string;
}

export interface UpdateVaultCommand {
  vaultId: string;
  displayName?: string | null;
  metadata?: Record<string, string | null> | null;
}

export interface ListVaultsQuery {
  pageSize?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface VaultsPage {
  vaults: VaultView[];
  nextCursor: string | null;
}

export interface DeleteVaultCommand {
  vaultId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export interface ArchiveVaultCommand {
  vaultId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export interface UnarchiveVaultCommand {
  vaultId: string;
  /** The revision from ETag (`If-Match`). Another revision gives precondition_failed. */
  expectedRevision?: number;
}

export type CreateVaultResult =
  | { type: "created"; vault: VaultView; revision?: number }
  | { type: "invalid_request"; message: string };

export type RetrieveVaultResult =
  | { type: "found"; vault: VaultView; revision?: number }
  | { type: "not_found" };

export type UpdateVaultResult =
  | { type: "updated"; vault: VaultView; revision?: number }
  | { type: "invalid_request"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type ListVaultsResult =
  | { type: "page"; page: VaultsPage }
  | { type: "invalid_request"; message: string };

export type DeleteVaultResult =
  | { type: "deleted"; vaultId: string }
  | { type: "precondition_failed"; message: string }
  | DependencyConflict
  | { type: "not_found" };

export type ArchiveVaultResult =
  | { type: "archived"; vault: VaultView; revision?: number }
  | { type: "precondition_failed"; message: string }
  | DependencyConflict
  | { type: "not_found" };

export type UnarchiveVaultResult =
  | { type: "unarchived"; vault: VaultView; revision?: number }
  | { type: "precondition_failed"; message: string }
  | { type: "not_found" };

export interface VaultsApplicationPort {
  createVault(command: CreateVaultCommand): Promise<CreateVaultResult>;
  retrieveVault(query: RetrieveVaultQuery): Promise<RetrieveVaultResult>;
  updateVault(command: UpdateVaultCommand): Promise<UpdateVaultResult>;
  listVaults(query: ListVaultsQuery): Promise<ListVaultsResult>;
  deleteVault(command: DeleteVaultCommand): Promise<DeleteVaultResult>;
  archiveVault(command: ArchiveVaultCommand): Promise<ArchiveVaultResult>;
  unarchiveVault(command: UnarchiveVaultCommand): Promise<UnarchiveVaultResult>;
}
