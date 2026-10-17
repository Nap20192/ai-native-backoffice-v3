import type { BetaManagedAgentsDeployment } from "@anthropic-ai/sdk/resources/beta/deployments";

export type Deployment = BetaManagedAgentsDeployment;

export type DeploymentState = "active" | "paused" | "archived";

export function deploymentState(deployment: Pick<Deployment, "archived_at" | "status">): DeploymentState {
  if (deployment.archived_at) return "archived";
  return deployment.status === "paused" ? "paused" : "active";
}

export const STATE_LABELS: Record<DeploymentState, string> = {
  active: "Активен",
  paused: "На паузе",
  archived: "В архиве",
};

const PAUSE_ERRORS: Record<string, string> = {
  agent_archived_error: "агент в архиве",
  environment_archived_error: "окружение в архиве",
  environment_not_found_error: "окружение не найдено",
  vault_not_found_error: "хранилище секретов не найдено",
  vault_archived_error: "хранилище секретов в архиве",
  file_not_found_error: "файл не найден",
  session_resource_not_found_error: "ресурс сессии не найден",
  workspace_archived_error: "рабочее пространство в архиве",
  organization_disabled_error: "организация отключена",
  memory_store_archived_error: "хранилище памяти в архиве",
  skill_not_found_error: "навык не найден",
  unknown_error: "неизвестная ошибка",
  self_hosted_resources_unsupported_error: "ресурсы не поддерживаются в своём окружении",
  mcp_egress_blocked_error: "исходящий доступ MCP закрыт",
};

/** Почему деплоймент на паузе, или `null`, если он не на паузе. */
export function pausedReasonText(deployment: Pick<Deployment, "paused_reason">): string | null {
  const reason = deployment.paused_reason;
  if (!reason) return null;
  if (reason.type === "manual") return "Поставлен на паузу вручную";
  const detail = PAUSE_ERRORS[reason.error.type] ?? reason.error.type;
  return `Остановлен из-за ошибки: ${detail}`;
}

/** Триггер деплоймента: запуск вручную или по расписанию. */
export function triggerText(deployment: Pick<Deployment, "schedule">): string {
  const schedule = deployment.schedule;
  if (!schedule) return "Вручную";
  return `По расписанию, ${schedule.expression} (${schedule.timezone})`;
}

/** Первое текстовое сообщение из начальных событий, для формы правки. */
export function initialMessageText(deployment: Pick<Deployment, "initial_events">): string {
  for (const event of deployment.initial_events) {
    if (event.type !== "user.message") continue;
    const parts = event.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}
