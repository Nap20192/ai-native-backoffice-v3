import type {
  AgentSkill,
  AgentSkillInput,
  AgentMcpToolConfig,
  AgentMcpToolConfigInput,
  AgentPermissionPolicy,
  AgentTool,
  AgentToolConfig,
  AgentToolConfigInput,
  AgentToolDefaultConfig,
  AgentToolDefaultConfigInput,
  AgentToolInput,
} from "../domain/agent-definition";

/**
 * Policy for a toolset whose input names none, as in Claude Managed Agents:
 * built-in tools run, an MCP server tool waits for a human. Saved agents keep
 * the policy written in them (docs/plans/cma-wave-1.md, 3.1).
 */
const DEFAULT_PERMISSION_POLICY = {
  agent_toolset_20260401: { type: "always_allow" },
  mcp_toolset: { type: "always_ask" },
} as const satisfies Record<string, AgentPermissionPolicy>;

function resolveDefaultConfig(
  input: AgentToolDefaultConfigInput | null | undefined,
  fallback: AgentPermissionPolicy,
): AgentToolDefaultConfig {
  return {
    enabled: input?.enabled ?? true,
    permissionPolicy: input?.permissionPolicy ?? { ...fallback },
  };
}

function resolveToolConfig(
  input: AgentToolConfigInput,
  defaults: AgentToolDefaultConfig,
): AgentToolConfig {
  const common = {
    name: input.name,
    type: input.name,
    enabled: input.enabled ?? defaults.enabled,
    permissionPolicy: input.permissionPolicy ?? defaults.permissionPolicy,
  };
  switch (input.name) {
    case "web_fetch":
      return {
        ...common,
        name: input.name,
        type: input.name,
        ...(input.allowedDomains !== undefined && {
          allowedDomains: input.allowedDomains,
        }),
        ...(input.blockedDomains !== undefined && {
          blockedDomains: input.blockedDomains,
        }),
        ...(input.maxContentTokens !== undefined && {
          maxContentTokens: input.maxContentTokens,
        }),
      };
    case "web_search":
      return {
        ...common,
        name: input.name,
        type: input.name,
        ...(input.allowedDomains !== undefined && {
          allowedDomains: input.allowedDomains,
        }),
        ...(input.blockedDomains !== undefined && {
          blockedDomains: input.blockedDomains,
        }),
        ...(input.userLocation !== undefined && {
          userLocation: input.userLocation,
        }),
      };
    case "bash":
      return { ...common, name: input.name, type: input.name };
    case "edit":
      return { ...common, name: input.name, type: input.name };
    case "read":
      return { ...common, name: input.name, type: input.name };
    case "write":
      return { ...common, name: input.name, type: input.name };
    case "glob":
      return { ...common, name: input.name, type: input.name };
    case "grep":
      return { ...common, name: input.name, type: input.name };
  }
}

function resolveMcpToolConfig(
  input: AgentMcpToolConfigInput,
  defaults: AgentToolDefaultConfig,
): AgentMcpToolConfig {
  return {
    name: input.name,
    enabled: input.enabled ?? defaults.enabled,
    permissionPolicy: input.permissionPolicy ?? defaults.permissionPolicy,
  };
}

export function resolveAgentTools(inputs: AgentToolInput[]): AgentTool[] {
  return inputs.map((input) => {
    switch (input.type) {
      case "agent_toolset_20260401": {
        const defaultConfig = resolveDefaultConfig(
          input.defaultConfig,
          DEFAULT_PERMISSION_POLICY.agent_toolset_20260401,
        );
        return {
          type: input.type,
          defaultConfig,
          configs: (input.configs ?? []).map((config) =>
            resolveToolConfig(config, defaultConfig),
          ),
        };
      }
      case "mcp_toolset": {
        const defaultConfig = resolveDefaultConfig(
          input.defaultConfig,
          DEFAULT_PERMISSION_POLICY.mcp_toolset,
        );
        return {
          type: input.type,
          mcpServerName: input.mcpServerName,
          defaultConfig,
          configs: (input.configs ?? []).map((config) =>
            resolveMcpToolConfig(config, defaultConfig),
          ),
        };
      }
      case "custom":
        return structuredClone(input);
    }
  });
}

/**
 * Checks the MCP part of a whole agent definition: at most 20 unique servers,
 * every server has an mcp_toolset and every mcp_toolset names a server. A
 * Session runs it on the agent after its overrides are merged, so a server
 * added without a toolset fails with 400 instead of running unchecked.
 */
export function validateMcpConfiguration(
  mcpServers: ReadonlyArray<{ name: string }>,
  tools: ReadonlyArray<{ type: string; mcpServerName?: string }>,
): string | null {
  if (mcpServers.length > 20) {
    return "Agent MCP servers may contain at most 20 entries";
  }
  const serverNames = new Set<string>();
  for (const server of mcpServers) {
    if (serverNames.has(server.name)) {
      return "Agent MCP server names must be unique";
    }
    serverNames.add(server.name);
  }
  const referencedNames = new Set(
    tools.flatMap((tool) =>
      tool.type === "mcp_toolset" && typeof tool.mcpServerName === "string"
        ? [tool.mcpServerName]
        : [],
    ),
  );
  for (const referencedName of referencedNames) {
    if (!serverNames.has(referencedName)) {
      return `MCP toolset references unknown server ${referencedName}`;
    }
  }
  for (const serverName of serverNames) {
    if (!referencedNames.has(serverName)) {
      return `MCP server ${serverName} must be referenced by an mcp_toolset`;
    }
  }
  return null;
}

/**
 * The first MCP server whose enabled tool would ask for a confirmation, or
 * null. A subagent thread cannot be confirmed: its call would stay without a
 * result, so a session refuses such a roster member (docs/plans/cma-wave-1.md,
 * section 4, decision 5).
 */
export function askingMcpServer(tools: ReadonlyArray<AgentTool>): string | null {
  for (const tool of tools) {
    if (tool.type !== "mcp_toolset") continue;
    const { defaultConfig } = tool;
    if (defaultConfig.enabled && defaultConfig.permissionPolicy.type === "always_ask") {
      return tool.mcpServerName;
    }
    if (tool.configs.some((config) => config.enabled && config.permissionPolicy.type === "always_ask")) {
      return tool.mcpServerName;
    }
  }
  return null;
}

export function resolveAgentSkills(inputs: AgentSkillInput[]): AgentSkill[] {
  return inputs.map((input) => ({
    skillId: input.skillId,
    type: input.type,
    version: input.version ?? "latest",
  }));
}
