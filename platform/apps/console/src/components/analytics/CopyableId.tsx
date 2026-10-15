import { CopyIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { toast } from "sonner";

import { PlainButton } from "@/components/ui/plain-button";
import { cn } from "@/lib/utils";

/**
 * Моноширинный ID со значком копирования. Значок виден при наведении и при
 * фокусе, на устройствах без наведения (телефон) всегда. Клик по значку не
 * открывает строку списка, в которой стоит ID.
 */
export function CopyableId({ id, className }: { id: string; className?: string }) {
  const copy = async (event: MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(id);
      toast.success("Скопировано");
    } catch {
      toast.error("Не удалось скопировать");
    }
  };
  return (
    <span className={cn("group/id inline-flex min-w-0 items-center gap-1", className)}>
      <span className="truncate font-mono text-sm font-medium text-ddc-heading" title={id}>
        {id}
      </span>
      <PlainButton
        aria-label={`Скопировать ${id}`}
        title="Скопировать"
        onClick={copy}
        className="inline-flex size-6 flex-none items-center justify-center rounded-md text-ddc-icon-muted opacity-0 transition-opacity group-hover/id:opacity-100 hover:text-ddc-text focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <CopyIcon className="size-3.5" aria-hidden="true" />
      </PlainButton>
    </span>
  );
}
