import { DEPENDENCY_KIND_LABELS, type DependencyEntry, type DependencyReport } from "../lib/dependencies";

function EntryRow({ entry }: { entry: DependencyEntry }) {
  const label = DEPENDENCY_KIND_LABELS[entry.kind] ?? entry.kind;
  const title = entry.name && entry.name !== "" ? entry.name : entry.id;
  return (
    <li className="flex flex-col gap-0.5 py-1.5 text-sm" data-testid="dependency-entry">
      <span className="text-ddc-heading">
        <span className="text-ddc-text-muted">{label}</span> {title}
        {entry.status ? <span className="text-ddc-text-muted">, {entry.status}</span> : null}
      </span>
      {entry.note ? <span className="text-xs text-ddc-text-muted">{entry.note}</span> : null}
    </li>
  );
}

function Section({
  title,
  entries,
  tone,
}: {
  title: string;
  entries: DependencyEntry[];
  tone: "blocking" | "affected";
}) {
  if (entries.length === 0) return null;
  return (
    <section
      aria-label={title}
      className={
        tone === "blocking"
          ? "rounded-lg border border-ddc-tone-danger-fg/30 bg-ddc-tone-danger-bg px-3 py-2"
          : "rounded-lg border border-ddc-border bg-ddc-surface px-3 py-2"
      }
    >
      <h3
        className={
          tone === "blocking"
            ? "text-sm font-medium text-ddc-tone-danger-fg"
            : "text-sm font-medium text-ddc-heading"
        }
      >
        {title}
      </h3>
      <ul className="divide-y divide-ddc-divider">
        {entries.map((entry) => (
          <EntryRow key={`${entry.kind}:${entry.id}`} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Списки зависимостей из GET /v1/oma/dependencies (docs/plans/crud.md, 1.2).
 * «Мешает» это блокирующие зависимости: пока они есть, действие недоступно.
 * «Затронет» показывает, что изменится, а действие остаётся доступным.
 */
export function DependencyList({ report }: { report: DependencyReport }) {
  if (report.blocking.length === 0 && report.affected.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      <Section title="Мешает" entries={report.blocking} tone="blocking" />
      <Section title="Затронет" entries={report.affected} tone="affected" />
      {report.truncated ? (
        <p className="text-xs text-ddc-text-muted">Показаны первые 50 строк каждого списка.</p>
      ) : null}
    </div>
  );
}
