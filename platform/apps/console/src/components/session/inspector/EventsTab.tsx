import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, Download, X } from "lucide-react";
import { CodeBlock } from "../../ai-elements/code-block";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import {
  buildEventIndex, eventFamily, eventJson, eventPreview, eventTimeMs, eventTypesPresent,
  filterEvents, groupEventsByRequest, TRANSCRIPT_EVENT_TYPES,
  type EventFilter, type EventSelection, type SessionEvent,
} from "../../../lib/session-stats";
import { EMPTY_VALUE, formatClockRu, formatEventDateTimeRu } from "../format-ru";

export interface EventsTabProps {
  sessionId: string;
  events: readonly SessionEvent[];
  selection: EventSelection;
  onSelectEvent(eventId: string | null, source: "events"): void;
}

function eventsJson(events: readonly SessionEvent[]): string {
  return `[\n${events.map(event => eventJson(event).split("\n").map(line => `  ${line}`).join("\n")).join(",\n")}\n]`;
}
export async function copyEventsToClipboard(events: readonly SessionEvent[]): Promise<void> {
  await navigator.clipboard.writeText(eventsJson(events));
}
export function downloadEventsFile(sessionId: string, events: readonly SessionEvent[]): void {
  const url = URL.createObjectURL(new Blob([eventsJson(events)], { type: "application/json" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `events-${sessionId}.json`;
    link.click();
  } finally { URL.revokeObjectURL(url); }
}

const columns = "grid grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_4rem] items-center gap-2 px-2";
const familyColors = { agent: "var(--ddc-tone-info-fg)", user: "var(--ddc-tone-brand-fg)", span: "var(--color-ink-500)", session: "var(--ddc-text-muted)", system: "var(--ddc-text-muted)", other: "var(--ddc-text)" };

function EventJsonCode({ event }: { event: SessionEvent }) {
  const root = useRef<HTMLDivElement>(null);
  const code = eventJson(event);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    // CodeBlock loads its fixed Shiki theme asynchronously and has no theme prop.
    const applyTokens = () => {
      for (const pre of node.querySelectorAll("pre")) {
        pre.style.setProperty("background-color", "var(--ddc-surface-sunken)", "important");
        pre.style.setProperty("color", "var(--ddc-text)", "important");
      }
      for (const token of node.querySelectorAll<HTMLElement>("code span[style]")) {
        const text = token.textContent?.trim() ?? "";
        const key = token.nextElementSibling?.textContent?.trimStart().startsWith(":");
        const color = text.startsWith('"') && !key ? "var(--ddc-tone-success-fg)" : /^(?:-?\d|true$|false$|null$)/.test(text) ? "var(--ddc-tone-info-fg)" : "var(--ddc-text)";
        token.style.setProperty("--ddc-json-token", color);
        token.style.setProperty("color", "var(--ddc-json-token)", "important");
        token.style.setProperty("background-color", "transparent", "important");
      }
    };
    applyTokens();
    const observer = new MutationObserver(applyTokens);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [code]);
  return <div ref={root}><CodeBlock code={code} language="json" className="[&_pre]:!p-2 [&_pre]:!text-xs [&_code]:!text-xs" /></div>;
}

export function EventsTab({ sessionId, events, selection, onSelectEvent }: EventsTabProps) {
  const [filter, setFilter] = useState<EventFilter>({ mode: "all" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [copyError, setCopyError] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const cachedSelection = useRef<SessionEvent | null>(null);
  const index = useMemo(() => buildEventIndex(events), [events]);
  const filtered = useMemo(() => filterEvents(events, filter), [events, filter]);
  // Filter the original frames so hiding a start does not merge adjacent requests.
  const visibleIds = new Set(filtered);
  const groups = useMemo(() => groupEventsByRequest(events), [events]);
  const selected = selection.eventId ? index.byId.get(selection.eventId) ?? (cachedSelection.current?.id === selection.eventId ? cachedSelection.current : null) : null;
  useEffect(() => { cachedSelection.current = selected; }, [selected]);
  const hidden = selection.eventId !== null && !filtered.some(event => event.id === selection.eventId);
  const label = filter.mode === "all" ? "Все события" : filter.mode === "transcript" ? "События разговора" : "Типы событий";
  const types = eventTypesPresent(events).filter(type => type.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    if (!selection.eventId || selection.source === "events") return;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-event-id]") ?? [])].find(el => el.dataset.eventId === selection.eventId);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [selection.eventId, selection.source, selection.seq, filter, events]);

  function toggleType(type: string) {
    const types = new Set(filter.mode === "types" ? filter.types : filter.mode === "transcript" ? TRANSCRIPT_EVENT_TYPES : []);
    if (types.has(type)) types.delete(type); else types.add(type);
    setFilter({ mode: "types", types });
    setMenuOpen(false);
  }
  function renderRow(event: SessionEvent, key: number) {
    const family = eventFamily(event.type);
    const dot = event.type.indexOf(".") + 1;
    const active = event.id !== undefined && event.id === selection.eventId;
    const at = eventTimeMs(event);
    return <div key={event.id ?? key} role="row" tabIndex={0} data-event-id={event.id} aria-selected={active}
      className={`${columns} h-6 cursor-pointer text-xs ${family === "session" ? "text-ddc-text-muted" : "text-ddc-text"} ${active ? "relative rounded-sm bg-ddc-selected-bg outline outline-1 -outline-offset-1 outline-ddc-ring" : "hover:bg-ddc-surface-muted"}`}
      onClick={() => onSelectEvent(event.id ?? null, "events")}
      onKeyDown={eventKey => { if (eventKey.key === "Enter" || eventKey.key === " ") { eventKey.preventDefault(); onSelectEvent(event.id ?? null, "events"); } }}>
      <span role="cell" className="truncate font-mono" title={event.type}><span data-event-family={family} style={{ color: familyColors[family] }}>{event.type.slice(0, dot)}</span>{event.type.slice(dot)}</span>
      <span role="cell" className="truncate" title={eventPreview(event, index)}>{eventPreview(event, index)}</span>
      <span role="cell" className="text-right text-ddc-text-muted tabular-nums">{at === null ? EMPTY_VALUE : formatClockRu(at)}</span>
    </div>;
  }

  return <div className="flex h-full min-h-0 flex-col bg-ddc-surface font-sans text-xs text-ddc-text">
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-2">
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild><button type="button" className="flex h-7 items-center gap-1 rounded-md border border-ddc-border px-2">{label}<ChevronDown size={12} /></button></PopoverTrigger>
        <PopoverContent align="start" className="w-72 gap-0 p-1 text-xs" onOpenAutoFocus={event => event.preventDefault()}>
          <input type="search" aria-label="Поиск типов событий" placeholder="Поиск" className="mb-1 h-7 w-full border-b border-ddc-divider bg-ddc-surface px-2 outline-none" value={query} onChange={event => setQuery(event.target.value)} />
          <button type="button" className="h-7 px-2 text-left hover:bg-ddc-surface-muted" onClick={() => { setFilter({ mode: "all" }); setMenuOpen(false); }}>Все события</button>
          <label className="flex h-7 items-center gap-2 px-2"><input type="checkbox" checked={filter.mode === "transcript"} onChange={() => { setFilter(filter.mode === "transcript" ? { mode: "all" } : { mode: "transcript" }); setMenuOpen(false); }} />События разговора</label>
          <div className="border-t border-ddc-divider px-2 py-2 text-ddc-text-muted">Типы событий</div>
          <div className="max-h-64 overflow-y-auto">{types.map(type => <label key={type} className="flex h-7 items-center gap-2 px-2 font-mono"><input type="checkbox" checked={filter.mode !== "all" && (filter.mode === "transcript" ? TRANSCRIPT_EVENT_TYPES : filter.types).has(type)} onChange={() => toggleType(type)} />{type}</label>)}</div>
        </PopoverContent>
      </Popover>
      <div className="flex gap-1">
        <button type="button" className="flex h-7 items-center gap-1 rounded-md border border-ddc-border px-1.5" onClick={async () => { try { await copyEventsToClipboard(filtered); setCopyError(false); } catch { setCopyError(true); } }}><Copy size={12} />Копировать</button>
        <button type="button" className="flex h-7 items-center gap-1 rounded-md border border-ddc-border px-1.5" onClick={() => downloadEventsFile(sessionId, filtered)}><Download size={12} />Скачать</button>
      </div>
    </div>
    {copyError && <div role="alert" className="px-2 text-ddc-danger-text">Не удалось скопировать события</div>}
    {hidden && <div className="px-2 py-1 text-ddc-text-muted">Событие скрыто фильтром</div>}
    <div ref={listRef} role="table" aria-label="События" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto pb-1"
      onKeyDown={event => {
        if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        if (!filtered.length) return;
        const i = filtered.findIndex(e => e.id === selection.eventId);
        const next = i < 0 ? event.key === "ArrowDown" ? 0 : filtered.length - 1 : Math.max(0, Math.min(filtered.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)));
        onSelectEvent(filtered[next].id ?? null, "events");
      }}>
      <div role="row" className={`${columns} sticky top-0 z-10 h-6 border-b border-ddc-divider bg-ddc-surface text-ddc-label`}><span role="columnheader">Событие</span><span role="columnheader">Кратко</span><span role="columnheader" className="text-right">Время</span></div>
      {groups.map((group, i) => group.kind === "single" ? visibleIds.has(group.event) && renderRow(group.event, i) : group.events.some(e => visibleIds.has(e)) && <div key={`${group.id}-${i}`} role="rowgroup" aria-label={`Запрос ${group.id}`} className="mx-1 my-1 rounded-lg border border-ddc-border py-1">{group.events.filter(e => visibleIds.has(e)).map(renderRow)}</div>)}
      {!filtered.length && <div className="p-3 text-ddc-text-muted">Нет событий</div>}
    </div>
    {selection.eventId && <section aria-label="Выбранное событие" className="flex h-1/2 min-h-0 shrink-0 flex-col border-t border-ddc-divider">
      <div className="flex min-h-8 items-center gap-2 px-2"><span className="min-w-0 flex-1 truncate">Событие <span className="font-mono">{selected?.type ?? ""}</span></span><span className="max-w-28 truncate font-mono text-ddc-text-muted" title={selection.eventId}>{selection.eventId.length > 16 ? `${selection.eventId.slice(0, 7)}…${selection.eventId.slice(-7)}` : selection.eventId}</span><button type="button" aria-label="Закрыть событие" onClick={() => onSelectEvent(null, "events")}><X size={14} /></button></div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {selected ? <><div className="mb-2 text-ddc-text-muted">{eventTimeMs(selected) === null ? EMPTY_VALUE : formatEventDateTimeRu(eventTimeMs(selected)!)}</div><EventJsonCode event={selected} /></> : <div className="text-ddc-text-muted">Событие недоступно в этом потоке</div>}
      </div>
    </section>}
  </div>;
}
