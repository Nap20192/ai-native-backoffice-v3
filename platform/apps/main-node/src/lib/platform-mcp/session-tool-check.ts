// Tool set of an assistant session (builder-agent.md 3.2). The server serves
// a session only when the harness would give its model no tool besides the
// platform server: no builtins, no other MCP server, no skills, no callable
// agents, no resources and no vaults. The check reads the same config the
// harness gets (`toLegacyHarnessAgentConfig`) and calls the same function
// that picks the builtins (`getEnabledBuiltinTools`, BX1), so it never
// repeats the harness logic.

import { getEnabledBuiltinTools } from "@open-managed-agents/agent/harness/tools";
import type { Session } from "@open-managed-agents/managed-agents-application";
import { toLegacyHarnessAgentConfig } from "../node-managed-agent-codec";
import type { SessionToolCheck, SessionToolCheckResult } from "./ports";

export const PLATFORM_MCP_SERVER_NAME = "platform";

export const SESSION_TOOLS_MESSAGE =
  "В сессии ассистента есть встроенные инструменты, другие MCP-серверы, навыки, ресурсы или хранилища секретов";

/** Harness ids that run the default loop in the control plane. */
const DEFAULT_HARNESSES = new Set(["default"]);

export function sameUrl(a: string, b: string): boolean {
  const trim = (value: string) => value.trim().replace(/\/+$/, "");
  return trim(a) === trim(b);
}

/** True when the session agent has an MCP server at `PLATFORM_MCP_URL`. */
export function isAssistantSession(session: Pick<Session, "agent">, platformMcpUrl: string): boolean {
  return session.agent.mcpServers.some((server) => server.type === "url" && sameUrl(server.url, platformMcpUrl));
}

export function checkAssistantToolSet(session: Session, platformMcpUrl: string): SessionToolCheckResult {
  const refused: SessionToolCheckResult = { ok: false, message: SESSION_TOOLS_MESSAGE };
  if (session.archivedAt !== null) return refused;
  if (session.resources.length > 0 || session.vaultIds.length > 0) return refused;

  const config = toLegacyHarnessAgentConfig(session) as ReturnType<typeof toLegacyHarnessAgentConfig> & Record<string, unknown>;
  const tools = config.tools as unknown as Record<string, unknown>[];
  if (tools.length !== 2) return refused;
  const [builtins, platform] = tools;
  if (builtins?.type !== "agent_toolset_20260401") return refused;
  const defaults = builtins.default_config as { enabled?: unknown } | undefined;
  if (defaults?.enabled !== false) return refused;
  const configs = builtins.configs as { enabled?: unknown }[] | undefined;
  if (!Array.isArray(configs) || configs.some((entry) => entry.enabled === true)) return refused;
  if (platform?.type !== "mcp_toolset" || platform.mcp_server_name !== PLATFORM_MCP_SERVER_NAME) return refused;
  if (getEnabledBuiltinTools(config.tools as never).size > 0) return refused;

  const servers = config.mcp_servers as { name?: unknown; type?: unknown; url?: unknown }[];
  if (servers.length !== 1) return refused;
  const [server] = servers;
  if (server?.name !== PLATFORM_MCP_SERVER_NAME || server.type !== "url" || typeof server.url !== "string") return refused;
  if (!sameUrl(server.url, platformMcpUrl)) return refused;

  if ((config.skills as unknown[]).length > 0) return refused;
  if (config.callable_agents !== undefined || config.multiagent !== undefined) return refused;
  if (config.enable_general_subagent === true) return refused;
  // An ACP agent or a runtime binding runs its own tools in the sandbox.
  if (config.acp !== undefined || session.agent.openma?.runtimeBinding !== undefined) return refused;
  const harness = session.agent.openma?.harness;
  if (harness !== undefined && !DEFAULT_HARNESSES.has(harness)) return refused;
  return { ok: true };
}

export interface SessionToolCheckDeps {
  platformMcpUrl: string;
  /** The session as the runner loads it, archived ones too. */
  loadSession(workspaceId: string, sessionId: string): Promise<Session | null>;
}

/** Reads the session anew on every check: a later edit of `tools` drops the platform from the next request. */
export function createSessionToolCheck(deps: SessionToolCheckDeps): SessionToolCheck {
  return {
    async check(workspaceId, sessionId) {
      const session = await deps.loadSession(workspaceId, sessionId);
      if (session === null) return { ok: false, message: "Сессия ассистента не найдена" };
      return checkAssistantToolSet(session, deps.platformMcpUrl);
    },
  };
}
