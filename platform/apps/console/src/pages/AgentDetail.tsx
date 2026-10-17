import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  HistoryIcon,
  PencilIcon,
  RocketIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { useOptionalAssistant } from "../components/assistant/AssistantProvider";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DangerDialog } from "../components/DangerDialog";
import { EmptyState } from "../components/EmptyState";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ModelCard } from "@open-managed-agents/api-types";
import { useModelOptions, type ModelOption } from "../lib/catalog-api";
import type { AgentRecord as Agent } from "../types/agent";
import { findModel } from "./agents/agent-model";
import { AgentFormDialog } from "./agents/AgentFormDialog";
import { formatDateTime, speedLabel, toolLabel } from "./agents/format";
import { restoreVersionBody } from "./agents/restore-version";
import { effortLabel, effortOf, sourceLabel } from "./agents/model-format";
import { useCrumbName } from "../lib/crumb-names";
import { useI18n } from "../i18n";

export function AgentDetail() {
  const { id } = useParams();
  const { api } = useApi();
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const assistant = useOptionalAssistant();

  const [showEdit, setShowEdit] = useState(false);
  const [askArchive, setAskArchive] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState<Agent | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);

  // Запросы одной записи через TanStack Query. `enabled: !!id` откладывает
  // запрос, пока в адресе нет id.
  const enabled = !!id;
  const { data: managedAgent, error: agentError } = useApiQuery<Agent>(
    id ? `/v1/agents/${id}` : null,
    undefined,
    { enabled },
  );
  const { data: versionsRes } = useApiQuery<{ data: Agent[] }>(
    id ? `/v1/agents/${id}/versions` : null,
    undefined,
    { enabled },
  );
  // Aux data for the edit dialog pickers — same sources as AgentsList.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await managedApi.agents.list({
          limit: 200,
          include_archived: true,
        });
        if (!cancelled) setAllAgents(all.data ?? []);
      } catch (e) {
        console.warn("[AgentDetail] /v1/agents aux fetch failed", e);
      }
      await Promise.allSettled([
        (async () => {
          const sk = await managedApi.skills.list({ limit: 200 });
          if (!cancelled) {
            setCustomSkills(
              (sk.data ?? []).map((skill) => ({
                id: skill.id,
                name: skill.display_title || skill.id,
                description: "",
              })),
            );
          }
        })().catch((e) => console.warn("[AgentDetail] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/oma/model_cards?limit=200");
          if (!cancelled) setModelCards(mc.data ?? []);
        })().catch((e) => console.warn("[AgentDetail] /v1/oma/model_cards aux fetch failed", e)),
      ]);
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const agent = managedAgent;
  const versions = versionsRes?.data ?? [];

  // Каталог нужен подписи модели. Пока он грузится или не пришёл, строка
  // показывает значение из самого агента.
  const modelsQuery = useModelOptions();
  const modelOption = findModel(modelsQuery.data?.data, modelIdOf(agent?.model));
  useCrumbName(id, agent?.name);
  const error = agentError instanceof Error ? agentError.message : agentError ? String(agentError) : "";

  const modelStr = (m: Agent["model"]) =>
    typeof m === "string" ? m : `${m?.id} (${speedLabel(m?.speed)})`;

  const refreshAgent = () => {
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: [`/v1/agents/${id}`] });
    void queryClient.invalidateQueries({ queryKey: [`/v1/agents/${id}/versions`] });
    void queryClient.invalidateQueries({ queryKey: ["/v1/agents"] });
  };

  // Архив и удаление идут через DangerDialog со списком зависимостей. Версия
  // агента служит значением If-Match (docs/plans/crud.md, 1.4).
  const unarchive = async () => {
    if (!id || !agent) return;
    try {
      await managedApi.agents.unarchive(id, { ifMatch: `"${agent.version}"` });
      refreshAgent();
    } catch {
      // Сообщение об ошибке уже показал useApi.
    }
  };

  const restoreVersion = async () => {
    if (!id || !agent || !restoringVersion) return;
    setRestoreBusy(true);
    try {
      await managedApi.agents.update(
        id,
        restoreVersionBody(restoringVersion as unknown as Record<string, unknown>, agent.version),
      );
      setRestoringVersion(null);
      refreshAgent();
    } catch {
      // Сообщение об ошибке уже показал useApi, окно остаётся для новой попытки.
    } finally {
      setRestoreBusy(false);
    }
  };

  if (error) {
    return (
      <Page>
        <EmptyState
          tone="danger"
          icon={<TriangleAlertIcon />}
          title="Не удалось загрузить агента"
          body={<span role="alert">{error}</span>}
          action={
            <Button variant="outline" onClick={() => nav("/agents")}>
              К списку агентов
            </Button>
          }
        />
      </Page>
    );
  }
  if (!agent) return <AgentDetailSkeleton />;

  const archived = !!agent.archived_at;
  const toolsLabel = (agent.tools || []).map((tool: any) => toolLabel(tool)).join(", ") || "Нет";

  return (
    <Page
      layout="rail"
      header={
        <PageHeader
          title={
            <>
              <span className="min-w-0">{agent.name}</span>
              {archived && <Badge variant="neutral">{t.common.archived}</Badge>}
            </>
          }
          description={agent.description || undefined}
          actions={
            <>
              {!archived && assistant && (
                <Button variant="outline" onClick={() => assistant.setOpen(true)} aria-keyshortcuts="Control+I">
                  <SparklesIcon />
                  Править с ассистентом
                </Button>
              )}
              {!archived && (
                <Button variant="outline" onClick={() => setShowEdit(true)}>
                  <PencilIcon />
                  {t.common.edit}
                </Button>
              )}
              {!archived && (
                <Button variant="outline" onClick={() => nav(`/deployments/new?agent=${agent.id}`)}>
                  <RocketIcon />
                  Создать деплоймент
                </Button>
              )}
              {archived ? (
                <Button variant="outline" onClick={() => void unarchive()}>
                  <ArchiveRestoreIcon />
                  {t.common.unarchive}
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setAskArchive(true)}>
                  <ArchiveIcon />
                  {t.common.archive}
                </Button>
              )}
              <Button variant="outline" onClick={() => setAskDelete(true)}>
                <Trash2Icon />
                {t.common.delete}
              </Button>
            </>
          }
        />
      }
      rail={
        <section className="console-property-group" aria-label="Свойства агента">
          <h2 className="console-property-group-title">Свойства</h2>
          <dl className="console-property-list">
            <PropertyRow label="ID"><span className="font-mono">{agent.id}</span></PropertyRow>
            <PropertyRow label="Модель">
              <ModelSummary model={agent.model} option={modelOption} />
            </PropertyRow>
            <PropertyRow label="Версия"><span className="tabular-nums">v{agent.version}</span></PropertyRow>
            <PropertyRow label="Инструменты">{toolsLabel}</PropertyRow>
            <PropertyRow label="Создан">
              <span className="tabular-nums">{formatDateTime(agent.created_at)}</span>
            </PropertyRow>
            <PropertyRow label="Обновлён">
              <span className="tabular-nums">
                {formatDateTime(agent.updated_at || agent.created_at)}
              </span>
            </PropertyRow>
            {agent.archived_at && (
              <PropertyRow label="В архиве">
                <span className="tabular-nums text-ddc-warning-text">
                  {formatDateTime(agent.archived_at)}
                </span>
              </PropertyRow>
            )}
          </dl>
        </section>
      }
    >
      <div className="console-detail-stack">
        {/* Системный промпт */}
        {agent.system && (
          <section className="card min-w-0 overflow-hidden" aria-labelledby="agent-system-title">
            <header className="border-b border-ddc-divider px-5 py-4">
              <h2 id="agent-system-title" className="section-title">
                Системный промпт
              </h2>
            </header>
            <div className="p-5">
              <pre className="console-detail-code-block">{agent.system}</pre>
            </div>
          </section>
        )}

        {/* История версий */}
        {versions.length > 0 && (
          <section
            className="card min-w-0 overflow-hidden"
            aria-labelledby="agent-versions-title"
          >
            <header className="border-b border-ddc-divider px-5 py-4">
              <h2 id="agent-versions-title" className="section-title">
                История версий
              </h2>
            </header>
            <div className="console-detail-table-wrap">
              <Table container={false} className="console-detail-table" style={{ minWidth: 0 }}>
                <TableHeader variant="wireless">
                  <TableRow variant="wireless">
                    <TableHead>Версия</TableHead>
                    <TableHead>Модель</TableHead>
                    <TableHead className="hidden md:table-cell">Системный промпт</TableHead>
                    {!archived && <TableHead className="w-px"><span className="sr-only">Действия</span></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow variant="wireless" key={v.version}>
                      <TableCell className="tabular-nums">
                        v{v.version}
                        {v.version === agent.version && (
                          <Badge variant="brand" className="ml-2">Текущая</Badge>
                        )}
                      </TableCell>
                      <TableCell className="truncate text-ddc-text-muted" title={modelStr(v.model)}>
                        {modelStr(v.model)}
                      </TableCell>
                      <TableCell
                        className="hidden max-w-xs truncate text-ddc-text-muted md:table-cell"
                        title={v.system || undefined}
                      >
                        {v.system || <span className="text-ddc-placeholder">Не задан</span>}
                      </TableCell>
                      {!archived && (
                        <TableCell className="text-right">
                          {v.version !== agent.version && (
                            <Button
                              variant="ghost"
                              size="xs"
                              aria-label={`Восстановить версию ${v.version}`}
                              onClick={() => setRestoringVersion(v)}
                            >
                              <HistoryIcon />
                              Восстановить эту версию
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
      </div>

      <AgentFormDialog
        open={showEdit}
        onClose={() => setShowEdit(false)}
        agent={agent}
        onUpdated={() => {
          setShowEdit(false);
          refreshAgent();
        }}
        allAgents={allAgents}
        customSkills={customSkills}
        modelCards={modelCards}
      />

      <DangerDialog
        open={askArchive}
        operation="archive"
        target={{ kind: "agent", id: agent.id }}
        ifMatch={`"${agent.version}"`}
        title="Отправить агента в архив?"
        message="Агент станет доступен только для чтения, новые сессии с ним создать нельзя."
        confirmLabel={t.common.archive}
        run={(options) => managedApi.agents.archive(agent.id, options)}
        onDone={() => {
          setAskArchive(false);
          nav("/agents");
        }}
        onClose={() => setAskArchive(false)}
      />
      <DangerDialog
        open={askDelete}
        operation="delete"
        target={{ kind: "agent", id: agent.id }}
        ifMatch={`"${agent.version}"`}
        title="Удалить агента?"
        message="Агент и все его версии будут удалены. Сессии сохранят снимок агента."
        run={(options) => managedApi.agents.delete(agent.id, options)}
        onDone={() => {
          setAskDelete(false);
          nav("/agents");
        }}
        onClose={() => setAskDelete(false)}
      />
      <ConfirmDialog
        open={restoringVersion !== null}
        title={`Восстановить версию ${restoringVersion?.version ?? ""}?`}
        message="Содержимое этой версии станет новой текущей версией. Старые версии останутся в истории."
        confirmLabel="Восстановить"
        busy={restoreBusy}
        onConfirm={() => void restoreVersion()}
        onCancel={() => setRestoringVersion(null)}
      />
    </Page>
  );
}

/** Скелетон страницы агента: повторяет разметку (заголовок, свойства справа,
 *  секции слева), чтобы страница не прыгала, когда придут данные. */
function AgentDetailSkeleton() {
  return (
    <Page
      layout="rail"
      header={
        <div className="mb-6 space-y-2" aria-hidden="true">
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      }
      rail={
        <section className="console-property-group" aria-hidden="true">
          <Skeleton className="mb-3 h-6 w-24" />
          <div className="console-property-list">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="console-property-row">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>
        </section>
      }
    >
      <div className="console-detail-stack" aria-busy="true">
        <span role="status" className="sr-only">Загрузка…</span>
        <div className="card space-y-3 p-5" aria-hidden="true">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-32 w-full" />
        </div>
        <div className="card space-y-3 p-5" aria-hidden="true">
          <Skeleton className="h-6 w-32" />
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </Page>
  );
}

function modelIdOf(model: Agent["model"] | undefined): string {
  if (!model) return "";
  return typeof model === "string" ? model : (model.id ?? "");
}

/** Модель агента: название из каталога, handle, усилие, скорость, источник. */
function ModelSummary({
  model,
  option,
}: {
  model: Agent["model"];
  option: ModelOption | undefined;
}) {
  const id = modelIdOf(model);
  const effort = effortOf(model);
  const fast = typeof model === "object" && model?.speed === "fast";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        {option && option.label !== id && <span className="font-medium">{option.label}</span>}
        <span className="font-mono text-xs">{id}</span>
      </span>
      {(effort || fast || option) && (
        <span className="flex flex-wrap gap-1.5">
          {effort && <Badge variant="neutral">Усилие: {effortLabel(effort, { lower: true })}</Badge>}
          {fast && <Badge variant="neutral">Быстрая</Badge>}
          {option && <Badge variant="neutral">{sourceLabel(option.source)}</Badge>}
        </span>
      )}
    </div>
  );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="console-property-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
