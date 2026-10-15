import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

/** Спиннер DDC: Loader2 того же размера, что и текст, с `animate-spin`. */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label="Загрузка"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
