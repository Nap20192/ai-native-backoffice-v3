import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, ArchiveRestoreIcon, PauseIcon, PlayIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";

import { DangerDialog } from "../../components/DangerDialog";
import { DataTable, type ColumnDef } from "../../components/DataTable";
import { FacetedFilter } from "../../components/FacetedFilter";
import { CreatedFilterChip, FilterChip } from "../../components/FilterChip";
import type { RowAction } from "../../components/RowContextMenu";
import { useI18n } from "../../i18n";
import { useApiQuery, useInfiniteApiQuery } from "../../lib/useApiQuery";
import { formatDate } from "../agents/format";
import { useDeploymentActions } from "./deployment-actions";
import {
  deploymentState,
  STATE_LABELS,
  triggerText,
  type Deployment,
  type DeploymentState,
} from "./deployment-state";

type StateFilter = "any" | DeploymentState;

const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "active", label: STATE_LABELS.active },
  { value: "paused", label: STATE_LABELS.paused },
  { value: "archived", label: STATE_LABELS.archived },
];

export function StateBadge({ deployment }: { deployment: Deployment }) {
  const state = deploymentState(deployment);
  const variant = state === "active" ? "success" : state === "paused" ? "warning" : "neutral";
  return <Badge variant={variant}>{STATE_LABELS[state]}</Badge>;
}

