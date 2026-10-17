// Preview of a write call and its digest (builder-agent.md 1.4, 2.5 step 4).
// The same code answers the console card, the `confirm` route, the gate and
// the model's `preview_change`. Only the console variant has a digest, masks
// the arguments and warns about a known secret in them (2.6).

import { createHash } from "node:crypto";
import { maxOpClass, type OpClass } from "./ports";
import {
  dependencyDigest,
  dumpYaml,
  formatSchemaError,
  hasKnownSecret,
  isRecord,
  targetKindOf,
  type CallContext,
  type DependencyReport,
  type OpContext,
  type OpPlan,
  type ToolDef,
} from "./tools/common";
import { prepareBatch, type BatchArgs, type PreparedOp } from "./tools/batch";

export type PreviewAudience = "console" | "model";

export const SECRET_WARNING = "В черновике значение секрета пространства. Секрет задаётся только в хранилище секретов";

export interface PreviewOpView {
  op_index: number;
  tool: string;
  target_kind: string;
  target_id: string | null;
  class: OpClass;
  reason: string | null;
  revision: string | null;
  before_yaml: string | null;
  after_yaml: string;
  diff: string;
  warnings: string[];
  details: Record<string, unknown> | null;
  not_found: string | null;
  invalid: string | null;
  args_stale: boolean;
  /** Name of the object for the card title: name, title or memory path. */
  name: string | null;
  /** Agent edit: the version now and the version the write makes. */
  version_from: number | null;
  version_to: number | null;
  /** Archive and delete: what blocks the operation and what it changes (crud.md 3.4). */
  dependencies: DependencyReport | null;
  /** Delete: the card says «Это нельзя отменить». */
  irreversible: boolean;
}

export interface PreviewOp {
  op: PreparedOp;
  plan: OpPlan;
}

export interface Preview {
  tool: string;
  args: unknown;
  schemaError: string | null;
  ops: PreviewOp[];
  views: PreviewOpView[];
  cls: OpClass;
  /** sha256 of the canonical JSON of the console variant; empty for the model. */
  digest: string;
  secretInArgs: boolean;
  argsStale: boolean;
  notFound: string | null;
  invalid: string | null;
  reason: string | null;
}

/** Operations of a write call: one, or the batch. */
export function prepareOps(
  tool: ToolDef,
  rawArgs: unknown,
): { ok: true; args: any; ops: PreparedOp[] } | { ok: false; message: string } {
  const parsed = tool.args.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, message: formatSchemaError(parsed.error) };
  if (tool.group === "batch") {
    const prepared = prepareBatch(parsed.data as BatchArgs);
    return prepared.ok ? { ok: true, args: parsed.data, ops: prepared.ops } : prepared;
  }
  if (!tool.op) return { ok: false, message: `Инструмент ${tool.name} ничего не пишет` };
  return { ok: true, args: parsed.data, ops: [{ opIndex: 0, ref: undefined, tool, args: parsed.data }] };
}

export function opContext(ctx: CallContext, ops: readonly PreparedOp[]): OpContext {
  const refs = new Map<string, { tool: string; args: any }>();
  for (const op of ops) if (op.ref !== undefined) refs.set(op.ref, { tool: op.tool.name, args: op.args });
  return { ...ctx, batch: ops.length > 1 || refs.size > 0 ? { refs } : null };
}

const NAME_FIELDS = ["name", "display_title", "title", "path"] as const;

