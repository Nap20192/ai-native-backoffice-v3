import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"

/**
 * Кнопка DDC (раздел 3 docs/ddc-design-system.md, классы `.btn*` портала).
 *
 * Высоту даёт размер, а не `h-*` на месте вызова: lg 44, по умолчанию 40,
 * sm 36, xs 32 (правило 1). Кнопка-иконка квадратная тех же размеров.
 * Фокус рисует глобальное кольцо `:focus-visible`, поэтому `outline-none`
 * здесь нет. Отключённая кнопка получает opacity-50 и cursor-not-allowed.
 * Цвета берутся из смысловых токенов `ddc-*`, которые сами меняются между
 * светлой и тёмной темой.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-transparent text-sm leading-5 font-medium whitespace-nowrap transition select-none active:not-aria-[haspopup]:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-ddc-primary text-ddc-on-primary shadow-card dark:shadow-none hover:bg-ddc-primary-hover",
        outline:
          "border-ddc-border-strong bg-ddc-outline-bg text-foreground hover:bg-ddc-outline-hover aria-expanded:bg-ddc-outline-hover",
        secondary:
          "bg-ddc-surface-sunken text-ddc-text hover:bg-ddc-border-strong/60 aria-expanded:bg-ddc-border-strong/60",
        ghost:
          "text-ddc-ghost-text hover:bg-ddc-ghost-hover aria-expanded:bg-ddc-ghost-hover",
        destructive:
          "bg-ddc-danger text-white shadow-card dark:shadow-none hover:bg-ddc-danger-hover active:bg-rose-800",
        "danger-ghost":
          "text-ddc-danger-text hover:bg-ddc-tone-danger-bg hover:text-ddc-tone-danger-fg aria-expanded:bg-ddc-tone-danger-bg",
        link:
          "text-ddc-link underline-offset-2 hover:text-ddc-link-hover hover:underline focus-visible:underline focus-visible:decoration-2",
      },
      size: {
        default:
          "h-10 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        xs: "h-8 gap-1.5 rounded-lg px-2.5 text-xs leading-4 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-9 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        lg: "h-11 px-5 font-semibold has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        icon: "size-10 p-0",
        "icon-xs": "size-8 rounded-lg p-0",
        "icon-sm": "size-9 p-0",
        "icon-lg": "size-11 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonOwnProps = {
  asChild?: boolean
  /** Занятая кнопка (правило 11): подпись остаётся, иконку заменяет
   *  спиннер, кнопка отключена и получает `aria-busy`. Работает вместе с
   *  useAsyncAction, чтобы быстрый двойной клик не вызвал обработчик дважды.
   *  Игнорируется вместе с `asChild`. */
  loading?: boolean
  /** Заменяет содержимое на время загрузки. По умолчанию подпись та же. */
  loadingLabel?: React.ReactNode
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  loadingLabel,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> &
  ButtonOwnProps) {
  const Comp = asChild ? Slot.Root : "button"

  // asChild пробрасывает свойства единственному потомку, а он не обязан быть
  // <button>. disabled / aria-busy / спиннер осмысленны только у настоящей
  // кнопки, поэтому loading при asChild ничего не делает.
  const showLoader = loading && !asChild

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      disabled={asChild ? undefined : disabled || showLoader}
      aria-busy={showLoader || undefined}
      className={cn(
        buttonVariants({ variant, size }),
        // Спиннер встаёт на место иконки: собственные иконки кнопки на время
        // загрузки скрыты.
        showLoader && "[&>svg:not([data-slot=spinner])]:hidden",
        className
      )}
      {...props}
    >
      {showLoader ? (
        <>
          <Spinner aria-label="Загрузка" />
          {loadingLabel ?? children}
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
