// Memory stores with seed helpers for archive, restore and delete tests
// (docs/plans/crud.md). The application tests and the HTTP tests of
// platform-node share it.
import type { Agent } from "@open-managed-agents/domain/agents";
import type { Deployment } from "@open-managed-agents/domain/deployments";
import type { EnvironmentWorkState } from "@open-managed-agents/domain/environment-work";
import type { Session } from "@open-managed-agents/domain/sessions";
import { MemoryAgentStore } from "../../agent-store-memory/src/index";
import { MemoryCredentialStore } from "../../credential-store-memory/src/index";
import { MemoryDeploymentStore } from "../../deployment-store-memory/src/index";
import { MemoryEnvironmentStore } from "../../environment-store-memory/src/index";
import { MemoryEnvironmentWorkStore } from "../../environment-work-store-memory/src/index";
import { MemoryFileStore } from "../../file-store-memory/src/index";
import { InMemoryMemoryDocumentStore } from "../../memory-document-store-memory/src/index";
import { InMemoryMemoryStoreStore } from "../../memory-store-store-memory/src/index";
import { MemorySessionStore } from "../../session-store-memory/src/index";
import { MemorySkillStore } from "../../skill-store-memory/src/index";
import { MemoryVaultStore } from "../../vault-store-memory/src/index";
import {
  DependenciesApplicationService,
  type DependenciesApplicationServiceDependencies,
} from "../src/dependencies/application";

export const WORKSPACE = "workspace_crud";
export const T0 = "2026-10-01T00:00:00.000Z";

export type CrudStores = Omit<DependenciesApplicationServiceDependencies, "workspaceId">;

export function createCrudStores(): CrudStores {
  return {
    agents: new MemoryAgentStore(),
    sessions: new MemorySessionStore(),
    deployments: new MemoryDeploymentStore(),
    environments: new MemoryEnvironmentStore(),
    environmentWork: new MemoryEnvironmentWorkStore(),
    files: new MemoryFileStore(),
    skills: new MemorySkillStore(),
    memoryStores: new InMemoryMemoryStoreStore(),
    memories: new InMemoryMemoryDocumentStore(),
    vaults: new MemoryVaultStore(),
    credentials: new MemoryCredentialStore(),
  };
}

export function dependencyService(
  stores: CrudStores,
  workspaceId = WORKSPACE,
): DependenciesApplicationService {
  return new DependenciesApplicationService({ workspaceId, ...stores });
}

export function agentRecord(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    archivedAt: null,
    createdAt: T0,
    description: null,
    mcpServers: [],
    metadata: {},
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: `Agent ${id}`,
    skills: [],
    system: null,
    tools: [],
    updatedAt: T0,
    version: 1,
    ...patch,
  };
}

export function sessionRecord(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    agent: {
      id: "agent_main",
      description: null,
      mcpServers: [],
      model: { id: "claude-opus-5" },
      multiagent: null,
      name: "Agent agent_main",
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt: T0,
    environmentId: "env_main",
    metadata: {},
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status: "idle",
    title: `Session ${id}`,
    updatedAt: T0,
    usage: {},
    vaultIds: [],
    ...patch,
  } as Session;
}

export function deploymentRecord(id: string, patch: Partial<Deployment> = {}): Deployment {
  return {
    id,
    agent: { id: "agent_main", version: 1 },
    archivedAt: null,
    createdAt: T0,
    description: null,
    environmentId: "env_main",
    initialEvents: [{ type: "user.message", content: [{ type: "text", text: "Go" }] }],
    metadata: {},
    name: `Deployment ${id}`,
    pausedReason: null,
    resources: [],
    schedule: null,
    status: "active",
    updatedAt: T0,
    vaultIds: [],
    ...patch,
  } as Deployment;
}

