import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Поле ввода DDC (`.input` портала): высота 40px, rounded-xl, рамка ink-200,
 * при фокусе рамка и кольцо ring-2 цвета бренда, ошибка через aria-invalid.
 * Отключённое поле остаётся читаемым: это режим просмотра, а не подсказка.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-xl border border-input bg-ddc-surface px-3.5 py-[9px] text-sm leading-5 transition-colors file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ddc-placeholder focus-visible:border-ddc-ring focus-visible:ring-2 focus-visible:ring-ddc-ring/30 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:border-input/40 disabled:bg-ddc-surface-muted disabled:text-ddc-label aria-invalid:border-rose-400 aria-invalid:focus-visible:border-rose-500 aria-invalid:focus-visible:ring-rose-500/30",
        className
      )}
      {...props}
    />
  )
}

export { Input }
