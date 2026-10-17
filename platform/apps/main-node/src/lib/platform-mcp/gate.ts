// The gate before every call above draft (builder-agent.md 2.5, step 8).
// It checks the switch, the call in the session log, the owner's confirmation,
// the class and the digest, marks the confirmation used and runs the
// operations one by one with the revision from the confirmation row.

import { createHash, randomUUID } from "node:crypto";
import { OP_CLASS_ORDER, type ActionResult, type ActionRow, type ConfirmationRow, type OpClass } from "./ports";
import { buildPreview, opContext } from "./preview";
import { resolveRefs } from "./tools/batch";
import { dependencyDigest, RouteError, targetKindOf, type CallContext, type ToolDef, type ToolOutput, type WriteOutcome } from "./tools/common";
import { readAllEvents } from "./tools/read";

export const MESSAGES = {
  confirmation: "Нужно подтверждение пользователя. Закончи ход и дождись ответа",
  stale: "Объект изменился после подтверждения. Покажи новую разницу и спроси снова",
  cls: "Операция стала опаснее, чем на карточке. В первой версии её делает человек в консоли",
  disabled: "Ассистент выключен в этом пространстве. Скажи пользователю, что включить его может владелец или администратор",
  notFound: "Объект не найден",
} as const;

/** After a create: the object exists, a second create makes a copy. */
export const DONE_NOTE = "Это уже создано на платформе, повторно не создавай. Перед новой записью сверяйся с тем, что уже создано в этом разговоре";

export interface LogInput {
  tool: string;
  cls: OpClass;
  toolUseId: string;
  opIndex: number;
  args: unknown;
  result: ActionResult;
  errorMessage?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  targetRevision?: string | null;
  confirmationId?: string | null;
  previewDigest?: string | null;
  maskedCount?: number;
  startedAt: Date;
}

function redactInput(ctx: CallContext, value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > 2000) return "[длинная строка]";
    return ctx.libs.scan(value, []).text;
  }
  if (Array.isArray(value)) return value.map((item) => redactInput(ctx, item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactInput(ctx, child)]));
  }
  return value;
}

/** Writes one row of the action log. Known secret values never reach it. */
export async function logAction(ctx: CallContext, input: LogInput): Promise<void> {
  const now = ctx.deps.now?.() ?? new Date();
  const assistant = await ctx.assistant().catch(() => ({ agentId: null, agentVersion: null, model: null }));
  const scannedError = input.errorMessage ? ctx.libs.scan(input.errorMessage, ctx.known).text.slice(0, 500) : null;
  const row: ActionRow = {
    id: ctx.deps.randomId?.() ?? randomUUID(),
    workspaceId: ctx.actor.workspaceId,
    userId: ctx.actor.userId,
    sessionId: ctx.actor.sessionId,
    agentId: assistant.agentId,
    agentVersion: assistant.agentVersion,
    model: assistant.model,
    tool: input.tool,
    class: input.cls,
    toolUseId: input.toolUseId,
    opIndex: input.opIndex,
    inputDigest: createHash("sha256").update(ctx.libs.canonicalJson(input.args ?? null)).digest("hex"),
    inputRedacted: JSON.parse(ctx.libs.scan(JSON.stringify(redactInput(ctx, input.args ?? null)), ctx.known).text),
    targetKind: input.targetKind ?? null,
    targetId: input.targetId ?? null,
    targetRevision: input.targetRevision ?? null,
    result: input.result,
    errorMessage: scannedError,
    confirmationId: input.confirmationId ?? null,
    previewDigest: input.previewDigest ?? null,
    maskedCount: input.maskedCount ?? 0,
    createdAt: input.startedAt.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: now.getTime() - input.startedAt.getTime(),
  };
  await ctx.deps.actions.insert(row);
}

const RESULT_TEXT: Partial<Record<ActionResult, string>> = {
  refused_confirmation: MESSAGES.confirmation,
  refused_stale: MESSAGES.stale,
  refused_class: MESSAGES.cls,
  refused_disabled: MESSAGES.disabled,
};

function writeResult(outcome: WriteOutcome): ActionResult {
  if (outcome.type === "ok") return "ok";
  return outcome.type === "stale" ? "refused_stale" : "error";
}

function sameCall(ctx: CallContext, event: any, tool: ToolDef, rawArgs: unknown): boolean {
  const name = String(event?.name ?? "");
  if (name !== tool.name && name !== `mcp__platform__${tool.name}`) return false;
  if (event?.mcp_server_name !== undefined && event.mcp_server_name !== "platform") return false;
  return ctx.libs.canonicalJson(event?.input ?? null) === ctx.libs.canonicalJson(rawArgs ?? null);
}

