import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { PlainButton } from "@/components/ui/plain-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { FilterButton } from "./FilterBar";

export interface SingleSelectOption<T extends string = string> {
  value: T;
  label: string;
}

/**
 * Фильтр с одним значением («Группировать по», «Статус»). Выбор закрывает
 * меню, выбранный пункт отмечен галочкой. Крестика сброса нет: возврат к
 * умолчанию делает кнопка «Сбросить» панели.
 */
export function SingleSelectFilter<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: Array<SingleSelectOption<T>>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FilterButton label={label} value={current?.label ?? ""} disabled={disabled} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-0 p-1.5">
        <div role="listbox" aria-label={label}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <PlainButton
                key={option.value}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  "menu-item justify-between",
                  selected && "font-medium text-ddc-text",
                )}
              >
                <span className="truncate">{option.label}</span>
                {selected && <CheckIcon className="size-4 text-ddc-link" aria-hidden="true" />}
              </PlainButton>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
