// `POST /v1/oma/platform-mcp/preview` and `/confirm` (builder-agent.md 1.4, 2.5).
// The console sends `session_id` and `tool_use_id`; the server takes the tool
// name and the arguments from the `agent.mcp_tool_use` event itself.

import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { logAction } from "./gate";
import { createCallContext } from "./handler";
import { createInnerApi } from "./inner-api";
import type { ActorClaims, ConfirmationRow, PlatformMcpDeps } from "./ports";
import { buildPreview, previewJson } from "./preview";
import { TOOL_TABLE } from "./tool-table";
import { isRecord, type ToolDef } from "./tools/common";
import { readAllEvents } from "./tools/read";

export interface ConsoleVariables {
  Variables: { tenant_id?: string; user_id?: string | null };
}

type Ctx = Context<ConsoleVariables>;

const fail = (c: Ctx, status: 400 | 403 | 404 | 409 | 502, type: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json({ error: { type, message }, ...extra }, status);

interface Loaded {
  /** Inner reads go as the owner of the session: only the owner gets assistant tokens (3.3). */
  actor: ActorClaims;
  /** The member who opened the card. */
  viewerId: string;
  tool: ToolDef;
  input: unknown;
  events: any[];
  pending: boolean;
  owner: { userId: string; displayName: string | null } | null;
}

function toolName(name: string): string {
  return name.startsWith("mcp__platform__") ? name.slice("mcp__platform__".length) : name;
}

/** Common checks of both routes. A `Response` means a refusal. */
async function load(c: Ctx, deps: PlatformMcpDeps, body: Record<string, unknown>): Promise<Loaded | Response> {
  const workspaceId = c.get("tenant_id");
  const userId = c.get("user_id");
  if (!workspaceId || !userId) return fail(c, 403, "forbidden", "Нужен вход пользователя");
  const sessionId = typeof body.session_id === "string" ? body.session_id : "";
  const toolUseId = typeof body.tool_use_id === "string" ? body.tool_use_id : "";
  if (!sessionId || !toolUseId) return fail(c, 400, "invalid_request", "Нужны session_id и tool_use_id");
  const owner = await deps.owners.ownerOf(workspaceId, sessionId);
  if (!owner) return fail(c, 404, "not_found", "Сессия не найдена");
  const check = await deps.sessionToolCheck.check(workspaceId, sessionId);
  if (!check.ok) return fail(c, 403, "session_tools", check.message);
  // Preview is a read for every member (3.1). Assistant tokens pass only for
  // the owner of the session, so the nested reads go under the owner; the
  // viewer is a member of the same workspace, the auth middleware checked it.
  const actor: ActorClaims = { workspaceId, userId: owner.userId, sessionId };
  const events = await readAllEvents({ api: createInnerApi(deps, actor) }, sessionId);
  if (!events) return fail(c, 404, "not_found", "Сессия не найдена");
  const use = events.find(
    (event) => event?.type === "agent.mcp_tool_use" && event.id === toolUseId && (event.mcp_server_name ?? "platform") === "platform",
  );
  if (!use) return fail(c, 404, "not_found", "Вызова с таким tool_use_id в сессии нет");
  const tool = TOOL_TABLE.get(toolName(String(use.name ?? "")));
  if (!tool || (tool.group !== "write" && tool.group !== "batch")) {
    return fail(c, 400, "invalid_request", "Этот вызов не требует подтверждения");
  }
  const answered = events.some(
    (event) =>
      (event?.type === "user.tool_confirmation" && event.tool_use_id === toolUseId) ||
      (event?.type === "agent.mcp_tool_result" && event.mcp_tool_use_id === toolUseId),
  );
  return { actor, viewerId: userId, tool, input: use.input ?? {}, events, pending: !answered, owner };
}

async function readBody(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

export function buildConfirmRoutes(deps: PlatformMcpDeps): Hono<ConsoleVariables> {
  const app = new Hono<ConsoleVariables>();

  app.post("/preview", async (c) => {
    const body = await readBody(c);
    if (!body) return fail(c, 400, "invalid_request", "Тело должно быть JSON");
    const loaded = await load(c, deps, body);
    if (loaded instanceof Response) return loaded;
    const canConfirm = loaded.owner?.userId === loaded.viewerId;
    const ownerFields = { can_confirm: canConfirm && loaded.pending, owner_name: loaded.owner?.displayName ?? null, pending: loaded.pending };
    if (!(await deps.assistantSwitch.isEnabled(loaded.actor.workspaceId))) {
      // The owner keeps the buttons: the card shows «Ассистент выключен» and blocks «Применить» itself.
      return c.json({ disabled: true, tool: loaded.tool.name, ...ownerFields });
    }
    const ctx = await createCallContext(deps, loaded.actor);
    const preview = await buildPreview(ctx, loaded.tool, loaded.input, "console");
    return c.json({ disabled: false, ...previewJson(preview), ...ownerFields });
  });

  app.post("/confirm", async (c) => {
    const body = await readBody(c);
    if (!body) return fail(c, 400, "invalid_request", "Тело должно быть JSON");
    const result = body.result;
    if (result !== "allow" && result !== "deny") return fail(c, 400, "invalid_request", "result это allow или deny");
    const loaded = await load(c, deps, body);
    if (loaded instanceof Response) return loaded;
    const { actor } = loaded;
    if (loaded.owner?.userId !== loaded.viewerId) {
      return fail(c, 403, "forbidden", `Подтвердить может только ${loaded.owner?.displayName ?? "владелец сессии"}`);
    }
    if (!loaded.pending) return fail(c, 409, "not_pending", "Вызов уже не ждёт подтверждения");
    const toolUseId = String(body.tool_use_id);
    const confirmApi = createInnerApi(deps, actor, { issuer: "confirm", toolUseId });
    const eventsPath = `/v1/sessions/${encodeURIComponent(actor.sessionId)}/events`;

    if (result === "deny") {
      const denyMessage = typeof body.deny_message === "string" && body.deny_message ? body.deny_message.slice(0, 2000) : undefined;
      const sent = await confirmApi.post(eventsPath, {
        events: [{ type: "user.tool_confirmation", result: "deny", tool_use_id: toolUseId, ...(denyMessage ? { deny_message: denyMessage } : {}) }],
      });
      if (!sent.ok) return fail(c, 502, "event_failed", "Событие отказа не записалось");
      // The refusal goes into the action log (3.6): the «Изменения» tab shows it.
      try {
        const ctx = await createCallContext(deps, actor);
        const preview = await buildPreview(ctx, loaded.tool, loaded.input, "model").catch(() => null);
        await logAction(ctx, {
          tool: loaded.tool.name,
          cls: preview?.cls ?? "update",
          toolUseId,
          opIndex: 0,
          args: loaded.input,
          result: "denied",
          errorMessage: denyMessage ?? null,
          targetKind: loaded.tool.op?.targetKind ?? null,
          targetId: preview?.ops[0]?.plan.targetId ?? null,
          startedAt: deps.now?.() ?? new Date(),
        });
      } catch {
        // The refusal is already in the session; the log row is a convenience.
      }
      return c.json({ ok: true, result: "deny" });
    }

    if (!(await deps.assistantSwitch.isEnabled(actor.workspaceId))) {
      return fail(c, 409, "disabled", "Ассистент выключен в пространстве");
    }
    const ctx = await createCallContext(deps, actor);
    const preview = await buildPreview(ctx, loaded.tool, loaded.input, "console");
    const fresh = { preview: { ...previewJson(preview), can_confirm: true } };
    if (preview.schemaError) return fail(c, 409, "schema", preview.schemaError, fresh);
    if (preview.notFound) return fail(c, 404, "not_found", "Объект не найден", fresh);
    if (preview.cls === "out_of_v1") return fail(c, 409, "class", preview.reason ?? "Операция вне первой версии", fresh);
    if (preview.secretInArgs) return fail(c, 409, "secret", "В черновике значение секрета пространства", fresh);
    if (preview.invalid) return fail(c, 409, "schema", preview.invalid, fresh);
    if (preview.argsStale || preview.digest !== body.preview_digest) {
      return fail(c, 409, "stale", "Объект изменился после предложения", fresh);
    }

    const row: ConfirmationRow = {
      id: deps.randomId?.() ?? randomUUID(),
      workspaceId: actor.workspaceId,
      sessionId: actor.sessionId,
      toolUseId,
      userId: actor.userId,
      result: "allow",
      previewDigest: preview.digest,
      opClasses: preview.ops.map(({ plan }) => plan.cls),
      targetRevisions: preview.ops.map(({ plan }) => plan.revision),
      eventId: null,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      usedAt: null,
    };
    await deps.confirmations.insert(row);
    await deps.hooks?.afterConfirm?.({ workspaceId: actor.workspaceId, sessionId: actor.sessionId, toolUseId, tool: loaded.tool.name });
    let sent;
    try {
      sent = await confirmApi.post(eventsPath, { events: [{ type: "user.tool_confirmation", result: "allow", tool_use_id: toolUseId }] });
    } catch {
      sent = null;
    }
    if (!sent?.ok) {
      await deps.confirmations.delete(row.id);
      return fail(c, 502, "event_failed", "Подтверждение не записалось в сессию");
    }
    const eventId = Array.isArray(sent.json?.data) ? sent.json.data[0]?.id : undefined;
    if (typeof eventId === "string") await deps.confirmations.attachEvent(row.id, eventId);
    return c.json({ ok: true, result: "allow", confirmation_id: row.id });
  });

  return app;
}
