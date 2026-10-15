// Источники навыков: установка навыков с любого сайта, который публикует
// индекс Agent Skills (протокол `npx skills add <url>`), и их обновление.
// Работает через /v1/oma/skill-sources на собственном управляющем сервере;
// если маршрута нет, консоль прячет эти элементы.

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Modal } from "./Modal";
import { SkeletonRows } from "./Skeleton";
import { plural } from "./knowledge-format";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, getActiveTenantId, useApi } from "../lib/api";

export const SKILL_SOURCES_API = "/v1/oma/skill-sources";

export interface SkillSourceLock {
  skill_id: string;
  source_url: string;
  name: string;
  digest: string;
  version: string;
  installed_at: string;
  updated_at: string;
}

interface DiscoveredSkill {
  name: string;
  description: string;
  digest: string | null;
  installed_skill_id: string | null;
}

type InstallResult =
  | { name: string; status: "installed" | "updated" | "unchanged"; skill_id: string; version: string }
  | { name: string; status: "error"; error: string; skill_id?: string };

interface UpdateCheck {
  sources: { url: string; status: "ok" | "error"; error?: string; new_skills: { name: string; description: string }[] }[];
  skills: {
    skill_id: string;
    name: string;
    source_url: string;
    status: "current" | "update_available" | "removed" | "error";
    error?: string;
  }[];
}

export function sourceLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Записи об отслеживаемых навыках, установленных из источников, по id навыка.
 * `available` равен null, пока идёт проверка, и false, когда на этом
 * развёртывании нет маршрутов источников. Проверка идёт напрямую через fetch,
 * чтобы отсутствующий маршрут не вызывал общий тост об ошибке.
 */
