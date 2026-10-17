// apply_changes: up to 10 create and edit operations under one card
// (builder-agent.md 2.3). `{"$ref": "<ref>"}` in the arguments stands for the id
// of an object an earlier operation of the batch creates.

import { z } from "zod";
import { CREATE_TOOLS } from "./create";
import { DANGER_TOOL_NAMES, unarchiveObjectTool } from "./danger";
import { addSessionResourceTool, createSessionTool, updateSessionTool } from "./sessions";
import { runDeploymentTool, UPDATE_TOOLS } from "./update";
import { formatSchemaError, isRecord, REF_PREFIX, type ToolDef } from "./common";

/**
 * Tools a batch may hold. send_message and run_deployment start an agent and
 * go on their own card; archive and delete are the danger class, one per card
 * (crud.md 3.1).
 */
export const BATCH_TOOLS: ReadonlyMap<string, ToolDef> = new Map(
  [...CREATE_TOOLS, createSessionTool, updateSessionTool, addSessionResourceTool, unarchiveObjectTool, ...UPDATE_TOOLS]
    .filter((tool) => tool.name !== runDeploymentTool.name)
    .map((tool) => [tool.name, tool as ToolDef]),
);

const batchArgs = z
  .object({
    title: z.string().min(1).max(200).optional(),
    operations: z
      .array(
        z
          .object({
            ref: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
            tool: z.string().min(1),
            args: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export type BatchArgs = z.infer<typeof batchArgs>;

export interface PreparedOp {
  opIndex: number;
  ref: string | undefined;
  tool: ToolDef;
  /** Arguments with `$ref` objects replaced by `$ref:<name>` placeholders. */
  args: any;
}

function replaceRefs(value: unknown, defined: ReadonlySet<string>, missing: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceRefs(item, defined, missing));
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$ref") {
      const name = String(value.$ref);
      if (!defined.has(name)) missing.push(name);
      return `${REF_PREFIX}${name}`;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = replaceRefs(child, defined, missing);
    return out;
  }
  return value;
}

export function prepareBatch(args: BatchArgs): { ok: true; ops: PreparedOp[] } | { ok: false; message: string } {
  const defined = new Set<string>();
  const targets = new Set<string>();
  const ops: PreparedOp[] = [];
  for (const [index, operation] of args.operations.entries()) {
    const label = `Операция ${index + 1}`;
    if (operation.tool === "send_message") {
      return { ok: false, message: `${label}: send_message в пачку не входит, первое сообщение идёт отдельной карточкой` };
    }
    if (DANGER_TOOL_NAMES.has(operation.tool)) {
      return { ok: false, message: `${label}: опасная операция ${operation.tool} идёт отдельной карточкой` };
    }
    const tool = BATCH_TOOLS.get(operation.tool);
    if (!tool) return { ok: false, message: `${label}: инструмент ${operation.tool} в пачку не входит` };
    const missing: string[] = [];
    const replaced = replaceRefs(operation.args, defined, missing);
    if (missing.length > 0) return { ok: false, message: `${label}: ссылка ${missing[0]} не задана раньше в пачке` };
    const parsed = tool.args.safeParse(replaced);
    if (!parsed.success) return { ok: false, message: `${label}: ${formatSchemaError(parsed.error)}` };
    const key = tool.op?.targetKey(parsed.data) ?? null;
    if (key !== null) {
      if (key.includes(REF_PREFIX) && tool.name !== "write_memory") {
        return { ok: false, message: `${label}: $ref годится только как ссылка из аргументов, а не как цель правки` };
      }
      if (targets.has(key)) return { ok: false, message: `${label}: две операции над одним объектом в пачке не допускаются` };
      targets.add(key);
    }
    if (operation.ref !== undefined) {
      if (defined.has(operation.ref)) return { ok: false, message: `${label}: ref ${operation.ref} уже занят` };
      defined.add(operation.ref);
    }
    ops.push({ opIndex: index, ref: operation.ref, tool, args: parsed.data });
  }
  return { ok: true, ops };
}

/** Placeholders replaced by ids created earlier in the batch. */
export function resolveRefs(value: unknown, created: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string" && value.startsWith(REF_PREFIX)) {
    const id = created.get(value.slice(REF_PREFIX.length));
    if (id === undefined) throw new Error(`ref ${value.slice(REF_PREFIX.length)} has no id`);
    return id;
  }
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, created));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = resolveRefs(child, created);
    return out;
  }
  return value;
}

export const applyChangesTool: ToolDef<BatchArgs> = {
  name: "apply_changes",
  group: "batch",
  description: "Пачка до 10 операций создания и правки под одной карточкой. Архив, удаление, send_message и run_deployment в пачку не входят. {\"$ref\": \"имя\"} ссылается на объект из операции с этим ref. Ждёт подтверждения.",
  args: batchArgs,
  routes: [...new Map([...BATCH_TOOLS.values()].flatMap((tool) => tool.routes).map((rule) => [`${rule.method} ${rule.pattern}`, rule])).values()],
  precondition: null,
};
