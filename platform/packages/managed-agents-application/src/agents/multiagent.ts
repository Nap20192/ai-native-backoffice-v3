// The multiagent block of an agent: `coordinator` from SDK 0.120 and
// `multiagent_20261001` from CMA (docs/plans/multiagent.md, 3.2). The service
// checks a block, pins every listed agent and applies the CMA edit rules of
// the new type here. It also gives the turn one view of the block a Session
// copied (slice 3).
import type { AgentStore } from "@open-managed-agents/agent-store";
import type {
  AgentMultiagent,
  AgentMultiagent20261001,
  AgentMultiagent20261001Input,
  AgentMultiagentAdvisor,
  AgentMultiagentAdvisorInput,
  AgentMultiagentInput,
  AgentMultiagentRosterEntry,
  AgentMultiagentSetting,
  AgentMultiagentSettingInput,
  AgentPinnedAgent,
  AgentPredefinedAgentInput,
  AgentTool,
} from "../domain/agent-definition";
import type {
  SessionAgentMultiagent,
  SessionAgentMultiagentSetting,
  SessionListedAgent,
} from "../domain/session";

export type ResolveMultiagentResult =
  | { type: "resolved"; multiagent: AgentMultiagent | null }
  | { type: "invalid_request"; message: string };

type Invalid = { type: "invalid_request"; message: string };
type ResolvedSetting = { type: "resolved"; setting: AgentMultiagentSetting };

/** The agent that owns the block: `self` pins to it. */
export interface MultiagentOwner {
  agentId: string;
  version: number;
  name: string;
}

const MAX_LISTED_AGENTS = 20;
/** CMA names every advisor consultation thread so. */
export const ADVISOR_THREAD_NAME = "anthropic.advisor";
/** CMA keeps this custom tool name prefix for dynamic workflows. */
export const RESERVED_TOOL_PREFIX = "ant__";

function invalid(message: string): Invalid {
  return { type: "invalid_request", message };
}

export async function resolveMultiagentInput(
  store: AgentStore,
  workspaceId: string,
  input: AgentMultiagentInput | null | undefined,
  owner: MultiagentOwner,
): Promise<ResolveMultiagentResult> {
  if (input === null || input === undefined) {
    return { type: "resolved", multiagent: null };
  }
  if (input.type === "multiagent_20261001") {
    return resolveMultiagent20261001(store, workspaceId, input, owner);
  }
  return resolveCoordinator(store, workspaceId, input, owner);
}

/**
 * The block after an update (CMA edit rules, docs/plans/multiagent.md, 3.2).
 * An update of the new type to an agent with the new type changes only what
 * it sends: a setting or field left out keeps its value, null takes the
 * default, a sent list replaces the old one whole, and a setting of another
 * `type` is replaced with its defaults. Any other update replaces the whole
 * block, so a change of the block type keeps nothing of the old one.
 */
export async function mergeMultiagentUpdate(
  store: AgentStore,
  workspaceId: string,
  current: AgentMultiagent | null,
  input: AgentMultiagentInput | null | undefined,
  owner: MultiagentOwner,
): Promise<ResolveMultiagentResult> {
  if (input === undefined) {
    return { type: "resolved", multiagent: current };
  }
  if (
    input === null
    || input.type !== "multiagent_20261001"
    || current?.type !== "multiagent_20261001"
  ) {
    return resolveMultiagentInput(store, workspaceId, input, owner);
  }
  const advisor = input.advisor === undefined ? current.advisor : resolveAdvisor(input.advisor);
  const reservedAdvisorName = advisor.type === "enabled";
  const subagents = await mergeSetting(
    store, workspaceId, "subagents", current.subagents, input.subagents, owner, reservedAdvisorName,
  );
  if (subagents.type === "invalid_request") return subagents;
  const workflows = await mergeSetting(
    store, workspaceId, "workflows", current.workflows, input.workflows, owner, reservedAdvisorName,
  );
  if (workflows.type === "invalid_request") return workflows;
  return {
    type: "resolved",
    multiagent: {
      type: "multiagent_20261001",
      subagents: subagents.setting,
      workflows: workflows.setting,
      advisor,
    },
  };
}

