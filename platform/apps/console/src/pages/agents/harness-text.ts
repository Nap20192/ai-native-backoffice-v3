/**
 * Тексты про harness: подписи, описания под полем, подписи протоколов и
 * статусов, пояснения вкладок ACP. Каталог сервера отдаёт английские подписи
 * встроенных записей, русские берутся отсюда (раздел 6.8 контракта
 * docs/plans/models-harness.md).
 */
import type { HarnessEntry, HarnessStatus } from "../../lib/catalog-api";

type EntryNames = Pick<HarnessEntry, "id" | "label" | "source">;

export const HARNESS_LABELS: Record<string, string> = {
  pi: "Встроенный цикл",
  "claude-acp": "Claude Code в песочнице",
  "codex-acp": "Codex в песочнице",
  gemini: "Gemini CLI в песочнице",
  opencode: "OpenCode в песочнице",
  "kimi-code": "Kimi Code в песочнице",
  "pi-acp": "Pi через ACP в песочнице",
  "ai-sdk": "AI SDK (устарел)",
};

/** Подпись записи: у встроенных русская, у карточки её название. */
export function harnessLabel(entry: EntryNames): string {
  if (entry.source === "card") return entry.label;
  return HARNESS_LABELS[entry.id] ?? entry.label;
}

const PI_DESCRIPTION =
  "Платформа сама ведёт ход: вызывает модель, инструменты, навыки и MCP-серверы. Подходит любая модель из списка.";
const CLAUDE_DESCRIPTION =
  "Ход выполняет Claude Code внутри VM окружения. Модель подключается через прокси сервера, ключа в VM нет. Инструменты, навыки и MCP-серверы платформы не используются.";
const UNVERIFIED_DESCRIPTION =
  "Агент запускается так же, как Claude Code, но на нашем сервере этот путь не проверялся.";

/** Описание выбранного варианта под полем Harness. */
export function harnessDescription(entry: Pick<HarnessEntry, "id" | "source" | "acp">): string {
  if (entry.source === "card") {
    const command = entry.acp?.agent.command ?? "";
    return `Свой ACP-агент из карточки. Запускается в VM окружения командой ${command}. Не проверено.`;
  }
  if (entry.id === "pi") return PI_DESCRIPTION;
  if (entry.id === "claude-acp") return CLAUDE_DESCRIPTION;
  return UNVERIFIED_DESCRIPTION;
}

/** Описание harness, которого нет в каталоге: устаревший, закрытый или неизвестный. */
export function legacyHarnessDescription(id: string): string {
  if (id === "ai-sdk") return "Старый harness. Выберите встроенный цикл.";
  if (id === "acp-proxy") {
    return "Этот harness на сервере не работает. Выберите встроенный цикл или ACP-агента из каталога.";
  }
  return `Harness «${id}» не найден в каталоге сервера.`;
}

const PROTOCOL_LABELS: Record<string, string> = {
  "anthropic-messages": "Anthropic Messages",
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  gemini: "Gemini API",
  "*": "Любой",
};

export function protocolLabel(protocol: string): string {
  return PROTOCOL_LABELS[protocol] ?? protocol;
}

const STATUS_LABELS: Record<HarnessStatus, string> = {
  ready: "Готово",
  unverified: "Не проверено",
  unavailable: "Недоступно",
};

export function statusLabel(status: HarnessStatus): string {
  return STATUS_LABELS[status];
}

/** Группы выбора harness. «Свои» это карточки рабочего пространства. */
export const HARNESS_GROUP_LABELS = {
  ready: "Готово",
  unverified: "Не проверено",
  unavailable: "Недоступно",
  own: "Свои",
} as const;

export type HarnessGroupKey = keyof typeof HARNESS_GROUP_LABELS;

export const ACP_EFFORT_NOTE = "Усилие и скорость ACP-агенту не передаются";
export const ACP_SYSTEM_NOTE = "ACP-агент пока не получает системный промпт";

/** Пояснение вместо полей вкладки «Инструменты» при ACP. */
export function acpToolsNote(entry: EntryNames): string {
  if (entry.id === "claude-acp") {
    return "Claude Code работает своими инструментами: Read, Write, Edit, Bash и другими. Разрешения задаёт список permissions.allow в переменной OMA_CLAUDE_SETTINGS, править её можно в режиме YAML. Настройки этой вкладки сохраняются, но в ходе не применяются.";
  }
  return `${harnessLabel(entry)} работает своими инструментами. Настройки этой вкладки сохраняются, но в ходе не применяются.`;
}

/** Пояснение вместо полей вкладки «MCP-серверы» при ACP. */
export function acpMcpNote(entry: EntryNames): string {
  return `MCP-серверы агента до ${harnessLabel(entry)} не доходят: на этом сервере у ACP-агентов нет шлюза MCP. Настройки сохраняются, но в ходе не применяются.`;
}

/** Пакеты, которые должны стоять в окружении сессии. Пустая строка, если их нет. */
export function installRequirement(install: HarnessEntry["install"]): string {
  const parts: string[] = [];
  if (install.npm.length > 0) parts.push(`npm ${install.npm.join(", ")}`);
  if (install.pip.length > 0) parts.push(`pip ${install.pip.join(", ")}`);
  return parts.length > 0
    ? `В окружении сессии должны стоять пакеты: ${parts.join("; ")}`
    : "";
}

/** Сообщение под полем модели, когда смена harness заменила модель. */
export function modelReplacedNote(handle: string, label: string): string {
  return `Модель заменена: ${handle} не работает с ${label}`;
}

export const EFFORT_RESET_NOTE = "Усилие сброшено: модель его не поддерживает";
export const SPEED_RESET_NOTE = "Скорость сброшена: модель не поддерживает быструю скорость";
