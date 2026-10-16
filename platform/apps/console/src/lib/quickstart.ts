import type { AppliedInfo, ThreadItem } from "./assistant/events";

/**
 * Состояние мастера `/quickstart/new` (раздел 1.3 плана builder-agent). Ход
 * считается по тому, что ассистент уже создал после подтверждения человека:
 * агент приходит со страницы «Описать агента», окружение и сессию консоль берёт
 * из применённых карточек ленты.
 */

export interface ResourceRef {
  id: string;
  name: string;
}

export interface WizardAgent extends ResourceRef {
  version: number;
}

export interface WizardResources {
  environment: ResourceRef | null;
  session: ResourceRef | null;
  messageSent: boolean;
}

function appliedOf(item: ThreadItem): AppliedInfo[] {
  return item.kind === "proposal" && item.phase === "applied" ? (item.applied ?? []) : [];
}

export function collectResources(thread: readonly ThreadItem[]): WizardResources {
  let environment: ResourceRef | null = null;
  let session: ResourceRef | null = null;
  let messageSent = false;
  for (const item of thread) {
    for (const info of appliedOf(item)) {
      if (info.action !== "create") continue;
      if (info.kind === "environment" && info.id) {
        environment = { id: info.id, name: info.name ?? "Окружение" };
      } else if (info.kind === "session" && info.id) {
        session = { id: info.id, name: info.name ?? "Сессия" };
      } else if (info.kind === "message") {
        messageSent = true;
      }
    }
  }
  return { environment, session, messageSent };
}

export type StepId = "agent" | "environment" | "session" | "connect";
export type StepStatus = "done" | "current" | "todo";

export interface WizardStep {
  id: StepId;
  title: string;
  status: StepStatus;
}

export function wizardSteps(state: WizardResources & { agent: WizardAgent | null }): WizardStep[] {
  const done: Record<StepId, boolean> = {
    agent: state.agent !== null,
    environment: state.environment !== null,
    session: state.session !== null && state.messageSent,
    connect: false,
  };
  const titles: Record<StepId, string> = {
    agent: "Создать агента",
    environment: "Настроить окружение",
    session: "Начать сессию",
    connect: "Подключить",
  };
  const order: StepId[] = ["agent", "environment", "session", "connect"];
  let currentSet = false;
  return order.map((id) => {
    if (done[id]) return { id, title: titles[id], status: "done" as const };
    if (!currentSet) {
      currentSet = true;
      return { id, title: titles[id], status: "current" as const };
    }
    return { id, title: titles[id], status: "todo" as const };
  });
}

/** Команды curl для «Экспорта кодом». Ключ берётся из переменной окружения. */
export function exportSnippet(input: {
  agentId: string;
  agentVersion: number;
  environmentId: string | null;
}): string {
  const environment = input.environmentId ?? "<id окружения>";
  return [
    "# Создать сессию с этим агентом и окружением",
    'curl -X POST "$OMA_URL/v1/sessions" \\',
    '  -H "x-api-key: $OMA_API_KEY" \\',
    '  -H "content-type: application/json" \\',
    "  -d '{",
    `    "agent": { "type": "agent", "id": "${input.agentId}", "version": ${input.agentVersion} },`,
    `    "environment_id": "${environment}"`,
    "  }'",
  ].join("\n");
}

/** Первое сообщение ассистенту после создания агента: перейти к окружению. */
export function agentHandoffPrompt(agent: WizardAgent): string {
  return [
    `Я создал агента «${agent.name}» (agent_id ${agent.id}, версия ${agent.version}).`,
    "Дальше предложи окружение для него карточкой.",
    "Потом, когда окружение будет создано, предложи сессию с этим агентом и первое сообщение отдельными карточками.",
  ].join(" ");
}
