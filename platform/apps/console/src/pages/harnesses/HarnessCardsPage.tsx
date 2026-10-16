import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { CheckIcon, CopyIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DataTable, type ColumnDef } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { LoadError } from "../../components/LoadError";
import { Page } from "../../components/Page";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { HARNESS_CARD_DRAFT_STATE_KEY } from "../../lib/assistant/drafts";
import { useHarnesses, type HarnessEntry } from "../../lib/catalog-api";
import {
  isHarnessCardsUnsupported,
  useDeleteHarnessCard,
  useHarnessCards,
  type HarnessCard,
} from "../../lib/harness-cards-api";
import { formatDate, formatDateTime } from "../agents/format";
import { harnessLabel, protocolLabel, statusLabel } from "../agents/harness-text";
import { HarnessCardDialog } from "./HarnessCardDialog";

const DESCRIPTION =
  "Программа, которая ведёт ход агента. Встроенные варианты есть всегда, свой harness запускается в VM окружения по протоколу ACP.";

/** Чип статуса записи каталога. Причину недоступности даёт подсказка. */
function StatusChip({ entry }: { entry: Pick<HarnessEntry, "status" | "reason"> }) {
  if (entry.status === "ready") return <Badge variant="success">{statusLabel("ready")}</Badge>;
  if (entry.status === "unavailable") {
    return (
      <Badge variant="warning" title={entry.reason ?? undefined}>
        {statusLabel("unavailable")}
        {entry.reason && <span className="sr-only">: {entry.reason}</span>}
      </Badge>
    );
  }
  return <Badge variant="neutral">{statusLabel("unverified")}</Badge>;
}

function ProtocolChips({ protocols }: { protocols: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {protocols.map((protocol) => (
        <Badge key={protocol} variant="neutral">
          {protocolLabel(protocol)}
        </Badge>
      ))}
    </span>
  );
}