export function useSkillSources() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [locks, setLocks] = useState<Map<string, SkillSourceLock>>(new Map());

  const refresh = useCallback(async () => {
    const tenant = getActiveTenantId();
    try {
      const res = await fetch(`${SKILL_SOURCES_API}/installed`, {
        credentials: "include",
        headers: tenant ? { "x-active-tenant": tenant } : {},
      });
      if (!res.ok) {
        setAvailable(false);
        return;
      }
      const body = (await res.json()) as { data?: SkillSourceLock[] };
      setLocks(new Map((body.data ?? []).map((l) => [l.skill_id, l])));
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { available: available === true, loading: available === null, locks, refresh };
}

const STATUS_TEXT: Record<InstallResult["status"], string> = {
  installed: "Установлен",
  updated: "Обновлён",
  unchanged: "Уже актуален",
  error: "Ошибка",
};

const STATUS_TONE: Record<InstallResult["status"], string> = {
  installed: "tone-success",
  updated: "tone-success",
  unchanged: "tone-neutral",
  error: "tone-danger",
};

function ResultList({ results }: { results: InstallResult[] }) {
  return (
    <ul className="divide-y divide-ddc-divider rounded-xl border border-ddc-border" aria-label="Результаты">
      {results.map((r) => (
        <li key={r.name} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-mono text-ddc-text" title={r.name}>
            {r.name}
          </span>
          <span className="flex flex-none flex-col items-end gap-1 text-right">
            <span className={`chip ${STATUS_TONE[r.status]}`}>{STATUS_TEXT[r.status]}</span>
            {r.status === "error" && <span className="text-xs text-error">{r.error}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Сообщение об ошибке внутри окна: выноска DDC `callout-danger`. */
function ErrorNote({ children }: { children: string }) {
  return (
    <div role="alert" className="callout-danger">
      {children}
    </div>
  );
}

/* ---------- установка по ссылке ---------- */

export function InstallFromUrlModal({
  open,
  onClose,
  onInstalled,
  initialUrl = "",
}: {
  open: boolean;
  onClose: () => void;
  onInstalled: () => void;
  initialUrl?: string;
}) {
  const { api } = useApi();
  const [url, setUrl] = useState(initialUrl);
  const [found, setFound] = useState<{ url: string; skills: DiscoveredSkill[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"discover" | "install" | null>(null);
  const [error, setError] = useState("");
  const [results, setResults] = useState<InstallResult[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setUrl(initialUrl);
    setFound(null);
    setSelected(new Set());
    setError("");
    setResults(null);
  }, [open, initialUrl]);

  const discover = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!url.trim()) return;
    setBusy("discover");
    setError("");
    setResults(null);
    try {
      const body = await api<{ url: string; data: DiscoveredSkill[] }>(`${SKILL_SOURCES_API}/discover`, {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      });
      setFound({ url: body.url, skills: body.data });
      setSelected(new Set(body.data.filter((s) => !s.installed_skill_id).map((s) => s.name)));
    } catch (err) {
      setFound(null);
      setError(
        err instanceof ApiError && err.status === 404
          ? "Индекс навыков по этому адресу не найден. Проверьте ссылку."
          : err instanceof Error
            ? err.message
            : "Не удалось прочитать источник",
      );
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!found || selected.size === 0) return;
    setBusy("install");
    setError("");
    try {
      const body = await api<{ data: InstallResult[] }>(`${SKILL_SOURCES_API}/install`, {
        method: "POST",
        body: JSON.stringify({ url: found.url, skills: [...selected] }),
      });
      setResults(body.data);
      onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось установить навыки");
    } finally {
      setBusy(null);
    }
  };

  const toggle = (name: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const allSelected = !!found && found.skills.length > 0 && selected.size === found.skills.length;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      closeDisabled={!!busy}
      title="Установка навыков по ссылке"
      subtitle="Любой сайт с индексом Agent Skills. Адрес тот же, что вы передали бы в npx skills add."
      maxWidth="max-w-2xl"
      footer={
        results ? (
          <Button onClick={onClose}>Готово</Button>
        ) : (
          <>
            <Button variant="ghost" disabled={!!busy} onClick={onClose}>
              Отмена
            </Button>
            <Button
              onClick={install}
              disabled={!found || selected.size === 0 || !!busy}
              loading={busy === "install"}
            >
              {selected.size > 0 ? `Установить ${selected.size}` : "Установить"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        <form onSubmit={discover} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <Label htmlFor="skill-source-url" className="mb-1.5 block text-xs leading-4 font-medium text-ddc-label">
              Адрес источника
            </Label>
            <Input
              id="skill-source-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://skills.example.com"
              disabled={!!busy || !!results}
              autoFocus
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={!url.trim() || !!busy || !!results}
            loading={busy === "discover"}
          >
            Найти навыки
          </Button>
        </form>

        {error && <ErrorNote>{error}</ErrorNote>}

        {results ? (
          <ResultList results={results} />
        ) : found ? (
          found.skills.length === 0 ? (
            <p className="text-sm text-ddc-text-muted">В этом источнике нет навыков.</p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs text-ddc-text-muted">
                <span className="min-w-0 truncate" title={sourceLabel(found.url)}>
                  Найдено: {found.skills.length} {plural(found.skills.length, "навык", "навыка", "навыков")} ·{" "}
                  {sourceLabel(found.url)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="flex-none"
                  onClick={() => setSelected(allSelected ? new Set() : new Set(found.skills.map((s) => s.name)))}
                >
                  {allSelected ? "Снять выбор" : "Выбрать все"}
                </Button>
              </div>
              <ul className="max-h-80 divide-y divide-ddc-divider overflow-y-auto rounded-xl border border-ddc-border">
                {found.skills.map((s) => (
                  <li key={s.name}>
                    <Label className="flex cursor-pointer items-start gap-3 px-3 py-2 font-normal hover:bg-ddc-surface-muted">
                      <Checkbox
                        className="mt-0.5"
                        checked={selected.has(s.name)}
                        onCheckedChange={(v) => toggle(s.name, v === true)}
                        aria-label={s.name}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm text-ddc-text">{s.name}</span>
                          {s.installed_skill_id && <span className="chip tone-neutral">Установлен</span>}
                        </span>
                        <span className="block text-xs text-ddc-text-muted">{s.description}</span>
                      </span>
                    </Label>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-ddc-text-muted">
                Повторная установка добавляет новую версию, только если содержимое навыка изменилось.
              </p>
            </div>
          )
        ) : null}
      </div>
    </Modal>
  );
}

/* ---------- проверка обновлений ---------- */

const CHECK_TEXT: Record<UpdateCheck["skills"][number]["status"], string> = {
  current: "Актуален",
  update_available: "Есть обновление",
  removed: "Удалён из источника",
  error: "Проверка не удалась",
};

const CHECK_TONE: Record<UpdateCheck["skills"][number]["status"], string> = {
  current: "tone-neutral",
  update_available: "tone-warning",
  removed: "tone-danger",
  error: "tone-danger",
};

export function SkillUpdatesModal({
  open,
  onClose,
  onUpdated,
  onInstallNew,
  skillIds,
}: {
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
  /** Открывает окно установки для источника, где есть ещё не установленные навыки. */
  onInstallNew?: (url: string) => void;
  /** Ограничить проверку этими навыками; если не передано, проверяются все отслеживаемые. */
  skillIds?: string[];
}) {
  const { api } = useApi();
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [results, setResults] = useState<InstallResult[] | null>(null);
  const idsKey = skillIds?.join(",") ?? "";

  const runCheck = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      setCheck(
        await api<UpdateCheck>(`${SKILL_SOURCES_API}/check-updates`, {
          method: "POST",
          body: JSON.stringify(idsKey ? { skill_ids: idsKey.split(",") } : {}),
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось проверить обновления");
    } finally {
      setChecking(false);
    }
  }, [api, idsKey]);

  useEffect(() => {
    if (!open) return;
    setCheck(null);
    setResults(null);
    void runCheck();
  }, [open, runCheck]);

  const pending = useMemo(
    () => (check?.skills ?? []).filter((s) => s.status === "update_available").map((s) => s.skill_id),
    [check],
  );

  const update = async (ids: string[]) => {
    if (ids.length === 0) return;
    setUpdating(ids);
    setError("");
    try {
      const body = await api<{ data: InstallResult[] }>(`${SKILL_SOURCES_API}/update`, {
        method: "POST",
        body: JSON.stringify({ skill_ids: ids }),
      });
      setResults(body.data);
      onUpdated();
      await runCheck();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось обновить навыки");
    } finally {
      setUpdating(null);
    }
  };

  const busy = checking || updating !== null;
  const newSkills = (check?.sources ?? []).filter((s) => s.new_skills.length > 0);

  return (
    <Modal
      open={open}
      onClose={() => {
        if (updating) return;
        onClose();
      }}
      closeDisabled={updating !== null}
      title="Обновления навыков"
      subtitle="Сравнивает установленные навыки с их источниками, как npx skills update."
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" disabled={updating !== null} onClick={onClose}>
            Закрыть
          </Button>
          <Button
            onClick={() => void update(pending)}
            disabled={pending.length === 0 || busy}
            loading={updating !== null && updating.length > 1}
          >
            {pending.length > 0 ? `Обновить все (${pending.length})` : "Обновить все"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorNote>{error}</ErrorNote>}
        {results && results.some((r) => r.status !== "unchanged") && <ResultList results={results} />}
        {!check && checking ? (
          <SkeletonRows count={3} height={48} />
        ) : check && check.skills.length === 0 ? (
          <p className="text-sm text-ddc-text-muted">Навыков, установленных по ссылке, пока нет.</p>
        ) : check ? (
          <ul
            className="divide-y divide-ddc-divider rounded-xl border border-ddc-border"
            aria-label="Навыки из источников"
          >
            {check.skills.map((s) => (
              <li key={s.skill_id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate font-mono text-sm text-ddc-text" title={s.name}>
                    {s.name}
                  </div>
                  <div className="truncate text-xs text-ddc-text-muted" title={s.source_url}>
                    {sourceLabel(s.source_url)}
                  </div>
                </div>
                <div className="flex flex-none items-center gap-2">
                  <span className={`chip ${CHECK_TONE[s.status]}`} title={s.error}>
                    {CHECK_TEXT[s.status]}
                  </span>
                  {s.status === "update_available" && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      loading={updating?.length === 1 && updating[0] === s.skill_id}
                      onClick={() => void update([s.skill_id])}
                      aria-label={`Обновить ${s.name}`}
                    >
                      Обновить
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {newSkills.map((source) => (
          <div key={source.url} className="flex items-center justify-between gap-3 text-xs text-ddc-text-muted">
            <span className="min-w-0">
              Ещё {source.new_skills.length} {plural(source.new_skills.length, "навык", "навыка", "навыков")} в
              источнике {sourceLabel(source.url)}: {source.new_skills.map((s) => s.name).join(", ")}
            </span>
            {onInstallNew && (
              <Button size="xs" variant="outline" className="flex-none" onClick={() => onInstallNew(source.url)}>
                Установить…
              </Button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
