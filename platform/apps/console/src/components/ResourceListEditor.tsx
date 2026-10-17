import { useState } from "react";
import { useFieldArray, type UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { EyeIcon, EyeOffIcon, PlusIcon } from "lucide-react";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlainButton } from "@/components/ui/plain-button";

import { Select, SelectOption } from "./Select";

/**
 * Редактор ресурсов сессии и деплоймента: репозитории GitHub, файлы и
 * хранилища памяти. Вынесен из SessionsList, чтобы форма деплоймента
 * (docs/plans/crud.md, 4.1) показывала те же поля. Форму ведёт
 * react-hook-form страницы, редактор читает и меняет её поле `resources`.
 */

// ────────────────────────────────────────────────────────────────────────
// Схема строки ресурса (zod)
// ────────────────────────────────────────────────────────────────────────

/** GitHub repo resource. URL + token are required; the rest are optional
 *  knobs that submit() either passes through or computes a sensible
 *  default for (mount_path → /workspace/<repo-name>). */
export const GithubResourceSchema = z.object({
  kind: z.literal("github"),
  url: z.string().min(1, "Укажите адрес репозитория"),
  token: z.string().min(1, "Укажите токен доступа"),
  checkout_type: z.enum(["none", "branch", "commit"]),
  checkout_name: z.string(),
  mount_path: z.string(),
});

const FileResourceSchema = z.object({
  kind: z.literal("file"),
  file_id: z.string(),
  mount_path: z.string(),
});

const MemoryStoreResourceSchema = z.object({
  kind: z.literal("memory_store"),
  memory_store_id: z.string(),
  access: z.enum(["read_write", "read_only"]),
});

/** Discriminated union — `kind` selects which fields apply. Mapped to the
 *  wire `{type, ...}` resource object at submit time (see `onSubmit`). */
export const ResourceSchema = z.discriminatedUnion("kind", [
  GithubResourceSchema,
  FileResourceSchema,
  MemoryStoreResourceSchema,
]);

export type ResourceRow = z.infer<typeof ResourceSchema>;

export interface ResourceFormValues {
  resources: ResourceRow[];
}

export function blankResource(kind: ResourceRow["kind"]): ResourceRow {
  switch (kind) {
    case "github": return { kind, url: "", token: "", checkout_type: "none", checkout_name: "", mount_path: "" };
    case "file": return { kind, file_id: "", mount_path: "" };
    case "memory_store": return { kind, memory_store_id: "", access: "read_write" };
  }
}

function kindLabel(kind: ResourceRow["kind"]): string {
  switch (kind) {
    case "github": return "Репозиторий GitHub";
    case "file": return "Файл";
    case "memory_store": return "Хранилище памяти";
  }
}

/** Best-effort `<repo-name>` extraction from GitHub URL forms. Used to
 *  derive the default mount path /workspace/<repo-name>. Returns null when
 *  the URL doesn't look like GitHub (caller falls back to /workspace). */
function parseGitHubRepoName(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  if (!trimmed) return null;
  // Full URL: https://github.com/owner/repo
  try {
    const u = new URL(trimmed);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    return parts[1] || null;
  } catch {
    // SSH: git@github.com:owner/repo
    const ssh = trimmed.match(/^git@github\.com:[^/]+\/([^/]+)$/);
    if (ssh) return ssh[1];
    // Bare: owner/repo
    const bare = trimmed.match(/^[^/]+\/([^/]+)$/);
    if (bare) return bare[1];
    return null;
  }
}

export function defaultMountPath(githubUrl: string): string {
  const name = parseGitHubRepoName(githubUrl);
  return name ? `/workspace/${name}` : "/workspace";
}

export type WireResource = NonNullable<SessionCreateParams["resources"]>[number];

/** Строки формы в ресурсы запроса. Неполные строки отбрасываются. */
export function resourcesToWire(rows: ResourceRow[]): WireResource[] {
  const resources: NonNullable<SessionCreateParams["resources"]> = [];
  for (const r of rows) {
    if (r.kind === "github") {
      // Token is required — schema gates the Create button on this,
      // but we double-check so a stale row from a previous validation
      // pass can't slip through.
      if (!r.url || !r.token) continue;
      const res: NonNullable<SessionCreateParams["resources"]>[number] = {
        type: "github_repository",
        url: r.url,
        authorization_token: r.token,
        // Always send mount_path: derive /workspace/<repo-name> from the
        // URL when the user left it blank. Mirrors the in-form preview.
        mount_path: r.mount_path || defaultMountPath(r.url),
      };
      if (r.checkout_type === "branch" && r.checkout_name) {
        res.checkout = { type: "branch", name: r.checkout_name };
      } else if (r.checkout_type === "commit" && r.checkout_name) {
        res.checkout = { type: "commit", sha: r.checkout_name };
      }
      resources.push(res);
    } else if (r.kind === "file") {
      if (!r.file_id) continue;
      const res: NonNullable<SessionCreateParams["resources"]>[number] = {
        type: "file",
        file_id: r.file_id,
      };
      if (r.mount_path) res.mount_path = r.mount_path;
      resources.push(res);
    } else if (r.kind === "memory_store") {
      if (!r.memory_store_id) continue;
      const res: NonNullable<SessionCreateParams["resources"]>[number] = {
        type: "memory_store",
        memory_store_id: r.memory_store_id,
        access: r.access,
      };
      resources.push(res);
    }
  }
  return resources;
}

