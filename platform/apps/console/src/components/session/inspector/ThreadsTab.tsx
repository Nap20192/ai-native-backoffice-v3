import { useMemo } from "react";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { BetaManagedAgentsSessionThread } from "@anthropic-ai/sdk/resources/beta/sessions/threads/threads";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  PRIMARY_THREAD_ID,
  computeThreadStats,
  type SessionEvent,
} from "../../../lib/session-stats";
import { AgentChip, type AgentCardInfo } from "../../../pages/session-detail/Panels";
import { StatusPill } from "../../Badge";
import { EMPTY_VALUE, formatShortDurationRu } from "../format-ru";
import { SessionPropertyRow } from "./SessionTab";

/**
 * Вкладка «Потоки»: таблица потоков сессии и деталь выбранного потока снизу.
 * Выбор потока переключает ленту и вкладку «События» на его события.
 * Сервер не заполняет `stats` у потоков, поэтому активное время считаем по
 * событиям потока. Токенов и стоимости здесь нет, потому что модели внутренние.
 */

export interface ThreadsTabProps {
  session: BetaManagedAgentsSession;
  /** Все потоки из GET /threads, включая основной. */
  threads: readonly BetaManagedAgentsSessionThread[];
  /** События всех потоков. */
  events: readonly SessionEvent[];
  activeThreadId: string;
  onSelectThread(threadId: string): void;
}

interface ThreadView {
  id: string;
  name: string;
  status: string;
  agent: AgentCardInfo | null;
  modelId: string | null;
  effort: string | null;
}

const EFFORT_LABEL: Record<string, string> = {
  low: "Низкое усилие",
  medium: "Среднее усилие",
  high: "Высокое усилие",
  xhigh: "Очень высокое усилие",
  max: "Максимальное усилие",
};

function viewOf(
  id: string,
  agent: { id?: string; name?: string; version?: number; description?: string | null; model?: unknown } | undefined,
  status: string,
): ThreadView {
  const model = agent?.model as { id?: string; effort?: { type?: string } | string | null } | string | undefined;
  const modelId = typeof model === "string" ? model : (model?.id ?? null);
  const rawEffort = typeof model === "object" ? model?.effort : null;
  const effortKey = typeof rawEffort === "string" ? rawEffort : rawEffort?.type;
  const name = agent?.name ?? id;
  return {
    id,
    name,
    status,
    agent:
      agent?.id && agent.name
        ? {
            id: agent.id,
            name: agent.name,
            version: agent.version,
            description: agent.description,
            model: modelId ? { id: modelId, effort: effortKey ? { type: effortKey } : null } : null,
          }
        : null,
    modelId,
    effort: effortKey ? (EFFORT_LABEL[effortKey] ?? effortKey) : null,
  };
}

const HEAD_CLASS = "h-8 px-3 text-xs tracking-normal normal-case";

export function ThreadsTab({
  session,
  threads,
  events,
  activeThreadId,
  onSelectThread,
}: ThreadsTabProps) {
  const views = useMemo<ThreadView[]>(() => {
    const list = threads.map((thread) =>
      viewOf(thread.id, thread.agent as Parameters<typeof viewOf>[1], thread.status),
    );
    if (!list.some((view) => view.id === PRIMARY_THREAD_ID)) {
      list.unshift(viewOf(PRIMARY_THREAD_ID, session.agent, session.status));
    }
    return list;
  }, [threads, session]);

  const selected = views.find((view) => view.id === activeThreadId) ?? views[0]!;
  const selectedStats = useMemo(
    () => computeThreadStats(events, selected.id),
    [events, selected.id],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" data-threads-list>
        <Table aria-label="Потоки" className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD_CLASS}>Поток</TableHead>
              <TableHead className={HEAD_CLASS}>Статус</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {views.map((view) => {
              const isSelected = view.id === selected.id;
              return (
                <TableRow
                  key={view.id}
                  aria-selected={isSelected}
                  data-state={isSelected ? "selected" : undefined}
                  onClick={() => onSelectThread(view.id)}
                  className="h-8 cursor-pointer"
                >
                  <TableCell className="min-w-0 px-3 py-1">
                    <span className="block max-w-40 truncate" title={view.name}>
                      {view.name}
                    </span>
                  </TableCell>
                  <TableCell className="px-3 py-1">
                    <StatusPill status={view.status} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <section
        aria-labelledby="threads-tab-detail"
        className="h-1/2 min-h-0 shrink-0 space-y-4 overflow-y-auto border-t border-ddc-divider p-4"
      >
        <h3 id="threads-tab-detail" className="text-sm font-semibold text-ddc-heading">
          <span className="font-normal text-ddc-text-muted">Поток</span> {selected.name}
        </h3>

        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-ddc-heading">Подробности</h4>
          <dl className="m-0">
            <SessionPropertyRow label="Агент">
              <span className="inline-flex items-center gap-1.5">
                {selected.agent ? <AgentChip agent={selected.agent} /> : selected.name}
                {selected.agent?.version != null && (
                  <span className="inline-flex h-5 items-center rounded-md bg-ddc-tone-neutral-bg px-1.5 text-2xs font-medium text-ddc-tone-neutral-fg">
                    v{selected.agent.version}
                  </span>
                )}
              </span>
            </SessionPropertyRow>
            <SessionPropertyRow label="Модель">
              <span className="inline-flex flex-wrap items-center gap-x-2">
                {selected.modelId ? <span className="font-mono">{selected.modelId}</span> : EMPTY_VALUE}
                {selected.effort && <span className="text-ddc-text-muted">{selected.effort}</span>}
              </span>
            </SessionPropertyRow>
          </dl>
        </div>

        <Table aria-label="Использование" className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 px-0 text-xs font-semibold tracking-normal text-ddc-heading normal-case">
                Использование
              </TableHead>
              <TableHead className="h-8 px-0 text-xs font-semibold tracking-normal text-ddc-heading normal-case">
                Этот поток
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="border-0 hover:bg-transparent">
              <TableCell className="px-0 py-1 text-ddc-text-muted">Активное время</TableCell>
              <TableCell className="px-0 py-1 tabular-nums">
                {selectedStats.activeMs > 0 ? formatShortDurationRu(selectedStats.activeMs) : EMPTY_VALUE}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
