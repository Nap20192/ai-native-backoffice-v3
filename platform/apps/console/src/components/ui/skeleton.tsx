import { cn } from "@/lib/utils"

/**
 * Скелетон DDC: подложка ink-100 (в тёмной теме ink-800) с бликом
 * `animate-shimmer`, который ползёт слева направо. Скелетон повторяет
 * разметку: строка `h-4` под text-sm, `h-3` под text-xs, аватар
 * `rounded-full`, бейдж `h-5 rounded-md`.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative overflow-hidden rounded-lg bg-ddc-surface-sunken before:absolute before:inset-0 before:animate-shimmer before:bg-linear-to-r before:from-transparent before:via-white/60 before:to-transparent before:bg-[length:200%_100%] dark:before:via-white/5",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