/** Встроенные записи только для чтения: название, ID, протоколы, статус. */
function BuiltinSection() {
  const catalog = useHarnesses();
  const builtin = (catalog.data?.data ?? []).filter((entry) => entry.source === "builtin");

  return (
    <section aria-labelledby="harness-builtin-title">
      <h2 id="harness-builtin-title" className="section-title mb-3">
        Встроенные
      </h2>
      <div className="card min-w-0 overflow-hidden">
        {catalog.isError && !catalog.data ? (
          <LoadError
            size="sm"
            title="Не удалось загрузить встроенные harness"
            message={catalog.error instanceof Error ? catalog.error.message : "Повторите попытку."}
            onRetry={() => void catalog.refetch()}
            retrying={catalog.isFetching}
          />
        ) : (
          <div className="console-detail-table-wrap">
            <Table container={false} className="console-detail-table" style={{ minWidth: 0 }}>
              <TableHeader variant="wireless">
                <TableRow variant="wireless">
                  <TableHead className="w-[38%]">Название</TableHead>
                  <TableHead className="w-[20%]">ID</TableHead>
                  <TableHead className="hidden w-[26%] sm:table-cell">Протоколы</TableHead>
                  <TableHead>Статус</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalog.isPending
                  ? Array.from({ length: 4 }).map((_, index) => (
                      <TableRow variant="wireless" key={index} aria-hidden="true">
                        <TableCell>
                          <Skeleton className="h-4 w-[70%]" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-[60%]" />
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Skeleton className="h-4 w-[60%]" />
                        </TableCell>
                        <TableCell>
                          <Skeleton className="h-4 w-[50%]" />
                        </TableCell>
                      </TableRow>
                    ))
                  : builtin.map((entry) => (
                      <TableRow variant="wireless" key={entry.id}>
                        <TableCell className="truncate font-medium text-ddc-heading" title={harnessLabel(entry)}>
                          {harnessLabel(entry)}
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-xs text-ddc-text-muted">{entry.id}</span>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <ProtocolChips protocols={entry.protocols} />
                        </TableCell>
                        <TableCell>
                          <StatusChip entry={entry} />
                        </TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}

/** ID моноширинным шрифтом и кнопка копирования. Клик по ней не открывает правку строки. */
function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Не удалось скопировать ID");
    }
  };
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-xs" title={id}>
        {id}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Скопировать ID ${id}`}
        title="Скопировать ID"
        className="text-ddc-icon-muted"
        onClick={(event) => {
          event.stopPropagation();
          void copy();
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </span>
  );
}

function PackageChips({ install }: { install: HarnessCard["install"] }) {
  const items = [
    ...install.npm.map((name) => `npm ${name}`),
    ...install.pip.map((name) => `pip ${name}`),
  ];
  if (items.length === 0) return <span className="text-ddc-placeholder">Нет</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => (
        <Badge key={item} variant="neutral" className="max-w-full font-mono">
          <span className="truncate">{item}</span>
        </Badge>
      ))}
    </span>
  );
}

/**
 * Страница «Harness» (раздел 6.7 контракта docs/plans/models-harness.md).
 * Сверху встроенные записи каталога только для чтения, ниже свои карточки в
 * таблице с созданием, правкой и удалением. Агенты, которые уже используют
 * удалённую карточку, продолжают работать, поэтому удаление только скрывает её.
 */
export function HarnessCardsPage() {
  const [search, setSearch] = useState("");
  const cards = useHarnessCards({ q: search });
  const remove = useDeleteHarnessCard();
  const unsupported = isHarnessCardsUnsupported(cards.error);

  // Цель окна не сбрасываем при закрытии: текст окна не должен пропасть, пока
  // оно уходит с экрана.
  const [dialog, setDialog] = useState<{ open: boolean; card: HarnessCard | null; draft?: unknown }>({
    open: false,
    card: null,
  });

  // Черновик ассистента приходит в состоянии маршрута, не в адресе. Окно
  // фильтрует его ещё раз. После открытия состояние сбрасываем: обновление
  // страницы не должно открывать окно снова.
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const state = location.state as Record<string, unknown> | null;
    const raw = state?.[HARNESS_CARD_DRAFT_STATE_KEY];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
    setDialog({ open: true, card: null, draft: raw });
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.state, location.pathname, location.search, navigate]);
  const [deleteTarget, setDeleteTarget] = useState<HarnessCard | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const openCreate = () => setDialog({ open: true, card: null, draft: undefined });
  const openEdit = (card: HarnessCard) => setDialog({ open: true, card });
  const askDelete = (card: HarnessCard) => {
    setDeleteTarget(card);
    setDeleteOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await remove.mutateAsync(deleteTarget.id);
      setDeleteOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Не удалось удалить harness");
    }
  };

  const columns = useMemo<ColumnDef<HarnessCard>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Название",
        size: 220,
        meta: { grow: true },
        enableHiding: false,
        cell: ({ row }) => (
          <span className="truncate font-medium text-ddc-heading" title={row.original.name}>
            {row.original.name}
          </span>
        ),
      },
      {
        id: "harness_id",
        accessorKey: "harness_id",
        header: "ID",
        size: 210,
        enableHiding: false,
        cell: ({ row }) => <CopyableId id={row.original.harness_id} />,
      },
      {
        id: "command",
        accessorFn: (card) => [card.command, ...card.args].join(" "),
        header: "Команда",
        size: 240,
        meta: { priority: 4 },
        cell: ({ getValue }) => (
          <span className="truncate font-mono text-xs text-ddc-text-muted" title={String(getValue())}>
            {String(getValue())}
          </span>
        ),
      },
      {
        id: "protocols",
        accessorFn: (card) => card.protocols.join(","),
        header: "Протоколы",
        size: 280,
        meta: { priority: 3 },
        cell: ({ row }) => <ProtocolChips protocols={row.original.protocols} />,
      },
      {
        id: "packages",
        accessorFn: (card) => [...card.install.npm, ...card.install.pip].join(","),
        header: "Пакеты",
        size: 240,
        meta: { priority: 5 },
        cell: ({ row }) => <PackageChips install={row.original.install} />,
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Статус",
        size: 140,
        cell: () => <Badge variant="neutral">{statusLabel("unverified")}</Badge>,
      },
      {
        id: "updated",
        accessorFn: (card) => card.updated_at,
        header: "Обновлён",
        size: 150,
        meta: { priority: 2 },
        cell: ({ row }) => (
          <span className="text-ddc-text-muted tabular-nums">
            {formatDateTime(row.original.updated_at)}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (card) => card.created_at,
        header: "Создан",
        size: 120,
        meta: { priority: 1 },
        cell: ({ row }) => (
          <span className="text-ddc-text-muted tabular-nums">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <Page
      header={
        <PageHeader
          title="Harness"
          description={DESCRIPTION}
          actions={
            <Button onClick={openCreate} disabled={unsupported}>
              <PlusIcon />
              Новый harness
            </Button>
          }
        />
      }
    >
      <div className="console-detail-stack">
        <BuiltinSection />

        <section aria-labelledby="harness-own-title">
          <h2 id="harness-own-title" className="section-title mb-3">
            Свои
          </h2>
          {unsupported ? (
            <div className="card">
              <EmptyState
                size="sm"
                title="Свои harness недоступны"
                body={cards.error instanceof Error ? cards.error.message : undefined}
              />
            </div>
          ) : cards.error && cards.items.length === 0 ? (
            <div className="card">
              <LoadError
                size="sm"
                title="Не удалось загрузить свои harness"
                message={cards.error.message}
                onRetry={cards.refresh}
              />
            </div>
          ) : (
            // Таблица списка рассчитана на всю страницу. Здесь она идёт после
            // блока встроенных записей, поэтому её собственные поля и высота
            // отключены: страница прокручивается целиком.
            <div className="[&_.console-list-page]:h-auto [&_.console-list-page]:min-h-0 [&_.console-list-page]:p-0">
              <DataTable<HarnessCard>
                columns={columns}
                data={cards.items}
                getRowId={(card) => card.id}
                loading={cards.isLoading}
                defaultHiddenColumns={["created"]}
                searchPlaceholder="Поиск harness…"
                searchValue={search}
                onSearchChange={setSearch}
                onRowClick={openEdit}
                rowActions={(card) => [
                  { label: "Изменить", icon: <PencilIcon />, onSelect: () => openEdit(card) },
                  {
                    label: "Удалить",
                    icon: <Trash2Icon />,
                    destructive: true,
                    onSelect: () => askDelete(card),
                  },
                ]}
                hasMore={cards.hasMore}
                loadingMore={cards.isLoadingMore}
                onLoadMore={cards.loadMore}
                emptyTitle={search ? "Harness не найдены" : "Своих harness нет"}
                emptySubtitle={
                  search
                    ? "Измените поисковый запрос."
                    : "Добавьте ACP-агента, которого нет среди встроенных."
                }
                emptyAction={
                  !search && (
                    <Button onClick={openCreate}>
                      <PlusIcon />
                      Новый harness
                    </Button>
                  )
                }
              />
            </div>
          )}
        </section>
      </div>

      <HarnessCardDialog
        open={dialog.open}
        card={dialog.card}
        draft={dialog.draft}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
      />

      <ConfirmDialog
        open={deleteOpen}
        title={deleteTarget ? `Удалить harness «${deleteTarget.name}»?` : "Удалить harness?"}
        message="Новых агентов на нём создать будет нельзя. Агенты, которые его уже используют, продолжат работать."
        confirmLabel="Удалить"
        destructive
        busy={remove.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteOpen(false)}
      />
    </Page>
  );
}
