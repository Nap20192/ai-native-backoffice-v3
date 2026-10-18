// Store support for archive, restore and delete with dependencies
// (docs/plans/crud.md, A1, A5, A11, A12). Every case runs against the memory
// store and the SQLite store, so both keep the same contract.
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "../../managed-agents-domain/src/agents/index";
import type { Credential } from "../../managed-agents-domain/src/credentials/index";
import type { Deployment } from "../../managed-agents-domain/src/deployments/index";
import type { Memory, MemoryVersion } from "../../managed-agents-domain/src/memories/index";
import type { Session } from "../../managed-agents-domain/src/sessions/index";
import type { AgentStore } from "../../agent-store/src/index";
import type { CredentialStore } from "../../credential-store/src/index";
import type { DeploymentStore } from "../../deployment-store/src/index";
import type { MemoryDocumentStore } from "../../memory-document-store/src/index";
import type { SessionStore } from "../../session-store/src/index";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { MemoryAgentStore } from "../../agent-store-memory/src/index";
import { SqlAgentStore } from "../../agent-store-sql/src/index";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import { SqlCredentialStore } from "../../credential-store-sql/src/index";
import { MemoryDeploymentStore } from "../../deployment-store-memory/src/index";
import { SqlDeploymentStore } from "../../deployment-store-sql/src/index";
import { InMemoryMemoryDocumentStore } from "../../memory-document-store-memory/src/index";
import { SqlMemoryDocumentStore } from "../../memory-document-store-sql/src/index";
import { MemorySessionStore } from "../../session-store-memory/src/index";
import { SqlSessionStore } from "../../session-store-sql/src/index";

const SCHEMA = `
CREATE TABLE managed_agents (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  version integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE TABLE managed_agent_versions (
  agent_id text NOT NULL,
  workspace_id text NOT NULL,
  version integer NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  PRIMARY KEY (agent_id, version)
);
CREATE TABLE managed_sessions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  agent_version integer NOT NULL,
  environment_id text NOT NULL,
  deployment_id text,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE TABLE managed_session_memory_stores (
  session_id text NOT NULL,
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  PRIMARY KEY (session_id, memory_store_id)
);
CREATE TABLE managed_session_initial_events (
  session_id text NOT NULL,
  workspace_id text NOT NULL,
  sequence integer NOT NULL,
  document text NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
CREATE TABLE managed_session_resource_secrets (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  resource_id text NOT NULL,
  secret_type text NOT NULL,
  sealed_value text NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, resource_id)
);
CREATE TABLE managed_session_events (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  type text NOT NULL,
  document text NOT NULL,
  processed_at integer NOT NULL,
  thread_id text,
  PRIMARY KEY (workspace_id, session_id, id)
);
CREATE TABLE managed_session_threads (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, session_id, id)
);
CREATE TABLE managed_deployments (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  sealed_resource_secrets text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_memories (
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  path text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX idx_managed_memories_workspace_store_path
  ON managed_memories (workspace_id, memory_store_id, path);
CREATE TABLE managed_memory_versions (
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  id text NOT NULL,
  memory_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  operation text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  created_at integer NOT NULL,
  redacted_at integer,
  PRIMARY KEY (workspace_id, id)
);
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

const W = "workspace_crud";
const T0 = "2026-10-01T00:00:00.000Z";

const identityCipher = {
  seal: async ({ plaintext }: { plaintext: string }) => ({ ciphertext: plaintext }),
  open: async ({ ciphertext }: { ciphertext: string }) => ({ plaintext: ciphertext }),
};

interface Stores {
  agents: AgentStore;
  sessions: SessionStore;
  deployments: DeploymentStore;
  memories: MemoryDocumentStore;
  credentials: CredentialStore;
  /** The SQLite client, to seed and count rows no store port reaches. */
  client?: SqlClient;
}

async function sqlStores(): Promise<Stores> {
  const client: SqlClient = await createBetterSqlite3SqlClient(":memory:");
  await client.exec(SCHEMA);
  return {
    agents: new SqlAgentStore(client),
    sessions: new SqlSessionStore(client, { seal: async (value) => value }),
    deployments: new SqlDeploymentStore(client, identityCipher),
    memories: new SqlMemoryDocumentStore(client),
    credentials: new SqlCredentialStore(client, identityCipher),
    client,
  };
}

function memoryStores(): Stores {
  const sessions = new MemorySessionStore();
  return {
    agents: new MemoryAgentStore(),
    sessions,
    deployments: new MemoryDeploymentStore(),
    memories: new InMemoryMemoryDocumentStore(),
    credentials: new MemoryCredentialStore(),
  };
}

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    archivedAt: null,
    createdAt: T0,
    description: null,
    mcpServers: [],
    metadata: {},
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: id,
    skills: [],
    system: null,
    tools: [],
    updatedAt: T0,
    version: 1,
    ...patch,
  };
}

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    agent: {
      id: "agent_x",
      description: null,
      mcpServers: [],
      model: { id: "claude-opus-5" },
      multiagent: null,
      name: "agent_x",
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt: T0,
    environmentId: "env_a",
    metadata: {},
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status: "idle",
    title: id,
    updatedAt: T0,
    usage: {},
    vaultIds: [],
    ...patch,
  } as Session;
}

function deployment(id: string, patch: Partial<Deployment> = {}): Deployment {
  return {
    id,
    agent: { id: "agent_x", version: 1 },
    archivedAt: null,
    createdAt: T0,
    description: null,
    environmentId: "env_a",
    initialEvents: [],
    metadata: {},
    name: id,
    pausedReason: null,
    resources: [],
    schedule: null,
    status: "active",
    updatedAt: T0,
    vaultIds: [],
    ...patch,
  };
}

function memory(id: string, memoryStoreId: string, path: string): { memory: Memory; version: MemoryVersion } {
  return {
    memory: {
      id,
      content: "text",
      contentSha256: "sha",
      contentSizeBytes: 4,
      createdAt: T0,
      memoryStoreId,
      memoryVersionId: `${id}_v1`,
      path,
      updatedAt: T0,
    },
    version: {
      id: `${id}_v1`,
      content: "text",
      contentSha256: "sha",
      contentSizeBytes: 4,
      createdAt: T0,
      createdBy: { kind: "user", userId: "user_1" },
      memoryId: id,
      memoryStoreId,
      operation: "created",
      path,
      redactedAt: null,
    },
  };
}

function credential(id: string, vaultId: string): Credential {
  return {
    id,
    archivedAt: null,
    auth: { type: "static_bearer", token: "secret", mcpServerUrl: `https://${id}.example.com/sse` },
    createdAt: T0,
    metadata: {},
    updatedAt: T0,
    vaultId,
  } as Credential;
}

