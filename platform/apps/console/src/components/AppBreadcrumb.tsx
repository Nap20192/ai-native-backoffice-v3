import { Fragment } from "react";
import { Link, useMatches, type UIMatch } from "react-router";
import { ChevronRightIcon } from "lucide-react";

import {
  Breadcrumb as ShadcnBreadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

import { useCrumbNamesVersion } from "../lib/crumb-names";
import { useI18n } from "../i18n";

/**
 * Контракт `handle.crumb` в main.tsx. Каждый маршрут может задать:
 *
 *   handle: { crumb: "Сессии" }                              // фиксированная подпись
 *   handle: { crumb: (m) => ({ label: m.data.name }) }      // динамическая
 *   handle: { crumb: (m) => crumbName(m.params.id, "Сессия") } // имя записи
 *
 * Страницы деталей используют функцию, чтобы последняя крошка показывала имя
 * записи («Документовед», «Рабочая среда»). Имя страница сообщает через
 * `useCrumbName` (lib/crumb-names.ts), пока его нет, крошка называет тип записи.
 * Сырой id в крошку не попадает, он виден только в «Свойствах». Длинные имена
 * обрезает `truncate` у `<BreadcrumbPage>`, шапка не растёт.
 *
 * Маршруты без `crumb` пропускаются. Сегменты URL подписью не служат: для
 * родителей-пустышек (например, `/integrations`, который только держит
 * вложенные маршруты) они были бы шумом.
 */
type CrumbValue = string | { label: string; to?: string };
type CrumbHandle = { crumb?: CrumbValue | ((m: UIMatch) => CrumbValue) };

/**
 * Хлебные крошки оболочки. Обходят цепочку совпавших маршрутов через
 * `useMatches()` (только data router, main.tsx на `createBrowserRouter`) и
 * выводят `handle.crumb`: последняя крошка текстом, предыдущие ссылками.
 *
 * Без крошек (корневой маршрут или маршруты без `crumb`) компонент ничего не
 * рисует, и верхняя панель остаётся чистой.
 */
export function AppBreadcrumb() {
  const matches = useMatches();
  const { t } = useI18n();
  useCrumbNamesVersion();

  const crumbs = matches
    .map((m) => {
      const handle = (m.handle ?? {}) as CrumbHandle;
      const raw =
        typeof handle.crumb === "function" ? handle.crumb(m) : handle.crumb;
      if (!raw) return null;
      const c = typeof raw === "string" ? { label: raw } : raw;
      return { label: c.label, to: c.to ?? m.pathname };
    })
    .filter((c): c is { label: string; to: string } => c !== null);

  if (crumbs.length === 0) return null;

  return (
    <ShadcnBreadcrumb aria-label={t.shell.breadcrumb} className="console-breadcrumb min-w-0">
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment key={`${c.to}-${i}`}>
              {i > 0 && (
                <BreadcrumbSeparator>
                  <ChevronRightIcon className="size-3.5" />
                </BreadcrumbSeparator>
              )}
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage
                    className="truncate max-w-[200px] sm:max-w-[280px]"
                    title={c.label}
                  >
                    {c.label}
                  </BreadcrumbPage>
                ) : (
                  // asChild + <Link> из React Router даёт переход без
                  // перезагрузки. Иначе BreadcrumbLink рисует голый
                  // <a href>, и клик по крошке перезагружает страницу и
                  // теряет состояние (кэш запросов, окна).
                  <BreadcrumbLink asChild>
                    <Link to={c.to} className="truncate" title={c.label}>
                      {c.label}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </ShadcnBreadcrumb>
  );
}
