import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, ArrowRightIcon, PencilIcon, PlusIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import type { RowAction } from "../components/RowContextMenu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../types/agent";
import { AgentFormDialog } from "./agents/AgentFormDialog";
import { formatDate } from "./agents/format";
import { useI18n } from "../i18n";

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "active", label: "Активные" },
  { value: "archived", label: "В архиве" },
];

export function AgentsList() {
  const { api } = useApi();
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [archivingAgent, setArchivingAgent] = useState<Agent | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  // Managed Agents exposes include_archived plus RFC3339 created-at bounds.
  // Archived-only and text search remain feed presentation filters; they do
  // not leak the legacy OMA `status/q/created_after` query dialect.
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  // Main agents table — paginated. Any change to these params resets to
  // page 0 automatically (paramsKey is part of the query key).
  const agentsParams = useMemo(
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
    items: agents,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshAgents,
  } = useInfiniteApiQuery<Agent>("/v1/agents", { limit: 20, params: agentsParams });
  const visibleAgents = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return agents.filter((agent) => {
      if (status === "archived" && !agent.archived_at) return false;
      if (status === "active" && agent.archived_at) return false;
      if (!needle) return true;
      return `${agent.name}\n${agent.id}`.toLocaleLowerCase().includes(needle);
    });
  }, [agents, search, status]);

  // Aux fetches that aren't paginated UI surfaces — refreshed on mount and
  // after agent CRUD. Pull all agents (for the callable-agents dropdown)
  // separately so it isn't constrained by the main list's page size.
  //
  // Failures of the secondary fetches (skills / model cards) are
  // tolerated and logged: missing data degrades a dropdown but shouldn't
  // block agent CRUD. Failures of the primary `/v1/agents` call surface
  // via the toast that `useApi` raises automatically; setting `auxLoading`
  // back to false in `finally` keeps the spinner from getting stuck.
  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const all = await managedApi.agents.list({
        limit: 200,
        include_archived: true,
      });
      setAllAgents(all.data ?? []);
      await Promise.allSettled([
        (async () => {
          const sk = await managedApi.skills.list({ limit: 200 });
          setCustomSkills(
            (sk.data ?? []).map((skill) => ({
              id: skill.id,
              name: skill.display_title || skill.id,
              description: "",
            })),
          );
        })().catch((e) => console.warn("[AgentsList] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/oma/model_cards?limit=200");
          setModelCards(mc.data ?? []);
        })().catch((e) => console.warn("[AgentsList] /v1/oma/model_cards aux fetch failed", e)),
      ]);
    } finally {
      setAuxLoading(false);
    }
  };

  useEffect(() => {
    loadAux();
  }, []);

  const modelStr = (m: Agent["model"]) => (typeof m === "string" ? m : m?.id || "");

  // Архивация необратима, поэтому перед ней спрашиваем (правило 11 DDC), как и
  // на странице агента. Ошибку API показывает useApi, здесь окно просто
  // остаётся открытым до новой попытки или отмены.
  const confirmArchive = async () => {
    if (!archivingAgent) return;
    setArchiveBusy(true);
    try {
      await managedApi.agents.archive(archivingAgent.id);
      setArchivingAgent(null);
      refreshAgents();
    } catch {
      // Сообщение об ошибке уже показано.
    } finally {
      setArchiveBusy(false);
    }
  };

  const getAgentActions = (agent: Agent): RowAction[] => {
    const archived = Boolean(agent.archived_at);
    return [
      {
        label: t.agents.editAgent,
        icon: <PencilIcon className="size-4" />,
        disabled: archived,
        onSelect: () => setEditingAgent(agent),
      },
      {
        label: archived ? t.common.unarchive : t.common.archive,
        icon: <ArchiveIcon className="size-4" />,
        disabled: archived,
        onSelect: () => setArchivingAgent(agent),
      },
    ];
  };

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu so the user can't end
  // up with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<Agent>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: t.common.name,
        size: 240,
        meta: { grow: true },
        cell: ({ row }) => (
          <span className="min-w-0 truncate font-medium text-ddc-heading" title={row.original.name}>
            {row.original.name}
          </span>
        ),
        enableHiding: false,
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
        id: "model",
        accessorFn: (a) => modelStr(a.model),
        header: t.common.model,
        size: 200,
        meta: { priority: 1 },
        cell: ({ row }) => (
          <span className="min-w-0 truncate text-ddc-text-muted" title={modelStr(row.original.model)}>
            {modelStr(row.original.model)}
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (a) => (a.archived_at ? "archived" : "active"),
        header: t.common.status,
        cell: ({ row }) =>
          row.original.archived_at ? (
            <Badge variant="neutral">{t.common.archived}</Badge>
          ) : (
            <Badge variant="success">{t.common.active}</Badge>
          ),
      },
      {
        id: "created",
        accessorFn: (a) => a.created_at,
        header: t.common.created,
        cell: ({ row }) => (
          <span className="text-ddc-text-muted tabular-nums">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [api, refreshAgents, t],
  );

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Status ▾" rather than "Status: All ▾". The clear-X
  // only renders when the chip is in non-default state.
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
        {/* Status uses the shadcn faceted-filter pattern (Command
            inside Popover). The Command primitive gives type-ahead
            search even for 3 options — pays off the moment a page
            picks an enum with 10+ values. */}
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

  return (
    <DataTable<Agent>
      title={t.nav.agents}
      subtitle="Агенты выполняют задачи по вашим инструкциям: у каждого своя модель, навыки и набор инструментов."
      createLabel={t.agents.newAgent}
      onCreate={() => setShowCreate(true)}
      searchPlaceholder={t.agents.searchAgents}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={visibleAgents}
      loading={loading}
      getRowId={(a) => a.id}
      onRowClick={(a) => nav(`/agents/${a.id}`)}
      rowActions={getAgentActions}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? t.agents.noMatchingAgents : t.agents.noAgentsYet}
      emptyKind="agent"
      emptyAction={
        !search && (
          <Button onClick={() => setShowCreate(true)}>
            <PlusIcon />
            {t.agents.newAgentTitle}
          </Button>
        )
      }
      emptySubtitle={
        search ? (
          t.agents.tryDifferentSearch
        ) : (
          <>
            <p>{t.agents.createFirstAgent}</p>
            <Button variant="link" onClick={() => nav("/")} className="mt-3">
              {t.agents.getStartedGuide}
              <ArrowRightIcon />
            </Button>
          </>
        )
      }
      columns={columns}
    >
      <AgentFormDialog
        open={showCreate || !!editingAgent}
        onClose={() => {
          setShowCreate(false);
          setEditingAgent(null);
        }}
        onCreated={() => {
          setShowCreate(false);
          refreshAgents();
          void loadAux();
        }}
        agent={editingAgent}
        onUpdated={() => {
          setEditingAgent(null);
          refreshAgents();
          void loadAux();
        }}
        allAgents={allAgents}
        customSkills={customSkills}
        modelCards={modelCards}
      />
      <ConfirmDialog
        open={!!archivingAgent}
        title="Отправить агента в архив?"
        message={`Агент станет доступен только для чтения, новые сессии с ним создать нельзя. ${t.agents.confirmDelete}`}
        confirmLabel={t.common.archive}
        destructive
        busy={archiveBusy}
        onConfirm={() => void confirmArchive()}
        onCancel={() => setArchivingAgent(null)}
      />
    </DataTable>
  );
}
