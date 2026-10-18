import type { Vault } from "../domain/vault";
import type {
  ArchiveVaultCommand,
  ArchiveVaultResult,
  CreateVaultCommand,
  CreateVaultResult,
  DeleteVaultCommand,
  DeleteVaultResult,
  ListVaultsQuery,
  ListVaultsResult,
  RetrieveVaultQuery,
  RetrieveVaultResult,
  UnarchiveVaultCommand,
  UnarchiveVaultResult,
  UpdateVaultCommand,
  UpdateVaultResult,
  VaultsApplicationPort,
} from "../ports/vaults";
import type { VaultStore } from "@open-managed-agents/vault-store";
import type { CredentialStore } from "@open-managed-agents/credential-store";
import type { DependenciesApplicationPort } from "../ports/dependencies";
import { dependencyConflictOf } from "../dependencies/application";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeVaultCursor(vault: Vault): string {
  return `vaults.${encodeCursorPart(vault.createdAt)}.${encodeCursorPart(vault.id)}`;
}

function decodeVaultCursor(
  value: string,
): { createdAt: string; vaultId: string } | null {
  const [scope, createdAt, vaultId, extra] = value.split(".");
  if (
    scope !== "vaults" ||
    createdAt === undefined ||
    vaultId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedVaultId = decodeCursorPart(vaultId);
  if (
    decodedCreatedAt === null ||
    decodedVaultId === null ||
    decodedVaultId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return { createdAt: decodedCreatedAt, vaultId: decodedVaultId };
}

function validateDisplayName(value: string): string | null {
  if (value.length < 1 || value.length > 255) {
    return "Vault display name must contain 1 to 255 characters";
  }
  if (/\p{Cc}/u.test(value)) {
    return "Vault display name must not contain control characters";
  }
  return null;
}

function patchMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null> | null,
): Record<string, string> {
  if (patch === null) return {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export interface VaultsApplicationServiceDependencies {
  workspaceId: string;
  store: VaultStore;
  /**
   * Delete sweeps the credentials of the vault after the vault row is gone.
   * On SQL the vault delete has already removed them; the in-memory
   * adapters need the sweep.
   */
  credentials?: CredentialStore;
  clock: { now(): Date };
  ids: { nextVaultId(): string };
  /** Archive and delete check dependencies with it (docs/plans/crud.md, 1.3). */
  dependencyCheck?: DependenciesApplicationPort;
}

function staleVaultRevision(
  vaultId: string,
  expectedRevision: number | undefined,
  revision: number,
): { type: "precondition_failed"; message: string } | null {
  if (expectedRevision === undefined || expectedRevision === revision) return null;
  return {
    type: "precondition_failed",
    message: `Vault ${vaultId} is at revision ${revision}, not ${expectedRevision}`,
  };
}

/** The answer when the store refused a write guarded by the expected revision. */
function revisionChanged(
  vaultId: string,
  actualRevision: number,
): { type: "precondition_failed"; message: string } {
  return {
    type: "precondition_failed",
    message: `Vault ${vaultId} changed concurrently at revision ${actualRevision}`,
  };
}

export class VaultsApplicationService implements VaultsApplicationPort {
  constructor(
    private readonly dependencies: VaultsApplicationServiceDependencies,
  ) {}

  async createVault(command: CreateVaultCommand): Promise<CreateVaultResult> {
    const invalidName = validateDisplayName(command.displayName);
    if (invalidName !== null) {
      return { type: "invalid_request", message: invalidName };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const record = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      vault: {
        id: this.dependencies.ids.nextVaultId(),
        archivedAt: null,
        createdAt: timestamp,
        displayName: command.displayName,
        metadata: command.metadata ?? {},
        updatedAt: timestamp,
      },
    });
    return { type: "created", vault: record.vault, revision: record.revision };
  }

  async retrieveVault(query: RetrieveVaultQuery): Promise<RetrieveVaultResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: query.vaultId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", vault: record.vault, revision: record.revision };
  }

  async updateVault(command: UpdateVaultCommand): Promise<UpdateVaultResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
    });
    if (current === null) return { type: "not_found" };
    if (command.displayName !== undefined && command.displayName !== null) {
      const invalidName = validateDisplayName(command.displayName);
      if (invalidName !== null) {
        return { type: "invalid_request", message: invalidName };
      }
    }
    const next: Vault = {
      ...current.vault,
      ...(command.displayName !== undefined && command.displayName !== null && {
        displayName: command.displayName,
      }),
      ...(command.metadata !== undefined && {
        metadata: patchMetadata(current.vault.metadata, command.metadata),
      }),
      updatedAt: this.dependencies.clock.now().toISOString(),
    };
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      expectedRevision: current.revision,
      next,
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Vault changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return {
      type: "updated",
      vault: replaced.record.vault,
      revision: replaced.record.revision,
    };
  }

  async listVaults(query: ListVaultsQuery): Promise<ListVaultsResult> {
    const position =
      query.cursor === undefined ? undefined : decodeVaultCursor(query.cursor);
    if (position === null) {
      return { type: "invalid_request", message: "Invalid Vault page cursor" };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      includeArchived: query.includeArchived ?? false,
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const vaults = (hasMore ? records.slice(0, pageSize) : records).map(
      (record) => record.vault,
    );
    const last = vaults[vaults.length - 1];
    return {
      type: "page",
      page: {
        vaults,
        nextCursor:
          hasMore && last !== undefined ? encodeVaultCursor(last) : null,
      },
    };
  }

  /**
   * Deletes the vault row first and sweeps its credentials after it. A
   * failed or refused vault delete keeps every credential. The sweep also
   * removes a credential that a concurrent create added before it ran.
   */
  async deleteVault(command: DeleteVaultCommand): Promise<DeleteVaultResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
    });
    if (current === null) return { type: "not_found" };
    const stale = staleVaultRevision(
      command.vaultId,
      command.expectedRevision,
      current.revision,
    );
    if (stale !== null) return stale;
    const conflict = await dependencyConflictOf(this.dependencies.dependencyCheck, {
      kind: "vault",
      id: command.vaultId,
      operation: "delete",
    });
    if (conflict !== null) return conflict;
    // The early check answers before the dependency queries. The store checks
    // the revision again inside the write: an update after the read gives 412.
    const result = await this.dependencies.store.delete({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      expectedRevision: command.expectedRevision,
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "revision_conflict") {
      return revisionChanged(command.vaultId, result.actualRevision);
    }
    await this.dependencies.credentials?.deleteAllInVault({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
    });
    return { type: "deleted", vaultId: command.vaultId };
  }

  async archiveVault(command: ArchiveVaultCommand): Promise<ArchiveVaultResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
    });
    if (current === null) return { type: "not_found" };
    const stale = staleVaultRevision(
      command.vaultId,
      command.expectedRevision,
      current.revision,
    );
    if (stale !== null) return stale;
    const conflict = await dependencyConflictOf(this.dependencies.dependencyCheck, {
      kind: "vault",
      id: command.vaultId,
      operation: "archive",
    });
    if (conflict !== null) return conflict;
    const result = await this.dependencies.store.archive({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      archivedAt: this.dependencies.clock.now().toISOString(),
      expectedRevision: command.expectedRevision,
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "revision_conflict") {
      return revisionChanged(command.vaultId, result.actualRevision);
    }
    return {
      type: "archived",
      vault: result.record.vault,
      revision: result.record.revision,
    };
  }

  async unarchiveVault(command: UnarchiveVaultCommand): Promise<UnarchiveVaultResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
    });
    if (current === null) return { type: "not_found" };
    const stale = staleVaultRevision(
      command.vaultId,
      command.expectedRevision,
      current.revision,
    );
    if (stale !== null) return stale;
    if (current.vault.archivedAt === null) {
      return { type: "unarchived", vault: current.vault, revision: current.revision };
    }
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      expectedRevision: current.revision,
      next: {
        ...current.vault,
        archivedAt: null,
        updatedAt: this.dependencies.clock.now().toISOString(),
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return revisionChanged(command.vaultId, replaced.actualRevision);
    }
    return {
      type: "unarchived",
      vault: replaced.record.vault,
      revision: replaced.record.revision,
    };
  }
}
