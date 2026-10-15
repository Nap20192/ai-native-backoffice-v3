import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Шапка страницы DDC (правило 7): заголовок, описание и действия на фоне
 * страницы, без собственной подложки. Одна на все страницы консоли: списки,
 * карточки записей, участники, сводка.
 *
 * Действия стоят справа, пока колонке текста рядом с ними остаётся не меньше
 * 20rem, иначе уходят под описание целиком. Раскладку решает место, а не
 * ширина окна. Заголовок переносится по словам и длинным названиям (prose-wrap),
 * а не обрезается: у обрезанного заголовка нет `title`, а читать его нужно
 * целиком. Полоса действий поднята на 4px, чтобы её середина совпала с
 * серединой строки заголовка (32px).
 */
interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("mb-6 flex flex-wrap items-start gap-x-6 gap-y-4", className)}>
      <div className="min-w-0 grow basis-80">
        <h1 className="prose-wrap flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl leading-8 font-bold tracking-tight text-ddc-heading">
          {title}
        </h1>
        {description && (
          <p className="prose-wrap mt-1 max-w-3xl text-sm text-ddc-text-muted [text-wrap:balance]">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="-mt-1 flex min-h-10 max-w-full flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
