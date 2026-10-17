// Class of an operation by the current state of its object (builder-agent.md 2.2).
// Every function is pure: the tools read the state, these decide.

import type { OpClass } from "./ports";

export interface Classified {
  cls: OpClass;
  /** Why the operation is out of v1, for the card and the model. */
  reason: string | null;
  /** A line for the card when the operation goes through with a side effect. */
  warning?: string | null;
}

/** One row of a dependency report (crud.md 1.2). */
export interface DependencyEntry {
  kind: string;
  id: string;
  name: string | null;
  status: string | null;
  note: string | null;
}

const ok = (cls: OpClass): Classified => ({ cls, reason: null });
const out = (reason: string): Classified => ({ cls: "out_of_v1", reason });

export const REASON_ARCHIVED = "Объект в архиве. В первой версии ассистент его не меняет";
export const REASON_OWN = "Это агент, окружение или разговор самого ассистента. Их меняет человек в консоли";
export const REASON_DEPENDENCIES = "Сначала уберите зависимости";
export const WARNING_DEPLOYMENT_ACTIVE = "Следующий запуск возьмёт новую конфигурацию";
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
  return { cls: "update", reason: null, warning: deployment.status === "paused" ? null : WARNING_DEPLOYMENT_ACTIVE };
}

/** Pause, unpause and run (crud.md 3.1). */
export function classifyDeploymentState(deployment: { status?: unknown; archived_at?: unknown }): Classified {
  return deployment.archived_at ? out(REASON_ARCHIVED) : ok("update");
}

const DEPENDENCY_NOUN: Record<string, string> = {
  agent: "агент",
  session: "сессия",
  deployment: "деплоймент",
  environment_work: "задание окружения",
  file: "файл",
  skill_version: "версия навыка",
  memory: "запись памяти",
  credential: "учётные данные",
  model_card: "карточка модели",
};

/** «деплоймент «Утренний отчёт» (depl_1)», or the kind and the id without a name. */
export function dependencyLabel(entry: DependencyEntry): string {
  const noun = DEPENDENCY_NOUN[entry.kind] ?? entry.kind;
  return entry.name ? `${noun} «${entry.name}» (${entry.id})` : `${noun} ${entry.id}`;
}

/** Archive and delete (crud.md 3.1): own objects and blocking dependencies stay with the human. */
export function classifyDanger(input: { ownAssistantTarget: boolean; blocking: readonly DependencyEntry[] }): Classified {
  if (input.ownAssistantTarget) return out(REASON_OWN);
  if (input.blocking.length > 0) return out(`${REASON_DEPENDENCIES}: ${input.blocking.map(dependencyLabel).join(", ")}`);
  return ok("danger");
}

/** Restore from the archive is an edit. */
export function classifyUnarchive(input: { ownAssistantTarget: boolean }): Classified {
  return input.ownAssistantTarget ? out(REASON_OWN) : ok("update");
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
