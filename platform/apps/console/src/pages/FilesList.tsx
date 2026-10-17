import { formatDateTime } from "../lib/date-format";
import { Input } from "@/components/ui/input";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { DownloadIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { DangerDialog } from "../components/DangerDialog";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import {
  useApiQuery,
  useFilesInfiniteApiQuery,
} from "../lib/useApiQuery";
import { PopoverContent } from "@/components/ui/popover";
import type { SessionRecord as Session } from "../types/session";
import { useI18n } from "../i18n";
import type { BetaFileMetadata as FileRecord } from "@anthropic-ai/sdk/resources/beta/files";
import { useManagedApi } from "../lib/useManagedApi";

const ALL_SCOPE = "";

const sizeFormat = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function FilesList() {
  const managedApi = useManagedApi();
  const [scopeId, setScopeId] = useState<string>(ALL_SCOPE);
  const [search, setSearch] = useState("");
  // Цель удаления держим и после закрытия окна: заголовок не мигает пустым
  // именем, пока окно уходит.
  const [deleteTarget, setDeleteTarget] = useState<FileRecord | null>(null);
  const [askDelete, setAskDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { t } = useI18n();

  // У файлов своя пагинация официального SDK (`before_id` и
  // `has_more/last_id`), отдельная от лент Managed с `page/next_page`.
  const filesParams = useMemo(
    () => ({ scope_id: scopeId || undefined }),
    [scopeId],
  );
  const {
    items,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshFiles,
  } = useFilesInfiniteApiQuery<FileRecord>("/v1/files", {
    limit: 20,
    params: filesParams,
  });

  // Сессии нужны для списка в фильтре «Сессия». Разовая выборка первых 200
  // сессий, видимых пользователю, как в AgentsList для списка вызываемых
  // агентов. Сессии за пределом лимита в списке не видны, но строка поиска
  // внутри FacetedFilter (cmdk) находит их по части id.
  const { data: sessionsRes } = useApiQuery<{ data: Session[] }>(
    "/v1/sessions",
    { limit: "200" },
  );
  const sessions = sessionsRes?.data ?? [];

  // Список сессий для фильтра: «Все» значит без фильтра, остальные пункты
  // несут настоящий id сессии и подписаны названием (или id, если названия
  // нет).
  const scopeOptions = useMemo(
    () => [
      { value: ALL_SCOPE, label: "Все сессии" },
      ...sessions.map((s) => ({
        value: s.id,
        label: s.title?.trim() ? `${s.title} (${s.id})` : s.id,
      })),
    ],
    [sessions],
  );

  // Подпись активного чипа. Если сессии нет в загруженном списке (например,
  // пользователь пришёл по ссылке на сессию за пределом 200 строк),
  // показываем сам id.
  const scopeDisplay = useMemo(() => {
    if (!scopeId) return undefined;
    const hit = sessions.find((s) => s.id === scopeId);
    return hit?.title?.trim() ? hit.title : scopeId;
  }, [scopeId, sessions]);

  // Бинарный ответ идёт по форме официального Files.download. Транспорт
  // Managed API передаёт ту же cookie, beta-заголовки и активное
  // рабочее пространство, что и JSON-запросы.
  const download = async (f: FileRecord) => {
    try {
      const res = await managedApi.files.download(f.id);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`Не удалось скачать файл: ${e instanceof Error ? e.message : "ошибка сети"}`);
    }
  };

  // Загрузка идёт по одному файлу: POST /v1/files принимает один файл. Список
  // обновляется после каждого удачного файла.
  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) {
        try {
          await managedApi.files.upload({ file });
          toast.success(`Файл «${file.name}» загружен`);
          // Сбрасываем все запросы /v1/files: refresh() возвращает список на
          // первую страницу, следующий запрос принесёт данные сервера.
          refreshFiles();
        } catch (e) {
          toast.error(
            `Не удалось загрузить «${file.name}»: ${e instanceof Error ? e.message : "ошибка сети"}`,
          );
        }
      }
    } finally {
      setUploading(false);
    }
  };

  const onDragOver = (event: DragEvent) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
  };
  const onDrop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void uploadFiles(files);
  };

  // Поиск работает на клиенте по уже загруженной странице: сервер не
  // индексирует имена, а в API загрузки нет фильтра по имени. Файл из
  // длинного хвоста сначала сужают по сессии (на сервере), затем по имени
  // внутри страницы.
  const filtered = search
    ? items.filter((f) => f.filename.toLowerCase().includes(search.toLowerCase()))
    : items;

  const columns = useMemo<ColumnDef<FileRecord>[]>(
    () => [
      {
        id: "filename",
        accessorKey: "filename",
        header: "Имя файла",
        size: 220,
        meta: { grow: true },
        cell: ({ row }) => (
          <span title={row.original.filename} className="truncate font-medium text-ddc-heading">
            {row.original.filename}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "id",
        accessorKey: "id",
        header: t.common.id,
        size: 220,
        cell: ({ row }) => (
          <span title={row.original.id} className="truncate font-mono text-xs text-ddc-text-muted">
            {row.original.id}
          </span>
        ),
      },
      {
        id: "mime_type",
        accessorKey: "mime_type",
        header: "Тип",
        size: 150,
        meta: { priority: 3 },
        cell: ({ row }) => (
          <span title={row.original.mime_type} className="truncate text-xs text-ddc-text-muted">
            {row.original.mime_type}
          </span>
        ),
      },
      {
        id: "size",
        accessorFn: (f) => f.size_bytes,
        header: "Размер",
        size: 100,
        cell: ({ row }) => (
          <span className="text-xs tabular-nums text-ddc-text-muted">
            {formatBytes(row.original.size_bytes)}
          </span>
        ),
      },
      {
        id: "scope",
        accessorFn: (f) => f.scope?.id ?? "",
        header: "Сессия",
        size: 190,
        meta: { priority: 2 },
        cell: ({ row }) =>
          row.original.scope?.id ? (
            <Link
              to={`/sessions/${row.original.scope.id}`}
              onClick={(e) => e.stopPropagation()}
              title={row.original.scope.id}
              className="link truncate font-mono text-xs"
            >
              {row.original.scope.id}
            </Link>
          ) : (
            <span className="text-ddc-placeholder">–</span>
          ),
      },
      {
        id: "created",
        accessorFn: (f) => f.created_at,
        header: t.common.created,
        size: 150,
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap tabular-nums text-ddc-text-muted">
            {formatDateTime(row.original.created_at)}
          </span>
        ),
      },
    ],
    [t],
  );

  const filters = (
    <FilterChip
      label="Сессия"
      active={scopeId !== ALL_SCOPE}
      display={scopeDisplay}
      onClear={() => setScopeId(ALL_SCOPE)}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-80 p-0"
      >
        <FacetedFilter
          options={scopeOptions}
          value={scopeId}
          onValueChange={(v) => setScopeId(v)}
          searchPlaceholder="ID или название сессии…"
        />
      </PopoverContent>
    </FilterChip>
  );

  return (
    // `contents` не меняет раскладку страницы, а события перетаскивания
    // всплывают к этому узлу от всей таблицы.
    <div data-file-drop className="contents" onDragOver={onDragOver} onDrop={onDrop}>
    <DataTable<FileRecord>
      title={t.nav.files}
      createLabel={uploading ? "Загрузка…" : "Загрузить"}
      onCreate={() => fileInput.current?.click()}
      subtitle="Файлы, которые агенты получили и сохранили в сессиях."
      searchPlaceholder="Поиск по загруженным файлам…"
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={filtered}
      loading={loading}
      getRowId={(f) => f.id}
      rowActions={(file) => [
        ...(file.downloadable
          ? [
              {
                label: "Скачать",
                icon: <DownloadIcon className="size-4" />,
                onSelect: () => void download(file),
              },
            ]
          : []),
        {
          label: t.common.delete,
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: () => {
            setDeleteTarget(file);
            setAskDelete(true);
          },
        },
      ]}
      hasMore={hasMore && !search}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={scopeId ? "В этой сессии нет файлов" : t.files.noFilesYet}
      emptyKind="file"
      emptySubtitle={
        scopeId ? (
          "Сбросьте фильтр по сессии или проверьте её id."
        ) : (
          <>
            Нажмите «Загрузить» или перетащите файл на страницу. Через API файлы грузит{" "}
            <code className="font-mono text-xs">POST /v1/files</code>.
          </>
        )
      }
      columns={columns}
    >
      <Input
        ref={fileInput}
        type="file"
        multiple
        aria-label="Файл для загрузки"
        className="hidden"
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void uploadFiles(files);
        }}
      />
      <DangerDialog
        open={askDelete}
        operation="delete"
        target={deleteTarget ? { kind: "file", id: deleteTarget.id } : null}
        title={`Удалить файл «${deleteTarget?.filename ?? ""}»?`}
        message="Файл и его метаданные будут удалены."
        run={() => managedApi.files.delete(deleteTarget!.id)}
        onDone={() => {
          setAskDelete(false);
          refreshFiles();
        }}
        onClose={() => setAskDelete(false)}
      />
    </DataTable>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${sizeFormat.format(n / 1024)} КБ`;
  if (n < 1024 * 1024 * 1024) return `${sizeFormat.format(n / 1024 / 1024)} МБ`;
  return `${(n / 1024 / 1024 / 1024).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ГБ`;
}
