import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"

import { useTheme } from "@/lib/theme"

/**
 * Sonner Toaster wired into the console's own `useTheme` (lib/theme.ts)
 * — the shadcn template ships with `next-themes`, but the console already
 * has its own light/dark/system manager that owns the `.dark` class on
 * `<html>`. Reading from it keeps the toast colour mode in lock-step
 * with the rest of the app on manual toggles (next-themes would only
 * see the system preference, not in-app overrides).
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { effective } = useTheme()

  return (
    <Sonner
      theme={effective}
      className="toaster group"
      // Тост DDC: белая карточка (поверхность, рамка, тень card) с цветной
      // иконкой по статусу, а не залитая цветом плашка. Справа сверху, ниже
      // ряда действий шапки страницы: шапка приложения 4rem, поле страницы
      // 2rem, кнопка 2.5rem и зазор 0.5rem, то есть 9rem. Выше тост закрыл бы
      // заголовок и главную кнопку страницы. Показ 3500ms.
      position="top-right"
      duration={3500}
      expand
      gap={8}
      visibleToasts={3}
      offset={{ top: "9rem", right: 16 }}
      mobileOffset={{ top: "9rem", right: 16, left: 16 }}
      containerAriaLabel="Уведомления"
      icons={{
        success: <CircleCheckIcon className="size-4 text-ddc-success-text" />,
        info: <InfoIcon className="size-4 text-ddc-tone-info-fg" />,
        warning: <TriangleAlertIcon className="size-4 text-ddc-warning-text" />,
        error: <OctagonXIcon className="size-4 text-ddc-danger-text" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--bg)",
          "--normal-text": "var(--fg)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--console-radius-popover)",
          "--width": "min(22rem, calc(100vw - 2rem))",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast !gap-2 !p-3 !font-sans !text-sm !shadow-card",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
