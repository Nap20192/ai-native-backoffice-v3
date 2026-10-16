import { load } from "js-yaml";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { YamlDiffView } from "../YamlDiffView";
import { displayText, type ConfigFormat, type DescribeState } from "./describe-state";
import { PlainButton } from "@/components/ui/plain-button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Панель «Конфигурация агента» справа от чата (раздел 1.3 плана, 617 px).
 * Переключатель «Форма | YAML», выбор YAML или JSON, «Копировать», строка
 * «Изменилось: ...» и переключатель «Показать разницу» с прошлым черновиком.
 * Панель ничего не отправляет сама: правки поднимаются наверх.
 */

type View = "form" | "text";

export interface ConfigPreviewPanelProps {
  state: DescribeState;
  /** Причина, по которой агента пока нельзя создать. */
  error: string | null;
  onEdit: (text: string) => void;
  onField: (key: string, value: string) => void;
  onFormat: (format: ConfigFormat) => void;
  disabled?: boolean;
  className?: string;
}

function readConfig(yaml: string | null): Record<string, unknown> | null {
  if (yaml === null) return null;
  try {
    const parsed = load(yaml);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const asText = (v: unknown): string => (typeof v === "string" ? v : "");

function modelLabel(model: unknown): string {
  if (typeof model === "string") return model;
  if (model !== null && typeof model === "object") return asText((model as Record<string, unknown>).id);
  return "";
}

function listOf(value: unknown, pick: (item: Record<string, unknown>) => string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item !== null && typeof item === "object" ? pick(item as Record<string, unknown>) : ""))
    .filter(Boolean);
}

function Field({
  label,
  changed,
  children,
  htmlFor,
}: {
  label: string;
  changed: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div
      data-changed={changed ? "true" : "false"}
      className={cn("flex flex-col gap-1 rounded-lg p-1.5", changed && "bg-(--assistant-accent-bg)")}
    >
      <Label htmlFor={htmlFor} className="text-xs font-medium text-ddc-label">
        {label}
      </Label>
      {children}
    </div>
  );
}

