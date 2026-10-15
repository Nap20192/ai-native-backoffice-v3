import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlainButton } from "@/components/ui/plain-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { formatDateRange } from "./analytics-format";
import {
  RANGE_PRESETS,
  resolveRange,
  validateCustomRange,
  type RangePreset,
  type RangeState,
} from "./analytics-params";
import { FilterButton } from "./FilterBar";

export const PRESET_LABELS: Record<RangePreset, string> = {
  mtd: "С начала месяца",
  "7d": "7 дней",
  "30d": "30 дней",
  last_month: "Прошлый месяц",
};

const CUSTOM_LABEL = "Свой период";

/** Подпись над полем даты и сам плотный ввод: поле 32 px, как кнопки панели. */
const DATE_LABEL = "block font-normal leading-normal";
const DATE_INPUT = "h-8 rounded-lg px-2.5 py-[7px] text-xs leading-4";

/** Подпись периода на кнопке. */
export function rangeLabel(value: RangeState): string {
  if (value.kind === "preset") return PRESET_LABELS[value.preset];
  return formatDateRange(value.from, value.to);
}

/**
 * Фильтр периода: «С начала месяца», «7 дней», «30 дней», «Прошлый месяц» и
 * «Свой период» с двумя полями даты. Свой период проверяется так же, как на
 * сервере (не больше 92 дней, начало не позже конца), ошибка стоит под
 * полями. Сутки считаются по UTC.
 */
export function RangeFilter({
  value,
  onChange,
  disabled = false,
  now,
}: {
  value: RangeState;
  onChange: (next: RangeState) => void;
  /** Период зафиксирован страницей (например, «7 дней» на «Кэшировании»). */
  disabled?: boolean;
  now?: Date;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(value.kind === "custom");
  const resolved = resolveRange(value, now);
  const [from, setFrom] = useState(resolved.from);
  const [to, setTo] = useState(resolved.to);
  const error = custom ? validateCustomRange(from, to) : null;

  const update = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    if (validateCustomRange(nextFrom, nextTo) === null) {
      onChange({ kind: "custom", from: nextFrom, to: nextTo });
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          const current = resolveRange(value, now);
          setFrom(current.from);
          setTo(current.to);
          setCustom(value.kind === "custom");
        }
      }}
    >
      <PopoverTrigger asChild>
        <FilterButton label="Период" value={rangeLabel(value)} disabled={disabled} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-0 p-1.5">
        <div role="listbox" aria-label="Период">
          {RANGE_PRESETS.map((preset) => {
            const selected = !custom && value.kind === "preset" && value.preset === preset;
            return (
              <PlainButton
                key={preset}
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setCustom(false);
                  onChange({ kind: "preset", preset });
                  setOpen(false);
                }}
                className={cn("menu-item justify-between", selected && "font-medium text-ddc-text")}
              >
                <span>{PRESET_LABELS[preset]}</span>
                {selected && <CheckIcon className="size-4 text-ddc-link" aria-hidden="true" />}
              </PlainButton>
            );
          })}
          <PlainButton
            role="option"
            aria-selected={custom}
            onClick={() => setCustom(true)}
            className={cn("menu-item justify-between", custom && "font-medium text-ddc-text")}
          >
            <span>{CUSTOM_LABEL}</span>
            {custom && <CheckIcon className="size-4 text-ddc-link" aria-hidden="true" />}
          </PlainButton>
        </div>
        {custom && (
          <div className="mt-1 space-y-3 border-t border-ddc-divider px-2 pt-3 pb-2">
            <Label className={DATE_LABEL}>
              <span className="label">С</span>
              <Input
                type="date"
                value={from}
                onChange={(e) => update(e.target.value, to)}
                aria-invalid={error ? true : undefined}
                className={DATE_INPUT}
              />
            </Label>
            <Label className={DATE_LABEL}>
              <span className="label">По</span>
              <Input
                type="date"
                value={to}
                onChange={(e) => update(from, e.target.value)}
                aria-invalid={error ? true : undefined}
                className={DATE_INPUT}
              />
            </Label>
            {error && (
              <p role="alert" className="text-xs text-error">
                {error}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
