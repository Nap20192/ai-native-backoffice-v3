import type { ReactNode } from "react";
import { CheckCircle2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import { useBranding } from "@/lib/branding";

interface ModernLoginShellProps {
  children: ReactNode;
  className?: string;
}

/** Что умеет консоль: коротко, по разделам меню. */
const HIGHLIGHTS = [
  {
    title: "Агенты и сессии",
    description: "Создание агентов, запуск и разбор сессий.",
  },
  {
    title: "Окружения и секреты",
    description: "Изолированные среды и хранилища учётных данных.",
  },
  {
    title: "Навыки и память",
    description: "Повторяемые навыки и общая память агентов.",
  },
  {
    title: "Оценка качества",
    description: "Запуски оценки на наборах задач.",
  },
];

/**
 * Оболочка входа в стиле портала DDC (раздел 4: `min-h-screen grid
 * lg:grid-cols-2`). Слева от lg панель бренда на `brand-700`, справа колонка
 * формы с отступами `p-6 md:p-12` и шириной `max-w-sm`. На телефоне панели
 * нет, знак стоит над заголовком формы.
 *
 * Только оформление: состояние и вызовы провайдеров остаются на странице.
 * Панель сама по себе ничего не объявляет читалке, поэтому знак в ней скрыт
 * от дикторов (`aria-hidden`), а знак колонки формы остаётся единственным.
 */
export function ModernLoginShell({ children, className }: ModernLoginShellProps) {
  const branding = useBranding();

  return (
    <div
      data-login-layout="split"
      className="grid h-full min-h-dvh w-full overflow-y-auto bg-ddc-surface lg:grid-cols-2"
    >
      <section
        aria-label="О платформе"
        className="relative hidden flex-col justify-center overflow-hidden bg-brand-700 px-12 py-32 text-ddc-on-primary lg:flex"
      >
        <div className="absolute inset-x-12 top-12 mx-auto flex max-w-xl items-center gap-3">
          <div aria-hidden="true" className="flex-none">
            <Logo size="lg" tone="current" className="text-ddc-on-primary brightness-0 invert" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold tracking-tight">{branding.productName}</p>
            <p className="text-xs font-semibold tracking-wider text-brand-200 uppercase">
              Конструктор агентов
            </p>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-xl">
          <p className="text-4xl leading-tight font-bold tracking-tight">
            Создавайте и запускайте ИИ-агентов для бэк-офиса
          </p>
          <p className="mt-4 text-base text-brand-100/90">
            Настраивайте агентов, окружения и навыки, запускайте сессии и проверяйте
            качество на тестовых задачах.
          </p>
          <ul className="mt-8 space-y-4">
            {HIGHLIGHTS.map((item) => (
              <li key={item.title} className="flex items-start gap-3">
                <CheckCircle2Icon className="mt-1 size-4 flex-none text-brand-200" aria-hidden="true" />
                <div>
                  <div className="font-semibold">{item.title}</div>
                  <div className="text-sm text-brand-100/90">{item.description}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <main
        aria-label="Вход в аккаунт"
        className={cn("flex items-center justify-center p-6 md:p-12", className)}
      >
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
