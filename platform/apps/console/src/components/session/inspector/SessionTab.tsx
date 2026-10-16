import type { ReactNode } from "react";
import type { BetaEnvironment } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type { BetaManagedAgentsSession } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { OutcomeView, SessionTotals } from "../../../lib/session-stats";
import { AgentChip, EnvironmentChip, VaultChip } from "../../../pages/session-detail/Panels";
import { StatusPill, type StatusTone } from "../../Badge";
import { EMPTY_VALUE, formatEventDateTimeRu, formatShortDurationRu } from "../format-ru";
import { CopyButton } from "../SessionHeader";

/**
 * Вкладка «Сессия»: таблица свойств, результат, активное время и метаданные.
 * Токенов, стоимости и бюджета здесь нет, потому что модели внутренние. Данные
 * приходят готовыми, вкладка сама ничего не грузит.
 */

export interface SessionTabProps {
  session: BetaManagedAgentsSession;
  environment: BetaEnvironment | null;
  vaults: ReadonlyArray<{ id: string; name?: string }>;
  status: string;
  totals: SessionTotals;
  outcomes: readonly OutcomeView[];
  /** Строки «Источник» из metadata linear и slack. */
  sources?: ReactNode;
}

// ── Строки и разделы ─────────────────────────────────────────────────────