/** Tables that hold one session's rows, with the column of the session id. */
const SESSION_TABLES = [
  ["managed_sessions", "id"],
  ["managed_session_events", "session_id"],
  ["managed_session_threads", "session_id"],
  ["managed_session_resource_secrets", "session_id"],
  ["managed_session_initial_events", "session_id"],
  ["managed_session_memory_stores", "session_id"],
] as const;

const ALL_SESSION_ROWS = Object.fromEntries(SESSION_TABLES.map(([table]) => [table, 1]));
const NO_SESSION_ROWS = Object.fromEntries(SESSION_TABLES.map(([table]) => [table, 0]));

/**
 * A session with one row in every child table. The store writes the initial
 * event, the resource secret and the memory store link. Events and threads
 * belong to other stores, so on SQLite the test writes them directly.
 */
async function insertSessionWithRows(stores: Stores, sessionId: string): Promise<void> {
  await stores.sessions.insert({
    workspaceId: W,
    session: session(sessionId, { resources: [{ type: "memory_store", memoryStoreId: "memstore_a" }] }),
    initialEvents: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }],
    resourceSecrets: [{ type: "github_token", resourceId: `res_${sessionId}`, authorizationToken: "token" }],
  });
  if (stores.client === undefined) return;
  await stores.client.batch([
    stores.client
      .prepare(
        `INSERT INTO managed_session_events (workspace_id, session_id, id, type, document, processed_at)
         VALUES (?, ?, ?, 'user.message', '{}', 0)`,
      )
      .bind(W, sessionId, `event_${sessionId}`),
    stores.client
      .prepare(
        `INSERT INTO managed_session_threads (workspace_id, session_id, id, document, created_at, updated_at)
         VALUES (?, ?, ?, '{}', 0, 0)`,
      )
      .bind(W, sessionId, `thread_${sessionId}`),
  ]);
}

/**
 * Row counts of one session per table. The memory store keeps no child rows,
 * so there only the session row counts and the children follow it.
 */
