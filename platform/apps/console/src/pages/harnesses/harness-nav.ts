import { WorkflowIcon } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Страница «Harness» для подключения в меню и маршруты. `main.tsx` берёт
 * `HARNESS_ROUTE` в защищённые маршруты, `AppSidebar.tsx` ставит
 * `HARNESS_NAV_ITEM` в группу «Конфигурация» сразу после «Карточек моделей».
 */

export const HARNESS_PATH = "/harnesses";
export const HARNESS_LABEL = "Harness";

export interface HarnessNavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export const HARNESS_NAV_ITEM: HarnessNavItem = {
  to: HARNESS_PATH,
  label: HARNESS_LABEL,
  icon: WorkflowIcon,
};

export interface HarnessPageRoute {
  /** Путь без начального слэша, как в `RouteObject`. */
  path: string;
  /** Подпись в хлебных крошках. */
  crumb: string;
  /** Загрузчик для `lazy:` маршрутизатора: страница уходит в свой фрагмент сборки. */
  load: () => Promise<{ Component: ComponentType }>;
}

export const HARNESS_ROUTE: HarnessPageRoute = {
  path: "harnesses",
  crumb: HARNESS_LABEL,
  load: async () => ({
    Component: (await import("./HarnessCardsPage")).HarnessCardsPage,
  }),
};