async function mergeSetting(
  store: AgentStore,
  workspaceId: string,
  field: "subagents" | "workflows",
  current: AgentMultiagentSetting,
  input: AgentMultiagentSettingInput | null | undefined,
  owner: MultiagentOwner,
  reservedAdvisorName: boolean,
): Promise<ResolvedSetting | Invalid> {
  if (input === undefined) {
    return checkKeptSetting(store, workspaceId, field, current, owner, reservedAdvisorName);
  }
  if (input === null || input.type === "disabled" || current.type === "disabled") {
    return resolveSetting(store, workspaceId, field, input, owner, reservedAdvisorName);
  }
  const inlineAgents = input.inlineAgents === undefined ? current.inlineAgents : input.inlineAgents;
  if (input.predefinedAgents === undefined) {
    return checkKeptSetting(store, workspaceId, field, {
      type: "enabled",
      inlineAgents: inlineAgents ?? true,
      predefinedAgents: current.predefinedAgents,
    }, owner, reservedAdvisorName);
  }
  return resolveSetting(store, workspaceId, field, {
    type: "enabled",
    inlineAgents,
    predefinedAgents: input.predefinedAgents,
  }, owner, reservedAdvisorName);
}

/**
 * A setting whose list the update keeps. The pins stay as they were saved,
 * and the rules that read the rest of the block run again: inline agents off
 * need a listed agent, and an enabled advisor reserves its thread name.
 */
async function checkKeptSetting(
  store: AgentStore,
  workspaceId: string,
  field: "subagents" | "workflows",
  setting: AgentMultiagentSetting,
  owner: MultiagentOwner,
  reservedAdvisorName: boolean,
): Promise<ResolvedSetting | Invalid> {
  if (setting.type === "disabled") return { type: "resolved", setting };
  if (!setting.inlineAgents && setting.predefinedAgents.length === 0) {
    return invalid(inlineAgentsNeedAnAgent(field));
  }
  if (reservedAdvisorName) {
    for (const entry of setting.predefinedAgents) {
      const name = entry.agentId === owner.agentId
        ? owner.name
        : (await findPinnedAgent(store, workspaceId, entry))?.name;
      if (name === ADVISOR_THREAD_NAME) {
        return invalid(advisorNameTaken(`${field}.predefined_agents`, entry.agentId));
      }
    }
  }
  return { type: "resolved", setting };
}

async function resolveCoordinator(
  store: AgentStore,
  workspaceId: string,
  input: Extract<AgentMultiagentInput, { type: "coordinator" }>,
  self: MultiagentOwner,
): Promise<ResolveMultiagentResult> {
  if (input.agents.length < 1 || input.agents.length > 20) {
    return invalid("Multiagent roster must contain 1 to 20 entries");
  }
  const agents: AgentMultiagentRosterEntry[] = [];
  const referencedAgentIds = new Set<string>();
  let selfCount = 0;
  for (const entry of input.agents) {
    if (typeof entry !== "string" && entry.type === "advisor") {
      agents.push({ type: entry.type, model: entry.model });
      continue;
    }
    if (typeof entry !== "string" && entry.type === "self") {
      selfCount += 1;
      if (selfCount > 1 || referencedAgentIds.has(self.agentId)) {
        return invalid("Multiagent roster agents must be distinct and may contain at most one self");
      }
      referencedAgentIds.add(self.agentId);
      agents.push({ type: "agent", agentId: self.agentId, version: self.version });
      continue;
    }
    const agentId = typeof entry === "string" ? entry : entry.agentId;
    if (referencedAgentIds.has(agentId)) {
      return invalid("Multiagent roster agents must be distinct");
    }
    referencedAgentIds.add(agentId);
    const requestedVersion = typeof entry === "string" ? undefined : entry.version;
    const referenced = await findListedAgent(store, workspaceId, agentId, requestedVersion);
    if (referenced === null) {
      return invalid(`Multiagent roster agent ${agentId} was not found`);
    }
    if (referenced.multiagent !== null) {
      return invalid(`Multiagent roster agent ${agentId} cannot be a coordinator`);
    }
    agents.push({ type: "agent", agentId: referenced.id, version: referenced.version });
  }
  return { type: "resolved", multiagent: { type: input.type, agents } };
}

