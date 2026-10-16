/**
 * Подписи и форматы для выбора модели: усилие, окно контекста, провайдер,
 * источник. Цен и стоимости здесь нет: владелец просил их не учитывать.
 */
import type { EffortLevel, ModelOption } from "../../lib/catalog-api";

/** Уровни усилия от низкого к максимальному, как их показывает селект. */
export const EFFORT_ORDER: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Низкое",
  medium: "Среднее",
  high: "Высокое",
  xhigh: "Очень высокое",
  max: "Максимальное",
};

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_ORDER as readonly string[]).includes(value);
}

/** Подпись уровня. `lower` нужен в середине фразы: «Усилие: высокое». */
export function effortLabel(level: EffortLevel, opts: { lower?: boolean } = {}): string {
  const label = EFFORT_LABELS[level];
  return opts.lower ? label.toLocaleLowerCase("ru") : label;
}

/** Усилие из поля `model` агента. API принимает и возвращает его строкой или
 *  объектом `{type}`. Неизвестное значение даёт пустую строку. */
export function effortOf(model: unknown): EffortLevel | "" {
  if (!model || typeof model !== "object") return "";
  const effort = (model as { effort?: unknown }).effort;
  if (isEffortLevel(effort)) return effort;
  if (effort && typeof effort === "object") {
    const type = (effort as { type?: unknown }).type;
    if (isEffortLevel(type)) return type;
  }
  return "";
}

function decimal(value: number): string {
  return String(Math.round(value * 10) / 10).replace(".", ",");
}

/** Окно контекста: «200 тыс. токенов», «1,5 млн токенов». Без значения `null`. */
export function contextLabel(tokens: number | null | undefined): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${decimal(tokens / 1_000_000)} млн токенов`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)} тыс. токенов`;
  return `${tokens} токенов`;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  google: "Google",
  minimax: "MiniMax",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export function sourceLabel(source: ModelOption["source"]): string {
  return source === "card" ? "Карточка" : "Ключ сервера";
}

/** Серая строка под моделью: «Карточка · Anthropic · 200 тыс. токенов». */
export function modelMetaLine(option: ModelOption): string {
  return [sourceLabel(option.source), providerLabel(option.provider), contextLabel(option.context_window)]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}
