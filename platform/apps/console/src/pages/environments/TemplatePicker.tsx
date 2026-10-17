import { Fragment, useId } from "react";

import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

import { Skeleton } from "../../components/Skeleton";
import type { EnvironmentTemplate } from "../../lib/environment-templates";

interface TemplatePickerProps {
  templates: EnvironmentTemplate[];
  /** Ключ выбранного шаблона. Он должен быть среди `templates`. */
  value: string;
  onChange: (id: string) => void;
  /** Каталог образов ещё грузится: рядом с «Пустым» стоят заглушки. */
  loading?: boolean;
  /** Id подписи группы («Шаблон»). */
  labelId?: string;
}

/**
 * Ряд карточек шаблонов окружения и сводка выбранного (раздел 2.2 плана
 * environments.md). На карточке название, одна строка назначения и чипы образа и
 * сети. Шаблон с несобранным образом выключен, на нём чип «Образ не собран».
 * Под рядом стоит сводка: образ, сеть и пакеты, которые создаст шаблон. Она
 * показывает то, что потом заполнит форму окружения.
 *
 * Компонент не ходит на сервер: список шаблонов приходит из
 * `lib/environment-templates.ts`.
 */
export function TemplatePicker({ templates, value, onChange, loading = false, labelId }: TemplatePickerProps) {
  const baseId = useId();
  const selected = templates.find((template) => template.id === value);

  return (
    <div className="space-y-3">
      <RadioGroup
        aria-labelledby={labelId}
        aria-busy={loading || undefined}
        value={value}
        onValueChange={onChange}
        className="grid gap-2 sm:grid-cols-2"
      >
        {templates.map((template) => {
          const checked = template.id === value;
          const chips = [
            template.imageLabel && {
              text: template.imageLabel,
              tone: "tone-neutral",
              title: template.details.image ?? undefined,
            },
            template.networkLabel && { text: template.networkLabel, tone: "tone-neutral", title: undefined },
            !template.available && {
              text: template.unavailableReason ?? "Недоступно",
              tone: "tone-warning",
              title: undefined,
            },
          ].filter((chip) => Boolean(chip)) as Array<{ text: string; tone: string; title: string | undefined }>;
          return (
            <Label
              key={template.id}
              htmlFor={`${baseId}-${template.id}`}
              className={cn(
                "flex min-w-0 items-start gap-2 rounded-xl border p-3 transition-colors",
                template.available
                  ? "cursor-pointer border-ddc-border hover:bg-ddc-surface-muted"
                  : "cursor-not-allowed border-ddc-border opacity-60",
                checked && "border-ddc-ring bg-ddc-selected-bg hover:bg-ddc-selected-bg",
              )}
            >
              <RadioGroupItem
                id={`${baseId}-${template.id}`}
                value={template.id}
                disabled={!template.available}
                aria-label={template.label}
                aria-describedby={`${baseId}-${template.id}-details`}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ddc-heading">{template.label}</span>{" "}
                <span id={`${baseId}-${template.id}-details`} className="block">
                  {template.hint && (
                    <span className="mt-0.5 block text-xs leading-relaxed font-normal text-ddc-text-muted">
                      {template.hint}
                    </span>
                  )}{" "}
                  {chips.length > 0 && (
                    <span className="mt-2 flex flex-wrap gap-1.5">
                      {chips.map((chip, index) => (
                        <Fragment key={chip.text}>
                          {/* Пробел нужен читалке экрана: без него чипы слипаются в одно слово. */}
                          {index > 0 && " "}
                          <span className={`chip ${chip.tone}`} title={chip.title}>
                            {chip.text}
                          </span>
                        </Fragment>
                      ))}
                    </span>
                  )}
                </span>
              </span>
            </Label>
          );
        })}
        {loading && [0, 1].map((index) => <Skeleton key={index} className="h-24 w-full" rounded="lg" />)}
      </RadioGroup>
      {loading && (
        <span role="status" className="sr-only">
          Загружаем шаблоны…
        </span>
      )}

      {selected && <TemplateSummary template={selected} />}
    </div>
  );
}

/** Что создаст выбранный шаблон. Строка «Образ» стоит, только когда есть каталог образов. */
function TemplateSummary({ template }: { template: EnvironmentTemplate }) {
  const rows: Array<[string, string]> = [];
  if (template.details.image !== null) rows.push(["Образ", template.details.image]);
  if (template.details.network !== null) rows.push(["Сеть", template.details.network]);
  rows.push(["Пакеты", template.details.packages ?? "Только то, что есть в образе"]);
  return (
    <div
      role="group"
      aria-label={`Что даёт шаблон «${template.label}»`}
      className="rounded-xl bg-ddc-surface-muted p-3"
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs leading-4">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-ddc-text-muted">{name}</dt>
            <dd className="prose-wrap text-ddc-text">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
