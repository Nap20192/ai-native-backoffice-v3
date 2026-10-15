import {
  ChartColumnIcon,
  CircleDollarSignIcon,
  DatabaseZapIcon,
  ScrollTextIcon,
  TimerIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import type { Locale } from "../../i18n/types";

export interface AnalyticsNavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export interface AnalyticsNavGroup {
  label: string;
  items: AnalyticsNavItem[];
}

type NavKey = "usage" | "caching" | "limits" | "cost" | "logs";

/** Маршруты и значки пяти страниц. Подписи ниже, по языку интерфейса. */
const ROUTES: Array<{ key: NavKey; to: string; icon: AnalyticsNavItem["icon"] }> = [
  { key: "usage", to: "/analytics/usage", icon: ChartColumnIcon },
  { key: "caching", to: "/analytics/caching", icon: DatabaseZapIcon },
  { key: "limits", to: "/analytics/limits", icon: TimerIcon },
  { key: "cost", to: "/analytics/cost", icon: CircleDollarSignIcon },
  { key: "logs", to: "/analytics/logs", icon: ScrollTextIcon },
];

const LABELS: Record<Locale, { group: string } & Record<NavKey, string>> = {
  ru: {
    group: "Аналитика",
    usage: "Использование",
    caching: "Кэширование",
    limits: "Лимиты",
    cost: "Стоимость",
    logs: "Журнал запросов",
  },
  en: {
    group: "Analytics",
    usage: "Usage",
    caching: "Caching",
    limits: "Rate limits",
    cost: "Cost",
    logs: "Logs",
  },
  "zh-CN": {
    group: "分析",
    usage: "用量",
    caching: "缓存",
    limits: "速率限制",
    cost: "成本",
    logs: "日志",
  },
};

/** Группа меню «Аналитика» на языке интерфейса. */
export function analyticsNav(locale: Locale): AnalyticsNavGroup {
  const labels = LABELS[locale] ?? LABELS.ru;
  return {
    label: labels.group,
    items: ROUTES.map(({ key, to, icon }) => ({ to, label: labels[key], icon })),
  };
}

/** Подписи страниц для хлебных крошек маршрутов (русский, как у остальных). */
export const ANALYTICS_CRUMBS = {
  root: LABELS.ru.group,
  usage: LABELS.ru.usage,
  caching: LABELS.ru.caching,
  limits: LABELS.ru.limits,
  cost: LABELS.ru.cost,
  logs: LABELS.ru.logs,
} as const;

export interface AnalyticsPageRoute {
  path: NavKey;
  crumb: string;
  /** Загрузчик страницы для `lazy:` маршрутизатора. Страница уходит в свой фрагмент сборки. */
  load: () => Promise<{ Component: ComponentType }>;
}

/**
 * Маршруты страниц под `/analytics/*` в порядке меню. `main.tsx` собирает из
 * них дочерние маршруты, а тест сверяет их с пунктами меню.
 */
export const ANALYTICS_PAGES: AnalyticsPageRoute[] = [
  {
    path: "usage",
    crumb: ANALYTICS_CRUMBS.usage,
    load: async () => ({ Component: (await import("../../pages/analytics/UsagePage")).UsagePage }),
  },
  {
    path: "caching",
    crumb: ANALYTICS_CRUMBS.caching,
    load: async () => ({ Component: (await import("../../pages/analytics/CachingPage")).CachingPage }),
  },
  {
    path: "limits",
    crumb: ANALYTICS_CRUMBS.limits,
    load: async () => ({ Component: (await import("../../pages/analytics/LimitsPage")).LimitsPage }),
  },
  {
    path: "cost",
    crumb: ANALYTICS_CRUMBS.cost,
    load: async () => ({ Component: (await import("../../pages/analytics/CostPage")).CostPage }),
  },
  {
    path: "logs",
    crumb: ANALYTICS_CRUMBS.logs,
    load: async () => ({ Component: (await import("../../pages/analytics/LogsPage")).LogsPage }),
  },
];
