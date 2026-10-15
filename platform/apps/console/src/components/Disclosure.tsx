import { Button } from "@/components/ui/button";
import { useState, type ReactNode } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronRightIcon } from "lucide-react";

/**
 * Collapsible section with chevron indicator and aria-expanded wiring.
 *
 * Built on shadcn `Collapsible` (which wraps Radix), so Escape support,
 * aria-controls / aria-expanded linkage, and the unmount-after-close
 * animation come for free. Spring-out chevron rotation is added here
 * because shadcn's primitive ships unstyled.
 *
 * Two trigger variants:
 *   - default ("border")  → bordered row with title left + chevron right
 *   - "bare"              → no border, used inside list rows / cards
 *                           where the parent already provides chrome
 */
interface DisclosureProps {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  variant?: "border" | "bare";
  className?: string;
  children: ReactNode;
}

export function Disclosure({
  title,
  meta,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  variant = "border",
  className = "",
  children,
}: DisclosureProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const wrapperCls = variant === "border" ? "rounded-xl border border-ddc-border bg-ddc-surface" : "";

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={`${wrapperCls} ${className}`.trim()}
    >
      <CollapsibleTrigger asChild>
        <Button variant="ghost"
          type="button"
          className="h-auto min-h-10 w-full justify-start gap-2 px-4 py-2.5 text-left font-normal"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-4 text-ddc-icon-muted transition-transform duration-[var(--dur-base)] ease-[var(--ease-soft)] ${
              open ? "rotate-90" : ""
            }`}
          />
          <span className="min-w-0 flex-1 text-sm font-medium text-ddc-text">{title}</span>
          {meta && <span className="shrink-0 text-xs text-ddc-text-muted">{meta}</span>}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content overflow-hidden">
        <div className="px-4 pb-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
