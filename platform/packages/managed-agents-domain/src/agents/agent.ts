import type {
  AgentMcpServer,
  AgentMultiagent,
  AgentSkill,
  AgentTool,
} from "./definition";
import type { JsonObject } from "../json";

export type AgentEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSpeed = "standard" | "fast";

export interface AgentModel {
  id: string;
  effort?: AgentEffortLevel;
  inferenceGeo?: string;
  /** Provider-namespaced, JSON-compatible inference options. */
  providerOptions?: JsonObject;
  speed?: AgentSpeed;
  /** OMA extension: per-turn output token ceiling (catalog default when unset). */
  maxTokens?: number;
}

/** Mirrors Anthropic Messages `context_management.edits` compaction shape. */
export interface AgentContextManagementEdit {
  type: "compact" | "compact_20260112";
  trigger?: { type: "input_tokens"; value: number };
  instructions?: string;
  pause_after_compaction?: boolean;
}

export interface AgentContextManagement {
  edits: AgentContextManagementEdit[];
}

/** OpenAI Agents SDK `model_settings` compaction shape. */
export interface AgentOpenAiModelSettings {
  max_tokens?: number;
  context_management?: Array<{
    type: "compaction";
    compact_threshold: number;
  }>;
}

export type AgentCompactionWireFormat =
  | "anthropic_context_management"
  | "openai_model_settings";

/**
 * OpenMA additions to the Anthropic Managed Agents resource. These values are
 * versioned with the Agent so a Session can pin one atomic configuration.
 *
 * Documents stored before 2026-10-17 may still hold `acp` and
 * `runtimeBinding` here. Nothing reads them any more and the mappers drop
 * them, so such an agent still loads.
 */
export interface AgentOpenMaExtensions {
  auxiliaryModel?: AgentModel;
  appendablePrompts?: string[];
  contextManagement?: AgentContextManagement;
  openaiModelSettings?: AgentOpenAiModelSettings;
  compactionWireFormat?: AgentCompactionWireFormat;
  /** Only the Pi loop exists: unset, "default" or "pi". A stored removed
   * name ("ai-sdk", "acp-sandbox", "acp-proxy") runs on Pi. */
  harness?: string;
  enableGeneralSubagent?: boolean;
  /**
   * Versioned adapter-owned data that has no public Managed Agents field.
   * API mappers intentionally do not expose this internal persistence slot.
   */
  compatibility?: JsonObject;
}

export interface Agent {
  id: string;
  archivedAt: string | null;
  createdAt: string;
  description: string | null;
  mcpServers: AgentMcpServer[];
  metadata: Record<string, string>;
  model: AgentModel;
  multiagent: AgentMultiagent | null;
  name: string;
  openma?: AgentOpenMaExtensions;
  skills: AgentSkill[];
  system: string | null;
  tools: AgentTool[];
  updatedAt: string;
  version: number;
}
