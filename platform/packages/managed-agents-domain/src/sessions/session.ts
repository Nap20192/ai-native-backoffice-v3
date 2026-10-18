import type { AgentModel, AgentOpenMaExtensions } from "../agents";
import type {
  AgentMcpServer,
  AgentMultiagentAdvisor,
  AgentSkill,
  AgentTool,
} from "../agents";
import type { SessionResource } from "./resource";
import type { SessionThreadAgent } from "./thread";

export type SessionStatus = "rescheduling" | "running" | "idle" | "terminated";

export interface MonetaryAmount {
  amountMinor: string;
  currency: "USD";
}

export interface SessionAgent {
  id: string;
  description: string | null;
  mcpServers: AgentMcpServer[];
  model: AgentModel;
  multiagent: SessionAgentMultiagent | null;
  name: string;
  openma?: AgentOpenMaExtensions;
  skills: AgentSkill[];
  system: string | null;
  tools: AgentTool[];
  version: number;
}

export interface SessionAgentCoordinatorMultiagent {
  agents: SessionThreadAgent[];
  type: "coordinator";
}

/** A listed agent as the Session copied it: the whole definition at its pin. */
export type SessionListedAgent = Extract<SessionThreadAgent, { type: "agent" }>;

export type SessionAgentMultiagentSetting =
  | {
      type: "enabled";
      inlineAgents: boolean;
      predefinedAgents: SessionListedAgent[];
    }
  | { type: "disabled" };

/**
 * A `multiagent_20261001` block as the Session copied it
 * (docs/plans/multiagent.md, 3.2): the type stays, and every listed agent is
 * there in full.
 */
export interface SessionAgentMultiagent20261001 {
  type: "multiagent_20261001";
  subagents: SessionAgentMultiagentSetting;
  workflows: SessionAgentMultiagentSetting;
  advisor: AgentMultiagentAdvisor;
}

export type SessionAgentMultiagent =
  | SessionAgentCoordinatorMultiagent
  | SessionAgentMultiagent20261001;

export interface SessionStats {
  activeSeconds?: number;
  durationSeconds?: number;
}

export interface SessionUsage {
  activeSeconds?: number;
  cacheCreation?: {
    ephemeralOneHourInputTokens?: number;
    ephemeralFiveMinuteInputTokens?: number;
  };
  cacheReadInputTokens?: number;
  inputTokens?: number;
  listCost?: MonetaryAmount | null;
  outputTokens?: number;
  serverToolUse?: {
    webFetchRequests?: number;
    webSearchRequests?: number;
  } | null;
}

export interface SessionOutcomeEvaluation {
  type: "outcome_evaluation";
  completedAt: string | null;
  description: string;
  explanation: string | null;
  iteration: number;
  outcomeId: string;
  result: string;
}

export interface Session {
  id: string;
  agent: SessionAgent;
  archivedAt: string | null;
  budget: MonetaryAmount | null;
  createdAt: string;
  environmentId: string;
  metadata: Record<string, string>;
  outcomeEvaluations: SessionOutcomeEvaluation[];
  resources: SessionResource[];
  stats: SessionStats;
  status: SessionStatus;
  title: string | null;
  updatedAt: string;
  usage: SessionUsage;
  vaultIds: string[];
  deploymentId?: string | null;
}

/**
 * Limits a Session is given or raised to (OpenMA extension `_oma.limits`,
 * docs/plans/multiagent.md, 3.Б). A missing value keeps the current one, on
 * create the server default.
 */
export interface SessionLimitsInput {
  maxTokens?: number;
  maxChildTurns?: number;
}

/**
 * The limits of a Session and the work counted against them (OpenMA
 * extension, docs/plans/multiagent.md, 3.Б). Tokens are the input and output
 * of every model request of every thread. Child turns are the turns of
 * subagent threads.
 */
export interface SessionLimitsView {
  maxTokens: number;
  maxChildTurns: number;
  usedTokens: number;
  usedChildTurns: number;
}
