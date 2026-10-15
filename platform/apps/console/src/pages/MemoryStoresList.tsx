import { Input } from "@/components/ui/input";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, SearchXIcon, TrashIcon, PlusIcon } from "lucide-react";
import type { BetaManagedAgentsMemoryStore as MemoryStore } from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores";

import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Field } from "../components/Field";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { Modal } from "../components/Modal";
import { StatusPill } from "../components/Badge";
import { formatDate } from "../components/knowledge-format";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { useI18n } from "../i18n";

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "active", label: "Активные" },
  { value: "archived", label: "В архиве" },
];

export function MemoryStoresList() {
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();

  // Фильтры на стороне сервера. Каждое значение попадает в storesParams →
  // useApiQuery перезапрашивает список при смене параметров → список
  // показывает ровно то, что вернул сервер (без подмены на клиенте).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  // У списка Managed нет параметра текстового поиска. Поиск и режим «только
  // архив» это фильтры представления поверх уже загруженных страниц.
  const [search, setSearch] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Удаление через ConfirmDialog (правило 11 DDC): window.confirm запрещён.
  const [deleteTarget, setDeleteTarget] = useState<MemoryStore | null>(null);
  const [deleting, setDeleting] = useState(false);

  const storesParams = useMemo(
    () => ({
      ...(status !== "active" ? { include_archived: "true" } : {}),
      ...(created.after !== undefined
        ? { "created_at[gte]": new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { "created_at[lte]": new Date(created.before).toISOString() }
        : {}),
    }),
    [status, created.after, created.before],
  );

  const {
    items: stores,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshStores,
  } = useInfiniteApiQuery<MemoryStore>("/v1/memory_stores", {
    limit: 20,
    params: storesParams,
  });
  const visibleStores = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return stores.filter((store) => {
      if (status === "active" && store.archived_at) return false;
      if (status === "archived" && !store.archived_at) return false;
      return !needle || `${store.name}\n${store.id}`.toLocaleLowerCase().includes(needle);
    });
  }, [search, status, stores]);

  const closeCreate = () => {
    if (creating) return;
    setShowCreate(false);
    setFormError(null);
  };

  const createStore = async () => {
    setFormError(null);
    setCreating(true);
    try {
      await managedApi.memoryStores.create({
        name: formName,
        description: formDesc || undefined,
      });
      setShowCreate(false);
      setFormName("");
      setFormDesc("");
      refreshStores();
    } catch (e) {
      setFormError(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await managedApi.memoryStores.delete(deleteTarget.id);
      refreshStores();
    } catch {
      // Ошибку показывает общий обработчик запросов.
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  // Описание столбцов TanStack. Обязательный столбец (название) не входит в
  // меню «Столбцы», чтобы нельзя было получить таблицу без идентификации строки.
  const columns = useMemo<ColumnDef<MemoryStore>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Название",
        size: 240,
        meta: { grow: true },
        cell: ({ row }) => (
          <span className="truncate font-medium text-ddc-heading" title={row.original.name}>
            {row.original.name}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        size: 300,
        cell: ({ row }) => (
          <span title={row.original.id} className="truncate font-mono text-xs text-ddc-text-muted">
            {row.original.id}
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (s) => (s.archived_at ? "archived" : "active"),
        header: "Статус",
        size: 140,
        cell: ({ row }) =>
          row.original.archived_at ? (
            <StatusPill status="idle" label="В архиве" />
          ) : (
            <StatusPill status="completed" label="Активно" />
          ),
      },
      {
        id: "created",
        accessorFn: (s) => s.created_at,
        header: "Создано",
        size: 140,
        cell: ({ row }) => (
          <span className="text-ddc-text-muted tabular-nums">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [],
  );

  // Подпись активного фильтра остаётся пустой, пока выбрано значение по
  // умолчанию: чип читается «Статус ▾», а не «Статус: Все ▾».
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const filters = (
    <>
      <FilterChip
        label="Статус"
        active={status !== "any"}
        display={statusDisplay}
        onClear={() => setStatus("any")}
      >
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-48 p-0"
        >
          <FacetedFilter
            options={STATUS_OPTIONS}
            value={status}
            onValueChange={(v) => setStatus(v as StatusValue)}
            searchPlaceholder="Найти статус…"
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  const hasSearch = search.trim() !== "";
  const filtered =
    hasSearch ||
    status !== "active" ||
    created.after !== undefined ||
    created.before !== undefined;

  const openCreate = () => {
    setShowCreate(true);
    setFormError(null);
  };

  return (
    <DataTable<MemoryStore>
      title={t.nav.memoryStores}
      subtitle="Память агентов: записи, которые сохраняются между сессиями и общие для нескольких агентов."
      createLabel={t.memory.newMemoryStore}
      onCreate={openCreate}
      searchPlaceholder={t.memory.searchMemoryStores}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={visibleStores}
      loading={loading}
      getRowId={(s) => s.id}
      onRowClick={(s) => nav(`/memory/${s.id}`)}
      rowActions={(store) => [
        {
          label: t.common.archive,
          icon: <ArchiveIcon className="size-4" />,
          disabled: Boolean(store.archived_at),
          onSelect: async () => {
            try {
              await managedApi.memoryStores.archive(store.id);
              refreshStores();
            } catch {
              // Ошибку показывает общий обработчик запросов.
            }
          },
        },
        {
          label: t.common.delete,
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: () => setDeleteTarget(store),
        },
      ]}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={filtered ? t.memory.noMatchingMemoryStores : t.memory.noMemoryStoresYet}
      emptyKind="memory"
      emptyIcon={filtered ? <SearchXIcon className="size-6" /> : undefined}
      emptyAction={
        filtered ? (
          hasSearch ? (
            <Button variant="outline" onClick={() => setSearch("")}>
              Сбросить поиск
            </Button>
          ) : undefined
        ) : (
          <Button onClick={openCreate}><PlusIcon />{t.memory.newMemoryStore}</Button>
        )
      }
      emptySubtitle={
        filtered
          ? "Измените поиск или фильтры."
          : "Создайте хранилище памяти, чтобы агенты сохраняли контекст между сессиями."
      }
      columns={columns}
    >
      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Удалить хранилище «${deleteTarget?.name ?? ""}»?`}
        message="Действие нельзя отменить."
        confirmLabel="Удалить"
        destructive
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      <Modal
        open={showCreate}
        onClose={closeCreate}
        closeDisabled={creating}
        title="Новое хранилище памяти"
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate} disabled={creating}>
              {t.common.cancel}
            </Button>
            <Button onClick={createStore} disabled={!formName} loading={creating}>
              {t.common.create}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {formError && (
            <div role="alert" className="callout-danger">
              {formError}
            </div>
          )}
          <Field label={t.common.name}>
            <Input
              id="memory-store-name"
              placeholder="Например, предпочтения пользователя"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
            />
          </Field>
          <Field
            label={
              <>
                {t.common.description}{" "}
                <span className="font-normal text-ddc-text-muted">(необязательно)</span>
              </>
            }
          >
            <Input
              id="memory-store-description"
              placeholder="Что здесь хранится?"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
            />
          </Field>
        </div>
      </Modal>
    </DataTable>
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Неизвестная ошибка";
}
