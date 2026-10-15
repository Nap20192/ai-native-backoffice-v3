import { Input } from "@/components/ui/input";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Local-options combobox: the input is the search box AND the value
 * editor. Useful when options come from a small static list (e.g. the
 * MCP server registry) AND the user can also type a value that isn't
 * in the list (e.g. a custom URL).
 *
 * Differs from the cursor-paginated Combobox in this folder:
 *   - Options are passed in (no fetch).
 *   - Input is freely editable; not picking an option is fine.
 *   - Popover positioning is handed off to shadcn `Popover` (Radix-based)
 *     so the dropdown escapes ancestor `overflow:hidden`/`overflow:auto`
 *     clipping the same way the data-paginated Combobox does. Radix
 *     Popover is wired to coexist with Radix Dialog scroll-lock, which
 *     the previous hand-rolled portal-to-body approach had to fight via
 *     a manual wheel handler.
 *
 * Pick semantics: `onPick(item)` fires when the user clicks an option.
 * Caller decides whether to also write the option's label/url back
 * into `value` via the same handler — usually yes.
 */
export interface LocalComboboxProps<T> {
  /** Id поля ввода, чтобы подпись `<Label htmlFor>` указывала на него. */
  id?: string;
  value: string;
  onChange: (text: string) => void;
  onPick?: (item: T) => void;
  options: T[];
  filter?: (item: T, query: string) => boolean;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** Left-side adornment (e.g. picked item's favicon). */
  prefix?: ReactNode;
  placeholder?: string;
  /** Container className override; defaults to a sane input shell. */
  className?: string;
  /** Shown inside the dropdown when no options match. */
  emptyHint?: ReactNode;
  /** Max dropdown height. Default 18rem. */
  maxHeight?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

// Поле DDC (`.input`): 40px, rounded-xl, при фокусе рамка и кольцо бренда.
// Рамкой и кольцом владеет оболочка, поэтому вложенный Input их не рисует.
const DEFAULT_INPUT_CLS =
  "flex h-10 w-full items-center gap-2 rounded-xl border border-input bg-ddc-surface px-3.5 text-sm leading-5 text-ddc-text transition-colors focus-within:border-ddc-ring focus-within:ring-2 focus-within:ring-ddc-ring/30";

export function LocalCombobox<T>({
  id,
  value,
  onChange,
  onPick,
  options,
  filter,
  getKey,
  renderItem,
  prefix,
  placeholder,
  className,
  emptyHint,
  maxHeight = "18rem",
  disabled,
  autoFocus,
}: LocalComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Esc closes — Popover normally handles this, but our trigger isn't the
  // input itself (the input must stay focused while typing), so let Radix
  // handle clicks-outside / focus-out and only opt in to Escape here.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const lowerQ = value.toLowerCase().trim();
  const matches = filter
    ? options.filter((o) => filter(o, lowerQ))
    : options;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          role="presentation"
          className={className ?? DEFAULT_INPUT_CLS}
          onClick={() => inputRef.current?.focus()}
        >
          {prefix}
          <Input
            ref={inputRef}
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setOpen(true)}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-autocomplete="list"
            className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 shadow-none ring-0 focus-visible:ring-0"
          />
          {value && !disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              // preventDefault on mousedown stops the input losing focus
              // before our click handler runs.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange("")}
              aria-label="Очистить"
              title="Очистить"
            >
              <XIcon />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((v) => !v)}
            disabled={disabled}
            aria-expanded={open}
            aria-label="Показать варианты"
            title="Показать варианты"
            className={cn(
              "transition-transform",
              open && "rotate-180",
            )}
          >
            <ChevronDownIcon />
          </Button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[var(--radix-popover-trigger-width)] gap-0 overflow-y-auto p-1.5"
        style={{ maxHeight }}
      >
        {matches.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-ddc-text-muted">
            {emptyHint ?? "Ничего не найдено"}
          </div>
        ) : (
          matches.map((item) => (
            <Button variant="ghost"
              key={getKey(item)}
              type="button"
              // mousedown picks before the input loses focus.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick?.(item);
                setOpen(false);
              }}
              className="h-auto min-h-9 w-full justify-start rounded-lg px-3 py-2 text-left font-normal text-ddc-text hover:bg-ddc-surface-muted"
            >
              {renderItem(item)}
            </Button>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}
