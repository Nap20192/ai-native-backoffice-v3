import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Нативный выбор из короткого списка. Нужен там, где важны родная клавиатура и
 * доступность без поповера (панель ассистента, мастер). Нативный `<select>`
 * остаётся внутри components/ui (контракт mature-components). Вид задают
 * классы вызывающего.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 rounded-lg border border-ddc-border-strong bg-ddc-outline-bg px-1.5 text-xs text-ddc-text disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
