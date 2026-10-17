import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { BetaManagedAgentsDeploymentRun } from "@anthropic-ai/sdk/resources/beta/deployment-runs";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { DangerDialog } from "../../components/DangerDialog";
import { EmptyState } from "../../components/EmptyState";
import { Page } from "../../components/Page";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { useI18n } from "../../i18n";
import { useCrumbName } from "../../lib/crumb-names";
import { useApiQuery } from "../../lib/useApiQuery";
import { formatDateTime } from "../agents/format";
import { useDeploymentActions } from "./deployment-actions";
import {
  deploymentState,
  initialMessageText,
  pausedReasonText,
  triggerText,
  type Deployment,
} from "./deployment-state";
import { StateBadge } from "./DeploymentsList";

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="console-property-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function runErrorText(run: BetaManagedAgentsDeploymentRun): string | null {
  return run.error ? run.error.message || run.error.type : null;
}

function RunsTab({ deploymentId }: { deploymentId: string }) {
  const runs = useApiQuery<{ data: BetaManagedAgentsDeploymentRun[] }>(
    "/v1/deployment_runs",
    { deployment_id: deploymentId, limit: "50" },
  );
  if (runs.isLoading) return <Skeleton className="h-24 w-full" />;
  const rows = runs.data?.data ?? [];
  if (rows.length === 0) {
    return <EmptyState size="sm" title="Прогонов пока нет" body="Прогон появляется при каждом запуске деплоймента." />;
  }
  return (
    <div className="console-detail-table-wrap">
      <Table container={false} className="console-detail-table" style={{ minWidth: 0 }}>
        <TableHeader variant="wireless">
          <TableRow variant="wireless">
            <TableHead>Запуск</TableHead>
            <TableHead>Триггер</TableHead>
            <TableHead>Сессия</TableHead>
            <TableHead>Результат</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((run) => {
            const error = runErrorText(run);
            return (
              <TableRow variant="wireless" key={run.id}>
                <TableCell className="tabular-nums">{formatDateTime(run.created_at)}</TableCell>
                <TableCell>{run.trigger_context.type === "schedule" ? "Расписание" : "Вручную"}</TableCell>
                <TableCell>
                  {run.session_id ? (
                    <Link className="link font-mono text-xs" to={`/sessions/${run.session_id}`}>
                      {run.session_id}
                    </Link>
                  ) : (
                    <span className="text-ddc-placeholder">Нет</span>
                  )}
                </TableCell>
                <TableCell>
                  {error ? <Badge variant="warning" title={error}>Ошибка</Badge> : <Badge variant="success">Создана сессия</Badge>}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Сервер запускает только активный деплоймент: на паузе POST /run отвечает 409. */
const RUN_NEEDS_ACTIVE = "Сначала продолжите деплоймент";

/** Карточка деплоймента (docs/plans/crud.md, 4.1). */
export function DeploymentDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { t } = useI18n();
  const actions = useDeploymentActions();
  const [askArchive, setAskArchive] = useState(false);

  const query = useApiQuery<Deployment>(id ? `/v1/deployments/${id}` : null, undefined, { enabled: !!id });
  const deployment = query.data;
  useCrumbName(id, deployment?.name);
  const agentQuery = useApiQuery<{ id: string; name: string }>(
    deployment ? `/v1/agents/${deployment.agent.id}` : null,
    undefined,
    { enabled: !!deployment },
  );
  const envQuery = useApiQuery<{ id: string; name: string }>(
    deployment ? `/v1/environments/${deployment.environment_id}` : null,
    undefined,
    { enabled: !!deployment },
  );

  const run = async (label: string, request: () => Promise<unknown>) => {
    try {
      await request();
      toast.success(label);
    } catch {
      // Сообщение об ошибке уже показал useApi.
    }
  };

  if (query.error) {
    return (
      <Page>
        <EmptyState
          tone="danger"
          icon={<TriangleAlertIcon />}
          title="Не удалось загрузить деплоймент"
          body={<span role="alert">{query.error instanceof Error ? query.error.message : "Повторите попытку."}</span>}
          action={<Button variant="outline" onClick={() => nav("/deployments")}>К списку деплойментов</Button>}
        />
      </Page>
    );
  }
  if (!deployment) {
    return (
      <Page header={<Skeleton className="mb-6 h-8 w-64" />}>
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }

  const state = deploymentState(deployment);
  const reason = state !== "active" ? pausedReasonText(deployment) : null;
  const message = initialMessageText(deployment);
  const upcoming = deployment.schedule?.upcoming_runs_at ?? [];

  return (
    <Page
      layout="rail"
      header={
        <PageHeader
          title={
            <>
              <span className="min-w-0">{deployment.name}</span>
              <StateBadge deployment={deployment} />
            </>
          }
          description={deployment.description || undefined}
          actions={
            state === "archived" ? (
              <Button
                variant="outline"
                onClick={() => void run("Деплоймент возвращён из архива и стоит на паузе", () => actions.unarchive(deployment.id))}
              >
                <ArchiveRestoreIcon />
                {t.common.unarchive}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  disabled={state !== "active"}
                  title={state === "active" ? undefined : RUN_NEEDS_ACTIVE}
                  onClick={() => void run("Запуск поставлен в очередь", () => actions.run(deployment.id))}
                >
                  <PlayIcon />
                  Запустить
                </Button>
                {state === "active" ? (
                  <Button variant="outline" onClick={() => void run("Деплоймент на паузе", () => actions.pause(deployment.id))}>
                    <PauseIcon />
                    Пауза
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => void run("Деплоймент снова активен", () => actions.unpause(deployment.id))}>
                    <RotateCcwIcon />
                    Продолжить
                  </Button>
                )}
                <Button variant="outline" onClick={() => nav(`/deployments/${deployment.id}/edit`)}>
                  <PencilIcon />
                  {t.common.edit}
                </Button>
                <Button variant="outline" onClick={() => setAskArchive(true)}>
                  <ArchiveIcon />
                  {t.common.archive}
                </Button>
              </>
            )
          }
        />
      }
      rail={
        <section className="console-property-group" aria-label="Свойства деплоймента">
          <h2 className="console-property-group-title">Свойства</h2>
          <dl className="console-property-list">
            <PropertyRow label="ID"><span className="font-mono">{deployment.id}</span></PropertyRow>
            <PropertyRow label="Агент">
              <Link className="link" to={`/agents/${deployment.agent.id}`}>
                {agentQuery.data?.name ?? deployment.agent.id}
              </Link>{" "}
              <span className="tabular-nums text-ddc-text-muted">v{deployment.agent.version}</span>
            </PropertyRow>
            <PropertyRow label="Окружение">
              <Link className="link" to={`/environments/${deployment.environment_id}`}>
                {envQuery.data?.name ?? deployment.environment_id}
              </Link>
            </PropertyRow>
            <PropertyRow label="Триггер">{triggerText(deployment)}</PropertyRow>
            {reason && <PropertyRow label="Причина паузы">{reason}</PropertyRow>}
            <PropertyRow label="Создан"><span className="tabular-nums">{formatDateTime(deployment.created_at)}</span></PropertyRow>
            <PropertyRow label="Обновлён"><span className="tabular-nums">{formatDateTime(deployment.updated_at)}</span></PropertyRow>
            {deployment.archived_at && (
              <PropertyRow label="В архиве">
                <span className="tabular-nums text-ddc-warning-text">{formatDateTime(deployment.archived_at)}</span>
              </PropertyRow>
            )}
          </dl>
        </section>
      }
    >
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Обзор</TabsTrigger>
          <TabsTrigger value="runs">Прогоны</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <div className="console-detail-stack">
            <section className="card min-w-0 overflow-hidden" aria-labelledby="deployment-upcoming-title">
              <header className="border-b border-ddc-divider px-5 py-4">
                <h2 id="deployment-upcoming-title" className="section-title">Ближайшие запуски</h2>
              </header>
              <div className="p-5">
                {upcoming.length === 0 ? (
                  <p className="text-sm text-ddc-text-muted">
                    {deployment.schedule ? "Расчёт запусков пока недоступен." : "Расписания нет, деплоймент запускают вручную."}
                  </p>
                ) : (
                  <ul className="space-y-1 text-sm tabular-nums">
                    {upcoming.map((at) => (
                      <li key={at}>{formatDateTime(at)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
            <section className="card min-w-0 overflow-hidden" aria-labelledby="deployment-message-title">
              <header className="border-b border-ddc-divider px-5 py-4">
                <h2 id="deployment-message-title" className="section-title">Начальное сообщение</h2>
              </header>
              <div className="p-5">
                {message ? (
                  <pre className="console-detail-code-block">{message}</pre>
                ) : (
                  <p className="text-sm text-ddc-text-muted">Текстового сообщения нет.</p>
                )}
              </div>
            </section>
            {deployment.resources.length > 0 && (
              <section className="card min-w-0 overflow-hidden" aria-labelledby="deployment-resources-title">
                <header className="border-b border-ddc-divider px-5 py-4">
                  <h2 id="deployment-resources-title" className="section-title">Ресурсы</h2>
                </header>
                <ul className="divide-y divide-ddc-divider px-5 text-sm">
                  {deployment.resources.map((resource, index) => (
                    <li key={index} className="py-2">
                      {resource.type === "github_repository"
                        ? `Репозиторий ${resource.url}`
                        : resource.type === "file"
                          ? `Файл ${resource.file_id}`
                          : `Хранилище памяти ${resource.memory_store_id}`}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </TabsContent>
        <TabsContent value="runs">
          <RunsTab deploymentId={deployment.id} />
        </TabsContent>
      </Tabs>

      <DangerDialog
        open={askArchive}
        operation="archive"
        target={{ kind: "deployment", id: deployment.id }}
        etagPath={`/v1/deployments/${encodeURIComponent(deployment.id)}`}
        title="Отправить деплоймент в архив?"
        message="Запуски по расписанию прекратятся."
        confirmLabel={t.common.archive}
        run={(options) => actions.archive(deployment.id, options)}
        onDone={() => setAskArchive(false)}
        onClose={() => setAskArchive(false)}
      />
    </Page>
  );
}
