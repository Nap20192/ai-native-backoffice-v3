// Шаблон агента-ассистента и окружения «Ассистент» (docs/plans/builder-agent.md, 1.1, 1.5, 3.2).
// Политика по умолчанию у сервера platform always_ask: новый инструмент таблицы спрашивает.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentCreateBody } from "@open-managed-agents/managed-agents-api";

export const PLATFORM_MCP_SERVER_NAME = "platform";
export const BUILDER_ROLE = "builder";

/** Инструменты чтения и черновика из 2.3. Только у них политика always_allow. */
export const BUILDER_ALWAYS_ALLOW_TOOLS = [
  "help",
  "search_docs",
  "search_config",
  "list",
  "get",
  "read_content",
  "get_session_events",
  "get_trajectory",
  "request_secret",
  "preview_change",
] as const;

/** Набор «черновик» (1.1): сессия только читает и собирает черновик. */
export const BUILDER_DRAFT_TOOLS = ["help", "list", "get", "preview_change"] as const;

/** Инструменты записи из 2.3, для групп в диалоге шаблона. Класс считает таблица BS1. */
export const BUILDER_WRITE_TOOLS = [
  "create_agent",
  "create_environment",
  "create_skill",
  "upload_file",
  "create_memory_store",
  "create_deployment",
  "create_session",
  "write_memory",
  "update_agent",
  "restore_agent_version",
  "update_environment",
  "create_skill_version",
  "update_memory_store",
  "update_deployment",
  "update_model_card",
  "update_harness_card",
  "send_message",
  "apply_changes",
] as const;

type AgentTool = NonNullable<AgentCreateBody["tools"]>[number];

export interface BuilderEnvironmentBody {
  name: string;
  description: string;
  metadata: Record<string, string>;
  config: {
    type: "cloud";
    networking: {
      type: "limited";
      allowed_hosts: string[];
      allow_mcp_servers: boolean;
      allow_package_managers: boolean;
      allow_web_search: boolean;
    };
  };
}

/** Папка K/ (platform/assistant): промпт, документы для search_docs, лицензии. */
export function assistantDir(): string {
  return fileURLToPath(new URL("../../../../../assistant", import.meta.url).href);
}

export function readBuilderPrompt(): string {
  return readFileSync(`${assistantDir()}/prompt.md`, "utf8");
}

/** Встроенные инструменты выключены: configs [] обязателен, без него harness включит набор по умолчанию (3.2). */
function disabledAgentToolset(): AgentTool {
  return { type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] };
}

export function buildBuilderTools(): AgentTool[] {
  return [
    disabledAgentToolset(),
    {
      type: "mcp_toolset",
      mcp_server_name: PLATFORM_MCP_SERVER_NAME,
      default_config: { permission_policy: { type: "always_ask" } },
      configs: BUILDER_ALWAYS_ALLOW_TOOLS.map((name) => ({ name, permission_policy: { type: "always_allow" as const } })),
    },
  ];
}

/** tools для agent_with_overrides в наборе «черновик»: включены только 4 инструмента. */
export function buildBuilderDraftTools(): AgentTool[] {
  return [
    disabledAgentToolset(),
    {
      type: "mcp_toolset",
      mcp_server_name: PLATFORM_MCP_SERVER_NAME,
      default_config: { enabled: false, permission_policy: { type: "always_ask" } },
      configs: BUILDER_DRAFT_TOOLS.map((name) => ({ name, enabled: true, permission_policy: { type: "always_allow" as const } })),
    },
  ];
}

export interface BuilderAgentOptions {
  /** Карточка модели, которую выбрал пользователь. Без неё поля model в теле нет. */
  model?: string;
  platformMcpUrl: string;
  name?: string;
}

export function buildBuilderAgentConfig(options: BuilderAgentOptions & { model: string }): AgentCreateBody;
export function buildBuilderAgentConfig(options: BuilderAgentOptions): Omit<AgentCreateBody, "model"> & { model?: AgentCreateBody["model"] };
export function buildBuilderAgentConfig(options: BuilderAgentOptions): Omit<AgentCreateBody, "model"> & { model?: AgentCreateBody["model"] } {
  return {
    name: options.name ?? "Ассистент",
    description: "Настраивает платформу и отвечает на вопросы о ней. Любую запись подтверждает пользователь.",
    ...(options.model === undefined ? {} : { model: options.model }),
    system: readBuilderPrompt(),
    metadata: { oma_role: BUILDER_ROLE },
    mcp_servers: [{ type: "url", name: PLATFORM_MCP_SERVER_NAME, url: options.platformMcpUrl }],
    tools: buildBuilderTools(),
  };
}

export function buildBuilderEnvironmentConfig(): BuilderEnvironmentBody {
  return {
    name: "Ассистент",
    description: "Окружение сессий ассистента. Сеть закрыта, открыт только MCP-сервер платформы.",
    metadata: { oma_role: BUILDER_ROLE },
    config: {
      type: "cloud",
      networking: {
        type: "limited",
        allowed_hosts: [],
        allow_mcp_servers: true,
        allow_package_managers: false,
        allow_web_search: false,
      },
    },
  };
}