async function findListedAgent(
  store: AgentStore,
  workspaceId: string,
  agentId: string,
  requestedVersion: number | undefined,
) {
  const current = await store.findCurrent({ workspaceId, agentId });
  const referenced =
    requestedVersion === undefined || current?.version === requestedVersion
      ? current
      : await store.findVersion({ workspaceId, agentId, version: requestedVersion });
  return referenced === null || referenced.archivedAt !== null ? null : referenced;
}

/** The store keeps the current version apart from the older ones. */
async function findPinnedAgent(store: AgentStore, workspaceId: string, entry: AgentPinnedAgent) {
  const current = await store.findCurrent({ workspaceId, agentId: entry.agentId });
  return current?.version === entry.version
    ? current
    : store.findVersion({ workspaceId, agentId: entry.agentId, version: entry.version });
}

async function resolveMultiagent20261001(
  store: AgentStore,
  workspaceId: string,
  input: AgentMultiagent20261001Input,
  owner: MultiagentOwner,
): Promise<ResolveMultiagentResult> {
  const advisor = resolveAdvisor(input.advisor);
  const reservedAdvisorName = advisor.type === "enabled";
  const subagents = await resolveSetting(
    store, workspaceId, "subagents", input.subagents, owner, reservedAdvisorName,
  );
  if (subagents.type === "invalid_request") return subagents;
  const workflows = await resolveSetting(
    store, workspaceId, "workflows", input.workflows, owner, reservedAdvisorName,
  );
  if (workflows.type === "invalid_request") return workflows;
  const multiagent: AgentMultiagent20261001 = {
    type: "multiagent_20261001",
    subagents: subagents.setting,
    workflows: workflows.setting,
    advisor,
  };
  return { type: "resolved", multiagent };
}

function resolveAdvisor(
  input: AgentMultiagentAdvisorInput | null | undefined,
): AgentMultiagentAdvisor {
  return input?.type === "enabled"
    ? { type: "enabled", model: input.model }
    : { type: "disabled" };
}

async function resolveSetting(
  store: AgentStore,
  workspaceId: string,
  field: "subagents" | "workflows",
  input: AgentMultiagentSettingInput | null | undefined,
  owner: MultiagentOwner,
  reservedAdvisorName: boolean,
): Promise<ResolvedSetting | Invalid> {
  if (input?.type === "disabled") {
    return { type: "resolved", setting: { type: "disabled" } };
  }
  const inlineAgents = input?.inlineAgents ?? true;
  const entries: AgentPredefinedAgentInput[] = input?.predefinedAgents ?? [];
  const list = `${field}.predefined_agents`;
  if (entries.length > MAX_LISTED_AGENTS) {
    return invalid(`${list} may list at most ${MAX_LISTED_AGENTS} agents`);
  }
  if (!inlineAgents && entries.length === 0) {
    return invalid(inlineAgentsNeedAnAgent(field));
  }
  const predefinedAgents: AgentPinnedAgent[] = [];
  const listed = new Set<string>();
  for (const entry of entries) {
    const agentId = typeof entry === "string"
      ? entry
      : entry.type === "self" ? owner.agentId : entry.agentId;
    if (listed.has(agentId)) {
      return invalid(`${list} must list distinct agents: ${agentId} is listed twice`);
    }
    listed.add(agentId);
    if (typeof entry !== "string" && entry.type === "self") {
      if (reservedAdvisorName && owner.name === ADVISOR_THREAD_NAME) {
        return invalid(advisorNameTaken(list, owner.agentId));
      }
      predefinedAgents.push({ type: "agent", agentId: owner.agentId, version: owner.version });
      continue;
    }
    const requestedVersion = typeof entry === "string" ? undefined : entry.version;
    const referenced = await findListedAgent(store, workspaceId, agentId, requestedVersion);
    if (referenced === null) {
      return invalid(`${list} agent ${agentId} was not found`);
    }
    if (referenced.multiagent !== null) {
      return invalid(`${list} agent ${agentId} has its own multiagent block; delegation is one level deep`);
    }
    if (reservedAdvisorName && referenced.name === ADVISOR_THREAD_NAME) {
      return invalid(advisorNameTaken(list, agentId));
    }
    predefinedAgents.push({ type: "agent", agentId: referenced.id, version: referenced.version });
  }
  return { type: "resolved", setting: { type: "enabled", inlineAgents, predefinedAgents } };
}