/** Is the confirmation row valid for this call right now. */
async function findConfirmation(ctx: CallContext, toolUseId: string, events: readonly any[]): Promise<ConfirmationRow | null> {
  const owner = await ctx.deps.owners.ownerOf(ctx.actor.workspaceId, ctx.actor.sessionId);
  const row = await ctx.deps.confirmations.findAllow(ctx.actor.workspaceId, ctx.actor.sessionId, toolUseId);
  if (!row || !owner || row.userId !== owner.userId || row.usedAt !== null || row.result !== "allow") return null;
  const confirmed = events.some(
    (event) =>
      event?.type === "user.tool_confirmation" &&
      event.tool_use_id === toolUseId &&
      event.result === "allow" &&
      (row.eventId === null || event.id === row.eventId),
  );
  return confirmed ? row : null;
}

function higher(now: OpClass, confirmed: OpClass | undefined): boolean {
  return now === "out_of_v1" || OP_CLASS_ORDER[now] > OP_CLASS_ORDER[confirmed ?? "read"];
}

/** A write call: checks, then the operations in order. */
export async function runConfirmedCall(
  ctx: CallContext,
  tool: ToolDef,
  rawArgs: unknown,
  toolUseId: string | null,
): Promise<ToolOutput> {
  const startedAt = ctx.deps.now?.() ?? new Date();
  const baseClass: OpClass = "create";
  const refuse = async (result: ActionResult, text: string, extra: Partial<LogInput> = {}): Promise<ToolOutput> => {
    await logAction(ctx, {
      tool: tool.name,
      cls: baseClass,
      toolUseId: toolUseId ?? `missing-${randomUUID()}`,
      opIndex: 0,
      args: rawArgs,
      result,
      errorMessage: text,
      startedAt,
      ...extra,
    });
    return { text, isError: true };
  };

  if (!toolUseId) return refuse("refused_confirmation", MESSAGES.confirmation);
  if (!(await ctx.deps.assistantSwitch.isEnabled(ctx.actor.workspaceId))) return refuse("refused_disabled", MESSAGES.disabled);

  const events = (await readAllEvents(ctx, ctx.actor.sessionId)) ?? [];
  const useEvent = events.find((event) => event?.type === "agent.mcp_tool_use" && event.id === toolUseId);
  if (!useEvent || !sameCall(ctx, useEvent, tool, rawArgs)) return refuse("refused_confirmation", MESSAGES.confirmation);
  const confirmation = await findConfirmation(ctx, toolUseId, events);
  if (!confirmation) return refuse("refused_confirmation", MESSAGES.confirmation);
  const confirmLog = { confirmationId: confirmation.id, previewDigest: confirmation.previewDigest };

  const preview = await buildPreview(ctx, tool, rawArgs, "console");
  if (preview.schemaError) return refuse("error", preview.schemaError, confirmLog);
  if (preview.notFound) return refuse("error", preview.notFound, confirmLog);
  if (preview.ops.some(({ plan }, index) => higher(plan.cls, confirmation.opClasses[index]))) {
    return refuse("refused_class", MESSAGES.cls, { ...confirmLog, cls: preview.cls });
  }
  if (preview.digest !== confirmation.previewDigest) return refuse("refused_stale", MESSAGES.stale, { ...confirmLog, cls: preview.cls });

  const usedAt = (ctx.deps.now?.() ?? new Date()).toISOString();
  if (!(await ctx.deps.confirmations.markUsed(confirmation.id, usedAt))) {
    return refuse("refused_confirmation", MESSAGES.confirmation, confirmLog);
  }

  const octx = opContext(ctx, preview.ops.map(({ op }) => op));
  const created = new Map<string, string>();
  const lines: string[] = [];
  const nextSteps: string[] = [];
  let madeNew = false;
  let failed: string | null = null;
  for (const [index, { op }] of preview.ops.entries()) {
    const opStarted = ctx.deps.now?.() ?? new Date();
    const confirmedClass = confirmation.opClasses[index];
    const row = (result: ActionResult, extra: Partial<LogInput>) =>
      logAction(ctx, {
        tool: op.tool.name,
        cls: confirmedClass ?? baseClass,
        toolUseId,
        opIndex: op.opIndex,
        args: op.args,
        result,
        targetKind: targetKindOf(op.tool, op.args),
        startedAt: opStarted,
        ...confirmLog,
        ...extra,
      });
    if (failed !== null) {
      lines.push(`${index + 1}. ${op.tool.name}: не выполнялась`);
      continue;
    }
    try {
      if (!(await ctx.deps.assistantSwitch.isEnabled(ctx.actor.workspaceId))) {
        await row("refused_disabled", { errorMessage: MESSAGES.disabled });
        failed = MESSAGES.disabled;
        lines.push(`${index + 1}. ${op.tool.name}: ${MESSAGES.disabled}`);
        continue;
      }
      const args = resolveRefs(op.args, created);
      const plan = await op.tool.op!.plan(octx, args);
      if (plan.notFound) {
        await row("error", { errorMessage: plan.notFound });
        failed = plan.notFound;
        lines.push(`${index + 1}. ${op.tool.name}: ${plan.notFound}`);
        continue;
      }
      if (higher(plan.cls, confirmedClass)) {
        await row("refused_class", { cls: plan.cls, targetId: plan.targetId, errorMessage: MESSAGES.cls });
        failed = MESSAGES.cls;
        lines.push(`${index + 1}. ${op.tool.name}: ${MESSAGES.cls}`);
        continue;
      }
      // Archive and delete read the dependencies once more right before the write (crud.md 3.4).
      const confirmedDependencies = ctx.libs.canonicalJson(dependencyDigest(preview.ops[index]?.plan.dependencies));
      if (ctx.libs.canonicalJson(dependencyDigest(plan.dependencies)) !== confirmedDependencies) {
        await row("refused_stale", { cls: plan.cls, targetId: plan.targetId, errorMessage: MESSAGES.stale });
        failed = MESSAGES.stale;
        lines.push(`${index + 1}. ${op.tool.name}: ${MESSAGES.stale}`);
        continue;
      }
      const revision = confirmation.targetRevisions[index] ?? plan.revision;
      // Test hook: the last check is behind, the nested write is ahead.
      await ctx.deps.hooks?.afterDigestCheck?.({
        workspaceId: ctx.actor.workspaceId,
        sessionId: ctx.actor.sessionId,
        toolUseId,
        tool: op.tool.name,
      });
      const outcome = await op.tool.op!.write(octx, args, plan, revision);
      const text = outcome.type === "ok" ? outcome.summary : outcome.message;
      if (outcome.type === "ok" && outcome.next) nextSteps.push(outcome.next);
      if (outcome.type === "ok" && plan.cls === "create" && op.tool.name !== "send_message") madeNew = true;
      await row(writeResult(outcome), {
        targetId: outcome.type === "ok" ? outcome.targetId : plan.targetId,
        targetRevision: outcome.type === "ok" ? outcome.revision : revision,
        errorMessage: outcome.type === "ok" ? null : outcome.message,
      });
      lines.push(`${index + 1}. ${op.tool.name}: ${text}`);
      if (outcome.type !== "ok") {
        failed = text;
        continue;
      }
      if (op.ref !== undefined && outcome.targetId) created.set(op.ref, outcome.targetId);
    } catch (error) {
      const message = error instanceof RouteError ? error.message : "Внутренняя ошибка сервера платформы";
      await row("error", { errorMessage: message });
      failed = message;
      lines.push(`${index + 1}. ${op.tool.name}: ${ctx.libs.scan(message, ctx.known).text}`);
    }
  }
  // The model reads what is done and what comes next, so it does not repeat a create.
  const tail: string[] = [];
  if (madeNew) tail.push(DONE_NOTE);
  if (failed === null && preview.ops.length === 1 && nextSteps.length > 0) tail.push(`Следующий шаг плана: ${nextSteps[0]}`);
  if (preview.ops.length === 1) {
    const only = lines[0]?.replace(/^1\. [a-z_]+: /, "") ?? "";
    return { text: [only, ...tail].join("\n"), isError: failed !== null };
  }
  const head = failed === null ? "Пачка выполнена." : "Пачка остановилась на ошибке. Созданное раньше осталось.";
  return { text: [head, ...lines, ...tail].join("\n"), isError: failed !== null };
}

/** Text of an earlier result for a repeated `tool_use_id`. Nothing runs again. */
export function replayText(rows: readonly ActionRow[]): ToolOutput {
  const sorted = [...rows].sort((a, b) => a.opIndex - b.opIndex);
  const failed = sorted.find((row) => row.result !== "ok");
  const lines = sorted.map((row) => {
    if (row.result === "ok") return `${row.tool}: уже выполнено${row.targetId ? `, id ${row.targetId}` : ""}`;
    return `${row.tool}: ${RESULT_TEXT[row.result] ?? row.errorMessage ?? "ошибка"}`;
  });
  return { text: `Этот вызов уже обработан.\n${lines.join("\n")}`, isError: failed !== undefined };
}
