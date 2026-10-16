import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "../../ai-elements/code-block";
import type { TraceSpan, TraceStatus, TraceTurnSummary } from "../../../lib/trace-api";
import type { SessionEvent } from "../../../lib/session-stats";
import { formatToolOutput } from "../../../lib/tool-output";
import { primaryEventOf, type TraceNode } from "../../../lib/trace-tree";
import { EMPTY_VALUE, formatShortDurationRu, formatTokensRu } from "../format-ru";
import {
  STATUS_LABEL,
  coverageNotes,
  durationCellText,
  formatDateTimeMsRu,
  lostText,
  sourceText,
  spanTitle,
  type DurationContext,
} from "./trace-text";

/**
 * Панель деталей выбранного узла (docs/plans/agent-trace.md, 4.3): время,
 * длительность, статус, ошибка, затем поля по виду узла. Аргументы и результат
 * инструмента в спане не хранятся, их берут из событий `primary_event_id` и
 * последнего id в `event_ids`.
 */

export interface TraceDetailsProps {
  span: TraceSpan;
  /** Узел в дереве: из детей берутся фазы песочницы, ожидание и выполнение. */
  node: TraceNode | null;
  /** Сводка, если узел это ход верхнего уровня. */
  summary: TraceTurnSummary | null;
  turnNumber?: number;
  eventsById: ReadonlyMap<string, SessionEvent>;
  durationContext: DurationContext;
  layout: "panel" | "sheet";
  onClose(): void;
  onShowInTranscript(eventId: string): void;
  onOpenThread?(threadId: string): void;
  /** Узел, на который ссылается это событие (подтверждение ссылается на вызов инструмента), если он загружен. */
  linkedSpanId?: string | null;
  onSelectSpan?(spanId: string): void;
}

const STATUS_VARIANT: Record<TraceStatus, "success" | "destructive" | "info" | "warning" | "neutral"> = {
  ok: "success",
  error: "destructive",
  running: "info",
  waiting: "warning",
  denied: "neutral",
  interrupted: "neutral",
  cancelled: "neutral",
};

const STATE_LABEL: Record<TraceTurnSummary["state"], string> = {
  open: "идёт",
  settling: "дописывается",
  complete: "собран",
  repaired: "восстановлен после сбоя",
  not_built: "не построен",
};

const THREAD_STATE_LABEL: Record<string, string> = {
  open: "открыт, ждёт сообщений",
  closed: "закрыт",
  archived: "в архиве",
};

const STOP_REASON_LABEL: Record<string, string> = {
  requires_action: "ждёт подтверждения",
  end_turn: "ответ дан",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="min-w-0">
      <h4 className="mb-1 font-medium text-ddc-label">{label}</h4>
      {children}
    </section>
  );
}

function EventJson({ event, code }: { event: SessionEvent | undefined; code: string }) {
  if (!event) return <p className="text-ddc-text-muted">Событие не загружено</p>;
  return (
    <div className="max-h-48 overflow-auto rounded-lg bg-ddc-surface-sunken">
      <CodeBlock className="[&_code]:!text-xs [&_pre]:!p-2 [&_pre]:!text-xs" code={code} language="json" />
    </div>
  );
}

/** Результат инструмента: простой текст без подсветки, переносы строк сохраняются. */
function EventOutput({ event, text }: { event: SessionEvent | undefined; text: string }) {
  if (!event) return <p className="text-ddc-text-muted">Событие не загружено</p>;
  return (
    <pre className="max-h-48 overflow-auto rounded-lg bg-ddc-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-ddc-text">
      {text}
    </pre>
  );
}

function inputText(event: SessionEvent | undefined): string {
  if (!event) return "";
  try {
    return JSON.stringify(event.input ?? {}, null, 2);
  } catch {
    return String(event.input);
  }
}

/** Ожидание и выполнение инструмента: по дочерним узлам. */
function toolTimes(node: TraceNode | null, context: DurationContext): Array<{ label: string; text: string }> {
  const rows: Array<{ label: string; text: string }> = [];
  for (const child of node?.children ?? []) {
    if (child.span.kind === "tool_wait") rows.push({ label: "Ожидание", text: durationCellText(child.span, context) });
    if (child.span.kind === "tool_exec") rows.push({ label: "Выполнение", text: durationCellText(child.span, context) });
  }
  return rows;
}

