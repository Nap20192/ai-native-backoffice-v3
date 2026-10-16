// JSON-RPC handler of the platform MCP server (builder-agent.md 2.1).
// Stateless Streamable HTTP: one request per POST, a JSON answer, no session id.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logAction, MESSAGES, replayText, runConfirmedCall } from "./gate";
import { createInnerApi } from "./inner-api";
import type { ActorClaims, PlatformMcpDeps } from "./ports";
import { prepareOps } from "./preview";
import { TOOL_TABLE } from "./tool-table";
import { formatSchemaError, isRecord, RouteError, type AssistantSessionInfo, type CallContext, type ToolDef, type ToolOutput } from "./tools/common";
import { LIMIT_BYTES } from "./tools/read";

export const SERVER_INFO = { name: "openma-platform", version: "1.0.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const KEY_INPUT_MESSAGE =
  "Похоже на ключ API. Секрет задаётся только в хранилище секретов, предложи пользователю request_secret";

export interface JsonRpcAnswer {
  status: number;
  body: unknown | null;
}

/** A per-call context: one known-secrets read, one assistant session read. */
export async function createCallContext(deps: PlatformMcpDeps, actor: ActorClaims): Promise<CallContext> {
  const api = createInnerApi(deps, actor);
  const known = await deps.knownSecrets.collect(actor.workspaceId);
  let assistant: Promise<AssistantSessionInfo> | null = null;
  return {
    deps,
    libs: deps.libs,
    actor,
    api,
    known,
    assistant() {
      assistant ??= (async () => {
        const response = await api.get(`/v1/sessions/${encodeURIComponent(actor.sessionId)}`);
        const session = response.ok ? response.json : null;
        const model = session?.agent?.model;
        return {
          agentId: session?.agent?.id ?? null,
          agentVersion: typeof session?.agent?.version === "number" ? session.agent.version : null,
          environmentId: session?.environment_id ?? null,
          model: typeof model === "string" ? model : typeof model?.id === "string" ? model.id : null,
        };
      })();
      return assistant;
    },
  };
}

/** A well-known key pattern in `system`, `metadata`, `env` values or a model card body (2.1, «Вход»). */
export function hasKeyLikeInput(tool: string, args: unknown, hasKeyPattern: (text: string) => boolean, kind?: unknown): boolean {
  const all = tool === "update_model_card" || (tool === "preview_change" && kind === "model_card");
  const walk = (node: unknown, sensitive: boolean): boolean => {
    if (typeof node === "string") return sensitive && hasKeyPattern(node);
    if (Array.isArray(node)) return node.some((item) => walk(item, sensitive));
    if (isRecord(node)) {
      return Object.entries(node).some(([key, child]) => {
        if (key === "system" && typeof child === "string") return hasKeyPattern(child);
        if (key === "metadata" || key === "env") return walk(child, true);
        return walk(child, sensitive);
      });
    }
    return false;
  };
  if (all) return walk(args, true);
  return walk(args, false);
}

function cut(text: string): string {
  return text.length > LIMIT_BYTES ? `${text.slice(0, LIMIT_BYTES)}\n(ответ обрезан до 8 КБ)` : text;
}

function toolResult(output: ToolOutput) {
  return { content: [{ type: "text", text: output.text }], isError: output.isError === true };
}

function finalize(ctx: CallContext, output: ToolOutput): { output: ToolOutput; masked: number } {
  if (output.prescanned) return { output: { ...output, text: cut(output.text) }, masked: output.maskedCount ?? 0 };
  const scanned = ctx.libs.scan(output.text, ctx.known);
  return { output: { ...output, text: cut(scanned.text) }, masked: (output.maskedCount ?? 0) + scanned.count };
}

export function listTools(): unknown[] {
  return [...TOOL_TABLE.values()].map((tool) => {
    const schema = z.toJSONSchema(tool.args, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: tool.name, description: tool.description, inputSchema: schema };
  });
}

export async function callTool(
  deps: PlatformMcpDeps,
  actor: ActorClaims,
  name: string,
  rawArgs: unknown,
  toolUseId: string | null,
): Promise<ToolOutput> {
  const tool: ToolDef | undefined = TOOL_TABLE.get(name);
  if (!tool) return { text: `Инструмента ${name} нет. Список даёт tools/list`, isError: true, prescanned: true };
  const startedAt = deps.now?.() ?? new Date();
  const enabled = await deps.assistantSwitch.isEnabled(actor.workspaceId);
  const ctx = await createCallContext(deps, actor);
  const logId = toolUseId ?? `read-${randomUUID()}`;
  if (!enabled) {
    await logAction(ctx, { tool: name, cls: tool.group === "read" || tool.group === "draft" ? tool.group : "create", toolUseId: logId, opIndex: 0, args: rawArgs, result: "refused_disabled", errorMessage: MESSAGES.disabled, startedAt });
    return { text: MESSAGES.disabled, isError: true };
  }
  const kind = isRecord(rawArgs) ? rawArgs.kind : undefined;
  if (hasKeyLikeInput(name, rawArgs, deps.libs.hasKeyPattern, kind)) {
    await logAction(ctx, { tool: name, cls: "read", toolUseId: logId, opIndex: 0, args: rawArgs, result: "error", errorMessage: KEY_INPUT_MESSAGE, startedAt });
    return { text: KEY_INPUT_MESSAGE, isError: true };
  }

  if (tool.group === "read" || tool.group === "draft") {
    const parsed = tool.args.safeParse(rawArgs ?? {});
    let output: ToolOutput;
    if (!parsed.success) {
      output = { text: formatSchemaError(parsed.error), isError: true, prescanned: true };
    } else {
      try {
        output = await tool.run!(ctx, parsed.data);
      } catch (error) {
        // Own text without the route message: a route may repeat a model value.
        output = {
          text: error instanceof RouteError ? `Маршрут ответил ${error.response.status}. Проверь аргументы через help` : "Внутренняя ошибка сервера платформы",
          isError: true,
          prescanned: true,
        };
      }
    }
    const done = finalize(ctx, output);
    await logAction(ctx, {
      tool: name,
      cls: tool.group,
      toolUseId: logId,
      opIndex: 0,
      args: rawArgs,
      result: done.output.isError ? "error" : "ok",
      errorMessage: done.output.isError ? done.output.text.slice(0, 500) : null,
      maskedCount: done.masked,
      startedAt,
    });
    return done.output;
  }

  const prepared = prepareOps(tool, rawArgs ?? {});
  if (!prepared.ok) {
    await logAction(ctx, { tool: name, cls: "create", toolUseId: logId, opIndex: 0, args: rawArgs, result: "error", errorMessage: prepared.message, startedAt });
    return { text: prepared.message, isError: true, prescanned: true };
  }
  if (toolUseId) {
    const previous = await deps.actions.findByToolUse(actor.workspaceId, actor.sessionId, toolUseId);
    if (previous.length > 0) return replayText(previous);
  }
  const output = await runConfirmedCall(ctx, tool, rawArgs ?? {}, toolUseId);
  return finalize(ctx, output).output;
}

function rpcError(id: unknown, code: number, message: string): JsonRpcAnswer {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

export async function handleJsonRpc(deps: PlatformMcpDeps, actor: ActorClaims, message: unknown): Promise<JsonRpcAnswer> {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } } };
  }
  const id = message.id;
  const isNotification = id === undefined;
  const params = isRecord(message.params) ? message.params : {};
  if (isNotification) return { status: 202, body: null };
  switch (message.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[1],
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: "Инструменты платформы OpenMA. Запись ждёт подтверждения пользователя.",
          },
        },
      };
    }
    case "ping":
      return { status: 200, body: { jsonrpc: "2.0", id, result: {} } };
    case "tools/list":
      return { status: 200, body: { jsonrpc: "2.0", id, result: { tools: listTools() } } };
    case "tools/call": {
      if (typeof params.name !== "string") return rpcError(id, -32602, "params.name is required");
      const meta = isRecord(params._meta) ? params._meta : {};
      const toolUseId = typeof meta["oma/tool_use_id"] === "string" ? meta["oma/tool_use_id"] : null;
      const output = await callTool(deps, actor, params.name, params.arguments ?? {}, toolUseId);
      return { status: 200, body: { jsonrpc: "2.0", id, result: toolResult(output) } };
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}
