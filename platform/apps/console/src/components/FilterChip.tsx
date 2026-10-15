import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Compact chip-style filter trigger used by every list page's toolbar.
 *
 * Decoration follows selection: nothing visible at rest (just `Label ▾`
 * text on transparent), only the actually-selected chip shows the
 * brand pill outline + bg + clear-X. Same principle as the sidebar
 * nav — an empty filter row visually weighs nothing.
 *
 * Built on shadcn Popover (Radix + Floating UI). PopoverContent hosts
 * whatever the caller wants — `<FacetedFilter>` for enum search-and-
 * pick, a hand-rolled preset list for time buckets, etc. Earlier
 * iteration used DropdownMenu but cmdk Command nested inside Radix
 * Menu fights for focus / keyboard control. Popover has identical
 * collision avoidance + auto-flip via the same Floating-UI primitive,
 * just without the menu semantics in the way.
 */
export function FilterChip({
  label,
  active,
  display,
  onClear,
  children,
}: {
  label: string;
  active: boolean;
  display?: string;
  onClear?: () => void;
  children: ReactNode;
}) {
  return (
    <Popover>
      <div
        className="console-filter-chip"
        data-testid="filter-chip"
        data-active={active || undefined}
      >
        <PopoverTrigger asChild>
          <Button variant="ghost"
            type="button"
            className="console-filter-chip-trigger"
          >
            <span className="font-medium">{display ? `${label}:` : label}</span>
            {display && <span>{display}</span>}
            {!active && <ChevronDownIcon className="size-4 text-ddc-placeholder" />}
          </Button>
        </PopoverTrigger>
        {active && onClear && (
          <Button variant="ghost"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="console-filter-chip-clear"
            aria-label={`Сбросить фильтр «${label}»`}
            title="Сбросить фильтр"
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {children}
    </Popover>
  );
}

// ── Created-at filter ───────────────────────────────────────────────
// Reusable across every list page that wants to slice by created_at.
// Internal state owns the preset choice + custom-range bounds; the
// page only sees the resolved `(after, before)` epoch-ms tuple via
// onChange. Both bounds nullable → "no bound on this side".

export type CreatedPreset =
  | "any"
  | "today"
  | "last-hour"
  | "last-day"
  | "last-7d"
  | "last-30d"
  | "custom";

export const CREATED_PRESET_LABELS: Record<CreatedPreset, string> = {
  any: "Всё время",
  today: "Сегодня",
  "last-hour": "Последний час",
  "last-day": "Последние сутки",
  "last-7d": "Последние 7 дней",
  "last-30d": "Последние 30 дней",
  custom: "Свой период",
};

function computePresetRange(
  preset: Exclude<CreatedPreset, "any" | "custom">,
): { after?: number; before?: number } {
  const now = Date.now();
  switch (preset) {
    case "today": {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { after: start.getTime() };
    }
    case "last-hour":
      return { after: now - 60 * 60 * 1000 };
    case "last-day":
      return { after: now - 24 * 60 * 60 * 1000 };
    case "last-7d":
      return { after: now - 7 * 24 * 60 * 60 * 1000 };
    case "last-30d":
      return { after: now - 30 * 24 * 60 * 60 * 1000 };
  }
}

/** Format epoch ms → YYYY-MM-DD for the native `<Input type="date">`
 *  value attribute. Date pickers store local-tz dates as strings; we
 *  convert back to ms via `new Date(str).getTime()` (also local). The
 *  precision mismatch (day vs ms) is fine because the chip presets
 *  themselves resolve to coarse boundaries (today 00:00, etc). */
export function msToDateInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Drop-in Created-at chip. Owns its preset choice internally; surfaces
 * the resolved (after, before) epoch-ms bounds to the parent via
 * onChange so the parent can drop them straight into a server query
 * param.
 *
 * Подпись настраивается: «Создано» / «Обновлено» / «Отправлено» и так
 * далее, смотря по ресурсу.
 */
export function CreatedFilterChip({
  label = "Создано",
  value,
  onChange,
}: {
  label?: string;
  /** Currently-resolved bounds. `{}` = no filter. */
  value: { after?: number; before?: number };
  onChange: (v: { after?: number; before?: number }) => void;
}) {
  const [preset, setPreset] = useState<CreatedPreset>("any");
  const [customAfter, setCustomAfter] = useState<number | undefined>(value.after);
  const [customBefore, setCustomBefore] = useState<number | undefined>(value.before);

  const active = value.after !== undefined || value.before !== undefined;
  const display = preset === "any" ? undefined : CREATED_PRESET_LABELS[preset];

  const apply = (next: CreatedPreset, opts?: { after?: number; before?: number }) => {
    setPreset(next);
    if (next === "any") {
      onChange({});
      return;
    }
    if (next === "custom") {
      onChange({ after: opts?.after ?? customAfter, before: opts?.before ?? customBefore });
      return;
    }
    onChange(computePresetRange(next));
  };

  return (
    <FilterChip
      label={label}
      active={active}
      display={display}
      onClear={() => {
        setPreset("any");
        setCustomAfter(undefined);
        setCustomBefore(undefined);
        onChange({});
      }}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-60 gap-0 p-1.5"
      >
        {(Object.keys(CREATED_PRESET_LABELS) as CreatedPreset[]).map((p) => (
          <Button variant="ghost"
            size="sm"
            key={p}
            type="button"
            onClick={() => apply(p)}
            className={cn(
              "w-full justify-between gap-2 rounded-lg text-sm font-normal text-ddc-ghost-text",
              "hover:bg-ddc-surface-muted",
              preset === p && "font-medium text-ddc-text",
            )}
          >
            {CREATED_PRESET_LABELS[p]}
            {preset === p && <CheckIcon className="size-4 text-ddc-link" />}
          </Button>
        ))}
        {preset === "custom" && (
          <div className="mt-1 space-y-3 border-t border-ddc-divider px-1.5 pt-3 pb-1.5">
            <Label className="block">
              <span className="mb-1.5 block text-xs leading-4 font-medium text-ddc-label">С</span>
              <Input
                type="date"
                value={msToDateInput(customAfter)}
                onChange={(e) => {
                  const v = e.target.value;
                  const next = v ? new Date(v).getTime() : undefined;
                  setCustomAfter(next);
                  apply("custom", { after: next, before: customBefore });
                }}
              />
            </Label>
            <Label className="block">
              <span className="mb-1.5 block text-xs leading-4 font-medium text-ddc-label">По</span>
              <Input
                type="date"
                value={msToDateInput(customBefore)}
                onChange={(e) => {
                  const v = e.target.value;
                  // End of selected day so "<= that day" works as the
                  // user expects (otherwise picking 2026-05-24 would
                  // exclude that whole day since the filter is `<`).
                  let next: number | undefined;
                  if (v) {
                    const d = new Date(v);
                    d.setDate(d.getDate() + 1);
                    next = d.getTime();
                  }
                  setCustomBefore(next);
                  apply("custom", { after: customAfter, before: next });
                }}
              />
            </Label>
          </div>
        )}
      </PopoverContent>
    </FilterChip>
  );
}