export function TraceDetails({
  span,
  node,
  summary,
  turnNumber,
  eventsById,
  durationContext,
  layout,
  onClose,
  onShowInTranscript,
  onOpenThread,
  linkedSpanId,
  onSelectSpan,
}: TraceDetailsProps) {
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  useEffect(() => setCopy("idle"), [span.span_id]);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(span.span_id);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopy("idle"), 2_000);
  };

  const title = spanTitle(span, { turnNumber });
  const primary = node ? primaryEventOf(node) : span.primary_event_id;
  const resultId = span.event_ids.length > 1 ? span.event_ids[span.event_ids.length - 1]! : null;
  const attrs = Object.entries(span.attrs);
  const phases = (node?.children ?? []).filter((child) => child.span.kind === "sandbox_phase");
  const notes = summary ? coverageNotes(summary) : [];
  const stopReason = typeof span.attrs.stop_reason === "string" ? span.attrs.stop_reason : null;
  const queueMs = typeof span.attrs.queue_ms === "number" ? span.attrs.queue_ms : null;
  const threadState = typeof span.attrs.thread_state === "string" ? span.attrs.thread_state : null;
  const attr = (key: string): string | null => {
    const value = span.attrs[key];
    return typeof value === "string" && value ? value : null;
  };

  return (
    <section aria-label="Детали узла" className="text-xs" data-layout={layout} data-trace-details>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-ddc-divider bg-ddc-surface px-3 py-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-ddc-heading">{title}</h3>
        <Badge variant={STATUS_VARIANT[span.status]}>{STATUS_LABEL[span.status]}</Badge>
        <Button
          aria-label="Закрыть детали"
          className="ml-auto"
          onClick={onClose}
          size="icon-xs"
          title="Закрыть детали"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      </header>

      <div className="flex flex-col gap-3 px-3 py-3">
        {span.error ? (
          <div
            className="rounded-lg bg-ddc-tone-danger-bg px-3 py-2 text-ddc-danger-text"
            role="alert"
          >
            <div className="font-medium">{span.error.message ?? "Ошибка без текста"}</div>
            {span.error.type ? <div className="mt-0.5 font-mono">{span.error.type}</div> : null}
          </div>
        ) : null}

        <dl>
          <Row label="Начало">{formatDateTimeMsRu(span.start_ms)}</Row>
          <Row label="Длительность">{durationCellText(span, durationContext)}</Row>
          <Row label="Источник">{sourceText(span.sources)}</Row>
          <Row label="Точность">{span.precision === "measured" ? "измерено" : "по событиям, время приблизительное"}</Row>

          {span.kind === "model_call" || span.kind === "acp_prompt" ? (
            <>
              <Row label="Модель">{span.model ?? (span.name || EMPTY_VALUE)}</Row>
              {span.usage ? (
                <>
                  <Row label="Токены на входе">{formatTokensRu(span.usage.input)}</Row>
                  <Row label="Токены на выходе">{formatTokensRu(span.usage.output)}</Row>
                  <Row label="Чтение кэша">{formatTokensRu(span.usage.cache_read)}</Row>
                  <Row label="Запись кэша">{formatTokensRu(span.usage.cache_write)}</Row>
                </>
              ) : null}
              <Row label="Первый токен">{span.ttft_ms === null ? EMPTY_VALUE : formatShortDurationRu(span.ttft_ms)}</Row>
              <Row label="Причина остановки">{span.finish_reason ?? EMPTY_VALUE}</Row>
            </>
          ) : null}

          {span.kind === "tool_call" || span.kind === "tool_wait" || span.kind === "tool_exec" ? (
            <>
              {span.tool?.mcp_server ? <Row label="Сервер MCP">{span.tool.mcp_server}</Row> : null}
              {toolTimes(span.kind === "tool_call" ? node : null, durationContext).map((time) => (
                <Row key={time.label} label={time.label}>
                  {time.text}
                </Row>
              ))}
            </>
          ) : null}

          {span.kind === "sandbox" ? (
            <>
              {attr("image") ? <Row label="Образ">{attr("image")}</Row> : null}
              {attr("packages") ? <Row label="Пакеты">{attr("packages")}</Row> : null}
              <Row label="Тёплая">{span.attrs.reused === true ? "да" : "нет"}</Row>
            </>
          ) : null}

          {span.kind === "subagent" ? (
            <>
              <Row label="Поток">{span.thread_id}</Row>
              {threadState ? <Row label="Состояние потока">{THREAD_STATE_LABEL[threadState] ?? threadState}</Row> : null}
            </>
          ) : null}

          {span.kind === "turn" ? (
            <>
              {summary ? <Row label="Состояние хода">{STATE_LABEL[summary.state]}</Row> : null}
              {span.harness ? <Row label="Harness">{span.harness}</Row> : null}
              {stopReason ? <Row label="Завершение">{STOP_REASON_LABEL[stopReason] ?? stopReason}</Row> : null}
              {queueMs !== null ? <Row label="В очереди">{formatShortDurationRu(queueMs)}</Row> : null}
              {summary && summary.lost.length ? <Row label="Потеряно">{lostText(summary.lost)}</Row> : null}
            </>
          ) : null}

          <Row label="ID">
            <span className="font-mono">{span.span_id}</span>
          </Row>
        </dl>

        {notes.map((note) => (
          <p className="text-ddc-warning-text" key={note}>
            {note}
          </p>
        ))}

        {linkedSpanId && onSelectSpan ? (
          <div>
            <Button onClick={() => onSelectSpan(linkedSpanId)} size="xs" variant="outline">
              К вызову
            </Button>
          </div>
        ) : null}

        {span.kind === "subagent" && onOpenThread ? (
          <div>
            <Button onClick={() => onOpenThread(span.thread_id)} size="xs" variant="outline">
              Открыть поток
            </Button>
          </div>
        ) : null}

        {span.kind === "tool_call" && primary ? (
          <Section label="Ввод">
            <EventJson code={inputText(eventsById.get(primary))} event={eventsById.get(primary)} />
          </Section>
        ) : null}
        {span.kind === "tool_call" && !primary ? (
          <Section label="Ввод">
            <p className="text-ddc-text-muted">Событие не загружено</p>
          </Section>
        ) : null}
        {span.kind === "tool_call" && resultId ? (
          <Section label="Результат">
            <EventOutput event={eventsById.get(resultId)} text={formatToolOutput(eventsById.get(resultId)?.content)} />
          </Section>
        ) : null}

        {phases.length ? (
          <Section label="Фазы">
            <ul className="flex flex-col gap-0.5">
              {phases.map((phase) => (
                <li className="flex items-baseline gap-2" key={phase.span.span_id}>
                  <span className="min-w-0 flex-1 truncate">{spanTitle(phase.span)}</span>
                  <span className="tabular-nums text-ddc-text-muted">{durationCellText(phase.span, durationContext)}</span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {attrs.length ? (
          <Section label="Параметры">
            {span.sources.includes("otel") ? (
              <p className="mb-1 text-ddc-text-muted">Данные сообщил сам агент, платформа их не проверяла.</p>
            ) : null}
            <dl>
              {attrs.map(([key, value]) => (
                <Row key={key} label={key}>
                  <span className="font-mono">{String(value)}</span>
                </Row>
              ))}
            </dl>
          </Section>
        ) : null}
      </div>

      <footer className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-ddc-divider bg-ddc-surface px-3 py-2">
        <Button
          disabled={!primary}
          onClick={() => primary && onShowInTranscript(primary)}
          size="xs"
          title={primary ? "Показать в разговоре" : "У этого узла нет события в разговоре"}
          variant="outline"
        >
          <MessageSquareIcon aria-hidden="true" />
          В разговоре
        </Button>
        <Button onClick={copyId} size="xs" variant="ghost">
          {copy === "done" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copy === "done" ? "ID скопирован" : "Копировать ID"}
        </Button>
        {copy === "failed" ? (
          <span className="text-ddc-danger-text" role="status">
            Не удалось скопировать
          </span>
        ) : null}
      </footer>
    </section>
  );
}
