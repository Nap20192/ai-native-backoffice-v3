import { useMemo, useState } from "react";
import { Code, FileText, Globe, Search, Terminal, X, Zap } from "lucide-react";
import {
  collectToolCalls, computeToolStats, toolCatalogFromAgent, toolInputPreview,
  type EventSelection, type SessionEvent, type ToolCallStatus, type ToolStatusCounts,
} from "../../../lib/session-stats";
import { EMPTY_VALUE, formatClockRu, formatPercentRu, formatShortDurationRu, plural } from "../format-ru";

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
      {statuses.filter(([status]) => status !== "running" || counts.running > 0).map(([status, label, color]) => <div key={status} className="contents"><dt className="flex items-center gap-1.5 text-ddc-text-muted"><span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `var(${color})` }} />{label}</dt><dd className={status === "failed" && counts.failed ? "text-ddc-danger-text" : "text-ddc-text"}>{counts[status] ? `${counts[status]} (${formatPercentRu(counts[status] / total)})` : "нет"}</dd></div>)}
    </dl>
  </div>;
}

const head = "h-6 px-2 text-left font-normal text-ddc-label";
const cell = "h-6 truncate px-2";
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
  const { rows, summary } = useMemo(() => computeToolStats(collectToolCalls(events), toolCatalogFromAgent(agentTools)), [events, agentTools]);
  const selected = rows.find(row => JSON.stringify([row.kind, row.name, row.callList[0]?.mcpServerName]) === selectedKey);
  const filtered = rows.filter(row => row.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="flex h-full min-h-0 flex-col bg-ddc-surface font-sans text-xs text-ddc-text">
    <div className="relative mx-2 my-2 shrink-0"><Search size={12} className="absolute top-2 left-2 text-ddc-icon-muted" /><input type="search" aria-label="Найти инструмент" placeholder="Найти инструмент" value={query} onChange={event => setQuery(event.target.value)} className="h-7 w-48 max-w-full rounded-md border border-ddc-border bg-ddc-surface pr-2 pl-7 placeholder:text-ddc-placeholder" /></div>
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label="Инструменты" className="w-full table-fixed border-collapse">
        <colgroup><col className="w-[29%]" /><col className="w-[25%]" /><col className="w-[12%]" /><col className="w-[20%]" /><col className="w-[14%]" /></colgroup>
        <thead className="sticky top-0 bg-ddc-surface"><tr>{["Название", "Разрешение", "Вызовы", "Ошибки", "p50"].map(label => <th key={label} className={`${head} ${["Вызовы", "Ошибки", "p50"].includes(label) ? "text-right" : ""}`}>{label}</th>)}</tr></thead>
        <tbody>{filtered.map((row, index) => <tr key={`${row.kind}-${row.name}-${index}`} tabIndex={0} aria-selected={selected === row} className={`h-6 cursor-pointer hover:bg-ddc-surface-muted ${row.calls === 0 ? "text-ddc-text-muted" : ""} ${selected === row ? "bg-ddc-selected-bg" : ""}`}
          onClick={() => setSelectedKey(JSON.stringify([row.kind, row.name, row.callList[0]?.mcpServerName]))}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(JSON.stringify([row.kind, row.name, row.callList[0]?.mcpServerName])); } }}>
          <td className={cell}><span className="flex items-center gap-1.5" title={row.name}><ToolIcon name={row.name} /><span className="truncate font-mono">{row.name}</span></span></td>
          <td className={cell}><Permission value={row.permission} /></td><td className={`${cell} text-right tabular-nums`}>{row.calls}</td>
          <td className={`${cell} text-right tabular-nums ${row.failed ? "text-ddc-danger-text" : ""}`}>{row.calls === 0 ? EMPTY_VALUE : row.failed ? `${row.failed} (${formatPercentRu(row.failedRatio!)})` : "0"}</td>
          <td className={`${cell} text-right tabular-nums`}>{duration(row.p50Ms)}</td>
        </tr>)}</tbody>
      </table>
      {!filtered.length && <div className="p-3 text-ddc-text-muted">Инструменты не найдены</div>}
    </div>
    <section role="region" aria-label={selected ? `Инструмент ${selected.name}` : "Сводка"} className="flex h-1/2 min-h-0 shrink-0 flex-col border-t border-ddc-divider">
      <div className="flex h-8 shrink-0 items-center gap-2 px-2">
        <span className="min-w-0 flex-1 truncate font-medium">{selected ? `Инструмент ${selected.name}` : "Сводка"}</span>
        {selected ? <><Permission value={selected.permission} /><button type="button" aria-label="Закрыть инструмент" onClick={() => setSelectedKey(null)}><X size={14} /></button></> : <span className="text-right text-2xs text-ddc-text-muted">{summary.toolCount} {plural(summary.toolCount, "инструмент", "инструмента", "инструментов")}, {summary.usedCount} использовано, {summary.callCount} {plural(summary.callCount, "вызов", "вызова", "вызовов")}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <StatusRing counts={selected?.counts ?? summary.counts} />
        {selected ? <table aria-label={`Вызовы ${selected.name}`} className="w-full table-fixed border-collapse"><colgroup><col className="w-20" /><col /><col className="w-24" /><col className="w-20" /></colgroup><thead><tr>{["Время", "Ввод", "Статус", "Длительность"].map(label => <th key={label} className={head}>{label}</th>)}</tr></thead>
          <tbody>{selected.callList.map(call => <tr key={call.useEventId} tabIndex={0} aria-selected={selection.eventId === call.useEventId || selection.eventId === call.resultEventId && call.resultEventId !== null} className={`h-6 cursor-pointer hover:bg-ddc-surface-muted ${selection.eventId === call.useEventId || selection.eventId === call.resultEventId && call.resultEventId !== null ? "bg-ddc-selected-bg outline outline-1 -outline-offset-1 outline-ddc-ring" : ""}`} onClick={() => onSelectEvent(call.useEventId, "tools")} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectEvent(call.useEventId, "tools"); } }}>
            <td className={`${cell} text-ddc-text-muted tabular-nums`}>{call.startMs === null ? EMPTY_VALUE : formatClockRu(call.startMs)}</td><td className={`${cell} font-mono`} title={toolInputPreview(call.name, call.input)}>{toolInputPreview(call.name, call.input)}</td><td className={`${cell} ${call.status === "completed" ? "text-ddc-success-text" : call.status === "failed" ? "text-ddc-danger-text" : "text-ddc-text-muted"}`}>{statusLabels[call.status]}</td><td className={`${cell} text-right tabular-nums`}>{duration(call.durationMs)}</td>
          </tr>)}</tbody></table> : <table className="w-full border-collapse"><thead><tr><th className={head}>Время в инструментах</th><th className={`${head} text-right`}>Длительность</th></tr></thead><tbody>{[["Всего", summary.time.totalMs], ["Выполнение", summary.time.executingMs], ["Ожидание вас", summary.time.waitingMs]].map(([label, ms]) => <tr key={label}><td className={`${cell} text-ddc-text-muted`}>{label}</td><td className={`${cell} text-right tabular-nums`}>{duration(ms as number)}</td></tr>)}</tbody></table>}
      </div>
    </section>
  </div>;
}
