import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { TrashIcon, XCircleIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PopoverContent } from "@/components/ui/popover";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { useI18n } from "../i18n";
import { EvalStatusPill, evalStatusLabel, type EvalStatus } from "./eval-status";
import { EMPTY, formatAgo, formatDateTime, formatSpan } from "./ru-format";

interface EvalRunSummary {
  id: string;
  agent_id: string;
  environment_id: string;
  status: EvalStatus;
  started_at: string;
  ended_at?: string;
  error?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  tasks: Array<{
    id: string;
    status: string;
    trial_pass_count?: number;
    trial_total?: number;
  }>;
}

type StatusValue = "any" | EvalStatus;

/** Значение фильтра и его подпись. «Все» берётся из словаря. */
const STATUS_VALUES: StatusValue[] = ["any", "pending", "running", "completed", "failed"];

function passRateStr(r: EvalRunSummary): string {
  let pass = 0;
  let total = 0;
  for (const t of r.tasks) {
    pass += t.trial_pass_count ?? 0;
    total += t.trial_total ?? 0;
  }
  if (total === 0) return EMPTY;
  return `${pass}/${total}`;
}

/** Действие над строкой, которое ждёт подтверждения. */
type PendingAction = { kind: "cancel" | "delete"; run: EvalRunSummary };