/** Список деплойментов (docs/plans/crud.md, 4.1). */
export function DeploymentsList() {
  const nav = useNavigate();
  const { t } = useI18n();
  const actions = useDeploymentActions();
  const [state, setState] = useState<StateFilter>("any");
  const [agentId, setAgentId] = useState("");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");
  const [archiving, setArchiving] = useState<Deployment | null>(null);

  const params = useMemo(
    () => ({
      ...(agentId ? { agent_id: agentId } : {}),
      ...(state === "active" || state === "paused" ? { status: state } : {}),
      ...(state === "archived" || state === "any" ? { include_archived: "true" } : {}),
      ...(created.after !== undefined
        ? { "created_at[gte]": new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { "created_at[lte]": new Date(created.before).toISOString() }
        : {}),
    }),
    [agentId, state, created.after, created.before],
  );
  const { items, isLoading, hasMore, isLoadingMore, loadMore } =
    useInfiniteApiQuery<Deployment>("/v1/deployments", { limit: 20, params });

  const agentsQuery = useApiQuery<{ data: Array<{ id: string; name: string }> }>(
    "/v1/agents",
    { limit: "200", include_archived: "true" },
  );
  const agentNames = useMemo(
    () => new Map((agentsQuery.data?.data ?? []).map((agent) => [agent.id, agent.name])),
    [agentsQuery.data],
  );

  const visible = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return items.filter((deployment) => {
      const current = deploymentState(deployment);
      if (state === "archived" && current !== "archived") return false;
      if (state !== "any" && state !== "archived" && current !== state) return false;
      if (!needle) return true;
      return `${deployment.name}\n${deployment.id}`.toLocaleLowerCase().includes(needle);
    });
  }, [items, search, state]);

  const run = async (label: string, request: () => Promise<unknown>) => {
    try {
      await request();
      toast.success(label);
    } catch {
      // Сообщение об ошибке уже показал useApi.
    }
  };

  const rowActions = (deployment: Deployment): RowAction[] => {
    const current = deploymentState(deployment);
    if (current === "archived") {
      return [
        {
          label: t.common.unarchive,
          icon: <ArchiveRestoreIcon className="size-4" />,
          onSelect: () => void run("Деплоймент возвращён из архива и стоит на паузе", () => actions.unarchive(deployment.id)),
        },
      ];
    }
    return [
      {
        label: "Запустить",
        icon: <PlayIcon className="size-4" />,
        // Сервер запускает только активный деплоймент, на паузе POST /run даёт 409.
        disabled: current !== "active",
        onSelect: () => void run("Запуск поставлен в очередь", () => actions.run(deployment.id)),
      },
      current === "active"
        ? {
            label: "Пауза",
            icon: <PauseIcon className="size-4" />,
            onSelect: () => void run("Деплоймент на паузе", () => actions.pause(deployment.id)),
          }
        : {
            label: "Продолжить",
            icon: <RotateCcwIcon className="size-4" />,
            onSelect: () => void run("Деплоймент снова активен", () => actions.unpause(deployment.id)),
          },
      {
        label: t.common.archive,
        icon: <ArchiveIcon className="size-4" />,
        onSelect: () => setArchiving(deployment),
      },
    ];
  };

  const columns = useMemo<ColumnDef<Deployment>[]>(
    () => [
      {
        id: "name",
        accessorFn: (d) => d.name,
        header: t.common.name,
        size: 240,
        meta: { grow: true },
        enableHiding: false,
        cell: ({ row }) => (
          <span className="min-w-0 truncate font-medium text-ddc-heading" title={row.original.name}>
            {row.original.name}
          </span>
        ),
      },
      {
        id: "id",
        accessorKey: "id",
        header: t.common.id,
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-ddc-text-muted">
            {row.original.id}
          </span>
        ),
      },
      {
        id: "agent",
        accessorFn: (d) => agentNames.get(d.agent.id) ?? d.agent.id,
        header: "Агент",
        size: 200,
        meta: { priority: 2 },
        cell: ({ row }) => {
          const label = agentNames.get(row.original.agent.id) ?? row.original.agent.id;
          return (
            <span className="min-w-0 truncate text-ddc-text-muted" title={label}>
              {label}
            </span>
          );
        },
      },
      {
        id: "trigger",
        accessorFn: (d) => triggerText(d),
        header: "Триггер",
        size: 220,
        meta: { priority: 1 },
        cell: ({ row }) => (
          <span className="min-w-0 truncate text-ddc-text-muted" title={triggerText(row.original)}>
            {triggerText(row.original)}
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (d) => deploymentState(d),
        header: t.common.status,
        cell: ({ row }) => <StateBadge deployment={row.original} />,
      },
      {
        id: "created",
        accessorFn: (d) => d.created_at,
        header: t.common.created,
        cell: ({ row }) => (
          <span className="text-ddc-text-muted tabular-nums">{formatDate(row.original.created_at)}</span>
        ),
      },
    ],
    [agentNames, t],
  );

  const agentOptions = useMemo(
    () => (agentsQuery.data?.data ?? []).map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.id})` })),
    [agentsQuery.data],
  );
  const stateDisplay = state === "any" ? undefined : STATE_OPTIONS.find((o) => o.value === state)?.label;
  const agentDisplay = agentId ? agentNames.get(agentId) ?? agentId : undefined;

  const filters = (
    <>
      <FilterChip label="Агент" active={!!agentId} display={agentDisplay} onClear={() => setAgentId("")}>
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-72 p-0">
          <FacetedFilter
            options={agentOptions}
            value={agentId}
            onValueChange={setAgentId}
            searchPlaceholder="Поиск агента…"
          />
        </PopoverContent>
      </FilterChip>
      <FilterChip label="Статус" active={state !== "any"} display={stateDisplay} onClear={() => setState("any")}>
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-48 p-0">
          <FacetedFilter
            options={STATE_OPTIONS}
            value={state}
            onValueChange={(value) => setState(value as StateFilter)}
            searchPlaceholder="Найти статус…"
          />
        </PopoverContent>
      </FilterChip>
      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  const hasFilter = !!search || !!agentId || state !== "any";

  return (
    <DataTable<Deployment>
      title={t.nav.deployments}
      subtitle="Деплоймент запускает агента по расписанию или вручную и создаёт сессию на каждый запуск."
      createLabel="Новый деплоймент"
      onCreate={() => nav("/deployments/new")}
      searchPlaceholder="Поиск деплойментов…"
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={visible}
      loading={isLoading}
      getRowId={(d) => d.id}
      onRowClick={(d) => nav(`/deployments/${d.id}`)}
      rowActions={rowActions}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={hasFilter ? "Деплойменты не найдены" : "Деплойментов пока нет"}
      emptyKind="deployment"
      emptySubtitle={
        hasFilter
          ? "Измените фильтры или поисковый запрос."
          : "Создайте деплоймент, чтобы запускать агента по расписанию."
      }
      emptyAction={
        !hasFilter && (
          <Button onClick={() => nav("/deployments/new")}>
            <PlusIcon />
            Новый деплоймент
          </Button>
        )
      }
      columns={columns}
    >
      <DangerDialog
        open={archiving !== null}
        operation="archive"
        target={archiving ? { kind: "deployment", id: archiving.id } : null}
        etagPath={archiving ? `/v1/deployments/${encodeURIComponent(archiving.id)}` : undefined}
        title={archiving ? `Отправить деплоймент «${archiving.name}» в архив?` : "Отправить деплоймент в архив?"}
        message="Запуски по расписанию прекратятся."
        confirmLabel={t.common.archive}
        run={(options) => actions.archive(archiving!.id, options)}
        onDone={() => setArchiving(null)}
        onClose={() => setArchiving(null)}
      />
    </DataTable>
  );
}
