// Class of an operation by the current state of its object (builder-agent.md 2.2).
// Every function is pure: the tools read the state, these decide.

import type { OpClass } from "./ports";

export interface Classified {
  cls: OpClass;
  /** Why the operation is out of v1, for the card and the model. */
  reason: string | null;
}

const ok = (cls: OpClass): Classified => ({ cls, reason: null });
const out = (reason: string): Classified => ({ cls: "out_of_v1", reason });

export const REASON_ARCHIVED = "Объект в архиве. В первой версии ассистент его не меняет";
export const REASON_OWN = "Это агент или окружение самого ассистента. Его меняет человек в консоли";
export const REASON_DEPLOYMENT_ACTIVE = "Деплоймент работает. В первой версии ассистент меняет только деплоймент на паузе";
export const REASON_SESSION_ASSISTANT = "Агент сессии это ассистент. Такую сессию ассистент не создаёт";
export const REASON_SESSION_ARCHIVED = "Агент или окружение в архиве";
export const REASON_SEND_MESSAGE =
  "В первой версии ассистент отправляет только первое сообщение в сессию, которую создал сам";

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** An agent with an MCP server at `PLATFORM_MCP_URL` is an assistant. */
export function isAssistantAgent(
  agent: { mcp_servers?: readonly { type?: string; url?: string }[] | null } | null | undefined,
  platformMcpUrl: string,
): boolean {
  const target = normalizeUrl(platformMcpUrl);
  return (agent?.mcp_servers ?? []).some(
    (server) => typeof server.url === "string" && normalizeUrl(server.url) === target,
  );
}

export function classifyEdit(input: { archived: boolean; ownAssistantTarget?: boolean }): Classified {
  if (input.archived) return out(REASON_ARCHIVED);
  if (input.ownAssistantTarget) return out(REASON_OWN);
  return ok("update");
}

export function classifyDeploymentEdit(deployment: { status?: unknown; archived_at?: unknown }): Classified {
  if (deployment.archived_at) return out(REASON_ARCHIVED);
  if (deployment.status !== "paused") return out(REASON_DEPLOYMENT_ACTIVE);
  return ok("update");
}

export function classifyWriteMemory(input: { pathTaken: boolean; storeArchived: boolean }): Classified {
  if (input.storeArchived) return out(REASON_ARCHIVED);
  return ok(input.pathTaken ? "update" : "create");
}

export function classifyCreateSession(input: {
  agentIsAssistant: boolean;
  agentArchived: boolean;
  environmentArchived: boolean;
}): Classified {
  if (input.agentIsAssistant) return out(REASON_SESSION_ASSISTANT);
  if (input.agentArchived || input.environmentArchived) return out(REASON_SESSION_ARCHIVED);
  return ok("create");
}

export function classifySendMessage(input: {
  createdByThisConversation: boolean;
  status: unknown;
  archived: boolean;
  userMessages: number;
}): Classified {
  if (
    !input.createdByThisConversation ||
    input.status !== "idle" ||
    input.archived ||
    input.userMessages > 0
  ) {
    return out(REASON_SEND_MESSAGE);
  }
  return ok("update");
}
