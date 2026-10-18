import type { Vault } from "@open-managed-agents/domain/vaults";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  ArchiveVaultRecord,
  ArchiveVaultRecordResult,
  DeleteVaultRecord,
  DeleteVaultRecordResult,
  InsertVault,
  ListVaultRecords,
  ReplaceVault,
  ReplaceVaultResult,
  StoredVault,
  VaultLocation,
  VaultStore,
} from "@open-managed-agents/vault-store";

interface VaultRow {
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
    throw new Error(`Invalid Vault timestamp: ${value}`);
  }
  return milliseconds;
}

function toStoredVault(row: VaultRow): StoredVault {
  const vault = JSON.parse(row.document) as Vault;
  return {
    revision: Number(row.revision),
    vault: {
      ...vault,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
      archivedAt:
        row.archived_at === null
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
 * Tables that hold the rows of one vault besides managed_vaults.
 * SqlCredentialStore writes them.
 */
const VAULT_CHILD_TABLES = ["managed_credentials"] as const;

export class SqlVaultStore implements VaultStore {
  constructor(private readonly client: SqlClient) {}

  async insert(input: InsertVault): Promise<StoredVault> {
    const value = input.vault;
    const result = await this.client
      .prepare(
        `INSERT INTO managed_vaults
          (workspace_id, id, document, revision, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.workspaceId,
        value.id,
        JSON.stringify(value),
        1,
        timestamp(value.createdAt),
        timestamp(value.updatedAt),
        value.archivedAt === null ? null : timestamp(value.archivedAt),
      )
      .run();
    if (result.meta.changes !== 1) {
      throw new Error(`Vault insertion affected ${result.meta.changes} rows`);
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      vaultId: value.id,
    });
    if (inserted === null) throw new Error("Vault vanished after insert");
    return inserted;
  }

  async find(input: VaultLocation): Promise<StoredVault | null> {
    const row = await this.client
      .prepare(
        `SELECT id, document, revision, created_at, updated_at, archived_at
           FROM managed_vaults
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(input.workspaceId, input.vaultId)
      .first<VaultRow>();
    return row === null ? null : toStoredVault(row);
  }

  async replace(input: ReplaceVault): Promise<ReplaceVaultResult> {
    if (input.next.id !== input.vaultId) {
      throw new Error("Replacement Vault ID does not match the target");
    }
    const result = await this.client
      .prepare(
        `UPDATE managed_vaults
            SET document = ?, revision = revision + 1,
                updated_at = ?, archived_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ?`,
      )
      .bind(
        JSON.stringify(input.next),
        timestamp(input.next.updatedAt),
        input.next.archivedAt === null
          ? null
          : timestamp(input.next.archivedAt),
        input.workspaceId,
        input.vaultId,
        input.expectedRevision,
      )
      .run();
    if (result.meta.changes === 0) {
      const current = await this.find(input);
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`Vault replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Vault vanished after replacement");
    return { type: "replaced", record };
  }

  async archive(input: ArchiveVaultRecord): Promise<ArchiveVaultRecordResult> {
    const archivedAt = timestamp(input.archivedAt);
    const guard = revisionGuard(input.expectedRevision);
    const result = await this.client
      .prepare(
        `UPDATE managed_vaults
            SET archived_at = ?, updated_at = ?, revision = revision + 1
          WHERE workspace_id = ? AND id = ?${guard.condition}`,
      )
      .bind(
        archivedAt,
        archivedAt,
        input.workspaceId,
        input.vaultId,
        ...guard.parameters,
      )
      .run();
    if (result.meta.changes === 0) return this.unchanged(input);
    if (result.meta.changes !== 1) {
      throw new Error(`Vault archive affected ${result.meta.changes} rows`);
    }
    const record = await this.find(input);
    if (record === null) throw new Error("Vault vanished after archive");
    return { type: "archived", record };
  }

  /**
   * One batch deletes the vault and its credentials. It starts with the
   * guarded vault row, so on Postgres it locks the row before the
   * credentials go. The credentials go only when the vault row is gone: a
   * stale revision leaves the vault and its credentials as they were, and a
   * failed credential delete rolls the vault row back.
   */
  async delete(input: DeleteVaultRecord): Promise<DeleteVaultRecordResult> {
    const guard = revisionGuard(input.expectedRevision);
    const results = await this.client.batch([
      this.client
        .prepare(
          `DELETE FROM managed_vaults
            WHERE workspace_id = ? AND id = ?${guard.condition}`,
        )
        .bind(input.workspaceId, input.vaultId, ...guard.parameters),
      ...VAULT_CHILD_TABLES.map((table) =>
        this.client
          .prepare(
            `DELETE FROM ${table}
              WHERE workspace_id = ? AND vault_id = ?
                AND NOT EXISTS (
                  SELECT 1 FROM managed_vaults
                   WHERE workspace_id = ? AND id = ?
                )`,
          )
          .bind(
            input.workspaceId,
            input.vaultId,
            input.workspaceId,
            input.vaultId,
          )),
    ]);
    const vaultChanges = results[0]?.meta.changes;
    if (vaultChanges === 0) return this.unchanged(input);
    if (vaultChanges !== 1) {
      throw new Error(`Vault deletion affected ${vaultChanges ?? "missing"} rows`);
    }
    return { type: "deleted" };
  }

  /** The answer of a guarded write that touched no vault row. */
  private async unchanged(input: DeleteVaultRecord): Promise<
    { type: "not_found" } | { type: "revision_conflict"; actualRevision: number }
  > {
    if (input.expectedRevision === undefined) return { type: "not_found" };
    const current = await this.find(input);
    return current === null
      ? { type: "not_found" }
      : { type: "revision_conflict", actualRevision: current.revision };
  }

  async list(input: ListVaultRecords): Promise<StoredVault[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Vault list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.position !== undefined) {
      const positionTime = timestamp(input.position.createdAt);
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      parameters.push(positionTime, positionTime, input.position.vaultId);
    }
    parameters.push(input.limit);
    const rows = await this.client
      .prepare(
        `SELECT id, document, revision, created_at, updated_at, archived_at
           FROM managed_vaults
          WHERE ${conditions.join(" AND ")}
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .bind(...parameters)
      .all<VaultRow>();
    return (rows.results ?? []).map(toStoredVault);
  }
}
