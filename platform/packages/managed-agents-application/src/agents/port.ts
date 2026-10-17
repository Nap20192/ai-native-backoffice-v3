import type { Agent, AgentModel } from "../domain/agent";
import type { DependencyConflict } from "../ports/dependencies";
import type {
  AgentMcpServerInput,
  AgentModelInput,
  AgentMultiagentInput,
  AgentOpenMaInput,
  AgentSkillInput,
  AgentToolInput,
} from "./wire-shape-input.js";

export type {
  AgentMcpServerInput,
  AgentMultiagentInput,
  AgentSkillInput,
  AgentToolInput,
} from "./wire-shape-input.js";

export type { AgentEffortLevel, AgentSpeed } from "../domain/agent";

export type {
  AgentContextManagementEditWireInput as AgentContextManagementEditInput,
  AgentContextManagementWireInput as AgentContextManagementInput,
  AgentModelInput,
  AgentOpenAiModelSettingsWireInput as AgentOpenAiModelSettingsInput,
  AgentOpenMaInput,
} from "./wire-shape-input.js";

export type AgentModelView = AgentModel;

export interface CreateAgentCommand {
  name: string;
  model: string | AgentModelInput;
  description?: string | null;
  mcpServers?: AgentMcpServerInput[];
  metadata?: Record<string, string>;
  multiagent?: AgentMultiagentInput | null;
  openma?: AgentOpenMaInput;
  skills?: AgentSkillInput[];
  system?: string | null;
  tools?: AgentToolInput[];
}

export interface RetrieveAgentQuery {
  agentId: string;
  version?: number;
}

export interface UpdateAgentCommand {
  agentId: string;
  description?: string | null;
  mcpServers?: AgentMcpServerInput[] | null;
  metadata?: Record<string, string | null> | null;
  model?: string | AgentModelInput;
  multiagent?: AgentMultiagentInput | null;
  name?: string;
  openma?: AgentOpenMaInput;
  skills?: AgentSkillInput[] | null;
  system?: string | null;
  tools?: AgentToolInput[] | null;
  expectedVersion?: number;
}

export interface ArchiveAgentCommand {
  agentId: string;
  /** The current version from ETag (`If-Match`). Another version gives precondition_failed. */
  expectedVersion?: number;
}

export interface UnarchiveAgentCommand {
  agentId: string;
  expectedVersion?: number;
}

export interface DeleteAgentCommand {
  agentId: string;
  expectedVersion?: number;
}

export interface ListAgentsQuery {
  pageSize?: number;
  cursor?: string;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  includeArchived?: boolean;
}

export interface ListAgentVersionsQuery {
  agentId: string;
  pageSize?: number;
  cursor?: string;
}

export type AgentView = Agent;

export type CreateAgentResult =
  | { type: "created"; agent: AgentView }
  | { type: "invalid_request"; message: string };

export type RetrieveAgentResult =
  | { type: "found"; agent: AgentView }
  | { type: "not_found" };

export type UpdateAgentResult =
  | { type: "updated"; agent: AgentView }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" }
  | { type: "version_conflict"; message: string };

export type ArchiveAgentResult =
  | { type: "archived"; agent: AgentView }
  | { type: "precondition_failed"; message: string }
  | DependencyConflict
  | { type: "not_found" };

/** Restore keeps the version. An agent out of the archive stays as it is. */
export type UnarchiveAgentResult =
  | { type: "unarchived"; agent: AgentView }
  | { type: "precondition_failed"; message: string }
  | { type: "not_found" };

/** Delete removes the agent and all its versions. Sessions keep their snapshot. */
export type DeleteAgentResult =
  | { type: "deleted"; agentId: string }
  | { type: "precondition_failed"; message: string }
  | DependencyConflict
  | { type: "not_found" };

export interface ListAgentsPage {
  agents: AgentView[];
  nextCursor: string | null;
}

export type ListAgentsResult =
  | { type: "page"; page: ListAgentsPage }
  | { type: "invalid_request"; message: string };

export type ListAgentVersionsResult =
  | { type: "page"; page: ListAgentsPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export interface AgentsApplicationPort {
  createAgent(command: CreateAgentCommand): Promise<CreateAgentResult>;
  retrieveAgent(query: RetrieveAgentQuery): Promise<RetrieveAgentResult>;
  updateAgent(command: UpdateAgentCommand): Promise<UpdateAgentResult>;
  archiveAgent(command: ArchiveAgentCommand): Promise<ArchiveAgentResult>;
  unarchiveAgent(command: UnarchiveAgentCommand): Promise<UnarchiveAgentResult>;
  deleteAgent(command: DeleteAgentCommand): Promise<DeleteAgentResult>;
  listAgents(query: ListAgentsQuery): Promise<ListAgentsResult>;
  listAgentVersions(query: ListAgentVersionsQuery): Promise<ListAgentVersionsResult>;
}
