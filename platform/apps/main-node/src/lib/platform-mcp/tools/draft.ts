// preview_change: a draft without a write (builder-agent.md 2.3). The model
// variant of the preview: the current object is cleaned, the model's own
// arguments stay as they are, and the known-secret check is absent (2.6).

import { z } from "zod";
import { buildPreview } from "../preview";
import { ROUTES } from "../route-rules";
import { createAgentTool, createDeploymentTool, createEnvironmentTool, createMemoryStoreTool, createSkillTool } from "./create";
import {
  configSchema,
  dumpYaml,
  encodeId,
  formatSchemaError,
  isRecord,
  parseConfig,
  type CallContext,
  type ToolDef,
  type ToolOutput,
} from "./common";
import {
  createSkillVersionTool,
  harnessCardChanges,
  updateAgentTool,
  updateDeploymentTool,
  updateEnvironmentTool,
  updateHarnessCardTool,
  updateMemoryStoreTool,
  updateModelCardTool,
  writeMemoryTool,
} from "./update";

const KINDS = ["agent", "environment", "skill", "deployment", "memory", "memory_store", "model_card", "harness_card", "outcome"] as const;

const previewArgs = z
  .object({ kind: z.enum(KINDS), id: z.string().min(1).optional(), body: configSchema })
  .strict();

const MODEL_CARD_DRAFT_FIELDS = ["model_id", "model", "provider", "pi_config", "is_default"] as const;
const HARNESS_CARD_DRAFT_FIELDS = ["name", "install", "protocols", "allowed_env"] as const;

const outcomeSchema = z
  .object({
    description: z.string().min(1),
    rubric: z.union([
      z.object({ type: z.literal("text"), content: z.string().min(1) }).strict(),
      z.object({ type: z.literal("file"), file_id: z.string().min(1) }).strict(),
    ]),
    max_iterations: z.number().int().min(1).max(20).optional(),
  })
  .strict();

function pick(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) if (body[field] !== undefined) out[field] = body[field];
  return out;
}

function draftOutput(kind: string, value: unknown, extra: Record<string, unknown> = {}): ToolOutput {
  return { text: JSON.stringify({ kind, class: "draft", after_yaml: dumpYaml(value), ...extra }), prescanned: true };
}

async function mapToTool(
  ctx: CallContext,
  kind: (typeof KINDS)[number],
  id: string | undefined,
  body: Record<string, unknown>,
): Promise<{ tool: ToolDef; args: unknown } | ToolOutput> {
  switch (kind) {
    case "agent": {
      if (!id) return { tool: createAgentTool, args: { config: body } };
      const agent = await ctx.api.get(`/v1/agents/${encodeId(id)}`);
      if (agent.status === 404) return { text: "Агент не найден", isError: true };
      return { tool: updateAgentTool, args: { agent_id: id, expected_version: agent.json?.version ?? 1, changes: body } };
    }
    case "environment":
      return id ? { tool: updateEnvironmentTool, args: { environment_id: id, changes: body } } : { tool: createEnvironmentTool, args: { config: body } };
    case "skill":
      return id
        ? { tool: createSkillVersionTool, args: { skill_id: id, files: body.files } }
        : { tool: createSkillTool, args: { display_title: body.display_title, files: body.files } };
    case "deployment":
      return id ? { tool: updateDeploymentTool, args: { deployment_id: id, changes: body } } : { tool: createDeploymentTool, args: body };
    case "memory":
      return { tool: writeMemoryTool, args: body };
    case "memory_store":
      return id ? { tool: updateMemoryStoreTool, args: { memory_store_id: id, ...body } } : { tool: createMemoryStoreTool, args: body };
    case "model_card":
      if (id) return { tool: updateModelCardTool, args: { model_card_id: id, changes: body } };
      return draftOutput("model_card", pick(body, MODEL_CARD_DRAFT_FIELDS), {
        note: "Карточку создаёт человек в форме консоли. Ключ он вводит сам",
      });
    case "harness_card": {
      if (id) return { tool: updateHarnessCardTool, args: { harness_card_id: id, changes: body } };
      const draft = pick(body, HARNESS_CARD_DRAFT_FIELDS);
      const parsed = harnessCardChanges.safeParse(draft);
      if (!parsed.success) return { text: formatSchemaError(parsed.error), isError: true };
      return draftOutput("harness_card", parsed.data, {
        note: "Карточку создаёт человек в форме консоли. ID, команду, аргументы и рабочую папку он вводит сам",
      });
    }
    case "outcome": {
      const parsed = outcomeSchema.safeParse(body);
      if (!parsed.success) return { text: formatSchemaError(parsed.error), isError: true };
      return draftOutput("outcome", parsed.data, { note: "Outcome задаёт человек в диалоге сессии" });
    }
  }
}

export const previewChangeTool: ToolDef<z.infer<typeof previewArgs>> = {
  name: "preview_change",
  group: "draft",
  description: "Черновик без записи: YAML, разница с текущим объектом, класс и предупреждения. body это объект или YAML.",
  args: previewArgs,
  routes: [
    ROUTES.agent, ROUTES.environment, ROUTES.skill, ROUTES.deployment, ROUTES.memoryStore, ROUTES.memories, ROUTES.memory,
    ROUTES.modelCard, ROUTES.modelCards, ROUTES.harnessCard, ROUTES.files, ROUTES.file, ROUTES.session, ROUTES.sessionEvents,
  ],
  precondition: null,
  async run(ctx, args) {
    const parsed = parseConfig(args.body);
    if (!parsed.ok) return { text: parsed.message, isError: true };
    if (!isRecord(parsed.value)) return { text: "body должен быть объектом", isError: true };
    const mapped = await mapToTool(ctx, args.kind, args.id, parsed.value);
    if (!("tool" in mapped)) return mapped;
    const preview = await buildPreview(ctx, mapped.tool, mapped.args, "model");
    if (preview.schemaError) return { text: preview.schemaError, isError: true };
    const first = preview.views[0];
    return {
      text: JSON.stringify({
        kind: args.kind,
        tool: mapped.tool.name,
        class: preview.cls,
        ...(preview.reason ? { reason: preview.reason } : {}),
        ...(preview.notFound ? { not_found: preview.notFound } : {}),
        ...(preview.invalid ? { invalid: preview.invalid } : {}),
        before_yaml: first?.before_yaml ?? null,
        after_yaml: first?.after_yaml ?? "",
        diff: first?.diff ?? "",
        warnings: first?.warnings ?? [],
        next: `Чтобы применить, вызови ${mapped.tool.name} с аргументами ${JSON.stringify(mapped.args)}`,
      }),
      prescanned: true,
    };
  },
};
