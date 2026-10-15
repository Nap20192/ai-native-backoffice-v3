import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { AlertCircleIcon, AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "../lib/useApiQuery";
import { shortenId } from "../lib/format";
import type { Trajectory } from "../lib/trajectory";
import { rewardHeadline } from "../lib/trajectory";
import { EmptyState } from "../components/EmptyState";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Skeleton, SkeletonRows } from "../components/Skeleton";
import { EvalStatusPill, summarizeStatuses, type EvalStatus } from "./eval-status";
import { EMPTY, formatDateTime, formatSpan } from "./ru-format";

interface EvalTrial {
  trial_index: number;
  status: EvalStatus;
  session_id?: string;
  trajectory_id?: string;
  current_message_index?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  finalize_attempts?: number;
  reward?: number;
  exit_code?: number;
  duration_seconds?: number;
  turns?: number;
  output_tail?: string;
}

interface EvalTask {
  id: string;
  spec: {
    id: string;
    messages: string[];
    setup_files?: { path: string; content: string }[];
    setup_script?: string;
    timeout_ms?: number;
    trials?: number;
  };
  status: EvalStatus;
  trials: EvalTrial[];
  trial_pass_count?: number;
  trial_total?: number;
}

interface EvalRunDetail {
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
  tasks: EvalTask[];
}

/** Пара «подпись и значение» в сводке запуска: подпись `eyebrow`, значение 16px semibold. */
function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 truncate text-base font-semibold text-ddc-heading tabular-nums">{children}</dd>
    </div>
  );
}

/** Раскрывающийся блок с текстом (`details`): подпись 12px, тело в моно. */
function TextDetails({ summary, children, maxHeight = "max-h-48" }: { summary: string; children: ReactNode; maxHeight?: string }) {
  return (
    <details className="rounded-xl border border-ddc-divider bg-ddc-surface">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ddc-label select-none hover:text-ddc-text">
        {summary}
      </summary>
      <pre className={`${maxHeight} overflow-auto border-t border-ddc-divider p-3 font-mono text-xs break-words whitespace-pre-wrap text-ddc-text`}>
        {children}
      </pre>
    </details>
  );
}