/** Seed helpers: each writes straight into the memory stores. */
export function seeder(stores: CrudStores, workspaceId = WORKSPACE) {
  return {
    agent: (id: string, patch: Partial<Agent> = {}) =>
      stores.agents.insert({ workspaceId, agent: agentRecord(id, patch) }),
    session: (id: string, patch: Partial<Session> = {}) =>
      stores.sessions.insert({
        workspaceId,
        session: sessionRecord(id, patch),
        initialEvents: [],
        resourceSecrets: [],
      }),
    deployment: (id: string, patch: Partial<Deployment> = {}) =>
      stores.deployments.insert({
        workspaceId,
        record: { deployment: deploymentRecord(id, patch), resourceSecrets: [] },
      }),
    environment: (id: string, archivedAt: string | null = null) =>
      stores.environments.insert({
        workspaceId,
        environment: {
          id,
          archivedAt,
          config: { type: "self_hosted" },
          createdAt: T0,
          description: null,
          metadata: {},
          name: `Environment ${id}`,
          updatedAt: T0,
        },
      }),
    environmentWork: (environmentId: string, id: string, state: EnvironmentWorkState) =>
      stores.environmentWork.insert({
        workspaceId,
        record: {
          work: {
            id,
            acknowledgedAt: null,
            createdAt: T0,
            data: { type: "session", id: `sesn_${id}` },
            environmentId,
            latestHeartbeatAt: null,
            metadata: {},
            startedAt: null,
            state,
            stopRequestedAt: null,
            stoppedAt: state === "stopped" ? T0 : null,
          },
          secret: { sessionsToken: "token" },
          claim: null,
          heartbeatTtlSeconds: 60,
        },
      }),
    file: (id: string, sessionId?: string) =>
      stores.files.insert({
        workspaceId,
        file: {
          id,
          createdAt: T0,
          filename: `${id}.txt`,
          mimeType: "text/plain",
          sizeBytes: 4,
          ...(sessionId === undefined ? {} : { scope: { type: "session" as const, id: sessionId } }),
        },
      }),
    skill: async (id: string, versions: string[]) => {
      const [first, ...rest] = versions;
      if (first === undefined) throw new Error("a skill needs a version");
      const version = (value: string) => ({
        id: `skillver_${id}_${value}`,
        createdAt: T0,
        description: "skill",
        directory: id,
        name: id,
        skillId: id,
        version: value,
      });
      const archive = { content: new Uint8Array([1]), filename: `${id}.zip`, mediaType: "application/zip" };
      const inserted = await stores.skills.insertWithInitialVersion({
        workspaceId,
        skill: {
          id,
          createdAt: T0,
          displayTitle: id,
          latestVersion: first,
          source: "custom",
          updatedAt: T0,
        },
        version: version(first),
        archive,
      });
      let revision = inserted.skill.revision;
      for (const value of rest) {
        const appended = await stores.skills.appendVersion({
          workspaceId,
          skillId: id,
          expectedSkillRevision: revision,
          nextSkill: { ...inserted.skill.skill, latestVersion: value },
          version: version(value),
          archive,
        });
        if (appended.type !== "appended") throw new Error("append failed");
        revision = appended.skill.revision;
      }
    },
    memoryStore: (id: string) =>
      stores.memoryStores.insert({
        workspaceId,
        memoryStore: { id, createdAt: T0, name: `Memory ${id}`, updatedAt: T0, archivedAt: null },
      }),
    memory: (memoryStoreId: string, id: string, path: string) =>
      stores.memories.create({
        workspaceId,
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
      }),
    vault: (id: string) =>
      stores.vaults.insert({
        workspaceId,
        vault: { id, archivedAt: null, createdAt: T0, displayName: `Vault ${id}`, metadata: {}, updatedAt: T0 },
      }),
    credential: (vaultId: string, id: string) =>
      stores.credentials.insert({
        workspaceId,
        credential: {
          id,
          archivedAt: null,
          auth: { type: "static_bearer", token: "secret", mcpServerUrl: `https://${id}.example.com/sse` },
          createdAt: T0,
          metadata: {},
          updatedAt: T0,
          vaultId,
        } as never,
      }),
  };
}
