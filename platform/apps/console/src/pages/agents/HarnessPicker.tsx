import { useId, useState } from "react";
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
import { cn } from "@/lib/utils";

import type { HarnessEntry, ModelOption } from "../../lib/catalog-api";
import { findHarness, groupHarnessEntries, harnessDisabledReason } from "./agent-harness";
import { HARNESS_LABELS, harnessLabel, protocolLabel } from "./harness-text";

interface HarnessPickerProps {
  id?: string;
  /** Id выбранного harness: `pi`, id записи каталога или устаревшее значение. */
  value: string;
  /** Каталог из `GET /v1/oma/harnesses`. `undefined`, пока он грузится. */
  entries: HarnessEntry[] | undefined;
  /** Модели нужны, чтобы выключить harness без единой совместимой модели. */
  options: ModelOption[] | undefined;
  loading?: boolean;
  onChange: (entry: HarnessEntry) => void;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

const TRIGGER_CLS =
  "w-full justify-between gap-2 border-input bg-ddc-surface px-3.5 font-normal text-ddc-text hover:bg-ddc-surface focus-visible:border-ddc-ring focus-visible:ring-2 focus-visible:ring-ddc-ring/30 focus-visible:outline-hidden";

const ITEM_CLS =
  "h-auto min-h-[var(--menu-picker-row-h)] cursor-pointer items-start py-1.5 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:pointer-events-auto data-[disabled=true]:opacity-100";

/** Вторая строка рабочей записи: какие модели она берёт. */
function protocolsLine(entry: HarnessEntry): string {
  if (entry.protocols.includes("*")) return "Любая модель из списка";
  return `Протокол модели: ${entry.protocols.map(protocolLabel).join(", ")}`;
}

/**
 * Выбор harness агента. Список на `Popover` и `Command`: группы «Готово»,
 * «Не проверено», «Недоступно» и «Свои», у пункта подпись, ID моноширинным
 * шрифтом и чип «Не проверено». Недоступная запись и запись без совместимой
 * модели выключены: причина стоит в строке, в `title` и в `aria-describedby`.
 * Агент с устаревшим значением показывает его подпись, выбрать его снова
 * нельзя.
 */
export function HarnessPicker({
  id,
  value,
  entries,
  options,
  loading,
  onChange,
  disabled,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
}: HarnessPickerProps) {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const selected = findHarness(entries, value);
  const groups = groupHarnessEntries(entries ?? []);

  const triggerLabel = selected
    ? harnessLabel(selected)
    : (HARNESS_LABELS[value] ?? value);

  const choose = (entry: HarnessEntry) => {
    onChange(entry);
    setOpen(false);
  };

  const renderItem = (entry: HarnessEntry) => {
    const reason = harnessDisabledReason(entry, options);
    const reasonId = `${baseId}-${entry.id}-reason`;
    return (
      <CommandItem
        key={entry.id}
        value={`${entry.id} ${harnessLabel(entry)}`}
        disabled={reason !== null}
        onSelect={() => choose(entry)}
        data-checked={entry.id === value}
        title={reason ?? undefined}
        aria-describedby={reason ? reasonId : undefined}
        className={ITEM_CLS}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("flex min-w-0 items-center gap-2", reason && "opacity-60")}>
            <span className="truncate text-sm text-ddc-text" title={harnessLabel(entry)}>
              {harnessLabel(entry)}
            </span>
            <span className="truncate font-mono text-xs text-ddc-text-muted" title={entry.id}>
              {entry.id}
            </span>
            {entry.status === "unverified" && <Badge variant="neutral">Не проверено</Badge>}
          </span>
          {reason ? (
            <span
              id={reasonId}
              className="text-xs leading-4 text-ddc-warning-text [overflow-wrap:anywhere]"
            >
              {reason}
            </span>
          ) : (
            <span className="truncate text-xs text-ddc-text-muted">{protocolsLine(entry)}</span>
          )}
        </span>
      </CommandItem>
    );
  };

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
            <span className="truncate">{triggerLabel}</span>
            {selected && selected.id !== triggerLabel && (
              <span className="truncate font-mono text-xs text-ddc-text-muted">{selected.id}</span>
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
            {loading && !entries && (
              <div className="px-3 py-6 text-center text-sm text-ddc-text-muted">Загрузка…</div>
            )}
            {entries && <CommandEmpty>Ничего не найдено</CommandEmpty>}
            {groups.map((group) => (
              <CommandGroup key={group.key} heading={group.label}>
                {group.entries.map(renderItem)}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
        <div className="border-t border-ddc-divider p-2.5 text-xs">
          <Link to="/harnesses" className="link" onClick={() => setOpen(false)}>
            Добавить свой harness
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