function inlineAgentsNeedAnAgent(field: "subagents" | "workflows"): string {
  return `${field}.inline_agents is disabled, so ${field}.predefined_agents needs at least one agent`;
}

function advisorNameTaken(list: string, agentId: string): string {
  return `${list} agent ${agentId} is named ${ADVISOR_THREAD_NAME}, and the name ${ADVISOR_THREAD_NAME} is reserved while the advisor is enabled`;
}

/**
 * The `ant__` prefix of an own custom tool while dynamic workflows are on.
 * The check reads the agent as it stands after the request, so an update
 * that leaves the block alone still checks the tools it sends.
 */
export function reservedToolNameProblem(
  multiagent: AgentMultiagent | null,
  tools: AgentTool[],
): string | null {
  if (multiagent?.type !== "multiagent_20261001" || multiagent.workflows.type !== "enabled") {
    return null;
  }
  const reserved = tools.find((tool) =>
    tool.type === "custom" && tool.name.startsWith(RESERVED_TOOL_PREFIX));
  if (reserved === undefined || reserved.type !== "custom") return null;
  return `Custom tool ${reserved.name} uses the reserved prefix ${RESERVED_TOOL_PREFIX} while multiagent.workflows is enabled`;
}

/**
 * The multiagent settings the turn reads (docs/plans/multiagent.md, 3.2).
 * The codec, the delegation policy and the subagent lookup read only this.
 * `coordinator` reads as subagents without inline agents, with no workflows
 * and with the advisor of its roster entry. A Session without a block has no
 * view.
 */
export interface EffectiveMultiagent {
  subagents: SessionAgentMultiagentSetting;
  workflows: SessionAgentMultiagentSetting;
  advisor: AgentMultiagentAdvisor;
}

export function effectiveMultiagent(
  multiagent: SessionAgentMultiagent | null,
): EffectiveMultiagent | null {
  if (multiagent === null) return null;
  if (multiagent.type === "multiagent_20261001") {
    return {
      subagents: multiagent.subagents,
      workflows: multiagent.workflows,
      advisor: multiagent.advisor,
    };
  }
  const predefinedAgents = multiagent.agents.filter(
    (entry): entry is SessionListedAgent => entry.type === "agent",
  );
  const advisor = multiagent.agents.find((entry) => entry.type === "advisor");
  return {
    subagents: predefinedAgents.length === 0
      ? { type: "disabled" }
      : { type: "enabled", inlineAgents: false, predefinedAgents },
    workflows: { type: "disabled" },
    advisor: advisor?.type === "advisor"
      ? { type: "enabled", model: advisor.model }
      : { type: "disabled" },
  };
}

/** The agents a turn may delegate to: the list of enabled subagents. */
export function listedSubagents(
  multiagent: SessionAgentMultiagent | null,
): SessionListedAgent[] {
  const subagents = effectiveMultiagent(multiagent)?.subagents;
  return subagents?.type === "enabled" ? subagents.predefinedAgents : [];
}