/** Строка «ярлык серым, значение». Страница кладёт такие же строки в `sources`. */
export function SessionPropertyRow({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  /** Ярлык моноширинным: ключи метаданных. */
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-3 py-1.5 text-xs leading-5">
      <dt className={cn("min-w-0 break-words text-ddc-text-muted", mono && "font-mono")}>{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ddc-text">{children}</dd>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className="text-sm font-semibold text-ddc-heading">
        {title}
      </h3>
      {children}
    </section>
  );
}

const RESULT_LABEL: Record<string, string> = {
  satisfied: "Выполнено",
  needs_revision: "Нужна доработка",
  max_iterations_reached: "Итерации исчерпаны",
  failed: "Оценка не удалась",
  interrupted: "Прервано",
  pending: "Ожидает оценки",
  running: "Идёт работа",
  evaluating: "Оценивается",
};

const RESULT_TONE: Record<string, StatusTone> = {
  satisfied: "completed",
  needs_revision: "rescheduling",
  failed: "errored",
  evaluating: "running",
};

interface OutcomeSummary {
  result: string;
  /** С единицы, как на экране. */
  iteration: number | null;
  completedMs: number | null;
  description: string;
  explanation: string | null;
}

function summarizeOutcome(
  outcomes: readonly OutcomeView[],
  session: BetaManagedAgentsSession,
): OutcomeSummary | null {
  const last = outcomes[outcomes.length - 1];
  if (last) {
    const evaluation = last.evaluations[last.evaluations.length - 1];
    return {
      result: evaluation?.result || "pending",
      iteration: evaluation ? evaluation.iteration + 1 : null,
      completedMs: evaluation?.atMs ?? null,
      description: last.description,
      explanation: evaluation?.explanation || null,
    };
  }
  const snapshot = session.outcome_evaluations?.[session.outcome_evaluations.length - 1];
  if (!snapshot) return null;
  const completed = snapshot.completed_at ? Date.parse(snapshot.completed_at) : Number.NaN;
  return {
    result: snapshot.result || "pending",
    iteration: snapshot.iteration + 1,
    completedMs: Number.isFinite(completed) ? completed : null,
    description: snapshot.description,
    explanation: snapshot.explanation || null,
  };
}

/** Длинная строка сжимается серединой: хвост остаётся виден («sesn_01S5djPEW…cr7RBiv»). */
function MiddleEllipsis({ text, tail = 8, className }: { text: string; tail?: number; className?: string }) {
  if (text.length <= tail + 4) {
    return (
      <span className={className} title={text}>
        {text}
      </span>
    );
  }
  return (
    <span className={cn("flex min-w-0 max-w-full", className)} title={text}>
      <span className="min-w-0 truncate">{text.slice(0, -tail)}</span>
      <span className="flex-none">{text.slice(-tail)}</span>
    </span>
  );
}

const HIDDEN_WITH_SOURCES = new Set(["linear", "slack"]);

export function SessionTab({
  session,
  environment,
  vaults,
  status,
  totals,
  outcomes,
  sources,
}: SessionTabProps) {
  const createdMs = Date.parse(session.created_at);
  const updatedMs = Date.parse(session.updated_at);
  const outcome = summarizeOutcome(outcomes, session);
  const metadata = Object.entries(session.metadata ?? {}).filter(
    ([key]) => !(sources && HIDDEN_WITH_SOURCES.has(key)),
  );

  return (
    <div className="space-y-5 p-4">
      <dl className="m-0">
        <SessionPropertyRow label="ID">
          <span className="inline-flex max-w-full items-center gap-1">
            <MiddleEllipsis text={session.id} className="font-mono" />
            <CopyButton value={session.id} label="Копировать ID" />
          </span>
        </SessionPropertyRow>
        <SessionPropertyRow label="Статус">
          <StatusPill status={status} />
        </SessionPropertyRow>
        <SessionPropertyRow label="Создана">
          {Number.isFinite(createdMs) ? formatEventDateTimeRu(createdMs) : EMPTY_VALUE}
        </SessionPropertyRow>
        <SessionPropertyRow label="Обновлена">
          {Number.isFinite(updatedMs) ? formatEventDateTimeRu(updatedMs) : EMPTY_VALUE}
        </SessionPropertyRow>
        <SessionPropertyRow label="Агент">
          <AgentChip agent={session.agent} />
        </SessionPropertyRow>
        <SessionPropertyRow label="Окружение">
          <EnvironmentChip id={session.environment_id} environment={environment} />
        </SessionPropertyRow>
        <SessionPropertyRow label="Хранилища">
          {vaults.length > 0 ? (
            <span className="flex flex-wrap gap-1.5">
              {vaults.map((vault) => (
                <VaultChip key={vault.id} vault={vault} />
              ))}
            </span>
          ) : (
            EMPTY_VALUE
          )}
        </SessionPropertyRow>
        <SessionPropertyRow label="Деплоймент">
          {session.deployment_id ? (
            <span className="font-mono">{session.deployment_id}</span>
          ) : (
            EMPTY_VALUE
          )}
        </SessionPropertyRow>
        {sources}
      </dl>

      {outcome && (
        <Section id="session-tab-outcome" title="Результат">
          <dl className="m-0">
            <SessionPropertyRow label="Итог">
              <StatusPill
                status={RESULT_TONE[outcome.result] ?? "neutral"}
                label={RESULT_LABEL[outcome.result] ?? outcome.result}
              />
            </SessionPropertyRow>
            {outcome.iteration !== null && (
              <SessionPropertyRow label="Итерация">{outcome.iteration}</SessionPropertyRow>
            )}
            {outcome.completedMs !== null && (
              <SessionPropertyRow label="Завершено">
                {formatEventDateTimeRu(outcome.completedMs)}
              </SessionPropertyRow>
            )}
            <SessionPropertyRow label="Описание">{outcome.description}</SessionPropertyRow>
            {outcome.explanation && (
              <SessionPropertyRow label="Пояснение">
                <span className="whitespace-pre-wrap">{outcome.explanation}</span>
              </SessionPropertyRow>
            )}
          </dl>
        </Section>
      )}

      <Table aria-label="Использование" className="text-xs">
        <TableHeader>
          <TableRow>
            <TableHead className="h-8 px-0 text-xs font-semibold tracking-normal text-ddc-heading normal-case">
              Использование
            </TableHead>
            <TableHead className="h-8 px-0 text-xs font-semibold tracking-normal text-ddc-heading normal-case">
              Итого по сессии
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="border-0 hover:bg-transparent">
            <TableCell className="px-0 py-1 text-ddc-text-muted">Активное время</TableCell>
            <TableCell className="px-0 py-1 tabular-nums">
              {totals.activeMs > 0 ? formatShortDurationRu(totals.activeMs) : EMPTY_VALUE}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      {metadata.length > 0 && (
        <Section id="session-tab-metadata" title="Метаданные">
          <dl className="m-0">
            {metadata.map(([key, value]) => (
              <SessionPropertyRow key={key} label={key} mono>
                {value}
              </SessionPropertyRow>
            ))}
          </dl>
        </Section>
      )}
    </div>
  );
}
