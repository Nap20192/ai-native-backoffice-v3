import type {
  AgentCreateParams,
  AgentListParams,
  AgentRetrieveParams,
  AgentUpdateParams,
  BetaManagedAgentsAgent,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { VersionListParams } from "@anthropic-ai/sdk/resources/beta/agents/versions";
import { z } from "zod";
import {
  agentMcpServerInputSchema,
  agentMultiagentInputSchema,
  agentSkillInputSchema,
  agentToolInputSchema,
} from "./agent-input-components";
import {
  agentMcpServerResponseSchema,
  agentModelResponseSchema,
  agentMultiagentResponseSchema,
  openMaAgentExtensionResponseSchema,
  agentSkillResponseSchema,
  agentToolResponseSchema,
} from "./agent-response-components";

type OfficialAgentCreateBody = Omit<AgentCreateParams, "betas">;
export type AgentListQuery = Omit<AgentListParams, "betas">;
export type AgentRetrieveQuery = Omit<AgentRetrieveParams, "betas">;
type OfficialAgentUpdateBody = Omit<AgentUpdateParams, "betas">;
export type AgentVersionListQuery = Omit<VersionListParams, "betas">;

type AgentModelConfig = Exclude<OfficialAgentCreateBody["model"], string>;
type AgentModelName = Exclude<OfficialAgentCreateBody["model"], AgentModelConfig>;

export type OpenMaJsonValue =
  | string
  | number
  | boolean
  | null
  | OpenMaProviderOptions
  | OpenMaJsonValue[];

export interface OpenMaProviderOptions {
  [key: string]: OpenMaJsonValue;
}

export type OpenMaAgentModelConfigBody = AgentModelConfig & {
  /** OpenMA extension: provider-namespaced, JSON-compatible inference options. */
  provider_options?: OpenMaProviderOptions | null;
  /** OMA extension: per-turn output token ceiling. */
  max_tokens?: number | null;
};

export type OpenMaAgentModelBody = AgentModelName | OpenMaAgentModelConfigBody;

export interface OpenMaStdioMcpServerBody {
  name: string;
  type: "stdio";
  /** Absolute executable path inside the sandbox. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type OpenMaMcpServerBody =
  | NonNullable<OfficialAgentCreateBody["mcp_servers"]>[number]
  | OpenMaStdioMcpServerBody;

export interface OpenMaAgentExtensionBody {
  aux_model?: OpenMaAgentModelBody | null;
  appendable_prompts?: string[] | null;
  context_management?: {
    edits: Array<{
      type: "compact" | "compact_20260112";
      trigger?: { type: "input_tokens"; value: number };
      instructions?: string;
      pause_after_compaction?: boolean;
    }>;
  } | null;
  model_settings?: {
    max_tokens?: number;
    context_management?: Array<{
      type: "compaction";
      compact_threshold: number;
    }>;
  } | null;
  harness?: string | null;
  enable_general_subagent?: boolean | null;
}

type OfficialAgentMultiagentBody = Exclude<
  OfficialAgentCreateBody["multiagent"],
  null | undefined
>;
type OfficialAgentMultiagentResponseBody = NonNullable<
  BetaManagedAgentsAgent["multiagent"]
>;

/** An entry of `predefined_agents`: an id, a reference, or the agent itself. */
export type OpenMaPredefinedAgentBody =
  | string
  | { type: "agent"; id: string; version?: number }
  | { type: "self" };

export interface OpenMaInlineAgentsBody {
  type: "enabled" | "disabled";
}

/** `subagents` or `workflows`. A field left out or null takes its default. */
export type OpenMaMultiagentSettingBody =
  | {
      type: "enabled";
      inline_agents?: OpenMaInlineAgentsBody | null;
      predefined_agents?: OpenMaPredefinedAgentBody[] | null;
    }
  | { type: "disabled" };

export type OpenMaMultiagentAdvisorBody =
  | { type: "enabled"; model: string }
  | { type: "disabled" };

/**
 * The CMA block `multiagent_20261001`. SDK 0.120 and 0.129 know only
 * `coordinator`, so the wire type is our own, declared like `_oma`
 * (API_LAYER.md, "Multiagent block"; owner decision 3 of
 * docs/plans/multiagent.md).
 */
export interface OpenMaMultiagent20261001Body {
  type: "multiagent_20261001";
  subagents?: OpenMaMultiagentSettingBody | null;
  workflows?: OpenMaMultiagentSettingBody | null;
  advisor?: OpenMaMultiagentAdvisorBody | null;
}

export type AgentMultiagentBody =
  | OfficialAgentMultiagentBody
  | OpenMaMultiagent20261001Body;

interface OpenMaPinnedAgentResponseBody {
  type: "agent";
  id: string;
  version: number;
}

type OpenMaMultiagentSettingResponseBody =
  | {
      type: "enabled";
      inline_agents: OpenMaInlineAgentsBody;
      predefined_agents: OpenMaPinnedAgentResponseBody[];
    }
  | { type: "disabled" };

/** The block as an agent reads it back: every default filled in, every entry pinned. */
export interface OpenMaMultiagent20261001ResponseBody {
  type: "multiagent_20261001";
  subagents: OpenMaMultiagentSettingResponseBody;
  workflows: OpenMaMultiagentSettingResponseBody;
  advisor: OpenMaMultiagentAdvisorBody;
}

export type AgentMultiagentResponseBody =
  | OfficialAgentMultiagentResponseBody
  | OpenMaMultiagent20261001ResponseBody;

export type AgentCreateBody = Omit<
  OfficialAgentCreateBody,
  "model" | "mcp_servers" | "multiagent"
> & {
  model: OpenMaAgentModelBody;
  mcp_servers?: OpenMaMcpServerBody[];
  multiagent?: AgentMultiagentBody | null;
  _oma?: OpenMaAgentExtensionBody;
};
export type AgentUpdateBody = Omit<
  OfficialAgentUpdateBody,
  "model" | "mcp_servers" | "multiagent"
> & {
  model?: OpenMaAgentModelBody;
  mcp_servers?: OpenMaMcpServerBody[] | null;
  multiagent?: AgentMultiagentBody | null;
  _oma?: OpenMaAgentExtensionBody;
};

const effortLevelSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const providerOptionsSchema: z.ZodType<OpenMaProviderOptions> = z.record(
  z.string(),
  z.json(),
);
const metadataKeySchema = z.string().min(1).max(64);
const metadataValueSchema = z.string().max(512);
const agentMetadataSchema = z
  .record(metadataKeySchema, metadataValueSchema)
  .refine((metadata) => Object.keys(metadata).length <= 16, {
    message: "Agent metadata may contain at most 16 keys",
  });
const agentMetadataPatchSchema = z.record(
  metadataKeySchema,
  metadataValueSchema.nullable(),
);

const modelConfigSchema: z.ZodType<OpenMaAgentModelConfigBody> = z
  .object({
    id: z.string().min(1),
    effort: z
      .union([
        effortLevelSchema,
        z.object({ type: effortLevelSchema }).strict(),
      ])
      .nullable()
      .optional(),
    inference_geo: z.string().nullable().optional(),
    provider_options: providerOptionsSchema.nullable().optional(),
    speed: z.enum(["standard", "fast"]).nullable().optional(),
    max_tokens: z.number().int().positive().nullable().optional(),
  })
  .strict();

export const agentModelInputSchema: z.ZodType<AgentCreateBody["model"]> = z.union([
  z.string().min(1),
  modelConfigSchema,
]);

const contextManagementSchema = z
  .object({
    edits: z.array(
      z
        .object({
          type: z.enum(["compact", "compact_20260112"]),
          trigger: z
            .object({
              type: z.literal("input_tokens"),
              value: z.number().int().positive(),
            })
            .strict()
            .optional(),
          instructions: z.string().optional(),
          pause_after_compaction: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const openAiModelSettingsSchema = z
  .object({
    max_tokens: z.number().int().positive().optional(),
    context_management: z
      .array(
        z
          .object({
            type: z.literal("compaction"),
            compact_threshold: z.number().int().positive(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const openMaAgentExtensionSchema: z.ZodType<OpenMaAgentExtensionBody> = z
  .object({
    aux_model: agentModelInputSchema.nullable().optional(),
    appendable_prompts: z.array(z.string().min(1)).nullable().optional(),
    context_management: contextManagementSchema.nullable().optional(),
    model_settings: openAiModelSettingsSchema.nullable().optional(),
    harness: z.string().min(1).nullable().optional(),
    enable_general_subagent: z.boolean().nullable().optional(),
  })
  .strict();

const predefinedAgentSchema: z.ZodType<OpenMaPredefinedAgentBody> = z.union([
  z.string().min(1),
  z
    .object({
      type: z.literal("agent"),
      id: z.string().min(1),
      version: z.number().int().min(1).optional(),
    })
    .strict(),
  z.object({ type: z.literal("self") }).strict(),
]);

const inlineAgentsSchema = z
  .object({ type: z.enum(["enabled", "disabled"]) })
  .strict() satisfies z.ZodType<OpenMaInlineAgentsBody>;

const multiagentSettingSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("enabled"),
      inline_agents: inlineAgentsSchema.nullable().optional(),
      predefined_agents: z.array(predefinedAgentSchema).nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("disabled") }).strict(),
]) satisfies z.ZodType<OpenMaMultiagentSettingBody>;

const multiagentAdvisorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("enabled"), model: z.string().min(1) }).strict(),
  z.object({ type: z.literal("disabled") }).strict(),
]) satisfies z.ZodType<OpenMaMultiagentAdvisorBody>;

const multiagent20261001BodySchema = z
  .object({
    type: z.literal("multiagent_20261001"),
    subagents: multiagentSettingSchema.nullable().optional(),
    workflows: multiagentSettingSchema.nullable().optional(),
    advisor: multiagentAdvisorSchema.nullable().optional(),
  })
  .strict() satisfies z.ZodType<OpenMaMultiagent20261001Body>;

const agentMultiagentBodySchema = z.discriminatedUnion("type", [
  agentMultiagentInputSchema,
  multiagent20261001BodySchema,
]) satisfies z.ZodType<AgentMultiagentBody>;

const pinnedAgentResponseSchema = z
  .object({
    type: z.literal("agent"),
    id: z.string(),
    version: z.number().int(),
  })
  .strict() satisfies z.ZodType<OpenMaPinnedAgentResponseBody>;

const multiagentSettingResponseSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("enabled"),
      inline_agents: inlineAgentsSchema,
      predefined_agents: z.array(pinnedAgentResponseSchema),
    })
    .strict(),
  z.object({ type: z.literal("disabled") }).strict(),
]) satisfies z.ZodType<OpenMaMultiagentSettingResponseBody>;

const multiagent20261001ResponseSchema = z
  .object({
    type: z.literal("multiagent_20261001"),
    subagents: multiagentSettingResponseSchema,
    workflows: multiagentSettingResponseSchema,
    advisor: multiagentAdvisorSchema,
  })
  .strict() satisfies z.ZodType<OpenMaMultiagent20261001ResponseBody>;

const agentMultiagentResponseBodySchema = z.discriminatedUnion("type", [
  agentMultiagentResponseSchema,
  multiagent20261001ResponseSchema,
]) satisfies z.ZodType<AgentMultiagentResponseBody>;

export const agentCreateBodySchema: z.ZodType<AgentCreateBody> = z
  .object({
    name: z.string().min(1),
    model: agentModelInputSchema,
    description: z.string().nullable().optional(),
    mcp_servers: z.array(agentMcpServerInputSchema).optional(),
    metadata: agentMetadataSchema.optional(),
    multiagent: agentMultiagentBodySchema.nullable().optional(),
    skills: z.array(agentSkillInputSchema).optional(),
    system: z.string().nullable().optional(),
    tools: z.array(agentToolInputSchema).optional(),
    _oma: openMaAgentExtensionSchema.optional(),
  })
  .strict();

export const agentRetrieveQuerySchema = z
  .object({
    version: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const agentListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
    "created_at[gte]": z.string().min(1).optional(),
    "created_at[lte]": z.string().min(1).optional(),
    include_archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();

export const agentVersionListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).optional(),
    page: z.string().min(1).optional(),
  })
  .strict();

