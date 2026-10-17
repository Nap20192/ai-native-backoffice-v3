import type { Agent } from "@open-managed-agents/domain/agents";

export type AgentRecord = Agent;

export interface InsertAgentRecord {
  workspaceId: string;
  agent: AgentRecord;
}

export interface ReplaceAgentRecord {
  workspaceId: string;
  agentId: string;
  expectedVersion: number;
  next: AgentRecord;
}

export interface FindCurrentAgentRecord {
  workspaceId: string;
  agentId: string;
}

export interface FindAgentVersionRecord extends FindCurrentAgentRecord {
  version: number;
}

export type ReplaceAgentRecordResult =
  | { type: "replaced"; agent: AgentRecord }
  | { type: "not_found" }
  | { type: "version_conflict"; actualVersion: number };

export interface ArchiveAgentRecord {
  workspaceId: string;
  agentId: string;
  archivedAt: string;
}

export type ArchiveAgentRecordResult =
  | { type: "archived"; agent: AgentRecord }
  | { type: "not_found" };

export interface UnarchiveAgentRecord {
  workspaceId: string;
  agentId: string;
  updatedAt: string;
}

/** Restore keeps the version: it clears archivedAt and sets updatedAt. */
export type UnarchiveAgentRecordResult =
  | { type: "unarchived"; agent: AgentRecord }
  | { type: "not_found" };

export type DeleteAgentRecordResult =
  | { type: "deleted" }
  | { type: "not_found" };

/**
 * Agents that reference another object (docs/plans/crud.md, 1.3). Every set
 * filter must match. `harness` matches `openma.harness` or the ACP agent id
 * `openma.acp.agent.id`, the key a harness card is found by. With
 * `allVersions` the old versions of every agent are searched too and each
 * matching version comes back as its own record.
 */
export interface ListReferencingAgentRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  allVersions: boolean;
  skillId?: string;
  skillVersion?: string;
  model?: string;
  harness?: string;
}

export interface AgentListPosition {
  createdAt: string;
  agentId: string;
}

export interface ListAgentRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  after?: AgentListPosition;
}

export interface ListAgentVersionRecords {
  workspaceId: string;
  agentId: string;
  beforeVersion: number;
  limit: number;
}

export interface AgentStore {
  insert(input: InsertAgentRecord): Promise<AgentRecord>;
  findCurrent(input: FindCurrentAgentRecord): Promise<AgentRecord | null>;
  findVersion(input: FindAgentVersionRecord): Promise<AgentRecord | null>;
  replaceCurrent(input: ReplaceAgentRecord): Promise<ReplaceAgentRecordResult>;
  archiveCurrent(input: ArchiveAgentRecord): Promise<ArchiveAgentRecordResult>;
  listCurrent(input: ListAgentRecords): Promise<AgentRecord[]>;
  listVersions(input: ListAgentVersionRecords): Promise<AgentRecord[]>;
  unarchiveCurrent(input: UnarchiveAgentRecord): Promise<UnarchiveAgentRecordResult>;
  /** Deletes the current record and every stored version. */
  deleteCurrent(input: FindCurrentAgentRecord): Promise<DeleteAgentRecordResult>;
  listReferencing(input: ListReferencingAgentRecords): Promise<AgentRecord[]>;
}

/** True when the agent matches every filter of {@link ListReferencingAgentRecords}. */
export function agentReferences(
  agent: AgentRecord,
  filter: Pick<ListReferencingAgentRecords, "skillId" | "skillVersion" | "model" | "harness">,
): boolean {
  if (filter.skillId !== undefined) {
    const matches = agent.skills.some((skill) =>
      skill.skillId === filter.skillId
      && (filter.skillVersion === undefined || skill.version === filter.skillVersion));
    if (!matches) return false;
  } else if (filter.skillVersion !== undefined) {
    return false;
  }
  if (filter.model !== undefined && agent.model.id !== filter.model) return false;
  if (filter.harness !== undefined) {
    const openma = agent.openma;
    if (openma?.harness !== filter.harness && openma?.acp?.agent.id !== filter.harness) {
      return false;
    }
  }
  return true;
}
