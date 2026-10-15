import * as React from "react"

import { cn } from "@/lib/utils"

/** Многострочное поле DDC: тот же класс, что у поля ввода, высота не зафиксирована. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-xl border border-input bg-ddc-surface px-3.5 py-[9px] text-sm leading-5 transition-colors placeholder:text-ddc-placeholder focus-visible:border-ddc-ring focus-visible:ring-2 focus-visible:ring-ddc-ring/30 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:border-input/40 disabled:bg-ddc-surface-muted disabled:text-ddc-label aria-invalid:border-rose-400 aria-invalid:focus-visible:border-rose-500 aria-invalid:focus-visible:ring-rose-500/30",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
