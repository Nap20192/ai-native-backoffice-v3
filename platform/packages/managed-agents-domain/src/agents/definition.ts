import type { JsonObject } from "../json";

export type AgentPermissionPolicy =
  | { type: "always_allow" }
  | { type: "always_ask" };

export interface AgentUrlMcpServerInput {
  name: string;
  type: "url";
  url: string;
}

/** OpenMA extension: a standard MCP stdio process launched by the sandbox Agent. */
export interface AgentStdioMcpServerInput {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type AgentMcpServerInput =
  | AgentUrlMcpServerInput
  | AgentStdioMcpServerInput;

export type AgentSkillInput =
  | {
      skillId: string;
      type: "anthropic";
      version?: string | null;
    }
  | {
      skillId: string;
      type: "custom";
      version?: string | null;
    };

export type AgentMultiagentRosterEntryInput =
  | string
  | { agentId: string; type: "agent"; version?: number }
  | { type: "self" }
  | { model: string; type: "advisor" };

export interface AgentCoordinatorMultiagentInput {
  agents: AgentMultiagentRosterEntryInput[];
  type: "coordinator";
}

/** An entry of `predefined_agents` in a `multiagent_20261001` block. */
export type AgentPredefinedAgentInput =
  | string
  | { agentId: string; type: "agent"; version?: number }
  | { type: "self" };

/**
 * `subagents` or `workflows` of a `multiagent_20261001` block. A field left
 * out or sent as null takes its default: inline agents on, an empty list.
 */
export type AgentMultiagentSettingInput =
  | {
      type: "enabled";
      inlineAgents?: boolean | null;
      predefinedAgents?: AgentPredefinedAgentInput[] | null;
    }
  | { type: "disabled" };

export type AgentMultiagentAdvisorInput =
  | { model: string; type: "enabled" }
  | { type: "disabled" };

/**
 * The CMA block that SDK 0.120 does not know (docs/plans/multiagent.md, 3.2).
 * A setting left out or sent as null takes its default: subagents and
 * workflows on, the advisor off.
 */
export interface AgentMultiagent20261001Input {
  type: "multiagent_20261001";
  subagents?: AgentMultiagentSettingInput | null;
  workflows?: AgentMultiagentSettingInput | null;
  advisor?: AgentMultiagentAdvisorInput | null;
}

export type AgentMultiagentInput =
  | AgentCoordinatorMultiagentInput
  | AgentMultiagent20261001Input;

export interface AgentToolDefaultConfigInput {
  enabled?: boolean | null;
  permissionPolicy?: AgentPermissionPolicy | null;
}

interface AgentSimpleToolConfigInput<Name extends string> {
  name: Name;
  enabled?: boolean | null;
  permissionPolicy?: AgentPermissionPolicy | null;
  type?: Name;
}

export interface AgentToolUserLocationInput {
  type: "approximate";
  city?: string | null;
  country?: string | null;
  region?: string | null;
  timezone?: string | null;
}

export type AgentToolConfigInput =
  | AgentSimpleToolConfigInput<"bash">
  | AgentSimpleToolConfigInput<"edit">
  | AgentSimpleToolConfigInput<"read">
  | AgentSimpleToolConfigInput<"write">
  | AgentSimpleToolConfigInput<"glob">
  | AgentSimpleToolConfigInput<"grep">
  | (AgentSimpleToolConfigInput<"web_fetch"> & {
      allowedDomains?: string[];
      blockedDomains?: string[];
      maxContentTokens?: number | null;
    })
  | (AgentSimpleToolConfigInput<"web_search"> & {
      allowedDomains?: string[];
      blockedDomains?: string[];
      userLocation?: AgentToolUserLocationInput | null;
    });

export interface AgentToolsetInput {
  type: "agent_toolset_20260401";
  configs?: AgentToolConfigInput[];
  defaultConfig?: AgentToolDefaultConfigInput | null;
}

export interface AgentMcpToolConfigInput {
  name: string;
  enabled?: boolean | null;
  permissionPolicy?: AgentPermissionPolicy | null;
}

export interface AgentMcpToolsetInput {
  type: "mcp_toolset";
  mcpServerName: string;
  configs?: AgentMcpToolConfigInput[];
  defaultConfig?: AgentToolDefaultConfigInput | null;
}

export type AgentCustomToolInputSchema = JsonObject & {
  type: "object";
  properties?: JsonObject | null;
  required?: string[] | null;
};

export interface AgentCustomToolInput {
  description: string;
  inputSchema: AgentCustomToolInputSchema;
  name: string;
  type: "custom";
}

export type AgentToolInput =
  | AgentToolsetInput
  | AgentMcpToolsetInput
  | AgentCustomToolInput;

export interface AgentUrlMcpServer {
  name: string;
  type: "url";
  url: string;
}

export interface AgentStdioMcpServer {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type AgentMcpServer = AgentUrlMcpServer | AgentStdioMcpServer;

export type AgentSkill =
  | { skillId: string; type: "anthropic"; version: string }
  | { skillId: string; type: "custom"; version: string };

/** A listed agent pinned to the version resolved when the block was saved. */
export interface AgentPinnedAgent {
  agentId: string;
  type: "agent";
  version: number;
}

export type AgentMultiagentRosterEntry =
  | AgentPinnedAgent
  | { model: string; type: "advisor" };

export interface AgentCoordinatorMultiagent {
  agents: AgentMultiagentRosterEntry[];
  type: "coordinator";
}

export type AgentMultiagentSetting =
  | {
      type: "enabled";
      inlineAgents: boolean;
      predefinedAgents: AgentPinnedAgent[];
    }
  | { type: "disabled" };

export type AgentMultiagentAdvisor =
  | { model: string; type: "enabled" }
  | { type: "disabled" };

/** A `multiagent_20261001` block with every default filled in. */
export interface AgentMultiagent20261001 {
  type: "multiagent_20261001";
  subagents: AgentMultiagentSetting;
  workflows: AgentMultiagentSetting;
  advisor: AgentMultiagentAdvisor;
}

export type AgentMultiagent =
  | AgentCoordinatorMultiagent
  | AgentMultiagent20261001;

export interface AgentToolDefaultConfig {
  enabled: boolean;
  permissionPolicy: AgentPermissionPolicy;
}

interface AgentSimpleToolConfig<Name extends string> {
  name: Name;
  enabled: boolean;
  permissionPolicy: AgentPermissionPolicy;
  type: Name;
}

export type AgentToolConfig =
  | AgentSimpleToolConfig<"bash">
  | AgentSimpleToolConfig<"edit">
  | AgentSimpleToolConfig<"read">
  | AgentSimpleToolConfig<"write">
  | AgentSimpleToolConfig<"glob">
  | AgentSimpleToolConfig<"grep">
  | (AgentSimpleToolConfig<"web_fetch"> & {
      allowedDomains?: string[];
      blockedDomains?: string[];
      maxContentTokens?: number | null;
    })
  | (AgentSimpleToolConfig<"web_search"> & {
      allowedDomains?: string[];
      blockedDomains?: string[];
      userLocation?: AgentToolUserLocationInput | null;
    });

export interface AgentToolset {
  type: "agent_toolset_20260401";
  configs: AgentToolConfig[];
  defaultConfig: AgentToolDefaultConfig;
}

export interface AgentMcpToolConfig {
  name: string;
  enabled: boolean;
  permissionPolicy: AgentPermissionPolicy;
}

export interface AgentMcpToolset {
  type: "mcp_toolset";
  mcpServerName: string;
  configs: AgentMcpToolConfig[];
  defaultConfig: AgentToolDefaultConfig;
}

export type AgentCustomTool = AgentCustomToolInput;

export type AgentTool = AgentToolset | AgentMcpToolset | AgentCustomTool;