/** The object name shown on the card: from the new state, the current one or the arguments. */
function objectName(op: PreparedOp, plan: OpPlan): string | null {
  const args = isRecord(op.args) ? op.args : {};
  const config = isRecord(args.config) ? args.config : {};
  for (const source of [plan.after, plan.before, config, args]) {
    if (!isRecord(source)) continue;
    for (const field of NAME_FIELDS) {
      const value = source[field];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return null;
}

/** An agent edit makes the next version: the card says «версия 3 станет 4». */
function agentVersions(op: PreparedOp, plan: OpPlan): { version_from: number | null; version_to: number | null } {
  const from = plan.revision === null ? Number.NaN : Number(plan.revision);
  if (targetKindOf(op.tool, op.args) !== "agent" || op.tool.op?.kindOf || plan.cls !== "update" || !Number.isInteger(from)) {
    return { version_from: null, version_to: null };
  }
  return { version_from: from, version_to: from + 1 };
}

function view(ctx: CallContext, op: PreparedOp, plan: OpPlan, audience: PreviewAudience): PreviewOpView {
  const beforeYaml = plan.before === null || plan.before === undefined ? null : dumpYaml(plan.before);
  let afterYaml = dumpYaml(plan.after);
  let details = plan.details ?? null;
  let dependencies = plan.dependencies ?? null;
  if (audience === "console") {
    afterYaml = ctx.libs.scan(afterYaml, ctx.known).text;
    if (details) details = JSON.parse(ctx.libs.scan(JSON.stringify(details), ctx.known).text);
    if (dependencies) dependencies = JSON.parse(ctx.libs.scan(JSON.stringify(dependencies), ctx.known).text);
  } else if (details && "card" in details) {
    // The card block repeats the arguments for the console; the model has them.
    const { card: _card, ...rest } = details;
    details = rest;
  }
  return {
    op_index: op.opIndex,
    tool: op.tool.name,
    target_kind: targetKindOf(op.tool, op.args) ?? "",
    target_id: plan.targetId,
    class: plan.cls,
    reason: plan.reason,
    revision: plan.revision,
    before_yaml: beforeYaml,
    after_yaml: afterYaml,
    diff: ctx.libs.yamlDiff(beforeYaml ?? "", afterYaml),
    warnings: plan.warnings,
    details,
    not_found: plan.notFound ?? null,
    invalid: plan.invalid ?? null,
    args_stale: plan.argsStale === true,
    name: objectName(op, plan),
    ...agentVersions(op, plan),
    dependencies,
    irreversible: plan.irreversible === true,
  };
}

export async function buildPreview(
  ctx: CallContext,
  tool: ToolDef,
  rawArgs: unknown,
  audience: PreviewAudience,
): Promise<Preview> {
  const prepared = prepareOps(tool, rawArgs);
  const digestOf = (payload: unknown) =>
    audience === "console" ? createHash("sha256").update(ctx.libs.canonicalJson(payload)).digest("hex") : "";
  if (!prepared.ok) {
    return {
      tool: tool.name,
      args: rawArgs,
      schemaError: prepared.message,
      ops: [],
      views: [],
      cls: "out_of_v1",
      digest: digestOf({ tool: tool.name, args: rawArgs, schema_error: prepared.message }),
      secretInArgs: false,
      argsStale: false,
      notFound: null,
      invalid: null,
      reason: null,
    };
  }
  const octx = opContext(ctx, prepared.ops);
  const ops: PreviewOp[] = [];
  for (const op of prepared.ops) ops.push({ op, plan: await op.tool.op!.plan(octx, op.args) });
  const views = ops.map(({ op, plan }) => view(ctx, op, plan, audience));
  const secretInArgs = audience === "console" && hasKnownSecret(rawArgs, ctx.known);
  if (secretInArgs) for (const item of views) item.warnings = [...item.warnings, SECRET_WARNING];
  const cls = maxOpClass(ops.map(({ plan }) => plan.cls));
  const firstOut = ops.find(({ plan }) => plan.cls === "out_of_v1");
  const digest = digestOf({
    tool: tool.name,
    args: rawArgs,
    ops: ops.map(({ op, plan }, index) => ({
      op_index: op.opIndex,
      tool: op.tool.name,
      args: op.args,
      target_kind: targetKindOf(op.tool, op.args),
      target_id: plan.targetId,
      revision: plan.revision,
      class: plan.cls,
      state: plan.state,
      before_yaml: views[index].before_yaml,
      after_yaml: views[index].after_yaml,
      warnings: views[index].warnings,
      not_found: plan.notFound ?? null,
      invalid: plan.invalid ?? null,
      args_stale: plan.argsStale === true,
      // A new dependency after the card changes the digest (crud.md 3.4).
      dependencies: dependencyDigest(plan.dependencies),
      irreversible: plan.irreversible === true,
    })),
    secret_in_args: secretInArgs,
  });
  return {
    tool: tool.name,
    args: rawArgs,
    schemaError: null,
    ops,
    views,
    cls,
    digest,
    secretInArgs,
    argsStale: ops.some(({ plan }) => plan.argsStale === true),
    notFound: ops.find(({ plan }) => plan.notFound)?.plan.notFound ?? null,
    invalid: ops.find(({ plan }) => plan.invalid)?.plan.invalid ?? null,
    reason: firstOut?.plan.reason ?? null,
  };
}

/** The preview as JSON for the console card and the `preview` route. */
export function previewJson(preview: Preview): Record<string, unknown> {
  const single = preview.views.length === 1 ? preview.views[0] : null;
  // The session and message cards read their own block (1.4): the owner sees
  // the agent, the environment and the files, or the full text of the message.
  const card = (tool: string) => (single?.tool === tool && single.details?.card ? single.details.card : null);
  return {
    tool: preview.tool,
    class: preview.cls,
    reason: preview.reason,
    schema_error: preview.schemaError,
    not_found: preview.notFound,
    invalid: preview.invalid,
    args_stale: preview.argsStale,
    secret_in_args: preview.secretInArgs,
    secret: preview.secretInArgs,
    before_yaml: single?.before_yaml ?? null,
    after_yaml: single?.after_yaml ?? null,
    diff: single?.diff ?? null,
    warnings: single?.warnings ?? [],
    dependencies: single?.dependencies ?? null,
    irreversible: single?.irreversible ?? false,
    operations: preview.views,
    session: card("create_session"),
    message: card("send_message"),
    preview_digest: preview.digest,
  };
}
