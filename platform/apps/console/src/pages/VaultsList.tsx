import { formatDate } from "../lib/date-format";
import { Input } from "@/components/ui/input";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, ArchiveRestoreIcon, TrashIcon, PlusIcon } from "lucide-react";
import type { BetaManagedAgentsVault as Vault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { Modal } from "../components/Modal";
import { DangerDialog } from "../components/DangerDialog";
import { Field } from "../components/Field";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { useI18n } from "../i18n";

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "active", label: "Активные" },
  { value: "archived", label: "В архиве" },
];

type PendingAction = { kind: "archive" | "delete"; vault: Vault };

export function VaultsList() {
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const [showCreateVault, setShowCreateVault] = useState(false);
  const [vaultName, setVaultName] = useState("");
  const [creating, setCreating] = useState(false);

  // Архив и удаление идут через DangerDialog со списком зависимостей. Цель
  // не сбрасываем при закрытии, чтобы текст окна не пропадал на время
  // анимации ухода. Окно читает ETag хранилища и шлёт его в If-Match.
  const [pending, setPending] = useState<PendingAction | null>(null);

  // Server-driven filter state. Any change to these flows into vaultParams
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [search, setSearch] = useState("");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});

  const vaultParams = useMemo(
    () => ({
      ...(status !== "active" ? { include_archived: "true" } : {}),
    }),
    [status],
  );

  const {
    items: vaults,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useInfiniteApiQuery<Vault>("/v1/vaults", { limit: 20, params: vaultParams });
  const visibleVaults = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return vaults.filter((vault) => {
      if (status === "active" && vault.archived_at) return false;
      if (status === "archived" && !vault.archived_at) return false;
      const createdAt = Date.parse(vault.created_at);
      if (created.after !== undefined && createdAt < created.after) return false;
      if (created.before !== undefined && createdAt > created.before) return false;
      return !needle || `${vault.display_name}\n${vault.id}`.toLocaleLowerCase().includes(needle);
    });
  }, [created.after, created.before, search, status, vaults]);

  const createVault = async () => {
    setCreating(true);
    try {
      await managedApi.vaults.create({ display_name: vaultName });
      setShowCreateVault(false);
      setVaultName("");
      load();
    } finally {
      setCreating(false);
    }
  };

  const askConfirm = (action: PendingAction) => setPending(action);

  const restoreVault = async (vault: Vault) => {
    try {
      await managedApi.vaults.unarchive(vault.id);
      load();
    } catch {
      // useApi уже показал ошибку тостом.
    }
  };

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu so the user can't end up
  // with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<Vault>[]>(
    () => [
      {
        id: "name",
        accessorKey: "display_name",
        header: t.common.name,
        size: 240,
        meta: { grow: true },
        cell: ({ row }) => (
          <span
            className="min-w-0 truncate font-medium text-ddc-heading"
            title={row.original.display_name}
          >
            {row.original.display_name}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "id",
        accessorKey: "id",
        header: t.common.id,
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-muted">
            {row.original.id}
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (v) => (v.archived_at ? "archived" : "active"),
        header: t.common.status,
        cell: ({ row }) => (
          <span className={`chip ${row.original.archived_at ? "tone-ghost" : "tone-success"}`}>
            {row.original.archived_at ? t.common.archived : "Активно"}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (v) => v.created_at,
        header: t.common.created,
        cell: ({ row }) => (
          <span className="text-muted tabular-nums">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [load, t],
  );

  // Active-filter chip display — null at the default so the chip reads
  // "Статус ▾" rather than "Статус: Все ▾". Mirrors AgentsList.
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const filters = (
    <>
      <FilterChip
        label={t.common.status}
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
            searchPlaceholder="Статус…"
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  // Пустой список из-за фильтра («В архиве», период) не то же самое, что
  // «хранилищ пока нет»: во втором случае уместна кнопка создания.
  const filtered =
    status === "archived" ||
    search.trim() !== "" ||
    created.after !== undefined ||
    created.before !== undefined;

  const closeCreate = () => {
    setShowCreateVault(false);
    setVaultName("");
  };

  const pendingName = pending?.vault.display_name ?? "";

  return (
    <DataTable<Vault>
      title={t.nav.credentialVaults}
      subtitle="Учётные данные и делегированный доступ, с которыми агенты ходят на MCP-серверы."
      createLabel={t.vaults.newVault}
      onCreate={() => setShowCreateVault(true)}
      searchPlaceholder={t.vaults.searchVaults}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={visibleVaults}
      loading={loading}
      getRowId={(v) => v.id}
      onRowClick={(v) => nav(`/vaults/${v.id}`)}
      rowActions={(vault) => [
        vault.archived_at
          ? {
              label: t.common.unarchive,
              icon: <ArchiveRestoreIcon className="size-4" />,
              onSelect: () => void restoreVault(vault),
            }
          : {
              label: t.common.archive,
              icon: <ArchiveIcon className="size-4" />,
              onSelect: () => askConfirm({ kind: "archive", vault }),
            },
        {
          label: t.common.delete,
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: () => askConfirm({ kind: "delete", vault }),
        },
      ]}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={filtered ? t.vaults.noMatchingVaults : t.vaults.noVaultsYet}
      emptyKind="vault"
      emptySubtitle={
        filtered
          ? "Измените фильтры, чтобы увидеть другие хранилища."
          : "В хранилище лежат учётные данные, с которыми агенты ходят на MCP-серверы."
      }
      emptyAction={
        !filtered && <Button onClick={() => setShowCreateVault(true)}><PlusIcon />{t.vaults.newVault}</Button>
      }
      columns={columns}
    >
      {/* Новое хранилище */}
      <Modal
        open={showCreateVault}
        onClose={closeCreate}
        title="Новое хранилище"
        closeDisabled={creating}
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate} disabled={creating}>
              {t.common.cancel}
            </Button>
            <Button onClick={createVault} disabled={!vaultName} loading={creating}>
              {t.common.create}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t.common.name} hint="До 30 символов.">
            <Input
              id="vault-name"
              value={vaultName}
              onChange={(e) => setVaultName(e.target.value.slice(0, 30))}
              placeholder="Например, Рабочие ключи"
            />
          </Field>
        </div>
      </Modal>

      <DangerDialog
        open={pending?.kind === "archive"}
        operation="archive"
        target={pending?.kind === "archive" ? { kind: "vault", id: pending.vault.id } : null}
        etagPath={pending?.kind === "archive" ? `/v1/vaults/${pending.vault.id}` : undefined}
        title="Отправить хранилище в архив?"
        message={`Хранилище «${pendingName}» и его учётные данные станут недоступны агентам.`}
        confirmLabel={t.common.archive}
        run={(options) => managedApi.vaults.archive(pending!.vault.id, options)}
        onDone={() => {
          setPending(null);
          load();
        }}
        onClose={() => setPending(null)}
      />
      <DangerDialog
        open={pending?.kind === "delete"}
        operation="delete"
        target={pending?.kind === "delete" ? { kind: "vault", id: pending.vault.id } : null}
        etagPath={pending?.kind === "delete" ? `/v1/vaults/${pending.vault.id}` : undefined}
        title={`Удалить хранилище «${pendingName}»?`}
        message="Хранилище и все его учётные данные будут удалены."
        run={(options) => managedApi.vaults.delete(pending!.vault.id, options)}
        onDone={() => {
          setPending(null);
          load();
        }}
        onClose={() => setPending(null)}
      />
    </DataTable>
  );
}
