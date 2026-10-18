import { useMemo, useState } from "react";
import { Code, FileText, Globe, Search, Terminal, X, Zap } from "lucide-react";
import {
  collectToolCalls, computeToolStats, toolCatalogFromAgent, toolInputPreview, toolPermission,
  type EventSelection, type SessionEvent, type ToolCallStatus, type ToolStatusCounts,
} from "../../../lib/session-stats";
import { EMPTY_VALUE, formatClockRu, formatPercentRu, formatShortDurationRu, plural } from "../format-ru";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";

export interface ToolsTabProps {
  events: readonly SessionEvent[];
  agentTools: readonly unknown[] | undefined;
  selection: EventSelection;
  onSelectEvent(eventId: string, source: "tools"): void;
}

const statuses = [
  ["failed", "Ошибки", "--ddc-dot-danger"], ["denied", "Отклонено", "--ddc-dot-warning"],
  ["interrupted", "Прервано", "--ddc-dot-neutral"], ["completed", "Выполнено", "--ddc-dot-success"],
  ["running", "Выполняется", "--ddc-dot-info"],
] as const;
const statusLabels: Record<ToolCallStatus, string> = { completed: "выполнен", failed: "ошибка", denied: "отклонён", interrupted: "прерван", running: "выполняется" };

function StatusRing({ counts }: { counts: ToolStatusCounts }) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  let offset = 0;
  return <div className="flex items-center gap-4 px-3 py-3">
    <svg role="img" aria-label="Статусы вызовов" viewBox="0 0 80 80" className="h-16 w-16 shrink-0 -rotate-90">
      <circle cx="40" cy="40" r="32" fill="none" stroke="var(--ddc-surface-sunken)" strokeWidth="8" />
      {statuses.map(([status, label, color]) => {
        const share = total ? counts[status] / total * 100 : 0;
        const start = offset; offset += share;
        return counts[status] > 0 && <circle key={status} cx="40" cy="40" r="32" pathLength="100" fill="none" stroke={`var(${color})`} strokeWidth="8" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start}><title>{label}: {counts[status]} ({formatPercentRu(total ? counts[status] / total : 0)})</title></circle>;
      })}
    </svg>
    <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-5 gap-y-1">
      {statuses.filter(([status]) => status !== "running" || counts.running > 0).map(([status, label, color]) => <div key={status} className="contents"><dt className="flex items-center gap-1.5 text-ddc-text-muted"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `var(${color})` }} />{label}</dt><dd className={status === "failed" && counts.failed ? "text-ddc-danger-text" : "text-ddc-text"}>{!counts[status] ? "нет" : status === "failed" ? `${counts[status]} (${formatPercentRu(counts[status] / total)})` : counts[status]}</dd></div>)}
    </dl>
  </div>;
}

// Таблицы инспектора теснее общих: строка 24 px, заголовок без капса.
const head = "h-6 px-2 text-left text-xs font-normal tracking-normal normal-case text-ddc-label";
const cell = "h-6 truncate px-2 py-0";
const duration = (ms: number | null) => ms === 0 ? "0 с" : formatShortDurationRu(ms);
function ToolIcon({ name }: { name: string }) {
  const Icon = name === "bash" ? Terminal : name.startsWith("web_") ? Globe : ["read", "write", "edit"].includes(name) ? FileText : ["grep", "glob"].includes(name) ? Search : Code;
  return <Icon size={12} className="shrink-0 text-ddc-icon-muted" />;
}
function Permission({ value }: { value: "auto" | "ask" | null }) {
  return <span className="inline-flex items-center gap-1 whitespace-nowrap text-ddc-text-muted"><Zap size={11} />{value === null ? EMPTY_VALUE : value === "auto" ? "Авто" : "Спросить"}</span>;
}

