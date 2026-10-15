import { useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { FilterButton } from "./FilterBar";

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Фильтр со списком флажков. Пустой список значений значит «все», поэтому
 * по умолчанию отмечено всё и в адрес ничего не пишется. Снятая галочка
 * превращает выбор в явный список остальных значений. «Очистить» снимает все
 * галочки, чтобы выбрать нужное с нуля, пока список не пуст, фильтр остаётся
 * «Все». «Выбрать всё» возвращает фильтр в исходное состояние.
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  disabled = false,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [cleared, setCleared] = useState(false);

  // Значение из адреса, которого нет среди вариантов, остаётся в списке.
  const all = useMemo(() => {
    const known = new Set(options.map((o) => o.value));
    return [
      ...options,
      ...selected.filter((value) => !known.has(value)).map((value) => ({ value, label: value })),
    ];
  }, [options, selected]);

  const allValues = all.map((o) => o.value);
  const isAll = selected.length === 0;
  const checked = (value: string) => !cleared && (isAll || selected.includes(value));

  const toggle = (value: string) => {
    if (cleared) {
      setCleared(false);
      onChange([value]);
      return;
    }
    const base = isAll ? allValues : selected;
    const next = base.includes(value) ? base.filter((v) => v !== value) : [...base, value];
    if (next.length === 0) {
      setCleared(true);
      onChange([]);
    } else if (next.length === allValues.length) {
      onChange([]);
    } else {
      onChange(next);
    }
  };

  const display = (() => {
    if (isAll) return "Все";
    if (selected.length === 1) {
      return all.find((o) => o.value === selected[0])?.label ?? selected[0];
    }
    return `${selected.length} из ${allValues.length}`;
  })();

  const needle = search.trim().toLowerCase();
  const visible = needle
    ? all.filter((o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle))
    : all;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSearch("");
          setCleared(false);
        }
      }}
    >
      <PopoverTrigger asChild>
        <FilterButton label={label} value={display} disabled={disabled} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 p-0" aria-label={label}>
        <div className="border-b border-ddc-divider p-2">
          <Input
            id={searchId}
            type="search"
            aria-label="Поиск"
            placeholder="Поиск"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 rounded-lg px-2.5 py-[7px] text-xs leading-4"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1.5">
          {visible.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-ddc-text-muted">Ничего не найдено</p>
          ) : (
            visible.map((option) => (
              <Label
                key={option.value}
                className="min-h-8 cursor-pointer rounded-lg px-3 py-1.5 font-normal leading-normal hover:bg-ddc-surface-muted"
              >
                <Checkbox
                  checked={checked(option.value)}
                  onCheckedChange={() => toggle(option.value)}
                />
                <span className="min-w-0 truncate" title={option.label}>
                  {option.label}
                </span>
              </Label>
            ))
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-ddc-divider p-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!cleared && isAll}
            onClick={() => {
              setCleared(false);
              onChange([]);
            }}
          >
            Выбрать всё
          </Button>
          <Button
            type="button"
            variant="link"
            size="xs"
            disabled={cleared}
            onClick={() => {
              setCleared(true);
              onChange([]);
            }}
          >
            Очистить
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
