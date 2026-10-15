import type { ReactElement, ReactNode } from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { MoreHorizontalIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface RowAction {
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface RowContextMenuProps {
  actions: RowAction[];
  children: ReactElement;
}

/** Context-only row actions. Keeping the trigger on the row itself removes
 * the permanent trailing action column while retaining keyboard ContextMenu
 * / Shift+F10 support from Radix. */
export function RowContextMenu({ actions, children }: RowContextMenuProps) {
  if (actions.length === 0) return children;

  const items: Array<RowAction | "separator"> = [];
  let sawSafe = false;
  let sawSeparator = false;
  for (const action of actions) {
    if (action.destructive && sawSafe && !sawSeparator) {
      items.push("separator");
      sawSeparator = true;
    }
    items.push(action);
    if (!action.destructive) sawSafe = true;
  }

  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          className="z-50 min-w-48 overflow-hidden rounded-[var(--console-radius-popover)] border border-ddc-border bg-ddc-surface p-1.5 text-ddc-text shadow-card data-[state=open]:animate-fade-in"
          collisionPadding={8}
        >
          {items.map((item, index) =>
            item === "separator" ? (
              <ContextMenuPrimitive.Separator
                key={`separator-${index}`}
                className="-mx-1.5 my-1 h-px bg-ddc-divider"
              />
            ) : (
              <ContextMenuPrimitive.Item
                key={index}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  "relative flex h-[var(--menu-action-row-h)] cursor-default select-none items-center gap-2 rounded-[var(--console-radius-md)] px-3 text-sm leading-5 text-ddc-ghost-text outline-hidden data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ddc-icon-muted",
                  item.destructive &&
                    "text-ddc-danger-text data-[highlighted]:bg-ddc-tone-danger-bg data-[highlighted]:text-ddc-tone-danger-fg [&_svg]:text-current",
                )}
              >
                {item.icon}
                {item.label}
              </ContextMenuPrimitive.Item>
            ),
          )}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

/**
 * Видимая кнопка «⋯» с теми же действиями строки. Нужна там, где нет правой
 * кнопки мыши: в карточках списка на телефоне. Клик по кнопке не доходит до
 * строки, поэтому не открывает её.
 */
export function RowActionsMenu({
  actions,
  label,
  className,
}: {
  actions: RowAction[];
  label: string;
  className?: string;
}) {
  if (actions.length === 0) return null;

  const items: Array<RowAction | "separator"> = [];
  let sawSafe = false;
  let sawSeparator = false;
  for (const action of actions) {
    if (action.destructive && sawSafe && !sawSeparator) {
      items.push("separator");
      sawSeparator = true;
    }
    items.push(action);
    if (!action.destructive) sawSafe = true;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          className={cn("shrink-0", className)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {items.map((item, index) =>
          item === "separator" ? (
            <DropdownMenuSeparator key={`separator-${index}`} />
          ) : (
            <DropdownMenuItem
              key={index}
              disabled={item.disabled}
              variant={item.destructive ? "destructive" : "default"}
              onSelect={item.onSelect}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
