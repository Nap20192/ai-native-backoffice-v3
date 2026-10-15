import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Бейдж DDC (`.chip` + тона из lib/tone.ts портала): высота 20px,
 * `rounded-md`, текст 12px medium, иконка 14px. Цвет задаёт один из пяти
 * статусных тонов (neutral, info, warning, success, danger) или brand
 * («выбор, своё, текущее», это не статус). Контур рисует внутреннее кольцо
 * `ring-1 ring-inset`, а не рамка, поэтому размер не зависит от тона.
 *
 * Старые имена вариантов сохранены: default это тон brand, secondary тон
 * neutral, destructive тон danger, outline и ghost тон ghost.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap transition-colors has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-rose-400 [&>svg]:pointer-events-none [&>svg]:size-3.5!",
  {
    variants: {
      variant: {
        default:
          "bg-ddc-tone-brand-bg text-ddc-tone-brand-fg ring-1 ring-ddc-tone-brand-ring ring-inset [a]:hover:bg-ddc-selected-bg",
        brand:
          "bg-ddc-tone-brand-bg text-ddc-tone-brand-fg ring-1 ring-ddc-tone-brand-ring ring-inset",
        secondary:
          "bg-ddc-tone-neutral-bg text-ddc-tone-neutral-fg [a]:hover:bg-ddc-surface-sunken",
        neutral: "bg-ddc-tone-neutral-bg text-ddc-tone-neutral-fg",
        info: "bg-ddc-tone-info-bg text-ddc-tone-info-fg ring-1 ring-ddc-tone-info-ring ring-inset",
        success:
          "bg-ddc-tone-success-bg text-ddc-tone-success-fg ring-1 ring-ddc-tone-success-ring ring-inset",
        warning:
          "bg-ddc-tone-warning-bg text-ddc-tone-warning-fg ring-1 ring-ddc-tone-warning-ring ring-inset",
        destructive:
          "bg-ddc-tone-danger-bg text-ddc-tone-danger-fg ring-1 ring-ddc-tone-danger-ring ring-inset",
        outline:
          "text-ddc-tone-ghost-fg ring-1 ring-ddc-tone-ghost-ring ring-inset [a]:hover:bg-muted [a]:hover:text-foreground",
        ghost:
          "text-ddc-tone-ghost-fg hover:bg-muted hover:text-foreground",
        link:
          "text-ddc-link underline-offset-2 hover:underline focus-visible:underline focus-visible:decoration-2",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