export interface FilePick {
  id: string;
  filename: string;
  size_bytes?: number;
}

export interface MemoryStorePick {
  id: string;
  name: string;
}

interface ResourceListEditorProps {
  /** Форма страницы. Нужно поле `resources`; остальные поля редактор не трогает. */
  form: UseFormReturn<any>;
  files: FilePick[];
  memoryStores: MemoryStorePick[];
}

export function ResourceListEditor({ form: anyForm, files, memoryStores }: ResourceListEditorProps) {
  const form = anyForm as UseFormReturn<ResourceFormValues>;
  const { control, register, setValue, watch, formState } = form;
  const { fields: resourceFields, append: appendResource, remove: removeResourceAt } = useFieldArray({
    control,
    name: "resources",
  });
  const watchedResources = watch("resources");

  // Per-field reveal toggle for any masked input (github token). Keyed by
  // `${idx}:${field}`. Adding or removing a row clears the set.
  const [revealedSecrets, setRevealedSecrets] = useState<Set<string>>(new Set());
  const toggleReveal = (key: string) =>
    setRevealedSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const addResource = (kind: ResourceRow["kind"]) => {
    appendResource(blankResource(kind));
    setRevealedSecrets(new Set());
  };
  const removeResource = (idx: number) => {
    removeResourceAt(idx);
    setRevealedSecrets(new Set());
  };

  // First github row index + total count, computed once per render so the
  // "primary" pill on the first GitHub row stays in sync with reorders.
  // The proxy resolver uses the first declared github_repository's token
  // for any request whose URL doesn't carry an owner/repo slug (graphql,
  // /user, /search, …). Only show the hint when there are 2+ github
  // resources — for a single repo the "first" semantics aren't meaningful.
  const githubIdxs = resourceFields
    .map((r, i) => (r.kind === "github" ? i : -1))
    .filter((i) => i >= 0);
  const firstGithubIdx = githubIdxs[0] ?? -1;
  const showPrimaryHint = githubIdxs.length > 1;

  // Show validation errors only after the field has been touched (or after
  // submit), so the form doesn't render with errors visible on first open.
  const showError = (touched: boolean | undefined, msg: string | undefined) =>
    msg && (touched || formState.isSubmitted) ? msg : undefined;

  // Resource row error / touched lookups. The schema's discriminated union
  // means TypeScript narrows `formState.errors.resources[i]` to the
  // intersection of all variants — i.e. nothing — so accessing per-kind
  // fields like `.url` requires a runtime-friendly cast. Same for
  // touchedFields. Both helpers return undefined when nothing matches so
  // callers can compose with `showError` cleanly.
  const resourceFieldError = (idx: number, key: string): string | undefined => {
    const row = formState.errors.resources?.[idx] as
      | Record<string, { message?: string } | undefined>
      | undefined;
    return row?.[key]?.message;
  };
  const resourceFieldTouched = (idx: number, key: string): boolean => {
    const row = formState.touchedFields.resources?.[idx] as
      | Record<string, boolean | undefined>
      | undefined;
    return !!row?.[key];
  };

  return (
    <div>
      <Label className="mb-1.5 flex text-xs leading-4 font-medium text-ddc-label">
        Ресурсы <span className="font-normal text-ddc-text-muted">(необязательно)</span>
      </Label>
      <p className="mb-3 text-xs leading-4 text-ddc-text-muted">
        Подключите к сессии файлы, репозитории GitHub и хранилища памяти.
      </p>
      {resourceFields.length === 0 ? (
        <div className="rounded-xl border border-dashed border-ddc-border-strong px-3 py-4 text-center text-xs leading-4 text-ddc-text-muted">
          Ресурсы не добавлены.
        </div>
      ) : (
        <div className="space-y-3">
          {resourceFields.map((field, i) => {
            // Live values for the current row — register() drives
            // input state, but conditional rendering (kind-specific
            // blocks, mount-path placeholder, reveal toggles) reads
            // the watched copy so changes reflect immediately.
            const live = watchedResources[i];
            if (!live) return null;
            return (
              <div key={field.id} className="rounded-xl bg-ddc-surface-muted p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-ddc-heading">
                    <span className="truncate" title={kindLabel(live.kind)}>{kindLabel(live.kind)}</span>
                    {showPrimaryHint && live.kind === "github" && i === firstGithubIdx && (
                      <Badge
                        variant="brand"
                        title="Токен этого репозитория используется для вызовов GitHub API без указания репозитория (GraphQL, Search, /user и другие)"
                      >
                        основной
                      </Badge>
                    )}
                  </span>
                  <Button
                    variant="danger-ghost"
                    size="xs"
                    type="button"
                    onClick={() => removeResource(i)}
                    aria-label="Убрать ресурс"
                  >
                    Убрать
                  </Button>
                </div>
                {live.kind === "github" && (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor={`session-resource-${i}-url`} className="mb-1.5 flex text-xs leading-4 font-medium text-ddc-label">
                        Адрес репозитория <span className="text-error">*</span>
                      </Label>
                      <Input
                        id={`session-resource-${i}-url`}
                        {...register(`resources.${i}.url`)}
                        aria-invalid={
                          showError(
                            resourceFieldTouched(i, "url"),
                            resourceFieldError(i, "url"),
                          )
                            ? true
                            : undefined
                        }
                        placeholder="https://github.com/owner/repo"
                      />
                      {showError(
                        resourceFieldTouched(i, "url"),
                        resourceFieldError(i, "url"),
                      ) && (
                        <p className="mt-1.5 text-xs leading-4 text-error">
                          {resourceFieldError(i, "url")}
                        </p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor={`session-resource-${i}-token`} className="mb-1.5 flex text-xs leading-4 font-medium text-ddc-label">
                        Токен доступа <span className="text-error">*</span>
                      </Label>
                      <div className="relative">
                        <Input
                          id={`session-resource-${i}-token`}
                          type={revealedSecrets.has(`${i}:token`) ? "text" : "password"}
                          {...register(`resources.${i}.token`)}
                          aria-invalid={
                            showError(
                              resourceFieldTouched(i, "token"),
                              resourceFieldError(i, "token"),
                            )
                              ? true
                              : undefined
                          }
                          className="pr-11"
                          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                        />
                        {live.token && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            type="button"
                            onClick={() => toggleReveal(`${i}:token`)}
                            className="absolute inset-y-0 right-1.5 my-auto text-ddc-icon-muted hover:text-ddc-text"
                            aria-label={
                              revealedSecrets.has(`${i}:token`) ? "Скрыть токен" : "Показать токен"
                            }
                            title={revealedSecrets.has(`${i}:token`) ? "Скрыть токен" : "Показать токен"}
                          >
                            {revealedSecrets.has(`${i}:token`) ? <EyeOffIcon /> : <EyeIcon />}
                          </Button>
                        )}
                      </div>
                      {showError(
                        resourceFieldTouched(i, "token"),
                        resourceFieldError(i, "token"),
                      ) && (
                        <p className="mt-1.5 text-xs leading-4 text-error">
                          {resourceFieldError(i, "token")}
                        </p>
                      )}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <Label htmlFor={`session-resource-${i}-checkout-type`} className="mb-1.5 flex text-xs leading-4 font-medium text-ddc-label">Версия кода</Label>
                        <Select
                          id={`session-resource-${i}-checkout-type`}
                          name={`resources.${i}.checkout_type`}
                          value={live.checkout_type}
                          onValueChange={(value) => {
                            setValue(
                              `resources.${i}.checkout_type`,
                              value as "none" | "branch" | "commit",
                              { shouldDirty: true, shouldTouch: true, shouldValidate: true },
                            );
                            // Switching the checkout kind clears the
                            // companion name so the placeholder hint
                            // doesn't lie about commit-vs-branch.
                            setValue(`resources.${i}.checkout_name`, "");
                          }}
                        >
                          <SelectOption value="none">По умолчанию</SelectOption>
                          <SelectOption value="branch">Ветка</SelectOption>
                          <SelectOption value="commit">Коммит</SelectOption>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor={`session-resource-${i}-checkout-name`} className="mb-1.5 flex text-xs leading-4 font-medium text-ddc-label">
                          {live.checkout_type === "commit" ? "Хеш коммита" : "Название ветки"}
                        </Label>
                        <Input
                          id={`session-resource-${i}-checkout-name`}
                          {...register(`resources.${i}.checkout_name`)}
                          disabled={live.checkout_type === "none"}
                          placeholder={live.checkout_type === "commit" ? "abc123…" : "main"}
                        />
                      </div>
                    </div>
                    <div>
                      <Label htmlFor={`session-resource-${i}-mount`} className="mb-1.5 flex text-xs leading-4 font-medium text-ddc-label">
                        Путь монтирования <span className="font-normal text-ddc-text-muted">(необязательно)</span>
                      </Label>
                      <Input
                        id={`session-resource-${i}-mount`}
                        {...register(`resources.${i}.mount_path`)}
                        placeholder={`${defaultMountPath(live.url)} (по умолчанию)`}
                      />
                    </div>
                  </div>
                )}
                {live.kind === "file" && (
                  <div className="space-y-3">
                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <Label htmlFor={`session-resource-${i}-file`} className="text-xs leading-4 font-medium text-ddc-label">
                          Файл <span className="text-error">*</span>
                        </Label>
                        <a href="/files" className="link text-xs">Управление файлами</a>
                      </div>
                      <Select
                        id={`session-resource-${i}-file`}
                        name={`resources.${i}.file_id`}
                        value={live.file_id}
                        onValueChange={(value) =>
                          setValue(`resources.${i}.file_id`, value, {
                            shouldDirty: true,
                            shouldTouch: true,
                            shouldValidate: true,
                          })
                        }
                        placeholder="Выберите файл…"
                      >
                        {files.map((f) => (
                          <SelectOption key={f.id} value={f.id}>
                            {f.filename} ({f.id})
                          </SelectOption>
                        ))}
                      </Select>
                      {files.length === 0 && (
                        <p className="mt-1.5 text-xs leading-4 text-ddc-text-muted">
                          Файлов пока нет. Загрузите файл через SDK или запрос POST /v1/files.
                        </p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor={`session-resource-${i}-file-mount`} className="mb-1.5 flex text-xs leading-4 font-medium text-ddc-label">
                        Путь монтирования <span className="font-normal text-ddc-text-muted">(необязательно)</span>
                      </Label>
                      <Input
                        id={`session-resource-${i}-file-mount`}
                        {...register(`resources.${i}.mount_path`)}
                        placeholder="/mnt/session/uploads/<id файла> (по умолчанию)"
                      />
                    </div>
                  </div>
                )}
                {live.kind === "memory_store" && (
                  <div className="space-y-3">
                    <div>
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <Label htmlFor={`session-resource-${i}-store`} className="text-xs leading-4 font-medium text-ddc-label">
                          Хранилище <span className="text-error">*</span>
                        </Label>
                        <a href="/memory" className="link text-xs">Управление хранилищами</a>
                      </div>
                      <Select
                        id={`session-resource-${i}-store`}
                        name={`resources.${i}.memory_store_id`}
                        value={live.memory_store_id}
                        onValueChange={(value) =>
                          setValue(`resources.${i}.memory_store_id`, value, {
                            shouldDirty: true,
                            shouldTouch: true,
                            shouldValidate: true,
                          })
                        }
                        placeholder="Выберите хранилище…"
                      >
                        {memoryStores.map((m) => (
                          <SelectOption key={m.id} value={m.id}>
                            {m.name} ({m.id})
                          </SelectOption>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor={`session-resource-${i}-access`} className="mb-1.5 flex text-xs leading-4 font-medium text-ddc-label">Доступ</Label>
                      <Select
                        id={`session-resource-${i}-access`}
                        name={`resources.${i}.access`}
                        value={live.access}
                        onValueChange={(value) =>
                          setValue(
                            `resources.${i}.access`,
                            value as "read_write" | "read_only",
                            { shouldDirty: true, shouldTouch: true, shouldValidate: true },
                          )
                        }
                      >
                        <SelectOption value="read_write">Чтение и запись</SelectOption>
                        <SelectOption value="read_only">Только чтение</SelectOption>
                      </Select>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <PlainButton type="button" className="btn-add min-h-8" onClick={() => addResource("github")}>
          <PlusIcon aria-hidden="true" />
          Репозиторий GitHub
        </PlainButton>
        <PlainButton type="button" className="btn-add min-h-8" onClick={() => addResource("file")}>
          <PlusIcon aria-hidden="true" />
          Файл
        </PlainButton>
        <PlainButton type="button" className="btn-add min-h-8" onClick={() => addResource("memory_store")}>
          <PlusIcon aria-hidden="true" />
          Хранилище памяти
        </PlainButton>
      </div>
    </div>
  );
}