export const agentUpdateBodySchema: z.ZodType<AgentUpdateBody> = z
  .object({
    description: z.string().nullable().optional(),
    mcp_servers: z.array(agentMcpServerInputSchema).nullable().optional(),
    metadata: agentMetadataPatchSchema.nullable().optional(),
    model: agentModelInputSchema.optional(),
    multiagent: agentMultiagentBodySchema.nullable().optional(),
    name: z.string().min(1).optional(),
    skills: z.array(agentSkillInputSchema).nullable().optional(),
    system: z.string().nullable().optional(),
    tools: z.array(agentToolInputSchema).nullable().optional(),
    version: z.number().int().min(1).optional(),
    _oma: openMaAgentExtensionSchema.optional(),
  })
  .strict();

export const agentResponseSchema = z
  .object({
    id: z.string().min(1),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    description: z.string().nullable(),
    mcp_servers: z.array(agentMcpServerResponseSchema),
    metadata: z.record(z.string(), z.string()),
    model: agentModelResponseSchema,
    multiagent: agentMultiagentResponseBodySchema.nullable(),
    name: z.string().min(1),
    skills: z.array(agentSkillResponseSchema),
    system: z.string().nullable(),
    tools: z.array(agentToolResponseSchema),
    type: z.literal("agent"),
    updated_at: z.string(),
    version: z.number().int().min(1),
    _oma: openMaAgentExtensionResponseSchema.optional(),
  })
  .strict();

export const agentPageResponseSchema = z
  .object({
    data: z.array(agentResponseSchema),
    next_page: z.string().nullable(),
  })
  .strict();

/** OMA: DELETE /v1/agents/:agent_id (docs/plans/crud.md, 2.1). */
export const deletedAgentResponseSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("agent_deleted"),
  })
  .strict();
