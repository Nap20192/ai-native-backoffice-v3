import { formatDate } from "../lib/date-format";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, ArchiveRestoreIcon, TrashIcon, PlusIcon } from "lucide-react";
import type { BetaEnvironment as Env } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { Modal } from "../components/Modal";
import { DangerDialog } from "../components/DangerDialog";
import { Field } from "../components/Field";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { Select, SelectOption } from "../components/Select";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { useI18n } from "../i18n";
import { EMPTY_TEMPLATE_ID, pickTemplate, templatesFor } from "../lib/environment-templates";
import { useSandboxCatalog } from "../lib/sandbox-catalog";
import { TemplatePicker } from "./environments/TemplatePicker";

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "Все" },
  { value: "active", label: "Активные" },
  { value: "archived", label: "В архиве" },
];

/** Подписи типов окружения. Неизвестный тип показываем как есть. */
const ENV_TYPE_LABEL: Record<string, string> = {
  cloud: "Облако",
  self_hosted: "Свой сервер",
};

export function EnvironmentsList() {
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const emptyForm = {
    name: "",
    description: "",
    template: EMPTY_TEMPLATE_ID,
  };
  const [form, setForm] = useState(emptyForm);
  // Шаблоны приходят из каталога сервера. Запрос идёт при открытии страницы, к
  // моменту нажатия «Новое окружение» ответ уже в кэше.
  const sandboxCatalog = useSandboxCatalog();
  const templates = useMemo(
    () => templatesFor({ catalog: sandboxCatalog.catalog, isLoading: sandboxCatalog.isLoading }),
    [sandboxCatalog.catalog, sandboxCatalog.isLoading],
  );
  const selectedTemplate = pickTemplate(templates, form.template);
  // Архив и удаление идут через DangerDialog со списком зависимостей.
  const [archiveTarget, setArchiveTarget] = useState<Env | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Env | null>(null);

  // Фильтры идут на сервер: каждое значение попадает в envsParams,
  // useInfiniteApiQuery при смене параметров возвращается на первую
  // страницу, и список показывает ровно то, что вернул сервер.
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const envsParams = useMemo(
    () => ({
      ...(status !== "active" ? { include_archived: "true" } : {}),
    }),
    [status],
  );

  const {
    items: envs,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useInfiniteApiQuery<Env>("/v1/environments", { limit: 20, params: envsParams });
  const visibleEnvs = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return envs.filter((environment) => {
      if (status === "active" && environment.archived_at) return false;
      if (status === "archived" && !environment.archived_at) return false;
      const createdAt = Date.parse(environment.created_at);
      if (created.after !== undefined && createdAt < created.after) return false;
      if (created.before !== undefined && createdAt > created.before) return false;
      return !needle || `${environment.name}\n${environment.id}`.toLocaleLowerCase().includes(needle);
    });
  }, [created.after, created.before, envs, search, status]);

  const create = async () => {
    setCreating(true);
    try {
      await managedApi.environments.create({
        name: form.name,
        ...selectedTemplate.fields,
        description: form.description || undefined,
      });
      setShowCreate(false);
      setForm(emptyForm);
      load();
    } catch {
      // Ошибку уже показал клиент API, окно остаётся открытым.
    } finally {
      setCreating(false);
    }
  };

  const restore = async (environment: Env) => {
    try {
      await managedApi.environments.unarchive(environment.id);
      load();
    } catch {
      // Ошибку уже показал клиент API.
    }
  };

  // Порядок, фильтры и поиск идут через серверные параметры, поэтому
  // сортировки и фильтров по столбцам нет. Обязательные столбцы (id,
  // название) нельзя скрыть через меню «Столбцы».
  const columns = useMemo<ColumnDef<Env>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: t.common.name,
        size: 240,
        meta: { grow: true },
        cell: ({ row }) => (
          <span title={row.original.name} className="min-w-0 truncate font-medium text-ddc-heading">
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
          <span title={row.original.id} className="truncate font-mono text-xs text-ddc-text-muted">
            {row.original.id}
          </span>
        ),
      },
      {
        id: "type",
        accessorFn: (e) => (e.config?.type as string) || "cloud",
        header: "Тип",
        cell: ({ row }) => {
          const type = (row.original.config?.type as string) || "cloud";
          return <span className="text-ddc-text-muted">{ENV_TYPE_LABEL[type] ?? type}</span>;
        },
      },
      {
        id: "status",
        accessorFn: (e) => (e.archived_at ? "archived" : "active"),
        header: t.common.status,
        cell: ({ row }) =>
          row.original.archived_at ? (
            <span className="chip tone-ghost">{t.common.archived}</span>
          ) : (
            <span className="chip tone-success">Активно</span>
          ),
      },
      {
        id: "created",
        accessorFn: (e) => e.created_at,
        header: t.common.created,
        cell: ({ row }) => (
          <span className="tabular-nums text-ddc-text-muted">
            {formatDate(row.original.created_at)}
          </span>
        ),
      },
    ],
    [t],
  );

  // Подпись активного фильтра пуста, пока выбрано значение по умолчанию:
  // чип читается как «Статус», а не «Статус: Все».
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
            searchPlaceholder="Найти статус…"
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  return (
    <DataTable<Env>
      title={t.nav.environments}
      subtitle="Изолированные песочницы, в которых агенты выполняют код."
      createLabel={t.environments.newEnvironment}
      onCreate={() => setShowCreate(true)}
      searchPlaceholder={t.environments.searchEnvironments}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={visibleEnvs}
      loading={loading}
      getRowId={(e) => e.id}
      onRowClick={(e) => nav(`/environments/${e.id}`)}
      rowActions={(environment) => [
        environment.archived_at
          ? {
              label: t.common.unarchive,
              icon: <ArchiveRestoreIcon className="size-4" />,
              onSelect: () => void restore(environment),
            }
          : {
              label: t.common.archive,
              icon: <ArchiveIcon className="size-4" />,
              onSelect: () => setArchiveTarget(environment),
            },
        {
          label: t.common.delete,
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: () => setDeleteTarget(environment),
        },
      ]}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? t.environments.noMatchingEnvironments : t.environments.noEnvironmentsYet}
      emptyKind="env"
      emptyAction={
        !search && <Button onClick={() => setShowCreate(true)}><PlusIcon />{t.environments.newEnvironment}</Button>
      }
      emptySubtitle={
        search
          ? t.agents.tryDifferentSearch
          : "Окружение даёт агентам изолированную песочницу для выполнения кода."
      }
      columns={columns}
    >
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Новое окружение"
        subtitle="Окружения дают изолированные песочницы для выполнения кода."
        maxWidth="max-w-3xl"
        closeDisabled={creating}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)} disabled={creating}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={create}
              disabled={!form.name || !selectedTemplate.available}
              loading={creating}
            >
              {t.common.create}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label={t.common.name}
            hint={<span className="tabular-nums">{form.name.length}/50 символов</span>}
          >
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, 50) })}
              placeholder="Рабочее окружение"
            />
          </Field>
          <Field label="Тип размещения" hint="После создания изменить нельзя.">
            <Select value="cloud" onValueChange={() => {}} disabled>
              <SelectOption value="cloud">Облако</SelectOption>
            </Select>
          </Field>
          <div>
            <div className="label" id="env-template-label">Шаблон</div>
            <TemplatePicker
              labelId="env-template-label"
              templates={templates}
              value={selectedTemplate.id}
              onChange={(template) => setForm({ ...form, template })}
              loading={sandboxCatalog.isLoading}
            />
          </div>
          <Field label="Описание (необязательно)">
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              placeholder="Для чего нужно это окружение"
              className="resize-y"
            />
          </Field>
        </div>
      </Modal>

      <DangerDialog
        open={archiveTarget !== null}
        operation="archive"
        target={archiveTarget ? { kind: "environment", id: archiveTarget.id } : null}
        etagPath={archiveTarget ? `/v1/environments/${archiveTarget.id}` : undefined}
        title="Отправить окружение в архив?"
        message={archiveTarget ? `Окружение «${archiveTarget.name}» перестанет выбираться для новых сессий.` : undefined}
        confirmLabel={t.common.archive}
        run={(options) => managedApi.environments.archive(archiveTarget!.id, options)}
        onDone={() => {
          setArchiveTarget(null);
          load();
        }}
        onClose={() => setArchiveTarget(null)}
      />
      <DangerDialog
        open={deleteTarget !== null}
        operation="delete"
        target={deleteTarget ? { kind: "environment", id: deleteTarget.id } : null}
        etagPath={deleteTarget ? `/v1/environments/${deleteTarget.id}` : undefined}
        title={`Удалить окружение «${deleteTarget?.name ?? ""}»?`}
        message="Окружение будет удалено вместе с настройками."
        run={(options) => managedApi.environments.delete(deleteTarget!.id, options)}
        onDone={() => {
          setDeleteTarget(null);
          load();
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </DataTable>
  );
}
