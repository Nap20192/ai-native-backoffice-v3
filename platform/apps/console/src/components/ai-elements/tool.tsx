"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

/** Вызов инструмента: вложенная панель DDC `rounded-xl bg-ink-50`. */
export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-3 w-full max-w-2xl rounded-xl bg-ddc-surface-muted", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Ждёт подтверждения",
  "approval-responded": "Ответ получен",
  "input-available": "Выполняется",
  "input-streaming": "Ожидает",
  "output-available": "Готово",
  "output-denied": "Отклонено",
  "output-error": "Ошибка",
};

/** Тон бейджа по состоянию вызова (раздел 4 DDC): в работе info, ждёт
 *  warning, готово success, ошибка danger, остальное neutral. */
const statusVariants: Record<
  ToolPart["state"],
  "neutral" | "info" | "warning" | "success" | "destructive"
> = {
  "approval-requested": "warning",
  "approval-responded": "info",
  "input-available": "info",
  "input-streaming": "neutral",
  "output-available": "success",
  "output-denied": "warning",
  "output-error": "destructive",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon aria-hidden="true" />,
  "approval-responded": <CheckCircleIcon aria-hidden="true" />,
  "input-available": <ClockIcon aria-hidden="true" className="animate-pulse" />,
  "input-streaming": <CircleIcon aria-hidden="true" />,
  "output-available": <CheckCircleIcon aria-hidden="true" />,
  "output-denied": <XCircleIcon aria-hidden="true" />,
  "output-error": <XCircleIcon aria-hidden="true" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge variant={statusVariants[status]}>
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex min-h-9 w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2 min-w-0">
        <WrenchIcon className="size-4 shrink-0 text-ddc-icon-muted" aria-hidden="true" />
        <span className="truncate text-sm font-medium text-ddc-heading" title={title ?? derivedName}>
          {title ?? derivedName}
        </span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon
        className="size-4 shrink-0 text-ddc-icon-muted transition-transform group-data-[state=open]:rotate-180"
        aria-hidden="true"
      />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-2 px-3 pb-3 text-ddc-text outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  // Single-key "command" input (bash, exec, etc.) renders as an inline
  // shell-style line — `pwd` instead of a 4-line JSON block. The wrapped
  // chrome (PARAMETERS label + bordered code box) was overkill for the
  // common case where the input is one short string.
  if (
    input
    && typeof input === "object"
    && !Array.isArray(input)
    && Object.keys(input).length === 1
  ) {
    const k = Object.keys(input)[0];
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length < 200 && !v.includes("\n")) {
      return (
        <div className={cn("font-mono text-xs text-ddc-text", className)} {...props}>
          <span className="text-ddc-text-muted select-none">{k}: </span>
          <span>{v}</span>
        </div>
      );
    }
  }
  return (
    <div className={cn("overflow-hidden", className)} {...props}>
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  // String output that isn't structured JSON → inline mono preview, no
  // syntax-highlighter chrome. CodeBlock with language="json" was making
  // every shell stdout look like a syntax-error.
  if (typeof output === "string" && !errorText) {
    const looksLikeJson = output.trimStart().startsWith("{") || output.trimStart().startsWith("[");
    if (!looksLikeJson) {
      return (
        <div
          className={cn(
            "max-h-64 overflow-y-auto rounded-xl border border-ddc-border bg-ddc-surface px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-ddc-text",
            className,
          )}
          {...props}
        >
          {output}
        </div>
      );
    }
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-1", className)} {...props}>
      <div
        className={cn(
          "overflow-x-auto rounded-xl text-xs [&_table]:w-full",
          errorText
            ? "bg-ddc-tone-danger-bg px-3 py-2 text-ddc-tone-danger-fg"
            : "text-ddc-text"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
