import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        // Prefer an explicit flex direction over `data-[orientation=…]:flex-col`.
        // Radix sets `data-orientation="horizontal"`, but older Tailwind
        // `data-horizontal:` shorthands compile to `[data-horizontal]` and never
        // match — which left tab lists beside content instead of above it.
        "group/tabs flex gap-4",
        orientation === "horizontal" ? "flex-col" : "flex-row",
        className
      )}
      {...props}
    />
  )
}

/**
 * Вкладки DDC (`.tabs` + `.tab`): панель rounded-2xl с рамкой и shadow-card,
 * внутри вкладки rounded-xl 36px. Выбранная вкладка заливается bg-brand-50
 * (в тёмной теме brand-500/15) с текстом brand-700 / brand-300, подчёркивания
 * и сплошной заливки нет. Ряд прокручивается, а не переносится. Выбор читается
 * из `data-state=active`, который ставит Radix (`data-active` у Radix нет).
 */
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit max-w-full items-center justify-start gap-1 overflow-x-auto p-1 text-ddc-label group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:items-stretch",
  {
    variants: {
      variant: {
        default: "rounded-2xl border border-ddc-border bg-ddc-surface shadow-card",
        line: "bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex flex-none items-center justify-center gap-2 rounded-xl border border-transparent px-3 py-2 text-sm leading-5 font-medium whitespace-nowrap text-ddc-label transition-colors group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start hover:bg-ddc-surface-muted hover:text-ddc-text focus-visible:-outline-offset-2 disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-[state=active]:bg-ddc-selected-bg data-[state=active]:text-ddc-selected-text data-[state=active]:hover:bg-ddc-selected-bg data-[state=active]:hover:text-ddc-selected-text",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
