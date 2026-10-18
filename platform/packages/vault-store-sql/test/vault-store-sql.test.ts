import { beforeEach, describe, expect, it } from "vitest";
import type { Vault } from "@open-managed-agents/domain/vaults";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlVaultStore } from "../src/index";

const SCHEMA_SQL = `
CREATE TABLE managed_vaults (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_vaults_workspace_created_id
  ON managed_vaults (workspace_id, created_at, id);
CREATE TABLE managed_credentials (
  workspace_id text NOT NULL,
  vault_id text NOT NULL,
  id text NOT NULL,
  sealed_document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
`;

function vault(id: string, createdAt: string): Vault {
  return {
    id,
    archivedAt: null,
    createdAt,
    displayName: `Vault ${id}`,
    metadata: {},
    updatedAt: createdAt,
  };
}

const W = "workspace_01";

/** Inserts one sealed credential row straight into the table. */
async function insertCredential(
  client: SqlClient,
  vaultId: string,
  credentialId: string,
): Promise<void> {
  await client.prepare(
    `INSERT INTO managed_credentials
      (workspace_id, vault_id, id, sealed_document, revision, created_at, updated_at)
     VALUES (?, ?, ?, 'sealed', 1, 0, 0)`,
  ).bind(W, vaultId, credentialId).run();
}

/** Row counts of one vault: the vault row and its credentials. */
async function rowsOf(client: SqlClient, vaultId: string) {
  const count = async (sql: string) =>
    (await client.prepare(sql).bind(W, vaultId).first<{ n: number }>())?.n;
  return {
    vault: await count(
      "SELECT COUNT(*) AS n FROM managed_vaults WHERE workspace_id = ? AND id = ?",
    ),
    credentials: await count(
      "SELECT COUNT(*) AS n FROM managed_credentials WHERE workspace_id = ? AND vault_id = ?",
    ),
  };
}

describe("SqlVaultStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("preserves scoped snapshots, CAS, pagination, archive, and delete", async () => {
    const store = new SqlVaultStore(client);
    const first = vault("vlt_01", "2026-08-26T10:00:00.000Z");
    const second = vault("vlt_02", "2026-08-26T11:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", vault: first });
    await store.insert({ workspaceId: "workspace_01", vault: second });
    await store.insert({ workspaceId: "workspace_02", vault: first });

    const next = {
      ...first,
      displayName: "Renamed",
      updatedAt: "2026-08-26T12:00:00.000Z",
    };
    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: first.id,
      expectedRevision: 1,
      next,
    })).resolves.toEqual({
      type: "replaced",
      record: { vault: next, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      vaultId: first.id,
      expectedRevision: 1,
      next,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.list({
      workspaceId: "workspace_01",
      limit: 10,
      includeArchived: false,
      position: { createdAt: first.createdAt, vaultId: first.id },
    })).resolves.toEqual([{ vault: second, revision: 1 }]);
    await expect(store.archive({
      workspaceId: "workspace_01",
      vaultId: first.id,
      archivedAt: "2026-08-26T13:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      record: { vault: { archivedAt: "2026-08-26T13:00:00.000Z" } },
    });
    await expect(store.delete({
      workspaceId: "workspace_01",
      vaultId: first.id,
    })).resolves.toEqual({ type: "deleted" });
    await expect(store.find({
      workspaceId: "workspace_02",
      vaultId: first.id,
    })).resolves.toEqual({ vault: first, revision: 1 });
  });

  it("deletes the vault with its credentials and keeps another vault", async () => {
    const store = new SqlVaultStore(client);
    const first = vault("vlt_01", "2026-08-26T10:00:00.000Z");
    const other = vault("vlt_02", "2026-08-26T11:00:00.000Z");
    await store.insert({ workspaceId: W, vault: first });
    await store.insert({ workspaceId: W, vault: other });
    await insertCredential(client, first.id, "cred_1");
    await insertCredential(client, first.id, "cred_2");
    await insertCredential(client, other.id, "cred_3");

    await expect(store.delete({
      workspaceId: W,
      vaultId: first.id,
      expectedRevision: 1,
    })).resolves.toEqual({ type: "deleted" });
    await expect(rowsOf(client, first.id))
      .resolves.toEqual({ vault: 0, credentials: 0 });
    await expect(rowsOf(client, other.id))
      .resolves.toEqual({ vault: 1, credentials: 1 });
    await expect(store.delete({ workspaceId: W, vaultId: first.id }))
      .resolves.toEqual({ type: "not_found" });
    await expect(store.delete({
      workspaceId: W,
      vaultId: first.id,
      expectedRevision: 1,
    })).resolves.toEqual({ type: "not_found" });
  });

  it("archive and delete with a stale revision keep the vault and its credentials", async () => {
    const store = new SqlVaultStore(client);
    const first = vault("vlt_01", "2026-08-26T10:00:00.000Z");
    await store.insert({ workspaceId: W, vault: first });
    await insertCredential(client, first.id, "cred_1");
    await store.replace({
      workspaceId: W,
      vaultId: first.id,
      expectedRevision: 1,
      next: { ...first, displayName: "Renamed" },
    });

    await expect(store.archive({
      workspaceId: W,
      vaultId: first.id,
      archivedAt: "2026-08-26T13:00:00.000Z",
      expectedRevision: 1,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.delete({
      workspaceId: W,
      vaultId: first.id,
      expectedRevision: 1,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.find({ workspaceId: W, vaultId: first.id }))
      .resolves.toMatchObject({ revision: 2, vault: { archivedAt: null } });
    await expect(rowsOf(client, first.id))
      .resolves.toEqual({ vault: 1, credentials: 1 });

    await expect(store.archive({
      workspaceId: W,
      vaultId: first.id,
      archivedAt: "2026-08-26T13:00:00.000Z",
      expectedRevision: 2,
    })).resolves.toMatchObject({ type: "archived", record: { revision: 3 } });
    await expect(store.archive({
      workspaceId: W,
      vaultId: "vlt_missing",
      archivedAt: "2026-08-26T13:00:00.000Z",
      expectedRevision: 1,
    })).resolves.toEqual({ type: "not_found" });
  });

  it("keeps the vault and its credentials when the credential delete fails", async () => {
    const store = new SqlVaultStore(client);
    const first = vault("vlt_01", "2026-08-26T10:00:00.000Z");
    await store.insert({ workspaceId: W, vault: first });
    await insertCredential(client, first.id, "cred_1");
    await client.exec(`
      CREATE TRIGGER managed_credentials_no_delete BEFORE DELETE ON managed_credentials
      BEGIN SELECT RAISE(ABORT, 'credential delete refused'); END;
    `);

    await expect(store.delete({ workspaceId: W, vaultId: first.id }))
      .rejects.toThrow("credential delete refused");
    await expect(rowsOf(client, first.id))
      .resolves.toEqual({ vault: 1, credentials: 1 });
  });
});
