import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMemo, useRef, useState } from "react";
import { PlusIcon, SearchXIcon, TrashIcon, UploadIcon } from "lucide-react";
import type { SkillListResponse } from "@anthropic-ai/sdk/resources/beta/skills/skills";
import type {
  VersionListResponse,
  VersionRetrieveResponse,
} from "@anthropic-ai/sdk/resources/beta/skills/versions";
import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { extractManagedSkillFiles } from "../lib/skill-upload";
import { useI18n } from "../i18n";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { Field } from "../components/Field";
import { Skeleton } from "../components/Skeleton";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatSkillVersion,
} from "../components/knowledge-format";
import {
  InstallFromUrlModal,
  SkillUpdatesModal,
  sourceLabel,
  useSkillSources,
} from "../components/SkillSources";

/* ---------- типы ---------- */

type Skill = SkillListResponse & { name?: string; description?: string };

interface SkillFile {
  filename: string;
  content: string;
  encoding?: "utf8" | "base64";
}

type VersionSummary = VersionListResponse;

type VersionDetail = VersionRetrieveResponse & {
  files: SkillFile[];
};

type SourceValue = "any" | "anthropic" | "custom";

const SOURCE_OPTIONS: { value: SourceValue; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "anthropic", label: "Встроенные" },
  { value: "custom", label: "Пользовательские" },
];

/* ---------- константы ---------- */

// Совпадает с UPLOAD_MAX_BYTES по умолчанию на сервере (apps/main/src/quotas.ts).
// Если сервер настроен на больший лимит, клиентская проверка отсечёт лишнее,
// а сервер всё равно проверит сам. Для необычной настройки это допустимо.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SKILLS_API = "/v1/skills";
const SKILLS_PREVIEW_API = "/v1/oma/skills";

function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

/** Текст ошибки загрузки. Разбор архива уже отдаёт русские сообщения. */
function uploadErrorText(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  return message || "Не удалось загрузить";
}

/* ---------- страница ---------- */

