/**
 * Формат дат DDC (правило 14): дата `dd.MM.yyyy`, время `HH:mm`, по
 * местному часовому поясу. Пустое или неразборчивое значение даёт прочерк
 * из дефиса, а не длинное тире. Сама логика лежит в lib/date-format.ts.
 */
import { formatDate as baseFormatDate, formatDateTime as baseFormatDateTime } from "../../lib/date-format";

const EMPTY = "-";

export function formatDate(value: string | number | Date | null | undefined): string {
  return baseFormatDate(value, EMPTY);
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  return baseFormatDateTime(value, EMPTY);
}

/** Скорость модели из API (`standard`, `fast`) по-русски. Неизвестное значение остаётся как есть. */
export function speedLabel(speed: string | undefined | null): string {
  if (!speed || speed === "standard") return "стандартная";
  if (speed === "fast") return "быстрая";
  return speed;
}

const TOOLSET_LABELS: Record<string, string> = {
  agent_toolset_20260401: "Базовый набор инструментов",
  mcp_toolset: "MCP-сервер",
};

/** Подпись инструмента агента по-русски. Сырой тип из API (`agent_toolset_20260401`)
 *  в интерфейс не выводится (раздел 5 DDC); неизвестный тип остаётся как есть.
 *  Сервер MCP на «Всегда разрешать» получает пометку «без подтверждения»: сохранённые
 *  агенты молча не меняются, а человек видит, кто ходит во внешнюю систему сам. */
export function toolLabel(tool: {
  type?: string;
  name?: string;
  mcp_server_name?: string;
  default_config?: { permission_policy?: { type?: string } };
}): string {
  if (tool.type === "custom") return tool.name ? `Свой: ${tool.name}` : "Свой инструмент";
  if (tool.type === "mcp_toolset") {
    const label = tool.mcp_server_name ? `MCP: ${tool.mcp_server_name}` : TOOLSET_LABELS.mcp_toolset;
    return tool.default_config?.permission_policy?.type === "always_allow"
      ? `${label}, без подтверждения`
      : label;
  }
  return (tool.type && TOOLSET_LABELS[tool.type]) || tool.type || "";
}
