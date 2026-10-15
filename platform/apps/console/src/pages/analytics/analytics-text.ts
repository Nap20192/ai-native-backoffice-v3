import type { LimitMetric } from "../../lib/analytics-api";
import type { GroupBy, StatusFilter } from "../../components/analytics/analytics-params";

/**
 * Тексты страниц аналитики и словари подписей. Страницы берут строки отсюда,
 * чтобы подпись одного и того же в таблице, фильтре и карточке не расходилась.
 */

/** Подписи harness для таблиц. Незнакомый ключ выводится как есть. */
export const HARNESS_LABELS: Record<string, string> = {
  pi: "Встроенный цикл",
  "claude-acp": "Claude Code в песочнице",
  "ai-sdk": "AI SDK (устарел)",
};

export function harnessLabel(key: string): string {
  return HARNESS_LABELS[key] ?? key;
}

export const SPEED_LABELS = {
  standard: "Обычная",
  fast: "Быстрая",
} as const;

export const TOKEN_TYPE_LABELS = {
  cache_read: "Чтение кэша",
  cache_write: "Запись кэша",
  output: "Выход",
  input: "Вход без кэша",
} as const;

export const NO_CARD_LABEL = "Без карточки";

export const USAGE_GROUP_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: "model", label: "Модель" },
  { value: "token_type", label: "Тип токена" },
  { value: "agent", label: "Агент" },
  { value: "harness", label: "Harness" },
  { value: "card", label: "Карточка" },
  { value: "environment", label: "Окружение" },
  { value: "speed", label: "Скорость" },
];

export const CACHE_GROUP_OPTIONS: Array<{ value: "model" | "agent"; label: string }> = [
  { value: "model", label: "Модель" },
  { value: "agent", label: "Агент" },
];

export const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "", label: "Все" },
  { value: "ok", label: "Успешно" },
  { value: "error", label: "Ошибка" },
];

export const METRIC_LABELS: Record<LimitMetric, string> = {
  itpm: "Токены на входе в минуту (без чтения кэша)",
  otpm: "Токены на выходе в минуту",
  rpm: "Запросы в минуту",
};

export const METRIC_ORDER: LimitMetric[] = ["itpm", "otpm", "rpm"];

export const METRIC_UNIT_LABELS: Record<LimitMetric, string> = {
  itpm: "токенов в минуту",
  otpm: "токенов в минуту",
  rpm: "запросов в минуту",
};

export const TEXT = {
  common: {
    empty: "За период нет вызовов модели. Запустите сессию агента.",
    loadErrorTitle: "Не удалось загрузить данные",
    unsupported: "На этой базе данных аналитика не ведётся.",
    noData: "Нет данных",
    total: "Итого",
  },
  usage: {
    title: "Использование",
    description: "Токены вызовов модели по агентам, моделям и harness. Даты в UTC.",
    chartTitle: "Расход токенов",
    chartDescription: (bucket: "day" | "hour") =>
      `Вход и выход по ${bucket === "day" ? "дням" : "часам"}, сложено по группе`,
    chartLabel: (bucket: "day" | "hour") => `Расход токенов по ${bucket === "day" ? "дням" : "часам"}`,
    tileIn: "Токены на входе",
    tileOut: "Токены на выходе",
    tileRequests: "Запросы к модели",
  },
  cost: {
    title: "Стоимость",
    description: "Расчётная стоимость вызовов модели по ценам карточек и каталога Pi. Даты в UTC.",
    chartTitle: (bucket: "day" | "hour") => `Стоимость по ${bucket === "day" ? "дням" : "часам"}`,
    chartDescription: "Расчётная стоимость вызовов, сложено по группе",
    chartLabel: (bucket: "day" | "hour") => `Стоимость по ${bucket === "day" ? "дням" : "часам"}`,
    tileTotal: "Общая стоимость",
    tileTotalHint: "Сумма по вызовам с известной ценой.",
    tileTokens: "Вход и выход",
    tileCache: "Кэш",
    tileUnpriced: "Запросы без цены",
    tileUnpricedHint: "Задайте цену в карточке модели.",
  },
  caching: {
    title: "Кэширование",
    description: "Как часто вызовы модели берут вход из кэша промпта. Последние 7 дней, даты в UTC.",
  },
  limits: {
    title: "Лимиты",
    description:
      "Лимиты запросов и токенов в минуту из карточек моделей и пиковая загрузка за 24 часа. Платформа не останавливает вызовы при превышении.",
  },
  logs: {
    title: "Журнал запросов",
    description:
      "Отдельные вызовы модели за выбранный период, новые сверху. Строка появляется, когда вызов завершён.",
  },
} as const;