export function SkillsList() {
  const { api } = useApi();
  const managedApi = useManagedApi();
  const { t } = useI18n();

  /* Фильтр на стороне сервера. `source` попадает в skillsParams → запрос
   * перезапускается при смене параметров → список показывает ровно то, что
   * вернул сервер (без разбиения на клиенте по s.source). */
  const [source, setSource] = useState<SourceValue>("any");
  const [search, setSearch] = useState("");
  const skillsParams = useMemo(
    () => (source !== "any" ? { source } : {}),
    [source],
  );

  /* Состояние списка ведёт TanStack Query. `load()` это `refetch`: он
   * обновляет данные в фоне и оставляет прежние строки на экране, пока не
   * придёт новый ответ. */
  const {
    items: skills,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    refresh: refetchSkills,
  } = useInfiniteApiQuery<Skill>(SKILLS_API, { limit: 20, params: skillsParams });
  /* Поиск по загруженным навыкам: название, имя, описание и id. */
  const visibleSkills = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      `${skill.display_title ?? ""}\n${skill.name ?? ""}\n${skill.description ?? ""}\n${skill.id}`
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [search, skills]);
  /* навыки, установленные по ссылке (индекс обнаружения Agent Skills) */
  const skillSources = useSkillSources();
  const [showInstallUrl, setShowInstallUrl] = useState(false);
  const [installUrl, setInstallUrl] = useState("");
  const [updatesFor, setUpdatesFor] = useState<string[] | "all" | null>(null);

  const load = () => {
    void refetchSkills();
    void skillSources.refresh();
  };

  /* окно создания */
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createZip, setCreateZip] = useState<File | null>(null);
  const [createUploading, setCreateUploading] = useState(false);
  const [createDragOver, setCreateDragOver] = useState(false);
  const [createError, setCreateError] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  /* окно навыка */
  const [detail, setDetail] = useState<Skill | null>(null);
  const [detailFiles, setDetailFiles] = useState<SkillFile[]>([]);
  const [detailVersions, setDetailVersions] = useState<VersionSummary[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  /* форма новой версии внутри окна навыка */
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [nvZip, setNvZip] = useState<File | null>(null);
  const [nvUploading, setNvUploading] = useState(false);
  const [nvDragOver, setNvDragOver] = useState(false);
  const [nvError, setNvError] = useState("");
  const nvInputRef = useRef<HTMLInputElement>(null);

  /* подтверждение удаления: из окна навыка или из меню строки */
  const [deleteTarget, setDeleteTarget] = useState<{ skill: Skill; fromDetail: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* ---- создание ---- */

  const resetCreate = () => {
    setCreateTitle("");
    setCreateZip(null);
    setCreateError("");
    setCreateDragOver(false);
    if (createInputRef.current) createInputRef.current.value = "";
  };

  // Проверяем файл сразу и записываем состояние. Возвращает true при успехе,
  // чтобы вызывающий знал, нужно ли сбрасывать состояние зоны перетаскивания.
  const acceptCreateZip = (file: File): boolean => {
    if (!isZipFile(file)) {
      setCreateError(`«${file.name}» не является архивом .zip`);
      return false;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setCreateError(
        `Архив весит ${formatBytes(file.size)}, лимит загрузки ${formatBytes(MAX_UPLOAD_BYTES)}`,
      );
      return false;
    }
    setCreateError("");
    setCreateZip(file);
    return true;
  };

  const doCreate = async () => {
    if (!createZip) return;
    setCreateError("");
    setCreateUploading(true);
    try {
      const files = await extractManagedSkillFiles(createZip);
      await managedApi.skills.create({
        files,
        ...(createTitle.trim() ? { display_title: createTitle.trim() } : {}),
      });
      setShowCreate(false);
      resetCreate();
      load();
    } catch (e) {
      setCreateError(uploadErrorText(e));
    } finally {
      setCreateUploading(false);
    }
  };

  /* ---- окно навыка ---- */

  const openDetail = async (skill: Skill) => {
    setDetail(skill);
    setDetailLoading(true);
    setShowNewVersion(false);
    setNvError("");
    setNvZip(null);
    try {
      if (!skill.latest_version) throw new Error("У навыка нет версий");
      const [versionDetail, versionsRes, preview] = await Promise.all([
        managedApi.skills.versions.retrieve(skill.latest_version, {
          skill_id: skill.id,
        }),
        managedApi.skills.versions.list(skill.id, { limit: 100 }),
        api<Pick<VersionDetail, "files">>(
          `${SKILLS_PREVIEW_API}/${skill.id}/versions/${skill.latest_version}`,
        ).catch(() => ({ files: [] })),
      ]);
      setDetail({
        ...skill,
        name: versionDetail.name,
        description: versionDetail.description,
      });
      setDetailFiles(preview.files || []);
      setDetailVersions(versionsRes.data || []);
    } catch {
      setDetailFiles([]);
      setDetailVersions([]);
    }
    setDetailLoading(false);
  };

  const closeDetail = () => {
    setDetail(null);
    setDetailFiles([]);
    setDetailVersions([]);
    setShowNewVersion(false);
    setNvZip(null);
    setNvError("");
  };

  /* ---- новая версия ---- */

  const startNewVersion = () => {
    setNvError("");
    setNvZip(null);
    setNvDragOver(false);
    if (nvInputRef.current) nvInputRef.current.value = "";
    setShowNewVersion(true);
  };

  const acceptNvZip = (file: File): boolean => {
    if (!isZipFile(file)) {
      setNvError(`«${file.name}» не является архивом .zip`);
      return false;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setNvError(
        `Архив весит ${formatBytes(file.size)}, лимит загрузки ${formatBytes(MAX_UPLOAD_BYTES)}`,
      );
      return false;
    }
    setNvError("");
    setNvZip(file);
    return true;
  };

  const doNewVersion = async () => {
    if (!detail || !nvZip) return;
    setNvError("");
    setNvUploading(true);
    try {
      const files = await extractManagedSkillFiles(nvZip);
      await managedApi.skills.versions.create(detail.id, { files });
      setShowNewVersion(false);
      setNvZip(null);
      /* обновляем и список, и это окно */
      load();
      const refreshed = await managedApi.skills.retrieve(detail.id);
      openDetail(refreshed);
    } catch (e) {
      setNvError(uploadErrorText(e));
    } finally {
      setNvUploading(false);
    }
  };

  /* ---- удаление ---- */

  // Единая точка удаления: подтверждение через ConfirmDialog (правило 11 DDC).
  // Из окна навыка после удаления окно закрывается, из меню строки закрывать нечего.
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await managedApi.skills.delete(deleteTarget.skill.id);
      if (deleteTarget.fromDetail) closeDetail();
      load();
    } catch {
      // Ошибку показывает общий обработчик запросов.
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const deleteName = deleteTarget
    ? deleteTarget.skill.display_title || deleteTarget.skill.name || deleteTarget.skill.id
    : "";

  // Версия в API это метка времени создания (16 цифр). Людям версии нумеруются
  // по порядку создания: v1 самая ранняя.
  const versionOrdinals = useMemo(() => {
    const byAge = [...detailVersions].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return new Map(byAge.map((v, index) => [v.version, index + 1]));
  }, [detailVersions]);

  /* ---- колонки ---- */

  // Описание столбцов TanStack. Одна таблица и для встроенных навыков
  // Anthropic, и для пользовательских: столбец «Источник» их различает.
  // Сортировки по клику и фильтров по столбцам нет: параметр `source` на
  // сервере задаёт чип «Источник».
  const columns = useMemo<ColumnDef<Skill>[]>(
    () => [
      {
        id: "name",
        accessorKey: "display_title",
        header: "Название",
        size: 240,
        meta: { grow: true },
        cell: ({ row }) => {
          const title = row.original.display_title || row.original.name || row.original.id;
          const subtitle =
            row.original.source === "anthropic"
              ? row.original.name || row.original.id
              : row.original.id;
          return (
            <div className="min-w-0">
              <div className="truncate font-medium text-ddc-heading" title={title}>
                {title}
              </div>
              <div className="truncate font-mono text-xs text-ddc-text-muted" title={subtitle}>
                {subtitle}
              </div>
            </div>
          );
        },
        enableHiding: false,
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Описание",
        size: 320,
        meta: { priority: 5 },
        cell: ({ row }) => (
          <span className="block truncate text-ddc-text-muted" title={row.original.description}>
            {row.original.description || "–"}
          </span>
        ),
      },
      {
        id: "source",
        accessorKey: "source",
        header: "Источник",
        size: 180,
        cell: ({ row }) => {
          const tracked = skillSources.locks.get(row.original.id);
          return row.original.source === "anthropic" ? (
            <span className="chip tone-info">Встроенный</span>
          ) : tracked ? (
            <span className="chip tone-neutral max-w-48" title={tracked.source_url}>
              <span className="truncate">{sourceLabel(tracked.source_url)}</span>
            </span>
          ) : (
            <span className="chip tone-neutral">Пользовательский</span>
          );
        },
      },
      {
        id: "version",
        accessorFn: (s) => s.latest_version,
        header: "Версия",
        size: 150,
        meta: { priority: 3 },
        cell: ({ row }) => (
          <span className="text-ddc-text-muted tabular-nums">
            {formatSkillVersion(row.original.latest_version)}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (s) => s.created_at,
        header: t.common.created,
        size: 120,
        meta: { priority: 1 },
        cell: ({ row }) => (
          <span className="text-ddc-text-muted tabular-nums">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [skillSources.locks],
  );

  // Подпись активного фильтра остаётся пустой, пока выбрано значение по
  // умолчанию: чип читается «Источник ▾», а не «Источник: Все ▾». Крестик
  // сброса виден, только когда фильтр включён.
  const sourceDisplay =
    source === "any" ? undefined : SOURCE_OPTIONS.find((o) => o.value === source)?.label;

  const filters = (
    <FilterChip
      label="Источник"
      active={source !== "any"}
      display={sourceDisplay}
      onClear={() => setSource("any")}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-48 p-0"
      >
        <FacetedFilter
          options={SOURCE_OPTIONS}
          value={source}
          onValueChange={(v) => setSource(v as SourceValue)}
          searchPlaceholder="Найти источник…"
        />
      </PopoverContent>
    </FilterChip>
  );

  const handleRowClick = (s: Skill) => {
    void openDetail(s);
  };

  const filtered = source !== "any" || search.trim() !== "";

  /* ---- разметка ---- */

  return (
    <DataTable<Skill>
      title={t.nav.skills}
      subtitle="Готовые и пользовательские навыки для ваших агентов."
      createLabel={t.skills.newSkill}
      onCreate={() => setShowCreate(true)}
      searchPlaceholder={t.skills.searchSkills}
      searchValue={search}
      onSearchChange={setSearch}
      headerActions={
        skillSources.available ? (
          <>
            {skillSources.locks.size > 0 && (
              <Button variant="outline" onClick={() => setUpdatesFor("all")}>
                Проверить обновления
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                setInstallUrl("");
                setShowInstallUrl(true);
              }}
            >
              Установить по ссылке
            </Button>
          </>
        ) : undefined
      }
      filters={filters}
      data={visibleSkills}
      loading={loading}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      getRowId={(s) => s.id}
      onRowClick={handleRowClick}
      rowActions={(skill) => [
        {
          label: "Удалить",
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          disabled: skill.source === "anthropic",
          onSelect: () => setDeleteTarget({ skill, fromDetail: false }),
        },
      ]}
      columns={columns}
      emptyTitle={filtered ? t.skills.noMatchingSkills : t.skills.noSkillsYet}
      emptyKind="skill"
      emptyIcon={filtered ? <SearchXIcon className="size-6" /> : undefined}
      emptySubtitle={
        filtered
          ? "Измените фильтр по источнику или поисковый запрос."
          : "Создайте навык, чтобы дать агентам знания в нужной области."
      }
      emptyAction={
        filtered ? (
          <Button
            variant="outline"
            onClick={() => {
              setSource("any");
              setSearch("");
            }}
          >
            Сбросить фильтр
          </Button>
        ) : (
          <>
            <Button onClick={() => setShowCreate(true)}><PlusIcon />{t.skills.newSkill}</Button>
            {skillSources.available && (
              <Button variant="outline" onClick={() => setShowInstallUrl(true)}>
                Установить по ссылке
              </Button>
            )}
          </>
        )
      }
    >
      <InstallFromUrlModal
        open={showInstallUrl}
        initialUrl={installUrl}
        onClose={() => setShowInstallUrl(false)}
        onInstalled={load}
      />
      <SkillUpdatesModal
        open={updatesFor !== null}
        skillIds={updatesFor === "all" || updatesFor === null ? undefined : updatesFor}
        onClose={() => setUpdatesFor(null)}
        onUpdated={() => {
          load();
          if (detail) void managedApi.skills.retrieve(detail.id).then(openDetail).catch(() => {});
        }}
        onInstallNew={(url) => {
          setUpdatesFor(null);
          setInstallUrl(url);
          setShowInstallUrl(true);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Удалить навык «${deleteName}»?`}
        message="Действие нельзя отменить."
        confirmLabel="Удалить"
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* ===== Окно создания ===== */}
      <Modal
        open={showCreate}
        onClose={() => {
          if (createUploading) return;
          setShowCreate(false);
          resetCreate();
        }}
        closeDisabled={createUploading}
        title="Загрузка пользовательского навыка"
        subtitle="Загрузите папку навыка в формате Anthropic, упакованную в .zip."
        maxWidth="max-w-lg"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={createUploading}
              onClick={() => {
                setShowCreate(false);
                resetCreate();
              }}
            >
              Отмена
            </Button>
            <Button
              onClick={doCreate}
              disabled={!createZip || createUploading}
              loading={createUploading}
            >
              Загрузить
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createError && (
            <div role="alert" className="callout-danger">
              {createError}
            </div>
          )}

          {/* Зона перетаскивания */}
          <DropZone
            file={createZip}
            dragOver={createDragOver}
            onDragOver={(over) => setCreateDragOver(over)}
            onFile={(f) => acceptCreateZip(f)}
            onClear={() => {
              setCreateZip(null);
              if (createInputRef.current) createInputRef.current.value = "";
            }}
            inputRef={createInputRef}
            disabled={createUploading}
          />

          {/* Отображаемое название (необязательная замена) */}
          <Field
            label="Отображаемое название (необязательно)"
            hint={
              <>
                Если оставить пустым, возьмём <code>name</code> из SKILL.md.
              </>
            }
          >
            <Input
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="Оставьте пустым, чтобы взять название из самого навыка"
              disabled={createUploading}
            />
          </Field>

          <p className="text-xs text-ddc-text-muted">
            В архиве должен лежать <code>SKILL.md</code> в корне или одна папка верхнего
            уровня с этим файлом. Так получается после команды{" "}
            <code>zip -r my-skill.zip my-skill</code>.
          </p>
        </div>
      </Modal>

      {/* ===== Окно навыка ===== */}
      <Modal
        open={!!detail}
        onClose={closeDetail}
        title={detail?.display_title || detail?.name || detail?.id || ""}
        subtitle={detail ? `${detail.id} · ${formatSkillVersion(detail.latest_version)}` : ""}
        maxWidth="max-w-2xl"
        footer={
          <>
            <Button
              variant="danger-ghost"
              className="sm:mr-auto"
              disabled={!detail || detailLoading}
              onClick={() => detail && setDeleteTarget({ skill: detail, fromDetail: true })}
            >
              <TrashIcon />
              Удалить
            </Button>
            <Button variant="ghost" onClick={closeDetail}>
              Закрыть
            </Button>
          </>
        }
      >
        {detailLoading ? (
          <div aria-busy="true" className="space-y-4">
            <span className="sr-only">Загрузка…</span>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
            <Skeleton className="h-16" />
            <Skeleton className="h-24" />
          </div>
        ) : detail ? (
          <div className="space-y-5">
            {/* Свойства */}
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="label">Отображаемое название</dt>
                <dd className="text-sm font-medium break-words text-ddc-heading">
                  {detail.display_title || "–"}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="label">Название (name)</dt>
                <dd className="font-mono text-sm break-words text-ddc-text">{detail.name || "–"}</dd>
              </div>
              <div className="min-w-0">
                <dt className="label">Описание</dt>
                <dd className="text-sm break-words text-ddc-text-muted">{detail.description || "–"}</dd>
              </div>
              <div className="min-w-0">
                <dt className="label">Создан</dt>
                <dd className="text-sm text-ddc-text-muted tabular-nums">
                  {formatDateTime(detail.created_at)}
                </dd>
              </div>
            </dl>

            {/* Источник (установлен по ссылке) */}
            {skillSources.locks.get(detail.id) && (() => {
              const tracked = skillSources.locks.get(detail.id)!;
              return (
                <div className="space-y-1 rounded-xl border border-ddc-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <Label className="text-xs leading-4 font-medium text-ddc-label">Установлен из</Label>
                    <Button size="xs" variant="outline" onClick={() => setUpdatesFor([detail.id])}>
                      Проверить обновления
                    </Button>
                  </div>
                  <p className="font-mono text-sm break-all text-ddc-text">{tracked.source_url}</p>
                  <p className="text-xs text-ddc-text-muted">
                    <span className="font-mono">{tracked.name}</span> · дайджест{" "}
                    <span className="font-mono" title={tracked.digest}>
                      {tracked.digest.replace(/^sha256:/, "").slice(0, 12)}
                    </span>{" "}
                    · обновлён {formatDateTime(tracked.updated_at)}
                  </p>
                </div>
              );
            })()}

            {/* Подсказка по использованию */}
            <div>
              <div className="label">Как подключить в настройках агента</div>
              <pre className="overflow-x-auto rounded-xl border border-ddc-border bg-ddc-surface-sunken p-3 font-mono text-xs text-ddc-text-muted">
{`"skills": [{ "type": "custom", "skill_id": "${detail.id}", "version": "latest" }]`}
              </pre>
            </div>

            {/* Файлы */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="label mb-0">Файлы ({formatSkillVersion(detail.latest_version)})</div>
                <Button variant="ghost" size="xs" onClick={startNewVersion}>
                  <PlusIcon />
                  Новая версия
                </Button>
              </div>
              {detailFiles.length === 0 ? (
                <p className="text-xs text-ddc-text-muted">В этой версии нет файлов.</p>
              ) : (
                <div className="space-y-2">
                  {detailFiles.map((f, i) => (
                    <div
                      key={i}
                      className="overflow-hidden rounded-xl border border-ddc-border"
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-ddc-divider bg-ddc-surface-muted px-3 py-1.5 font-mono text-xs text-ddc-text-muted">
                        <span className="min-w-0 truncate" title={f.filename}>
                          {f.filename}
                        </span>
                        {f.encoding === "base64" && <span className="chip tone-neutral flex-none">двоичный</span>}
                      </div>
                      {f.encoding === "base64" ? (
                        <p className="px-3 py-2 text-xs text-ddc-text-muted italic">
                          Двоичный файл, предпросмотр недоступен.
                        </p>
                      ) : (
                        <pre className="max-h-60 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ddc-text-muted">
                          {f.content}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Форма новой версии */}
            {showNewVersion && (
              <div className="space-y-3 rounded-xl border border-ddc-border-strong bg-ddc-surface-muted p-4">
                <h3 className="text-sm font-semibold text-ddc-heading">Загрузка новой версии</h3>
                {nvError && (
                  <div role="alert" className="callout-danger">
                    {nvError}
                  </div>
                )}
                <DropZone
                  file={nvZip}
                  dragOver={nvDragOver}
                  onDragOver={(over) => setNvDragOver(over)}
                  onFile={(f) => acceptNvZip(f)}
                  onClear={() => {
                    setNvZip(null);
                    if (nvInputRef.current) nvInputRef.current.value = "";
                  }}
                  inputRef={nvInputRef}
                  disabled={nvUploading}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="ghost"
                    disabled={nvUploading}
                    onClick={() => {
                      setShowNewVersion(false);
                      setNvZip(null);
                      setNvError("");
                    }}
                  >
                    Отмена
                  </Button>
                  <Button
                    onClick={doNewVersion}
                    disabled={!nvZip || nvUploading}
                    loading={nvUploading}
                  >
                    Опубликовать версию
                  </Button>
                </div>
              </div>
            )}

            {/* История версий */}
            <div>
              <div className="label mb-2">История версий</div>
              {detailVersions.length === 0 ? (
                <p className="text-xs text-ddc-text-muted">История версий недоступна.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-ddc-border">
                  <Table className="w-full text-sm">
                    <TableHeader>
                      <TableRow variant="wireless">
                        <TableHead className="px-4 py-2 text-left text-xs font-semibold tracking-wider text-ddc-text-muted uppercase">
                          Версия
                        </TableHead>
                        <TableHead className="px-4 py-2 text-left text-xs font-semibold tracking-wider text-ddc-text-muted uppercase">
                          {t.common.created}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detailVersions.map((v) => (
                        <TableRow key={v.version}>
                          <TableCell className="px-4 py-2 text-xs tabular-nums">
                            {versionOrdinals.get(v.version)
                              ? `v${versionOrdinals.get(v.version)}`
                              : formatSkillVersion(v.version)}
                            {v.version === detail.latest_version && (
                              <span className="chip tone-success ml-2">Последняя</span>
                            )}
                          </TableCell>
                          <TableCell className="px-4 py-2 text-xs text-ddc-text-muted tabular-nums">
                            {formatDateTime(v.created_at)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </DataTable>
  );
}

/* ---------- DropZone ---------- */

interface DropZoneProps {
  file: File | null;
  dragOver: boolean;
  onDragOver: (over: boolean) => void;
  onFile: (file: File) => boolean;
  onClear: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}

function DropZone({
  file,
  dragOver,
  onDragOver,
  onFile,
  onClear,
  inputRef,
  disabled,
}: DropZoneProps) {
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    onDragOver(false);
    if (disabled) return;
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) onDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        onDragOver(false);
      }}
      onDrop={handleDrop}
      className={[
        "rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors duration-150",
        dragOver
          ? "border-ddc-ring bg-ddc-selected-bg"
          : "border-ddc-border-strong bg-ddc-surface-muted",
        disabled ? "pointer-events-none opacity-60" : "",
      ].join(" ")}
    >
      <Input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        aria-label="Архив навыка (.zip)"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {file ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 text-left">
            <div className="truncate text-sm font-medium text-ddc-heading" title={file.name}>
              {file.name}
            </div>
            <div className="text-xs text-ddc-text-muted tabular-nums">{formatBytes(file.size)}</div>
          </div>
          <div className="flex flex-none gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => inputRef.current?.click()}
            >
              Заменить
            </Button>
            <Button variant="ghost" size="xs" onClick={onClear}>
              Убрать
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <UploadIcon className="size-5 text-ddc-icon-muted" aria-hidden="true" />
          <div className="text-sm text-ddc-text-muted">
            Перетащите архив <code>.zip</code> сюда или
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
          >
            Выберите файл
          </Button>
        </div>
      )}
    </div>
  );
}
