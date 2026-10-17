import { Table, TableCaption, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FileTextIcon,
  FolderIcon,
  PlusIcon,
  SearchXIcon,
  TrashIcon,
} from "lucide-react";
import { useApiQuery, useInfiniteApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import type { BetaManagedAgentsMemoryStore } from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores";
import type {
  BetaManagedAgentsMemory,
  BetaManagedAgentsMemoryListItem,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memories";
import type {
  BetaManagedAgentsActor,
  BetaManagedAgentsMemoryVersion,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DangerDialog } from "../components/DangerDialog";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { LoadError } from "../components/LoadError";
import { PageHeader } from "../components/PageHeader";
import { useCrumbName } from "../lib/crumb-names";
import { Skeleton } from "../components/Skeleton";
import { formatBytes, formatDate, formatDateTime } from "../components/knowledge-format";
import { Button } from "@/components/ui/button";
import { PlainButton } from "@/components/ui/plain-button";
import { useI18n } from "../i18n";

type MemoryStore = BetaManagedAgentsMemoryStore;
type MemoryListItem = BetaManagedAgentsMemoryListItem;
type Memory = BetaManagedAgentsMemory;
type MemoryVersion = BetaManagedAgentsMemoryVersion;

type TabKey = "memories" | "versions" | "settings";

const TABS: { key: TabKey; label: string }[] = [
  { key: "memories", label: "Записи" },
  { key: "versions", label: "История версий" },
  { key: "settings", label: "Настройки" },
];

// Вторичные столбцы прячутся на узких экранах (правило 13 DDC).
const HIDE_SM = "hidden sm:table-cell";
const HIDE_MD = "hidden md:table-cell";
const HIDE_LG = "hidden lg:table-cell";

// Таблицы страницы живут в карточке. Правило min-width в console-pages.css не
// лежит в слое, поэтому перебить его можно только важным модификатором.
const PAGE_TABLE = "console-detail-table min-w-0! md:min-w-[560px]!";

// Строка, по которой можно кликнуть: подсветка идёт по ячейкам, потому что
// фон ячеек задан правилом console-pages.css вне слоя.
const CLICKABLE_ROW = "cursor-pointer [&:hover>td]:bg-ddc-surface-muted!";

export function MemoryStoreDetail() {
  const { id: storeId } = useParams<{ id: string }>();
  const nav = useNavigate();
  const managedApi = useManagedApi();
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const [tab, setTab] = useState<TabKey>("memories");
  const [error, setError] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<"archive" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const tablistRef = useRef<HTMLDivElement>(null);

  // Запрос самого хранилища через TanStack Query. Две дочерние панели
  // делают свои запросы: этот только открывает страницу и наполняет шапку.
  const {
    data: store,
    error: storeError,
    refetch,
    isFetching,
  } = useApiQuery<MemoryStore>(storeId ? `/v1/memory_stores/${storeId}` : null);
  const loadError = storeError ? errMsg(storeError) : null;
  useCrumbName(storeId, store?.name);

  // «В архив» и «Удалить» живут здесь: строки списка не несут действий над
  // самим хранилищем, как и в шапке AgentDetail.
  // Архив и удаление идут через DangerDialog: он читает зависимости, берёт
  // ETag хранилища для If-Match и показывает список при ответе 409.
  const unarchive = async () => {
    if (!storeId) return;
    setBusy(true);
    try {
      await managedApi.memoryStores.unarchive(storeId);
      void queryClient.invalidateQueries({ queryKey: [`/v1/memory_stores/${storeId}`] });
      void queryClient.invalidateQueries({ queryKey: ["/v1/memory_stores"] });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // Стрелки, Home и End переключают вкладки: неактивная вкладка не стоит в
  // порядке Tab (tabIndex -1), поэтому без этого до неё не добраться.
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((item) => item.key === tab);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(TABS[next].key);
    requestAnimationFrame(() => {
      tablistRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  };

  if (!storeId) {
    return (
      <div className="console-detail-page">
        <EmptyState
          kind="memory"
          title="Хранилище не указано"
          body="В адресе страницы нет идентификатора хранилища памяти."
          action={
            <Button variant="outline" onClick={() => nav("/memory")}>
              К хранилищам
            </Button>
          }
        />
      </div>
    );
  }

  if (!store && loadError) {
    return (
      <div className="console-detail-page">
        <LoadError
          title="Не удалось загрузить хранилище"
          message={loadError}
          retrying={isFetching}
          onRetry={() => void refetch()}
          extra={
            <Button variant="ghost" onClick={() => nav("/memory")}>
              К хранилищам
            </Button>
          }
        />
      </div>
    );
  }

  if (!store) return <DetailSkeleton />;

  return (
    <Page
      header={
        <PageHeader
          title={store.name}
          description={
            store.description || store.archived_at ? (
              <>
                {store.description && <span>{store.description}</span>}
                {store.archived_at && (
                  <span className="block text-ddc-text-muted">
                    В архиве с {formatDate(store.archived_at)}
                  </span>
                )}
              </>
            ) : undefined
          }
          actions={
            <>
              {store.archived_at ? (
                <Button
                  variant="outline"
                  onClick={() => void unarchive()}
                  disabled={busy}
                  aria-label={t.common.unarchive}
                  title={t.common.unarchive}
                >
                  <ArchiveRestoreIcon />
                  <span className="hidden sm:inline">{t.common.unarchive}</span>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => setConfirmKind("archive")}
                  aria-label={t.common.archive}
                  title={t.common.archive}
                >
                  <ArchiveIcon />
                  <span className="hidden sm:inline">{t.common.archive}</span>
                </Button>
              )}
              <Button
                variant="danger-ghost"
                onClick={() => setConfirmKind("delete")}
                aria-label={t.common.delete}
                title={t.common.delete}
              >
                <TrashIcon />
                <span className="hidden sm:inline">{t.common.delete}</span>
              </Button>
            </>
          }
        />
      }
    >
      <div className="space-y-6">
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Разделы хранилища памяти"
          className="tabs"
          onKeyDown={onTabKeyDown}
        >
          {TABS.map((item) => (
            <PlainButton
              key={item.key}
              id={`memory-tab-${item.key}`}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              aria-controls="memory-tabpanel"
              tabIndex={tab === item.key ? 0 : -1}
              className="tab"
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </PlainButton>
          ))}
        </div>

        <div
          id="memory-tabpanel"
          role="tabpanel"
          aria-labelledby={`memory-tab-${tab}`}
          className="space-y-4"
        >
          {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
          {tab === "memories" && (
            <MemoriesPanel storeId={storeId} archived={!!store.archived_at} />
          )}
          {tab === "versions" && <VersionsPanel storeId={storeId} />}
          {tab === "settings" && (
            <SettingsPanel
              store={store}
              archived={!!store.archived_at}
              onUpdated={() => {
                if (!storeId) return;
                void queryClient.invalidateQueries({
                  queryKey: [`/v1/memory_stores/${storeId}`],
                });
                void queryClient.invalidateQueries({ queryKey: ["/v1/memory_stores"] });
              }}
            />
          )}
        </div>
      </div>

      <DangerDialog
        open={confirmKind === "archive"}
        operation="archive"
        target={storeId ? { kind: "memory_store", id: storeId } : null}
        etagPath={storeId ? `/v1/memory_stores/${storeId}` : undefined}
        title="Отправить хранилище памяти в архив?"
        message="Хранилище станет доступным только для чтения, новые сессии не смогут его подключить."
        confirmLabel={t.common.archive}
        run={(options) => managedApi.memoryStores.archive(storeId!, options)}
        onDone={() => nav("/memory")}
        onClose={() => setConfirmKind(null)}
      />
      <DangerDialog
        open={confirmKind === "delete"}
        operation="delete"
        target={storeId ? { kind: "memory_store", id: storeId } : null}
        etagPath={storeId ? `/v1/memory_stores/${storeId}` : undefined}
        title="Удалить хранилище?"
        message="Хранилище, все его записи и история версий будут удалены."
        run={(options) => managedApi.memoryStores.delete(storeId!, options)}
        onDone={() => nav("/memory")}
        onClose={() => setConfirmKind(null)}
      />
    </Page>
  );
}

/** Скелетон страницы: повторяет шапку, вкладки и карточку с таблицей. */
function DetailSkeleton() {
  return (
    <div className="console-detail-page" aria-busy="true">
      <span className="sr-only">Загрузка…</span>
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-[46px] w-72" rounded="lg" />
        <div className="card space-y-3 p-5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      </div>
    </div>
  );
}

// =================================================================
// Вкладка «Записи»: список, создание, просмотр, правка, удаление
// =================================================================

function MemoriesPanel({ storeId, archived }: { storeId: string; archived: boolean }) {
  const managedApi = useManagedApi();
  const [error, setError] = useState<string | null>(null);
  const [pathPrefix, setPathPrefix] = useState("");
  const [depth, setDepth] = useState("");
  const [showWrite, setShowWrite] = useState(false);
  const [open, setOpen] = useState<Memory | null>(null);

  // Ключ запроса в TanStack Query зависит от (path, params), поэтому смена
  // pathPrefix или depth даёт новый слот кэша и перезапрос сама собой.
  const params = {
    path_prefix: pathPrefix || undefined,
    depth: depth || undefined,
  };
  const {
    items: memories,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    error: listError,
    refresh: refetch,
  } = useInfiniteApiQuery<MemoryListItem>(
    `/v1/memory_stores/${storeId}/memories`,
    { limit: 50, params },
  );
  useEffect(() => {
    if (listError) setError(errMsg(listError));
  }, [listError]);
  const load = () => {
    void refetch();
  };

  const openMemory = async (m: Memory) => {
    try {
      const full = await managedApi.memoryStores.memories.retrieve(m.id, {
        memory_store_id: storeId,
        view: "full",
      });
      setOpen(full);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const filtered = pathPrefix !== "" || depth !== "";

  return (
    <div className="space-y-4">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Префикс пути, например /preferences/"
            aria-label="Фильтр по префиксу пути"
            value={pathPrefix}
            onChange={(e) => setPathPrefix(e.target.value)}
            className="min-w-0 flex-1 basis-full sm:basis-64"
          />
          <Input
            placeholder="Глубина"
            aria-label="Глубина вложенности"
            inputMode="numeric"
            value={depth}
            onChange={(e) => setDepth(e.target.value.replace(/[^0-9]/g, ""))}
            className="w-28 flex-none"
          />
          {!archived && (
            <Button onClick={() => setShowWrite(true)} className="ml-auto flex-none">
              <PlusIcon />
              Новая запись
            </Button>
          )}
        </div>
      </div>

      {showWrite && !archived && (
        <WriteMemoryDialog
          storeId={storeId}
          existing={null}
          onClose={() => setShowWrite(false)}
          onSaved={() => { setShowWrite(false); load(); }}
        />
      )}

      {!loading && !memories.length ? (
        <EmptyState
          kind="memory"
          icon={filtered ? <SearchXIcon /> : undefined}
          title={filtered ? "Записи не найдены" : "Записей пока нет"}
          body={
            filtered
              ? "Измените префикс пути или глубину."
              : archived
                ? "Хранилище в архиве: новые записи добавить нельзя."
                : "Агенты будут сохранять сюда заметки, или добавьте запись вручную."
          }
          action={
            filtered ? (
              <Button
                variant="outline"
                onClick={() => {
                  setPathPrefix("");
                  setDepth("");
                }}
              >
                Сбросить фильтры
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="console-detail-table-wrap">
            <Table className={PAGE_TABLE} aria-busy={loading}>
              <TableCaption className="sr-only">Записи хранилища памяти</TableCaption>
              <TableHeader variant="wireless">
                <TableRow variant="wireless">
                  <TableHead>Путь</TableHead>
                  <TableHead className={`${HIDE_SM} w-28`}>Размер</TableHead>
                  <TableHead className={`${HIDE_MD} w-40`}>SHA-256</TableHead>
                  <TableHead className="w-44">Изменено</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <SkeletonTableRows
                    columns={[
                      { className: "" },
                      { className: HIDE_SM },
                      { className: HIDE_MD },
                      { className: "" },
                    ]}
                  />
                ) : (
                  memories.map((m) =>
                    m.type === "memory_prefix" ? (
                      <TableRow
                        variant="wireless"
                        key={`prefix:${m.path}`}
                        onClick={() => setPathPrefix(m.path)}
                        onKeyDown={(e) => activateOnKey(e, () => setPathPrefix(m.path))}
                        tabIndex={0}
                        className={CLICKABLE_ROW}
                      >
                        <TableCell className="overflow-hidden">
                          <PathCell icon={<FolderIcon />} path={m.path} />
                        </TableCell>
                        <TableCell className={HIDE_SM}>–</TableCell>
                        <TableCell className={HIDE_MD}>–</TableCell>
                        <TableCell className="text-ddc-text-muted">Каталог</TableCell>
                      </TableRow>
                    ) : (
                      <TableRow
                        variant="wireless"
                        key={m.id}
                        onClick={() => openMemory(m)}
                        onKeyDown={(e) => activateOnKey(e, () => void openMemory(m))}
                        tabIndex={0}
                        className={CLICKABLE_ROW}
                      >
                        <TableCell className="overflow-hidden">
                          <PathCell icon={<FileTextIcon />} path={m.path} />
                        </TableCell>
                        <TableCell className={`${HIDE_SM} tabular-nums`}>
                          {formatBytes(m.content_size_bytes)}
                        </TableCell>
                        <TableCell className={`${HIDE_MD} font-mono text-xs text-ddc-text-muted`}>
                          {m.content_sha256.slice(0, 12)}…
                        </TableCell>
                        <TableCell className="text-ddc-text-muted tabular-nums">
                          {formatDateTime(m.updated_at)}
                        </TableCell>
                      </TableRow>
                    ),
                  )
                )}
                {!loading && (
                  <FeedMoreRow
                    colSpan={4}
                    hasMore={hasMore}
                    loading={isLoadingMore}
                    onLoadMore={loadMore}
                  />
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {open && (
        <MemoryDetailDialog
          storeId={storeId}
          memory={open}
          archived={archived}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); load(); }}
        />
      )}
    </div>
  );
}

/** Путь записи с иконкой: длинный путь обрезается, полный виден во всплывающей подсказке. */
function PathCell({ icon, path }: { icon: ReactNode; path: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex flex-none text-ddc-icon-muted [&_svg]:size-4">{icon}</span>
      <span className="truncate font-mono text-xs text-ddc-text" title={path}>
        {path}
      </span>
    </div>
  );
}

/** Строки таблицы открываются и клавишами Enter и пробел, как и кликом. */
function activateOnKey(event: KeyboardEvent<HTMLElement>, action: () => void) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

// =================================================================
// Окно записи: просмотр, правка, удаление и история версий
// =================================================================

type PendingAction =
  | { kind: "delete" }
  | { kind: "rollback"; version: MemoryVersion }
  | { kind: "redact"; version: MemoryVersion };

function MemoryDetailDialog({
  storeId, memory, archived, onClose, onSaved,
}: {
  storeId: string;
  memory: Memory;
  archived: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const managedApi = useManagedApi();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState(memory.content ?? "");
  const [path, setPath] = useState(memory.path);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<MemoryVersion[] | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);

  const loadVersions = async () => {
    try {
      const { data } = await managedApi.memoryStores.memoryVersions.list(storeId, {
        memory_id: memory.id,
        view: "full",
        limit: 100,
      });
      setVersions(data);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await managedApi.memoryStores.memories.update(memory.id, {
          memory_store_id: storeId,
          path: path !== memory.path ? path : undefined,
          content: content !== (memory.content ?? "") ? content : undefined,
          // Защита от перезаписи: отказ, если кто-то записал после нашего чтения.
          precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await managedApi.memoryStores.memories.delete(memory.id, {
        memory_store_id: storeId,
        expected_content_sha256: memory.content_sha256,
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const rollback = async (v: MemoryVersion) => {
    if (v.content === undefined || v.content === null) return;
    setError(null);
    try {
      await managedApi.memoryStores.memories.update(memory.id, {
          memory_store_id: storeId,
          content: v.content,
          // Сверка с текущей головной версией, чтобы не затереть параллельную запись.
          precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const redact = async (v: MemoryVersion) => {
    setError(null);
    try {
      await managedApi.memoryStores.memoryVersions.redact(v.id, {
        memory_store_id: storeId,
      });
      loadVersions();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const askRollback = (v: MemoryVersion) => {
    if (v.content === undefined || v.content === null) {
      setError("Содержимое этой версии стёрто, откатиться к ней нельзя.");
      return;
    }
    setPending({ kind: "rollback", version: v });
  };

  const askRedact = (v: MemoryVersion) => {
    if (v.content_sha256 && v.content_sha256 === memory.content_sha256) {
      setError("Актуальную версию стереть нельзя. Сначала запишите новую версию или удалите запись.");
      return;
    }
    setPending({ kind: "redact", version: v });
  };

  const runPending = async () => {
    if (!pending) return;
    setPendingBusy(true);
    try {
      if (pending.kind === "delete") await remove();
      else if (pending.kind === "rollback") await rollback(pending.version);
      else await redact(pending.version);
    } finally {
      setPendingBusy(false);
      setPending(null);
    }
  };

  const pendingCopy =
    pending?.kind === "delete"
      ? {
          title: `Удалить запись «${memory.path}»?`,
          message: "История изменений сохранится.",
          confirmLabel: "Удалить",
          destructive: true,
        }
      : pending?.kind === "rollback"
        ? {
            title: "Откатиться к этой версии?",
            message: `Версия ${pending.version.id} от ${formatDateTime(pending.version.created_at)}. Будет записана новая версия со старым содержимым.`,
            confirmLabel: "Откатить",
            destructive: false,
          }
        : pending?.kind === "redact"
          ? {
              title: "Стереть содержимое версии?",
              message: `Версия ${pending.version.id}. Содержимое будет стёрто, строка в журнале останется.`,
              confirmLabel: "Стереть",
              destructive: true,
            }
          : { title: "", message: "", confirmLabel: "Подтвердить", destructive: false };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        closeDisabled={saving}
        title={memory.path}
        subtitle={`${memory.id} · sha256=${memory.content_sha256.slice(0, 16)}… · ${formatBytes(memory.content_size_bytes)}`}
        maxWidth="max-w-2xl"
        footer={
          <div className="flex w-full flex-wrap items-center gap-2">
            {!editing && (
              <Button
                variant="outline"
                onClick={() => {
                  setShowVersions((s) => !s);
                  if (!showVersions) loadVersions();
                }}
                aria-expanded={showVersions}
              >
                {showVersions ? "Скрыть историю версий" : "История версий"}
              </Button>
            )}
            {!archived && !editing && (
              <Button variant="danger-ghost" onClick={() => setPending({ kind: "delete" })}>
                <TrashIcon />
                Удалить запись
              </Button>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {editing && (
                <>
                  <Button
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      setEditing(false);
                      setContent(memory.content ?? "");
                      setPath(memory.path);
                    }}
                  >
                    Отмена
                  </Button>
                  <Button onClick={save} loading={saving}>
                    Сохранить
                  </Button>
                </>
              )}
              {!archived && !editing && (
                <Button onClick={() => setEditing(true)}>Изменить</Button>
              )}
            </div>
          </div>
        }
      >
        {error && (
          <div className="mb-4">
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          </div>
        )}

        {editing && (
          <div className="mb-4">
            <Label htmlFor="memory-edit-path" className="sr-only">Путь записи</Label>
            <Input
              id="memory-edit-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="font-mono"
            />
          </div>
        )}

        {editing ? (
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={20}
            aria-label="Содержимое записи"
            className="min-h-80 font-mono"
          />
        ) : (
          <pre className="max-h-[40vh] overflow-auto rounded-xl border border-ddc-border bg-ddc-surface-sunken p-3 font-mono text-sm whitespace-pre-wrap text-ddc-text">
            {memory.content || <span className="text-ddc-text-muted">(пусто)</span>}
          </pre>
        )}

        {showVersions && !versions && (
          <div className="mt-4 space-y-2" aria-busy="true">
            <span className="sr-only">Загрузка…</span>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {showVersions && versions && (
          <div className="console-detail-table-wrap mt-4 rounded-xl border border-ddc-border">
            <Table className="console-detail-table">
              <TableCaption className="sr-only">История версий записи</TableCaption>
              <TableHeader variant="wireless">
                <TableRow variant="wireless">
                  <TableHead>Когда</TableHead>
                  <TableHead>Операция</TableHead>
                  <TableHead>Автор</TableHead>
                  <TableHead>SHA-256</TableHead>
                  <TableHead className="w-44">
                    <span className="sr-only">Действия</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((v) => {
                  const isLiveHead = v.content_sha256 && v.content_sha256 === memory.content_sha256;
                  const actor = formatMemoryActor(v.created_by);
                  return (
                    <TableRow variant="wireless" key={v.id}>
                      <TableCell className="text-ddc-text-muted tabular-nums">
                        {formatDateTime(v.created_at)}
                      </TableCell>
                      <TableCell>
                        {operationLabel(v.operation)}
                        {v.redacted_at && <span className="chip tone-neutral ml-2">Стёрто</span>}
                      </TableCell>
                      <TableCell className="overflow-hidden">
                        <span className="block truncate font-mono text-xs text-ddc-text-muted" title={actor}>
                          {actor}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-ddc-text-muted">
                        {v.content_sha256 ? v.content_sha256.slice(0, 12) + "…" : "–"}
                        {isLiveHead && <span className="chip tone-brand ml-2">Актуальная</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {!archived && !v.redacted_at && v.content !== undefined && v.content !== null && !isLiveHead && (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => askRollback(v)}
                              aria-label={`Откатить к версии ${v.id}`}
                            >
                              Откатить
                            </Button>
                          )}
                          {!archived && !v.redacted_at && !isLiveHead && (
                            <Button
                              variant="danger-ghost"
                              size="xs"
                              onClick={() => askRedact(v)}
                              aria-label={`Стереть содержимое версии ${v.id}`}
                            >
                              Стереть
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!versions.length && (
                  <TableRow variant="wireless">
                    <TableCell colSpan={5} className="py-4 text-center text-ddc-text-muted">
                      Версий нет
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={pending !== null}
        title={pendingCopy.title}
        message={pendingCopy.message}
        confirmLabel={pendingCopy.confirmLabel}
        destructive={pendingCopy.destructive}
        busy={pendingBusy}
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

// =================================================================
// Вкладка «История версий» (журнал изменений всего хранилища)
// =================================================================

function VersionsPanel({ storeId }: { storeId: string }) {
  const [error, setError] = useState<string | null>(null);
  const {
    items: versions,
    isLoading: loading,
    isLoadingMore,
    hasMore,
    loadMore,
    error: queryError,
  } = useInfiniteApiQuery<MemoryVersion>(
    `/v1/memory_stores/${storeId}/memory_versions`,
    { limit: 50 },
  );
  useEffect(() => {
    if (queryError) setError(errMsg(queryError));
  }, [queryError]);

  if (error) return <ErrorBanner message={error} onDismiss={() => setError(null)} />;
  if (!loading && !versions.length) {
    return (
      <EmptyState
        kind="memory"
        title="Версий пока нет"
        body="История появится после первой записи в хранилище."
      />
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="console-detail-table-wrap">
        <Table className={PAGE_TABLE} aria-busy={loading}>
          <TableCaption className="sr-only">История версий хранилища памяти</TableCaption>
          <TableHeader variant="wireless">
            <TableRow variant="wireless">
              <TableHead className="w-44">Когда</TableHead>
              <TableHead className="w-32">Операция</TableHead>
              <TableHead>Путь</TableHead>
              <TableHead className={`${HIDE_LG} w-64`}>Автор</TableHead>
              <TableHead className={`${HIDE_MD} w-36`}>SHA-256</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <SkeletonTableRows
                columns={[
                  { className: "" },
                  { className: "" },
                  { className: "" },
                  { className: HIDE_LG },
                  { className: HIDE_MD },
                ]}
              />
            ) : (
              versions.map((v) => {
                const actor = formatMemoryActor(v.created_by);
                return (
                  <TableRow variant="wireless" key={v.id}>
                    <TableCell className="text-ddc-text-muted tabular-nums">
                      {formatDateTime(v.created_at)}
                    </TableCell>
                    <TableCell>
                      {operationLabel(v.operation)}
                      {v.redacted_at && <span className="chip tone-neutral ml-2">Стёрто</span>}
                    </TableCell>
                    <TableCell className="overflow-hidden">
                      <span className="block truncate font-mono text-xs" title={v.path ?? undefined}>
                        {v.path ?? "–"}
                      </span>
                    </TableCell>
                    <TableCell className={`${HIDE_LG} overflow-hidden`}>
                      <span className="block truncate font-mono text-xs text-ddc-text-muted" title={actor}>
                        {actor}
                      </span>
                    </TableCell>
                    <TableCell className={`${HIDE_MD} font-mono text-xs text-ddc-text-muted`}>
                      {v.content_sha256 ? v.content_sha256.slice(0, 12) + "…" : "–"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
            {!loading && (
              <FeedMoreRow
                colSpan={5}
                hasMore={hasMore}
                loading={isLoadingMore}
                onLoadMore={loadMore}
              />
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// =================================================================
// Вкладка «Настройки»: название и описание, остальное только для чтения
// =================================================================

function SettingsPanel({
  store,
  archived,
  onUpdated,
}: {
  store: MemoryStore;
  archived: boolean;
  onUpdated: () => void;
}) {
  const managedApi = useManagedApi();
  const { t } = useI18n();
  const [name, setName] = useState(store.name);
  const [description, setDescription] = useState(store.description ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Черновики синхронизируются, когда кэш TanStack Query обновляет хранилище.
  useEffect(() => {
    setName(store.name);
    setDescription(store.description ?? "");
  }, [store.id, store.name, store.description]);

  const dirty =
    name.trim() !== store.name ||
    (description.trim() || "") !== (store.description ?? "");

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t.common.nameRequired);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await managedApi.memoryStores.update(store.id, {
        name: trimmedName,
        description: description.trim() || null,
      });
      onUpdated();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card max-w-2xl space-y-4 p-5 text-sm">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div>
        <div className="label">{t.common.id}</div>
        <code className="font-mono text-xs break-all text-ddc-text">{store.id}</code>
      </div>

      <Field
        label={t.common.name}
        hint={
          <>
            {t.memory.mountPathHint}{" "}
            <code className="font-mono">/mnt/memory/{name.trim() || store.name}/</code>
          </>
        }
      >
        <Input
          id="memory-store-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={archived || saving}
        />
      </Field>

      <Field label={t.common.description}>
        <Textarea
          id="memory-store-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={archived || saving}
          rows={3}
          className="resize-y"
        />
      </Field>

      <div>
        <div className="label">{t.common.created}</div>
        <span className="tabular-nums">{formatDateTime(store.created_at)}</span>
      </div>
      {archived && (
        <div>
          <div className="label">{t.common.archived}</div>
          <span className="tabular-nums">{formatDateTime(store.archived_at)}</span>
        </div>
      )}

      {!archived && (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button onClick={save} disabled={!dirty || !name.trim()} loading={saving}>
            {t.common.saveChanges}
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setName(store.name);
                setDescription(store.description ?? "");
                setError(null);
              }}
              disabled={saving}
            >
              {t.common.reset}
            </Button>
          )}
        </div>
      )}

      <p className="border-t border-ddc-divider pt-4 text-xs text-ddc-text-muted">
        {t.memory.settingsArchiveHint}
      </p>
    </div>
  );
}

// =================================================================
// Окно «Новая запись» (создание, первая запись)
// =================================================================

function WriteMemoryDialog({
  storeId, existing, onClose, onSaved,
}: {
  storeId: string;
  existing: Memory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const managedApi = useManagedApi();
  const [path, setPath] = useState(existing?.path ?? "/");
  const [content, setContent] = useState(existing?.content ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await managedApi.memoryStores.memories.create(storeId, { path, content });
      onSaved();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      title="Новая запись"
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button onClick={save} loading={saving}>
            Создать
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <Field label="Путь">
          <Input
            id="new-memory-path"
            placeholder="/preferences/formatting.md"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="font-mono"
          />
        </Field>

        <Field label="Содержимое (до 100 КБ)">
          <Textarea
            id="new-memory-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={14}
            className="min-h-72 font-mono"
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Ошибка в выноске DDC `callout-danger`: роль alert, закрывается кнопкой. */
function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div role="alert" className="callout-danger justify-between">
      <p className="min-w-0 flex-1 break-words">{message}</p>
      <Button variant="ghost" size="xs" onClick={onDismiss} className="-my-1 flex-none">
        Закрыть
      </Button>
    </div>
  );
}

/** Строки-заглушки в таблице на время первой загрузки (правило 12 DDC): высота строки h-4 под text-sm. */
function SkeletonTableRows({ columns, rows = 5 }: { columns: { className: string }[]; rows?: number }) {
  return Array.from({ length: rows }).map((_, rowIndex) => (
    <TableRow variant="wireless" key={`skeleton-${rowIndex}`}>
      {columns.map((column, columnIndex) => (
        <TableCell key={columnIndex} className={column.className}>
          <Skeleton className={columnIndex === 0 ? "h-4 w-3/5" : "h-4 w-4/5"} />
        </TableCell>
      ))}
    </TableRow>
  ));
}

const OPERATION_LABEL: Record<string, string> = {
  created: "Создание",
  modified: "Изменение",
  deleted: "Удаление",
};

/** Операция версии по-русски; неизвестное значение показываем как есть. */
function operationLabel(operation: string): string {
  return OPERATION_LABEL[operation] ?? operation;
}

const ACTOR_LABEL: Record<BetaManagedAgentsActor["type"], string> = {
  api_actor: "API-ключ",
  session_actor: "Сессия",
  user_actor: "Пользователь",
  service_account_actor: "Сервисный аккаунт",
};

function formatMemoryActor(actor: BetaManagedAgentsActor | undefined): string {
  if (!actor) return "–";
  switch (actor.type) {
    case "api_actor":
      return `${ACTOR_LABEL[actor.type]} · ${actor.api_key_id}`;
    case "session_actor":
      return `${ACTOR_LABEL[actor.type]} · ${actor.session_id}`;
    case "user_actor":
      return `${ACTOR_LABEL[actor.type]} · ${actor.user_id}`;
    case "service_account_actor":
      return `${ACTOR_LABEL[actor.type]} · ${actor.service_account_id}`;
  }
}

function FeedMoreRow({
  colSpan,
  hasMore,
  loading,
  onLoadMore,
}: {
  colSpan: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore || loading || !ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  if (!hasMore) return null;
  return (
    <TableRow variant="wireless">
      <TableCell colSpan={colSpan} className="text-center text-xs text-ddc-text-muted">
        <div ref={ref}>{loading ? "Загружаем ещё…" : "Остальное загрузится при прокрутке"}</div>
      </TableCell>
    </TableRow>
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Неизвестная ошибка";
}
