import { useState } from "react";
import { Link } from "react-router";
import { ChevronDownIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import type { ModelOption } from "../../lib/catalog-api";
import { modelMetaLine } from "./model-format";

interface ModelPickerProps {
  id?: string;
  /** Handle выбранной модели. Пустая строка: ничего не выбрано. */
  value: string;
  /** Модели из `GET /v1/oma/model_options`. `undefined`, пока они грузятся. */
  options: ModelOption[] | undefined;
  loading?: boolean;
  /** `null` приходит от пункта `emptyLabel`. */
  onChange: (option: ModelOption | null) => void;
  /** Пункт сверху списка, который снимает выбор. Нужен вспомогательной модели. */
  emptyLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

const TRIGGER_CLS =
  "w-full justify-between gap-2 border-input bg-ddc-surface px-3.5 font-normal text-ddc-text hover:bg-ddc-surface focus-visible:border-ddc-ring focus-visible:ring-2 focus-visible:ring-ddc-ring/30 focus-visible:outline-hidden";

const ITEM_CLS = "h-auto min-h-[var(--menu-picker-row-h)] cursor-pointer items-start py-1.5";

/** Название модели, её handle моноширинным шрифтом и бейдж «По умолчанию». */
function ModelName({ option }: { option: ModelOption }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate text-sm text-ddc-text" title={option.label}>
        {option.label}
      </span>
      {option.handle !== option.label && (
        <span className="truncate font-mono text-xs text-ddc-text-muted" title={option.handle}>
          {option.handle}
        </span>
      )}
      {option.is_default && <Badge variant="brand">По умолчанию</Badge>}
    </span>
  );
}

/**
 * Выбор модели для агента. Список на `Popover` и `Command`: поиск по handle и
 * названию, группы «Карточки моделей» и «Ключ сервера», у строки серая строка
 * с источником, провайдером и контекстом.
 */
export function ModelPicker({
  id,
  value,
  options,
  loading,
  onChange,
  emptyLabel,
  placeholder = "Выберите модель…",
  disabled,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const selected = options?.find((option) => option.handle === value);

  const cards = (options ?? []).filter((option) => option.source === "card");
  const builtin = (options ?? []).filter((option) => option.source === "builtin");

  const choose = (option: ModelOption | null) => {
    onChange(option);
    setOpen(false);
  };

  const renderItem = (option: ModelOption) => (
    <CommandItem
      key={option.handle}
      value={`${option.handle} ${option.label}`}
      onSelect={() => choose(option)}
      data-checked={option.handle === value}
      className={ITEM_CLS}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="block min-w-0">
          <ModelName option={option} />
        </span>
        <span className="truncate text-xs text-ddc-text-muted">{modelMetaLine(option)}</span>
      </span>
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          type="button"
          id={id}
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          className={TRIGGER_CLS}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {selected ? (
              <>
                <span className="truncate">{selected.label}</span>
                {selected.handle !== selected.label && (
                  <span className="truncate font-mono text-xs text-ddc-text-muted">
                    {selected.handle}
                  </span>
                )}
              </>
            ) : value ? (
              <span className="truncate font-mono text-xs">{value}</span>
            ) : (
              <span className="truncate text-ddc-placeholder">{emptyLabel ?? placeholder}</span>
            )}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 text-ddc-placeholder" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={8}
        className="w-[var(--radix-popover-trigger-width)] min-w-[min(20rem,calc(100vw-1rem))] gap-0 p-0"
      >
        <Command className="max-h-96">
          <CommandInput placeholder="Поиск…" autoFocus />
          <CommandList>
            {loading && !options && (
              <div className="px-3 py-6 text-center text-sm text-ddc-text-muted">Загрузка…</div>
            )}
            {options && options.length === 0 && !emptyLabel && (
              <div className="px-3 py-6 text-center text-sm text-ddc-text-muted">Моделей нет</div>
            )}
            {options && options.length > 0 && <CommandEmpty>Ничего не найдено</CommandEmpty>}
            {emptyLabel && (
              <CommandGroup>
                <CommandItem
                  value="__none__ нет"
                  onSelect={() => choose(null)}
                  data-checked={value === ""}
                  className="cursor-pointer"
                >
                  {emptyLabel}
                </CommandItem>
              </CommandGroup>
            )}
            {cards.length > 0 && (
              <CommandGroup heading="Карточки моделей">{cards.map(renderItem)}</CommandGroup>
            )}
            {builtin.length > 0 && (
              <CommandGroup heading="Ключ сервера">{builtin.map(renderItem)}</CommandGroup>
            )}
          </CommandList>
        </Command>
        <div className="border-t border-ddc-divider p-2.5 text-xs">
          <Link to="/model-cards" className="link" onClick={() => setOpen(false)}>
            Добавить карточку модели
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
