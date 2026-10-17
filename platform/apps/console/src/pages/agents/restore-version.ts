import type { AgentUpdateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";

/** Поля агента, которые версия хранит и правка принимает обратно. */
const RESTORABLE_FIELDS = [
  "name",
  "description",
  "model",
  "system",
  "tools",
  "mcp_servers",
  "skills",
  "multiagent",
  "_oma",
] as const;

/**
 * Тело `POST /v1/agents/:id` для восстановления старой версии
 * (docs/plans/crud.md, 2.1): поля старой версии и текущая `version`. Сервер
 * создаёт новую версию с этим содержимым, старые версии остаются.
 */
export function restoreVersionBody(
  old: Record<string, unknown>,
  currentVersion: number,
): AgentUpdateParams {
  const body: Record<string, unknown> = { version: currentVersion };
  for (const field of RESTORABLE_FIELDS) {
    if (old[field] !== undefined) body[field] = old[field];
  }
  return body as AgentUpdateParams;
}