export function EvalRunsList() {
  const nav = useNavigate();
  const { api } = useApi();
  const { t } = useI18n();

  const statusOptions = STATUS_VALUES.map((value) => ({
    value,
    label: value === "any" ? t.common.all : evalStatusLabel(value),
  }));

  // Server-driven status filter. "any" → omit the param entirely so the
  // server returns all runs; anything else is whitelisted by the route's
  // strict enum validator (400 on typo).
  const [status, setStatus] = useState<StatusValue>("any");
  const [search, setSearch] = useState("");

  const params = useMemo(
    () => ({
      limit: "100",
      ...(status !== "any" ? { status } : {}),
    }),
    [status],
  );

  // Auto-poll every 5s only while at least one run is still pending or
  // running. TQ inspects the cached `data` on each tick to decide, so a
  // run reaching a terminal state pauses the poll on its own — matches
  // the previous `anyActive` guard without the manual setInterval +
  // cancelled flag dance.
  const { data: runsRes, isLoading: loading, refetch } = useApiQuery<{ data: EvalRunSummary[] }>(
    "/v1/oma/evals/runs",
    params,
    {
      refetchInterval: (query) => {
        const data = query.state.data as { data: EvalRunSummary[] } | undefined;
        const anyActive = !!data?.data.some(
          (r) => r.status === "pending" || r.status === "running",
        );
        return anyActive ? 5_000 : false;
      },
    },
  );
  const allRuns = runsRes?.data ?? [];
  const runs = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return needle
      ? allRuns.filter((run) => run.id.toLocaleLowerCase().includes(needle))
      : allRuns;
  }, [allRuns, search]);

  // TanStack column defs. Order, filtering, and search all flow through
  // server params — no per-column sort/filter UI. Required columns (id,
  // status) opt out of the Columns hide menu so the user can't end up
  // with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<EvalRunSummary>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-ddc-label">
            {row.original.id}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "status",
        accessorKey: "status",
        header: t.common.status,
        cell: ({ row }) => <EvalStatusPill status={row.original.status} />,
        enableHiding: false,
      },
      {
        id: "pass_rate",
        accessorFn: (r) => passRateStr(r),
        header: "Результат",
        cell: ({ row }) => (
          <span className="font-medium text-ddc-text tabular-nums">{passRateStr(row.original)}</span>
        ),
      },
      {
        id: "tasks",
        accessorFn: (r) => `${r.completed_count}/${r.task_count}`,
        header: "Задачи",
        cell: ({ row }) => (
          <span className="text-ddc-label tabular-nums">
            {row.original.completed_count}/{row.original.task_count}
            {row.original.failed_count > 0 && (
              <span className="text-error ml-1">({row.original.failed_count} с ошибкой)</span>
            )}
          </span>
        ),
      },
      {
        id: "duration",
        accessorFn: (r) => formatSpan(r.started_at, r.ended_at),
        header: "Длительность",
        cell: ({ row }) => (
          <span className="text-ddc-label tabular-nums">
            {formatSpan(row.original.started_at, row.original.ended_at)}
          </span>
        ),
      },
      {
        id: "started",
        accessorFn: (r) => r.started_at,
        header: "Запущен",
        cell: ({ row }) => (
          <span title={formatDateTime(row.original.started_at)} className="text-ddc-label tabular-nums">
            {formatAgo(row.original.started_at)}
          </span>
        ),
      },
      {
        id: "agent",
        accessorKey: "agent_id",
        header: t.dashboard.agent,
        cell: ({ row }) => (
          <span className="font-mono text-xs text-ddc-label">{row.original.agent_id}</span>
        ),
      },
    ],
    [t],
  );

  // Отмена и удаление спрашивают подтверждение в окне (правило 11 DDC).
  // Цель не сбрасывается при закрытии, чтобы заголовок не мигал.
  const [target, setTarget] = useState<PendingAction | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const ask = (kind: PendingAction["kind"], run: EvalRunSummary) => {
    setTarget({ kind, run });
    setConfirmOpen(true);
  };
  const confirmAction = useAsyncAction(async () => {
    if (!target) return;
    try {
      await api(`/v1/oma/evals/runs/${target.run.id}`, { method: "DELETE" });
      void refetch();
    } catch {
      // Ошибку уже показал api() тостом.
    } finally {
      setConfirmOpen(false);
    }
  });

  // Active-filter chip display — kept null when matching the default so
  // the chip reads "Status ▾" rather than "Status: All ▾". The clear-X
  // only renders when the chip is in non-default state.
  const statusDisplay =
    status === "any" ? undefined : statusOptions.find((o) => o.value === status)?.label;

  const filters = (
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
          options={statusOptions}
          value={status}
          onValueChange={(v) => setStatus(v as StatusValue)}
          searchPlaceholder={`${t.common.status}…`}
        />
      </PopoverContent>
    </FilterChip>
  );

  return (
    <DataTable<EvalRunSummary>
      defaultHiddenColumns={[]}
      title={t.nav.evalRuns}
      subtitle="Проверки агентов на наборах задач: результат, длительность и статус каждого запуска."
      searchPlaceholder={t.evals.searchEvalRuns}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={runs}
      loading={loading}
      getRowId={(r) => r.id}
      onRowClick={(r) => nav(`/evals/${r.id}`)}
      rowActions={(run) => [
        {
          label: "Отменить запуск",
          icon: <XCircleIcon className="size-4" />,
          disabled: run.status !== "pending" && run.status !== "running",
          onSelect: () => ask("cancel", run),
        },
        {
          label: t.common.delete,
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: () => ask("delete", run),
        },
      ]}
      columns={columns}
      emptyTitle={
        status === "any" && !search.trim() ? t.evals.noEvalRunsYet : t.evals.noMatchingEvalRuns
      }
      emptyKind="eval"
      emptySubtitle={
        status === "any" && !search.trim() ? (
          <p>
            Создайте запуск через{" "}
            <code className="rounded-md bg-ddc-surface-sunken px-1.5 py-0.5 font-mono text-xs text-ddc-label">POST /v1/oma/evals/runs</code>{" "}
            или командой{" "}
            <code className="rounded-md bg-ddc-surface-sunken px-1.5 py-0.5 font-mono text-xs text-ddc-label">npx tsx rl/tasks/terminal-bench/run-cloud.ts</code>.
          </p>
        ) : (
          "Сбросьте фильтр по статусу или измените поисковый запрос."
        )
      }
    >
      <ConfirmDialog
        open={confirmOpen && !!target}
        title={target?.kind === "delete" ? "Удалить запуск оценки?" : "Отменить запуск оценки?"}
        message={
          target?.kind === "delete"
            ? `Запуск ${target.run.id}. Действие нельзя отменить.`
            : `Запуск ${target?.run.id ?? ""}. Выполняемые задачи будут помечены как неудачные.`
        }
        confirmLabel={target?.kind === "delete" ? t.common.delete : "Отменить запуск"}
        cancelLabel={target?.kind === "delete" ? t.common.cancel : "Назад"}
        destructive
        busy={confirmAction.loading}
        onConfirm={() => void confirmAction.run()}
        onCancel={() => setConfirmOpen(false)}
      />
    </DataTable>
  );
}