export function ToolsTab({ events, agentTools, selection, onSelectEvent }: ToolsTabProps) {
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { rows, summary } = useMemo(() => computeToolStats(collectToolCalls(events), toolCatalogFromAgent(agentTools), tool => toolPermission(agentTools, tool)), [events, agentTools]);
  const selected = rows.find(row => JSON.stringify([row.kind, row.name, row.callList[0]?.mcpServerName]) === selectedKey);
  const filtered = rows.filter(row => row.name.toLowerCase().includes(query.toLowerCase()));
  const keyOf = (row: (typeof rows)[number]) => JSON.stringify([row.kind, row.name, row.callList[0]?.mcpServerName]);
  const callSelected = (call: (typeof rows)[number]["callList"][number]) =>
    selection.eventId === call.useEventId || (call.resultEventId !== null && selection.eventId === call.resultEventId);

  return <div className="flex h-full min-h-0 flex-col bg-ddc-surface font-sans text-xs text-ddc-text">
    <div className="relative mx-2 my-2 shrink-0">
      <Search aria-hidden="true" size={12} className="pointer-events-none absolute top-2.5 left-2 text-ddc-icon-muted" />
      <Input
        type="search"
        aria-label="Найти инструмент"
        placeholder="Найти инструмент"
        value={query}
        onChange={event => setQuery(event.target.value)}
        className="h-8 w-48 max-w-full rounded-lg pr-2 pl-7 text-xs"
      />
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      <Table aria-label="Инструменты" container={false} className="table-fixed border-collapse text-xs">
        <colgroup><col className="w-[29%]" /><col className="w-[25%]" /><col className="w-[12%]" /><col className="w-[20%]" /><col className="w-[14%]" /></colgroup>
        <TableHeader variant="wireless" className="sticky top-0 bg-ddc-surface">
          <TableRow variant="wireless">
            {["Название", "Разрешение", "Вызовы", "Ошибки", "p50"].map(label => (
              <TableHead key={label} className={`${head} ${["Вызовы", "Ошибки", "p50"].includes(label) ? "text-right" : ""}`}>{label}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((row, index) => (
            <TableRow
              key={`${row.kind}-${row.name}-${index}`}
              variant="wireless"
              tabIndex={0}
              aria-selected={selected === row}
              className={`h-6 cursor-pointer hover:bg-ddc-surface-muted ${row.calls === 0 ? "text-ddc-text-muted" : ""} ${selected === row ? "bg-ddc-selected-bg" : ""}`}
              onClick={() => setSelectedKey(keyOf(row))}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(keyOf(row)); } }}
            >
              <TableCell className={cell}><span className="flex items-center gap-1.5" title={row.name}><ToolIcon name={row.name} /><span className="truncate font-mono">{row.name}</span></span></TableCell>
              <TableCell className={cell}><Permission value={row.permission} /></TableCell>
              <TableCell className={`${cell} text-right tabular-nums`}>{row.calls}</TableCell>
              <TableCell className={`${cell} text-right tabular-nums ${row.failed ? "text-ddc-danger-text" : ""}`}>{row.calls === 0 ? EMPTY_VALUE : row.failed ? `${row.failed} (${formatPercentRu(row.failedRatio!)})` : "0"}</TableCell>
              <TableCell className={`${cell} text-right tabular-nums`}>{duration(row.p50Ms)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!filtered.length && <div className="p-3 text-ddc-text-muted">Инструменты не найдены</div>}
    </div>
    <section role="region" aria-label={selected ? `Инструмент ${selected.name}` : "Сводка"} className="flex h-1/2 min-h-0 shrink-0 flex-col border-t border-ddc-divider">
      <div className="flex h-8 shrink-0 items-center gap-2 px-2">
        <span className="min-w-0 flex-1 truncate font-medium">
          {selected ? <><span className="font-normal text-ddc-text-muted">Инструмент</span> <span className="font-mono">{selected.name}</span></> : "Сводка"}
        </span>
        {selected
          ? <><Permission value={selected.permission} /><Button variant="ghost" size="icon-xs" aria-label="Закрыть инструмент" title="Закрыть инструмент" onClick={() => setSelectedKey(null)}><X aria-hidden="true" className="size-3.5" /></Button></>
          : <span className="text-right text-2xs text-ddc-text-muted">{summary.toolCount} {plural(summary.toolCount, "инструмент", "инструмента", "инструментов")}, {summary.usedCount} использовано, {summary.callCount} {plural(summary.callCount, "вызов", "вызова", "вызовов")}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <StatusRing counts={selected?.counts ?? summary.counts} />
        {selected ? (
          <Table aria-label={`Вызовы ${selected.name}`} container={false} className="table-fixed border-collapse text-xs">
            <colgroup><col className="w-20" /><col /><col className="w-24" /><col className="w-28" /></colgroup>
            <TableHeader variant="wireless">
              <TableRow variant="wireless">{["Время", "Ввод", "Статус", "Длительность"].map(label => <TableHead key={label} className={`${head} ${label === "Длительность" ? "text-right" : ""}`}>{label}</TableHead>)}</TableRow>
            </TableHeader>
            <TableBody>
              {selected.callList.map(call => (
                <TableRow
                  key={call.useEventId}
                  variant="wireless"
                  tabIndex={0}
                  aria-selected={callSelected(call)}
                  className={`h-6 cursor-pointer hover:bg-ddc-surface-muted ${callSelected(call) ? "bg-ddc-selected-bg outline outline-1 -outline-offset-1 outline-ddc-ring" : ""}`}
                  onClick={() => onSelectEvent(call.useEventId, "tools")}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectEvent(call.useEventId, "tools"); } }}
                >
                  <TableCell className={`${cell} text-ddc-text-muted tabular-nums`}>{call.startMs === null ? EMPTY_VALUE : formatClockRu(call.startMs)}</TableCell>
                  <TableCell className={`${cell} font-mono`} title={toolInputPreview(call.name, call.input)}>{toolInputPreview(call.name, call.input)}</TableCell>
                  <TableCell className={`${cell} ${call.status === "completed" ? "text-ddc-success-text" : call.status === "failed" ? "text-ddc-danger-text" : "text-ddc-text-muted"}`}>{statusLabels[call.status]}</TableCell>
                  <TableCell className={`${cell} text-right tabular-nums`}>{duration(call.durationMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table container={false} className="border-collapse text-xs">
            <TableHeader variant="wireless">
              <TableRow variant="wireless"><TableHead className={head}>Время в инструментах</TableHead><TableHead className={`${head} text-right`}>Длительность</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {([["Всего", summary.time.totalMs], ["Выполнение", summary.time.executingMs], ["Ожидание вас", summary.time.waitingMs]] as const).map(([label, ms]) => (
                <TableRow key={label} variant="wireless">
                  <TableCell className={`${cell} ${label === "Всего" ? "font-medium text-ddc-text" : "text-ddc-text-muted"}`}>{label}</TableCell>
                  <TableCell className={`${cell} text-right tabular-nums ${label === "Всего" ? "font-medium" : ""}`}>{duration(ms)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  </div>;
}