function ReadOnlyList({ label, changed, items, empty }: { label: string; changed: boolean; items: string[]; empty: string }) {
  return (
    <div
      data-changed={changed ? "true" : "false"}
      className={cn("flex flex-col gap-1 rounded-lg p-1.5", changed && "bg-(--assistant-accent-bg)")}
    >
      <span className="text-xs font-medium text-ddc-label">{label}</span>
      {items.length === 0 ? (
        <span className="text-sm text-ddc-text-muted">{empty}</span>
      ) : (
        <ul className="flex flex-col gap-0.5 text-sm text-ddc-text">
          {items.map((item) => (
            <li key={item} className="break-words">
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FormView({
  config,
  changed,
  disabled,
  onField,
}: {
  config: Record<string, unknown>;
  changed: ReadonlySet<string>;
  disabled: boolean;
  onField: (key: string, value: string) => void;
}) {
  const tools = listOf(config.tools, (t) => asText(t.type) || asText(t.name));
  const mcp = listOf(config.mcp_servers, (s) => [asText(s.name), asText(s.url)].filter(Boolean).join(" · "));
  const skills = listOf(config.skills, (s) => asText(s.skill_id) || asText(s.name) || asText(s.id));
  return (
    <div className="flex flex-col gap-1">
      <Field label="Название" htmlFor="describe-name" changed={changed.has("name")}>
        <Input
          id="describe-name"
          value={asText(config.name)}
          disabled={disabled}
          onChange={(e) => onField("name", e.target.value)}
        />
      </Field>
      <Field label="Описание" htmlFor="describe-description" changed={changed.has("description")}>
        <Input
          id="describe-description"
          value={asText(config.description)}
          disabled={disabled}
          onChange={(e) => onField("description", e.target.value)}
        />
      </Field>
      <div
        data-changed={changed.has("model") ? "true" : "false"}
        className={cn("flex flex-col gap-1 rounded-lg p-1.5", changed.has("model") && "bg-(--assistant-accent-bg)")}
      >
        <span className="text-xs font-medium text-ddc-label">Модель</span>
        <span className="text-sm text-ddc-text">{modelLabel(config.model) || "Не указана"}</span>
      </div>
      <Field label="Системный промпт" htmlFor="describe-system" changed={changed.has("system")}>
        <Textarea
          id="describe-system"
          rows={8}
          value={asText(config.system)}
          disabled={disabled}
          onChange={(e) => onField("system", e.target.value)}
        />
      </Field>
      <ReadOnlyList label="Инструменты" changed={changed.has("tools")} items={tools} empty="Набор по умолчанию" />
      <ReadOnlyList label="MCP-серверы" changed={changed.has("mcp_servers")} items={mcp} empty="Нет" />
      <ReadOnlyList label="Навыки" changed={changed.has("skills")} items={skills} empty="Нет" />
      <p className="px-1.5 text-xs text-ddc-text-muted">
        Инструменты, серверы и навыки меняет ассистент по вашей просьбе или вы сами во вкладке с текстом.
      </p>
    </div>
  );
}

export function ConfigPreviewPanel({
  state,
  error,
  onEdit,
  onField,
  onFormat,
  disabled = false,
  className,
}: ConfigPreviewPanelProps) {
  const [view, setView] = useState<View>("form");
  const [showDiff, setShowDiff] = useState(false);
  const [copied, setCopied] = useState(false);
  const config = useMemo(() => readConfig(state.yaml), [state.yaml]);
  const changed = useMemo(() => new Set(state.changed), [state.changed]);
  const text = displayText(state);
  const formatLabel = state.format === "json" ? "JSON" : "YAML";
  const hasDraft = state.yaml !== null;
  const canDiff = state.previous !== null && state.yaml !== null && state.previous !== state.yaml;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* буфер недоступен: кнопка остаётся прежней */
    }
  }

  return (
    <section
      aria-labelledby="describe-config-title"
      className={cn("flex min-h-0 w-full flex-col rounded-xl border border-ddc-border bg-ddc-surface lg:w-[617px]", className)}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-ddc-border px-3 py-2">
        <h2 id="describe-config-title" className="mr-auto text-sm font-semibold text-ddc-heading">
          Конфигурация агента
        </h2>
        <div role="tablist" aria-label="Вид конфигурации" className="flex gap-1">
          {(
            [
              ["form", "Форма"],
              ["text", formatLabel],
            ] as const
          ).map(([id, label]) => (
            <PlainButton
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={cn(
                "h-8 rounded-lg px-2.5 text-xs font-medium",
                view === id ? "bg-ddc-selected-bg text-ddc-selected-text" : "text-ddc-ghost-text hover:bg-ddc-ghost-hover",
              )}
            >
              {label}
            </PlainButton>
          ))}
        </div>
        <NativeSelect
          aria-label="Формат"
          value={state.format}
          disabled={!hasDraft}
          onChange={(e) => onFormat(e.target.value === "json" ? "json" : "yaml")}
          className="h-8 rounded-lg border border-ddc-border-strong bg-ddc-outline-bg px-1.5 text-xs text-ddc-text"
        >
          <option value="yaml">YAML</option>
          <option value="json">JSON</option>
        </NativeSelect>
        <Button type="button" variant="outline" size="sm" disabled={!hasDraft} onClick={() => void copy()}>
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied ? "Скопировано" : "Копировать"}
        </Button>
      </header>

      {hasDraft ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ddc-border px-3 py-1.5 text-xs">
          {state.changed.length > 0 ? (
            <span className="text-ddc-text">{`Изменилось: ${state.changed.join(", ")}`}</span>
          ) : null}
          <PlainButton
            type="button"
            role="switch"
            aria-checked={showDiff && canDiff}
            aria-label="Показать разницу"
            disabled={!canDiff}
            onClick={() => setShowDiff((v) => !v)}
            className="ml-auto flex items-center gap-1.5 text-ddc-text disabled:text-ddc-text-muted"
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-4 w-7 items-center rounded-full border border-ddc-border-strong p-0.5",
                showDiff && canDiff ? "justify-end bg-ddc-primary-bg" : "justify-start bg-ddc-surface-muted",
              )}
            >
              <span className="size-2.5 rounded-full bg-ddc-surface" />
            </span>
            Показать разницу
          </PlainButton>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!hasDraft ? (
          <p className="text-sm text-ddc-text-muted">
            Черновик появится, когда ассистент соберёт конфигурацию. Её можно будет править руками.
          </p>
        ) : showDiff && canDiff ? (
          <YamlDiffView before={state.previous} after={state.yaml} />
        ) : view === "form" ? (
          config ? (
            <FormView config={config} changed={changed} disabled={disabled} onField={onField} />
          ) : (
            <p className="text-sm text-ddc-text-muted">Форма недоступна, пока текст конфигурации не читается. Исправьте его во вкладке с текстом.</p>
          )
        ) : (
          <Textarea
            aria-label="Конфигурация в виде текста"
            spellCheck={false}
            rows={22}
            value={text}
            disabled={disabled}
            onChange={(e) => onEdit(e.target.value)}
            className="font-mono text-xs leading-5"
          />
        )}

        {state.warnings.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1">
            {state.warnings.map((w) => (
              <li key={w} className="callout-warning text-xs">
                {w}
              </li>
            ))}
          </ul>
        ) : null}
        {error && hasDraft ? (
          <p className="mt-3 text-xs font-medium text-ddc-danger-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