async function sessionRows(stores: Stores, sessionId: string): Promise<Record<string, number>> {
  const client = stores.client;
  if (client === undefined) {
    const found = await stores.sessions.findCurrent({ workspaceId: W, sessionId });
    return found === null ? NO_SESSION_ROWS : ALL_SESSION_ROWS;
  }
  const counts: Record<string, number> = {};
  for (const [table, column] of SESSION_TABLES) {
    const row = await client
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? AND ${column} = ?`)
      .bind(W, sessionId)
      .first<{ count: number }>();
    counts[table] = Number(row?.count ?? 0);
  }
  return counts;
}

const factories: Array<[string, () => Promise<Stores> | Stores]> = [
  ["memory", memoryStores],
  ["SQLite", sqlStores],
];

describe.each(factories)("%s stores for archive, restore and delete", (_label, make) => {
  let stores: Stores;
  beforeEach(async () => {
    stores = await make();
  });

  describe("agents", () => {
    it("finds current agents by skill, skill version and model", async () => {
      await stores.agents.insert({ workspaceId: W, agent: agent("agent_skill", {
        skills: [{ skillId: "skill_a", type: "custom", version: "3" }],
      }) });
      await stores.agents.insert({ workspaceId: W, agent: agent("agent_latest", {
        skills: [{ skillId: "skill_a", type: "custom", version: "latest" }],
      }) });
      await stores.agents.insert({ workspaceId: W, agent: agent("agent_model", {
        model: { id: "card-model" },
      }) });
      await stores.agents.insert({ workspaceId: "other", agent: agent("agent_foreign", {
        model: { id: "card-model" },
      }) });

      const ids = async (filter: Parameters<AgentStore["listReferencing"]>[0]) =>
        (await stores.agents.listReferencing(filter)).map((record) => record.id).sort();
      const base = { workspaceId: W, limit: 10, includeArchived: true, allVersions: false };
      await expect(ids({ ...base, skillId: "skill_a" })).resolves.toEqual(["agent_latest", "agent_skill"]);
      await expect(ids({ ...base, skillId: "skill_a", skillVersion: "3" })).resolves.toEqual(["agent_skill"]);
      await expect(ids({ ...base, model: "card-model" })).resolves.toEqual(["agent_model"]);
      await expect(ids({ ...base, model: "claude-opus" })).resolves.toEqual([]);
    });

    it("skips archived agents unless asked and searches old versions with allVersions", async () => {
      const first = agent("agent_old", { model: { id: "old-model" } });
      await stores.agents.insert({ workspaceId: W, agent: first });
      await stores.agents.replaceCurrent({
        workspaceId: W,
        agentId: first.id,
        expectedVersion: 1,
        next: { ...first, model: { id: "new-model" }, version: 2, updatedAt: "2026-10-01T01:00:00.000Z" },
      });
      await stores.agents.insert({ workspaceId: W, agent: agent("agent_archived", { model: { id: "m1" } }) });
      await stores.agents.archiveCurrent({ workspaceId: W, agentId: "agent_archived", archivedAt: T0 });

      const base = { workspaceId: W, limit: 10, allVersions: false };
      await expect(stores.agents.listReferencing({ ...base, includeArchived: false, model: "m1" }))
        .resolves.toEqual([]);
      await expect(stores.agents.listReferencing({ ...base, includeArchived: true, model: "m1" }))
        .resolves.toMatchObject([{ id: "agent_archived" }]);
      await expect(stores.agents.listReferencing({ ...base, includeArchived: true, model: "old-model" }))
        .resolves.toEqual([]);
      await expect(stores.agents.listReferencing({
        ...base, includeArchived: true, allVersions: true, model: "old-model",
      })).resolves.toMatchObject([{ id: "agent_old", version: 1 }]);
    });

    it("loads an agent stored with the removed acp extension", async () => {
      const legacy = agent("agent_legacy_acp", {
        openma: {
          harness: "acp-sandbox",
          acp: { agent: { id: "claude-acp", command: "run" } },
        } as unknown as Agent["openma"],
      });
      await stores.agents.insert({ workspaceId: W, agent: legacy });
      await expect(stores.agents.findCurrent({ workspaceId: W, agentId: legacy.id }))
        .resolves.toMatchObject({ id: "agent_legacy_acp", openma: { harness: "acp-sandbox" } });
    });

    it("restores an archived agent without a new version", async () => {
      await stores.agents.insert({ workspaceId: W, agent: agent("agent_r") });
      await stores.agents.archiveCurrent({ workspaceId: W, agentId: "agent_r", archivedAt: "2026-10-02T00:00:00.000Z" });
      const restored = await stores.agents.unarchiveCurrent({
        workspaceId: W,
        agentId: "agent_r",
        updatedAt: "2026-10-03T00:00:00.000Z",
      });
      expect(restored).toMatchObject({
        type: "unarchived",
        agent: { id: "agent_r", archivedAt: null, version: 1, updatedAt: "2026-10-03T00:00:00.000Z" },
      });
      await expect(stores.agents.unarchiveCurrent({
        workspaceId: W, agentId: "missing", updatedAt: T0,
      })).resolves.toEqual({ type: "not_found" });
    });

    it("deletes the current agent with all its versions", async () => {
      const first = agent("agent_d");
      await stores.agents.insert({ workspaceId: W, agent: first });
      await stores.agents.replaceCurrent({
        workspaceId: W, agentId: first.id, expectedVersion: 1,
        next: { ...first, name: "two", version: 2 },
      });
      await stores.agents.insert({ workspaceId: W, agent: agent("agent_keep") });

      await expect(stores.agents.deleteCurrent({ workspaceId: W, agentId: first.id }))
        .resolves.toEqual({ type: "deleted" });
      await expect(stores.agents.findCurrent({ workspaceId: W, agentId: first.id })).resolves.toBeNull();
      await expect(stores.agents.findVersion({ workspaceId: W, agentId: first.id, version: 1 }))
        .resolves.toBeNull();
      await expect(stores.agents.findCurrent({ workspaceId: W, agentId: "agent_keep" }))
        .resolves.not.toBeNull();
      await expect(stores.agents.deleteCurrent({ workspaceId: W, agentId: first.id }))
        .resolves.toEqual({ type: "not_found" });
    });

    it("archive, restore and delete with a stale version change nothing", async () => {
      const first = agent("agent_v");
      await stores.agents.insert({ workspaceId: W, agent: first });
      await stores.agents.replaceCurrent({
        workspaceId: W, agentId: first.id, expectedVersion: 1,
        next: { ...first, name: "two", version: 2 },
      });
      const current = () => stores.agents.findCurrent({ workspaceId: W, agentId: first.id });
      const archivedAt = "2026-10-02T00:00:00.000Z";
      const restoredAt = "2026-10-03T00:00:00.000Z";

      await expect(stores.agents.archiveCurrent({
        workspaceId: W, agentId: first.id, archivedAt, expectedVersion: 1,
      })).resolves.toEqual({ type: "version_conflict", actualVersion: 2 });
      await expect(current()).resolves.toMatchObject({ archivedAt: null, version: 2, updatedAt: T0 });
      await expect(stores.agents.archiveCurrent({
        workspaceId: W, agentId: first.id, archivedAt, expectedVersion: 2,
      })).resolves.toMatchObject({ type: "archived", agent: { archivedAt, version: 2 } });

      await expect(stores.agents.unarchiveCurrent({
        workspaceId: W, agentId: first.id, updatedAt: restoredAt, expectedVersion: 1,
      })).resolves.toEqual({ type: "version_conflict", actualVersion: 2 });
      await expect(current()).resolves.toMatchObject({ archivedAt, version: 2 });
      await expect(stores.agents.unarchiveCurrent({
        workspaceId: W, agentId: first.id, updatedAt: restoredAt, expectedVersion: 2,
      })).resolves.toMatchObject({ type: "unarchived", agent: { archivedAt: null, version: 2 } });

      await expect(stores.agents.deleteCurrent({ workspaceId: W, agentId: first.id, expectedVersion: 1 }))
        .resolves.toEqual({ type: "version_conflict", actualVersion: 2 });
      await expect(current()).resolves.toMatchObject({ version: 2 });
      await expect(stores.agents.findVersion({ workspaceId: W, agentId: first.id, version: 1 }))
        .resolves.toMatchObject({ id: first.id, version: 1 });
      await expect(stores.agents.deleteCurrent({ workspaceId: W, agentId: first.id, expectedVersion: 2 }))
        .resolves.toEqual({ type: "deleted" });
      await expect(current()).resolves.toBeNull();
      await expect(stores.agents.findVersion({ workspaceId: W, agentId: first.id, version: 1 }))
        .resolves.toBeNull();

      await expect(stores.agents.archiveCurrent({
        workspaceId: W, agentId: first.id, archivedAt, expectedVersion: 2,
      })).resolves.toEqual({ type: "not_found" });
      await expect(stores.agents.unarchiveCurrent({
        workspaceId: W, agentId: first.id, updatedAt: restoredAt, expectedVersion: 2,
      })).resolves.toEqual({ type: "not_found" });
      await expect(stores.agents.deleteCurrent({ workspaceId: W, agentId: first.id, expectedVersion: 2 }))
        .resolves.toEqual({ type: "not_found" });
    });
  });

  describe("sessions", () => {
    it("filters by environment, file and vault", async () => {
      const insert = (value: Session) =>
        stores.sessions.insert({ workspaceId: W, session: value, initialEvents: [], resourceSecrets: [] });
      await insert(session("sesn_env_b", { environmentId: "env_b" }));
      await insert(session("sesn_file", {
        resources: [{
          id: "res_1", type: "file", createdAt: T0, fileId: "file_a", mountPath: "/mnt/a", updatedAt: T0,
        }],
      }));
      await insert(session("sesn_vault", { vaultIds: ["vlt_a"] }));
      await insert(session("sesn_mention", { title: "file_a vlt_a env_b" }));

      const ids = async (filter: Partial<Parameters<SessionStore["listCurrent"]>[0]>) =>
        (await stores.sessions.listCurrent({
          workspaceId: W, limit: 10, includeArchived: true, order: "asc", ...filter,
        })).map((record) => record.session.id).sort();
      await expect(ids({ environmentId: "env_b" })).resolves.toEqual(["sesn_env_b"]);
      await expect(ids({ fileId: "file_a" })).resolves.toEqual(["sesn_file"]);
      await expect(ids({ vaultId: "vlt_a" })).resolves.toEqual(["sesn_vault"]);
    });

    it("archive and delete with a stale revision keep the session and its rows", async () => {
      await insertSessionWithRows(stores, "sesn_r");
      await insertSessionWithRows(stores, "sesn_other");
      const first = await stores.sessions.findCurrent({ workspaceId: W, sessionId: "sesn_r" });
      await stores.sessions.replaceCurrent({
        workspaceId: W, sessionId: "sesn_r", expectedRevision: 1,
        next: { ...first!.session, title: "two" },
      });
      const current = () => stores.sessions.findCurrent({ workspaceId: W, sessionId: "sesn_r" });
      const rows = (sessionId: string) => sessionRows(stores, sessionId);
      const archivedAt = "2026-10-02T00:00:00.000Z";
      await expect(rows("sesn_r")).resolves.toEqual(ALL_SESSION_ROWS);

      await expect(stores.sessions.archiveCurrent({
        workspaceId: W, sessionId: "sesn_r", archivedAt, expectedRevision: 1,
      })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
      await expect(current()).resolves.toMatchObject({ revision: 2, session: { archivedAt: null, title: "two" } });

      await expect(stores.sessions.deleteCurrent({ workspaceId: W, sessionId: "sesn_r", expectedRevision: 1 }))
        .resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
      await expect(current()).resolves.toMatchObject({ revision: 2 });
      await expect(rows("sesn_r")).resolves.toEqual(ALL_SESSION_ROWS);

      await expect(stores.sessions.archiveCurrent({
        workspaceId: W, sessionId: "sesn_r", archivedAt, expectedRevision: 2,
      })).resolves.toMatchObject({ type: "archived", record: { revision: 3, session: { archivedAt } } });
      await expect(stores.sessions.deleteCurrent({ workspaceId: W, sessionId: "sesn_r", expectedRevision: 3 }))
        .resolves.toEqual({ type: "deleted" });
      await expect(current()).resolves.toBeNull();
      await expect(rows("sesn_r")).resolves.toEqual(NO_SESSION_ROWS);
      await expect(rows("sesn_other")).resolves.toEqual(ALL_SESSION_ROWS);

      await expect(stores.sessions.archiveCurrent({
        workspaceId: W, sessionId: "sesn_r", archivedAt, expectedRevision: 3,
      })).resolves.toEqual({ type: "not_found" });
      await expect(stores.sessions.deleteCurrent({ workspaceId: W, sessionId: "sesn_r", expectedRevision: 3 }))
        .resolves.toEqual({ type: "not_found" });
    });
  });

  describe("deployments", () => {
    it("filters by environment, file, memory store and vault", async () => {
      const insert = (value: Deployment) =>
        stores.deployments.insert({ workspaceId: W, record: { deployment: value, resourceSecrets: [] } });
      await insert(deployment("depl_env", { environmentId: "env_b" }));
      await insert(deployment("depl_file", { resources: [{ kind: "file", fileId: "file_a" }] }));
      await insert(deployment("depl_memory", {
        resources: [{ kind: "memory_store", memoryStoreId: "memstore_a" }],
      }));
      await insert(deployment("depl_vault", { vaultIds: ["vlt_a"] }));
      await insert(deployment("depl_mention", { name: "file_a memstore_a vlt_a env_b" }));

      const ids = async (filter: Partial<Parameters<DeploymentStore["list"]>[0]>) =>
        (await stores.deployments.list({ workspaceId: W, limit: 10, includeArchived: true, ...filter }))
          .map((record) => record.deployment.id).sort();
      await expect(ids({ environmentId: "env_b" })).resolves.toEqual(["depl_env"]);
      await expect(ids({ fileId: "file_a" })).resolves.toEqual(["depl_file"]);
      await expect(ids({ memoryStoreId: "memstore_a" })).resolves.toEqual(["depl_memory"]);
      await expect(ids({ vaultId: "vlt_a" })).resolves.toEqual(["depl_vault"]);
      await expect(ids({ vaultId: "vlt_a", limit: 1 } as never)).resolves.toEqual(["depl_vault"]);
    });
  });

  describe("memory documents", () => {
    it("deletes every memory and version of one store and keeps the others", async () => {
      for (const [id, store, path] of [
        ["mem_1", "memstore_a", "/a.md"],
        ["mem_2", "memstore_a", "/b.md"],
        ["mem_3", "memstore_b", "/a.md"],
      ] as const) {
        const created = memory(id, store, path);
        await stores.memories.create({ workspaceId: W, ...created });
      }
      await expect(stores.memories.deleteAllInStore({ workspaceId: W, memoryStoreId: "memstore_a" }))
        .resolves.toEqual({ deletedMemories: 2, deletedVersions: 2 });
      const left = await stores.memories.listCurrent({
        workspaceId: W, memoryStoreId: "memstore_a", limit: 10, depth: 10, pathPrefix: "/",
      });
      expect(left.items).toEqual([]);
      await expect(stores.memories.listVersions({ workspaceId: W, memoryStoreId: "memstore_a", limit: 10 }))
        .resolves.toEqual([]);
      await expect(stores.memories.findCurrent({ workspaceId: W, memoryStoreId: "memstore_b", memoryId: "mem_3" }))
        .resolves.not.toBeNull();
    });
  });

  describe("credentials", () => {
    it("deletes every credential of one vault and keeps the others", async () => {
      await stores.credentials.insert({ workspaceId: W, credential: credential("cred_1", "vlt_a") });
      await stores.credentials.insert({ workspaceId: W, credential: credential("cred_2", "vlt_a") });
      await stores.credentials.insert({ workspaceId: W, credential: credential("cred_3", "vlt_b") });
      await expect(stores.credentials.deleteAllInVault({ workspaceId: W, vaultId: "vlt_a" }))
        .resolves.toEqual({ deleted: 2 });
      await expect(stores.credentials.list({ workspaceId: W, vaultId: "vlt_a", limit: 10, includeArchived: true }))
        .resolves.toEqual([]);
      await expect(stores.credentials.list({ workspaceId: W, vaultId: "vlt_b", limit: 10, includeArchived: true }))
        .resolves.toHaveLength(1);
    });
  });
});

describe("SQLite session delete", () => {
  it("keeps the session and its rows when a child delete fails", async () => {
    const stores = await sqlStores();
    const client = stores.client!;
    await insertSessionWithRows(stores, "sesn_locked");
    await client.exec(`
      CREATE TRIGGER keep_session_threads BEFORE DELETE ON managed_session_threads
      BEGIN SELECT RAISE(ABORT, 'threads are locked'); END;
    `);
    await expect(stores.sessions.deleteCurrent({ workspaceId: W, sessionId: "sesn_locked", expectedRevision: 1 }))
      .rejects.toThrow("threads are locked");
    await expect(sessionRows(stores, "sesn_locked")).resolves.toEqual(ALL_SESSION_ROWS);
  });
});
