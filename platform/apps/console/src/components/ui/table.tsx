"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({
  className,
  container = true,
  ...props
}: React.ComponentProps<"table"> & { container?: boolean }) {
  const table = (
    <table
      data-slot="table"
      className={cn("w-full caption-bottom text-sm", className)}
      {...props}
    />
  )

  if (!container) return table

  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      {table}
    </div>
  )
}

function TableHeader({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"thead"> & { variant?: "default" | "wireless" }) {
  return (
    <thead
      data-slot="table-header"
      className={cn(variant === "default" && "[&_tr]:border-b [&_tr]:border-ddc-divider", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-ddc-divider bg-muted font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"tr"> & { variant?: "default" | "wireless" }) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        variant === "default"
          ? "border-b border-ddc-divider transition-colors hover:bg-muted has-aria-expanded:bg-muted data-[state=selected]:bg-ddc-selected-bg"
          : "transition-colors",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-[var(--table-head-h)] px-3 text-left align-middle text-xs font-semibold tracking-wider whitespace-nowrap text-ddc-text-muted uppercase [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-2.5 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-ddc-text-muted", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
