import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";
import { ArrowRightIcon } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { StatusPill } from "../components/Badge";
import {
  ConsolePanel,
  DashboardLayout,
  KpiCard,
} from "../components/ConsoleSurface";
import { EmptyState } from "../components/EmptyState";
import { NAV_ICONS } from "../components/nav-icons";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { useI18n } from "../i18n";
import { useApiQuery } from "../lib/useApiQuery";
import { formatDate } from "./ru-format";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";

interface Stats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
}

/** Шаг быстрого старта: слева номер и название, справа пояснение и действие. */
function QuickstartStep({
  number,
  title,
  children,
}: {
  number: string;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2 border-t border-ddc-divider px-5 py-4 first:border-t-0 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
      <div>
        <div className="eyebrow text-brand">Шаг {number}</div>
        <div className="mt-0.5 text-sm font-semibold text-ddc-heading">{title}</div>
      </div>
      <div className="min-w-0 space-y-2 text-sm text-muted">{children}</div>
    </div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const statsQuery = useApiQuery<Stats>("/v1/oma/stats");
  const sessionsQuery = useApiQuery<{
    data: BetaManagedAgentsSession[];
    next_page: string | null;
    prev_page: string | null;
  }>(
    "/v1/sessions",
    { limit: "5" },
  );
  const stats = statsQuery.data;
  const statsLoading = statsQuery.isLoading;
  const recentSessions = sessionsQuery.data?.data.slice(0, 5) ?? [];

  const primaryKpis = [
    { label: t.nav.agents, value: stats?.agents, to: "/agents", icon: NAV_ICONS.agents },
    { label: t.nav.sessions, value: stats?.sessions, to: "/sessions", icon: NAV_ICONS.sessions },
    { label: t.nav.environments, value: stats?.environments, to: "/environments", icon: NAV_ICONS.environments },
    { label: t.nav.credentialVaults, value: stats?.vaults, to: "/vaults", icon: NAV_ICONS.vaults },
  ];
  const secondaryStats = [
    { label: t.nav.skills, value: stats?.skills, to: "/skills" },
    { label: t.nav.modelCards, value: stats?.model_cards, to: "/model-cards" },
  ];

  return (
    <DashboardLayout
      intro={
        <PageHeader
          className="mb-0"
          title="Начало работы"
          description={t.dashboard.intro}
        />
      }
      kpis={primaryKpis.map((kpi) => (
        <KpiCard
          key={kpi.to}
          label={kpi.label}
          value={kpi.value}
          icon={kpi.icon}
          loading={statsLoading}
          onClick={() => navigate(kpi.to)}
        />
      ))}
      secondary={
        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          data-testid="dashboard-secondary-stats"
        >
          {secondaryStats.map((stat) => (
            <KpiCard
              key={stat.to}
              compact
              label={stat.label}
              value={stat.value}
              loading={statsLoading}
              onClick={() => navigate(stat.to)}
            />
          ))}
        </div>
      }
    >
      <ConsolePanel
        title="Запуск агента"
        description="Короткий путь от пустого рабочего пространства до первого запуска."
      >
        <QuickstartStep number="1" title="Опишите задачу">
          <p>
            Опишите задачу, и ассистент поможет собрать агента, окружение и первую сессию.
            Агента можно создать и вручную.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => navigate("/quickstart")}>
              Быстрый старт
              <ArrowRightIcon />
            </Button>
            <Button type="button" variant="outline" onClick={() => navigate("/agents/new")}>
              Новый агент
            </Button>
          </div>
        </QuickstartStep>

        <QuickstartStep number="2" title="Настройте окружение">
          <p>Окружение задаёт песочницу агента: образ, пакеты и сеть.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => navigate("/environments")}>
              Окружения
            </Button>
          </div>
        </QuickstartStep>

        <QuickstartStep number="3" title="Запустите сессию">
          <p>Сессия запускает агента в окружении. Дальше вы пишете ему в чате сессии.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => navigate("/sessions")}>
              Сессии
            </Button>
          </div>
        </QuickstartStep>
      </ConsolePanel>

      <ConsolePanel
        title={t.dashboard.recentSessions}
        description="Последняя активность в рабочем пространстве."
        action={
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => navigate("/sessions")}
          >
            {t.common.viewAll}
            <ArrowRightIcon />
          </Button>
        }
      >
        {sessionsQuery.isLoading ? (
          <div aria-busy="true">
            <span className="sr-only">Загрузка…</span>
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className="flex h-10 items-center gap-3 border-t border-ddc-divider px-5 first-of-type:border-t-0"
              >
                <Skeleton className="h-4 w-[42%]" />
                <Skeleton className="ml-auto h-5 w-20" rounded="md" />
              </div>
            ))}
          </div>
        ) : recentSessions.length === 0 ? (
          <EmptyState
            size="sm"
            kind="session"
            className="rounded-none border-0 shadow-none"
            title={t.sessions.noSessionsYet}
            body="Созданные сессии появятся здесь."
            action={
              <Button type="button" variant="outline" onClick={() => navigate("/sessions")}>
                {t.dashboard.visitSessionsPage}
              </Button>
            }
          />
        ) : (
          <div className="console-dashboard-table-wrap">
            <Table className="console-dashboard-table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-full">{t.dashboard.title}</TableHead>
                  <TableHead className="w-px">{t.common.status}</TableHead>
                  <TableHead className="hidden w-px 2xl:table-cell">{t.dashboard.agent}</TableHead>
                  <TableHead className="w-px">{t.common.created}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentSessions.map((session) => {
                  const title = session.title || t.dashboard.untitled;
                  const agentName = session.agent.name || "–";
                  return (
                    <TableRow key={session.id} onClick={() => navigate(`/sessions/${session.id}`)}>
                      <TableCell className="max-w-0 truncate text-ddc-text" title={title}>
                        <Link
                          to={`/sessions/${session.id}`}
                          className="link-hover"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {title}
                        </Link>
                      </TableCell>
                      <TableCell><StatusPill status={session.status || "idle"} /></TableCell>
                      <TableCell
                        className="hidden max-w-48 truncate text-xs text-ddc-label 2xl:table-cell"
                        title={agentName}
                      >
                        {agentName}
                      </TableCell>
                      <TableCell className="text-xs text-ddc-label tabular-nums">
                        {formatDate(session.created_at)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </ConsolePanel>
    </DashboardLayout>
  );
}