export function EvalRunDetail() {
  const { id } = useParams<{ id: string }>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Run detail with auto-poll while the run is unfinished. Using TQ's
  // refetchInterval so we don't have to hand-roll the cleanup-on-unmount
  // dance the previous useEffect did. Returning `false` stops the poll
  // once the run reaches a terminal state.
  const {
    data: run,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useApiQuery<EvalRunDetail>(
    id ? `/v1/oma/evals/runs/${id}` : null,
    undefined,
    {
      refetchInterval: (query) => {
        const r = query.state.data as EvalRunDetail | undefined;
        if (!r) return false;
        return r.status === "pending" || r.status === "running" ? 5_000 : false;
      },
    },
  );
  const error = queryError instanceof Error ? queryError.message : queryError ? String(queryError) : null;

  // Агент и окружение называются по имени, а не по id: id остаётся в подсказке.
  const agentName = useApiQuery<{ name?: string }>(
    run?.agent_id ? `/v1/agents/${run.agent_id}` : null,
  ).data?.name;
  const environmentName = useApiQuery<{ name?: string }>(
    run?.environment_id ? `/v1/environments/${run.environment_id}` : null,
  ).data?.name;

  function toggleExpand(taskId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  // Скелетон повторяет разметку страницы: заголовок, сводка, таблица задач.
  if (loading) {
    return (
      <Page
        header={
          <div className="mb-6 space-y-2" aria-hidden="true">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </div>
        }
      >
        <div className="console-detail-stack">
          <div className="card p-5">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-6 w-28" />
                </div>
              ))}
            </div>
          </div>
          <div className="card overflow-hidden">
            <SkeletonRows count={4} />
          </div>
        </div>
      </Page>
    );
  }
  if (error) {
    return (
      <Page>
        <EmptyState
          tone="warning"
          icon={<AlertTriangleIcon />}
          title="Не удалось загрузить запуск"
          body={<span role="alert">{error}</span>}
          action={
            <Button type="button" variant="outline" onClick={() => void refetch()}>
              Повторить
            </Button>
          }
        />
      </Page>
    );
  }
  if (!run) {
    return (
      <Page>
        <EmptyState
          kind="eval"
          title="Запуск не найден"
          action={
            <Button asChild variant="outline">
              <Link to="/evals">К запускам оценки</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  let totalPass = 0;
  let totalTrials = 0;
  for (const t of run.tasks) {
    totalPass += t.trial_pass_count ?? 0;
    totalTrials += t.trial_total ?? 0;
  }

  return (
    <Page
      header={
        <PageHeader
          title="Запуск оценки"
          description={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <EvalStatusPill status={run.status} />
              <span className="font-mono text-xs break-all" title={run.id}>
                {run.id}
              </span>
            </span>
          }
        />
      }
    >
      <div className="console-detail-stack">
      {/* Хлебные крошки в оболочке называют раздел. Заголовок страницы со
          статусом стоит в шапке, сводка лежит в одной карточке: карточка
          p-5, сетка 2 колонки на телефоне и 3 от lg, шаг 16px. */}
      <section className="card p-5" aria-label="Сводка запуска">
        <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          <SummaryItem label="Запущен">{formatDateTime(run.started_at)}</SummaryItem>
          <SummaryItem label="Результат">
            {totalTrials > 0 ? `${totalPass}/${totalTrials}` : EMPTY}
          </SummaryItem>
          <SummaryItem label="Задачи">
            {run.completed_count}/{run.task_count}
            {run.failed_count > 0 && (
              <span className="text-error text-sm font-medium"> ({run.failed_count} с ошибкой)</span>
            )}
          </SummaryItem>
          <SummaryItem label="Длительность">{formatSpan(run.started_at, run.ended_at)}</SummaryItem>
          <SummaryItem label="Агент">
            <Link
              to={`/agents/${run.agent_id}`}
              className="link-hover text-sm"
              title={agentName ?? run.agent_id}
            >
              {agentName ?? shortenId(run.agent_id)}
            </Link>
          </SummaryItem>
          <SummaryItem label="Окружение">
            <Link
              to={`/environments/${run.environment_id}`}
              className="link-hover text-sm"
              title={environmentName ?? run.environment_id}
            >
              {environmentName ?? shortenId(run.environment_id)}
            </Link>
          </SummaryItem>
        </dl>
      </section>

      {run.error && (
        <div role="alert" className="callout-danger flex-col gap-2">
          <div className="flex items-center gap-2 font-semibold">
            <AlertCircleIcon className="size-4 flex-none" aria-hidden="true" />
            Ошибка запуска
          </div>
          <pre className="w-full font-mono text-xs break-words whitespace-pre-wrap">{run.error}</pre>
        </div>
      )}

      <section className="card min-w-0 overflow-hidden" aria-labelledby="eval-tasks-title">
        <header className="border-b border-ddc-divider px-5 py-4">
          <h2 id="eval-tasks-title" className="section-title">
            Задачи
          </h2>
        </header>
        {run.tasks.length === 0 ? (
          <EmptyState kind="eval" size="sm" title="В запуске нет задач" />
        ) : (
          /* Список задач: плоские строки 40px с разделителями в карточке. Вторичная
             колонка «Попытки» скрыта на телефоне (правило 13). */
          <div className="console-detail-table-wrap" data-testid="eval-results-table">
            <Table className="console-detail-table">
              <TableHeader variant="wireless">
                <TableRow variant="wireless">
                  <TableHead className="w-14">
                    <span className="sr-only">Развернуть</span>
                  </TableHead>
                  <TableHead>Задача</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead>Пройдено</TableHead>
                  <TableHead className="hidden md:table-cell">Попытки</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.tasks.map(t => {
                  const isOpen = expanded.has(t.id);
                  return [
                    <TableRow
                      variant="wireless"
                      key={t.id}
                      className="cursor-pointer transition-colors hover:bg-ddc-surface-muted"
                      onClick={() => toggleExpand(t.id)}
                    >
                      <TableCell className="py-0 text-center">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Свернуть задачу" : "Развернуть задачу"}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleExpand(t.id);
                          }}
                        >
                          {isOpen ? <ChevronDownIcon /> : <ChevronRightIcon />}
                        </Button>
                      </TableCell>
                      <TableCell className="truncate font-mono text-xs text-ddc-text" title={t.id}>
                        {t.id}
                      </TableCell>
                      <TableCell>
                        <EvalStatusPill status={t.status} />
                      </TableCell>
                      <TableCell className="font-medium text-ddc-text tabular-nums">
                        {(t.trial_pass_count ?? 0)}/{t.trial_total ?? t.trials.length}
                      </TableCell>
                      <TableCell
                        className="hidden truncate text-xs text-ddc-label md:table-cell"
                        title={summarizeStatuses(t.trials.map(tr => tr.status))}
                      >
                        {summarizeStatuses(t.trials.map(tr => tr.status)) || EMPTY}
                      </TableCell>
                    </TableRow>,
                    isOpen && (
                      // Раскрытая часть лежит отдельной строкой под задачей на
                      // подложке ink-50: так видно, что это детали строки выше.
                      <TableRow key={`${t.id}-trials`} className="bg-ddc-surface-muted/60">
                        <TableCell colSpan={5} className="space-y-3 px-3 py-3 whitespace-normal">
                          <div className="overflow-hidden rounded-xl border border-ddc-divider bg-ddc-surface">
                            <Table className="w-full text-xs">
                              <TableHeader>
                                <TableRow>
                                  <TableHead>#</TableHead>
                                  <TableHead>Статус</TableHead>
                                  <TableHead>Награда</TableHead>
                                  <TableHead>Код выхода</TableHead>
                                  <TableHead>Длительность</TableHead>
                                  <TableHead>Ходы</TableHead>
                                  <TableHead>Сессия</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {t.trials.map(tr => (
                                  <TableRow key={tr.trial_index}>
                                    <TableCell className="text-ddc-text-muted tabular-nums">{tr.trial_index}</TableCell>
                                    <TableCell>
                                      <EvalStatusPill status={tr.status} />
                                    </TableCell>
                                    <TableCell>
                                      <TrialReward
                                        fallback={tr.reward}
                                        trajectory={undefined}
                                      />
                                    </TableCell>
                                    <TableCell className="font-mono text-ddc-label tabular-nums">{tr.exit_code ?? EMPTY}</TableCell>
                                    <TableCell className="text-ddc-label tabular-nums">{formatSpan(tr.started_at, tr.ended_at)}</TableCell>
                                    <TableCell className="text-ddc-label tabular-nums">{tr.turns ?? EMPTY}</TableCell>
                                    <TableCell>
                                      {tr.session_id ? (
                                        <Link
                                          to={`/sessions/${tr.session_id}`}
                                          className="link font-mono"
                                        >
                                          {tr.session_id}
                                        </Link>
                                      ) : (
                                        <span className="text-ddc-placeholder">{EMPTY}</span>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>

                          {t.trials.some(tr => tr.error) && (
                            <ul className="space-y-1 text-xs text-error">
                              {t.trials
                                .filter(tr => tr.error)
                                .map(tr => (
                                  <li key={tr.trial_index} className="break-words">
                                    Попытка {tr.trial_index}: {tr.error}
                                  </li>
                                ))}
                            </ul>
                          )}

                          {t.trials.some(tr => tr.output_tail) && (
                            <TextDetails summary="Вывод verify_script (конец)" maxHeight="max-h-64">
                              {t.trials
                                .filter(tr => tr.output_tail)
                                .map(tr => `Попытка ${tr.trial_index}:\n${tr.output_tail}`)
                                .join("\n\n")}
                            </TextDetails>
                          )}

                          {t.spec.setup_script && (
                            <TextDetails summary="Скрипт подготовки (setup_script)">
                              {t.spec.setup_script}
                            </TextDetails>
                          )}

                          <TextDetails summary="Первое сообщение">
                            {t.spec.messages[0]}
                          </TextDetails>
                        </TableCell>
                      </TableRow>
                    ),
                  ];
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      </div>
    </Page>
  );
}

/** Ячейка награды в строке попытки.
 *
 *  Показывает награду, уже записанную в результате оценки. Ветка с
 *  траекторией оставлена для будущего расширения сессий, консоль не обращается
 *  к снятому маршруту сессий OMA.
 *
 *  Особые значения:
 *   - "loading" → приглушённая заглушка
 *   - "error"   → награда из результата и подсказка «траектория недоступна»
 *   - undefined → только награда из результата (задача ещё не раскрыта) */
function TrialReward({
  fallback,
  trajectory,
}: {
  fallback: number | undefined;
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  if (trajectory && trajectory !== "loading" && trajectory !== "error" && trajectory.reward) {
    const r = trajectory.reward;
    const headline = rewardHeadline(r);
    const isPass = r.final_reward >= 0.99;
    const isFail = r.final_reward <= 0;
    const cls = isPass
      ? "text-ddc-success-text font-semibold"
      : isFail
      ? "text-ddc-danger-text font-semibold"
      : "text-ddc-text";
    return (
      <div className="leading-tight">
        <div className={cls}>{headline}</div>
        {r.verifier_id && (
          <div className="font-mono text-xs text-ddc-text-muted">проверка: {r.verifier_id}</div>
        )}
      </div>
    );
  }
  if (trajectory === "loading") {
    return <span className="text-xs text-ddc-text-muted">Загрузка…</span>;
  }
  if (fallback != null) {
    const tooltip = trajectory === "error" ? "Траектория недоступна, показана прежняя награда" : undefined;
    return (
      <span
        className={fallback >= 1 ? "font-semibold text-ddc-success-text" : "text-ddc-text-muted"}
        title={tooltip}
      >
        {fallback}
      </span>
    );
  }
  if (trajectory === "error") {
    return <span className="text-xs text-ddc-text-muted" title="Не удалось получить траекторию">Траектория недоступна</span>;
  }
  return <span className="text-ddc-placeholder">{EMPTY}</span>;
}

/** Таблица raw_rewards по одной попытке: строка на критерий из
 *  `RewardResult.raw_rewards`. Родитель прячет её в `<details>`, чтобы
 *  верификаторы с многими критериями не раздували строку. */
function RewardBreakdown({
  trialIndex,
  reward,
}: {
  trialIndex: number;
  reward: { raw_rewards: Record<string, number>; final_reward: number; verifier_id?: string };
}) {
  const entries = Object.entries(reward.raw_rewards);
  return (
    <div className="rounded-xl bg-ddc-surface-muted p-3">
      <div className="mb-1 flex items-baseline gap-2 text-xs text-ddc-text-muted">
        <span>Попытка {trialIndex}</span>
        {reward.verifier_id && (
          <span className="font-mono">{reward.verifier_id}</span>
        )}
        <span className="ml-auto text-ddc-text tabular-nums">
          итог = <span className="font-semibold">{reward.final_reward.toFixed(2)}</span>
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="text-xs text-ddc-text-muted">Оценки по критериям не записаны</div>
      ) : (
        <div className="overflow-x-auto">
          <Table className="w-full text-xs">
            <TableBody>
              {entries.map(([k, v]) => (
                <TableRow key={k}>
                  <TableCell className="py-0.5 pr-2 font-mono text-ddc-label">{k}</TableCell>
                  <TableCell className="py-0.5 text-right text-ddc-text tabular-nums">{Number.isFinite(v) ? v.toFixed(2) : String(v)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
