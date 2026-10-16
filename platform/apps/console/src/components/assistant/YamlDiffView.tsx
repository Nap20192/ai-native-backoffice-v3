import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * Разница YAML для карточек ассистента (раздел 1.4 плана). Сервер присылает
 * `before_yaml` и `after_yaml`, а строки разницы консоль считает сама: форма
 * ответа сервера не влияет на то, что видит пользователь. Удалённое красным,
 * новое зелёным, по 3 строки вокруг. Каждая строка несёт подпись для чтения
 * без цвета.
 */

export type DiffType = "ctx" | "del" | "add";
export interface DiffLine {
  type: DiffType;
  text: string;
}

/** Выше этого числа клеток таблицы LCS считаем замену целиком, чтобы не тормозить. */
const MAX_CELLS = 4_000_000;

export function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  // Общие начало и конец режем сразу: правка обычно в середине.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const head: DiffLine[] = before.slice(0, start).map((text) => ({ type: "ctx", text }));
  const tail: DiffLine[] = before.slice(endB).map((text) => ({ type: "ctx", text }));
  const a = before.slice(start, endB);
  const b = after.slice(start, endA);

  let middle: DiffLine[];
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) {
    middle = [
      ...a.map((text): DiffLine => ({ type: "del", text })),
      ...b.map((text): DiffLine => ({ type: "add", text })),
    ];
  } else {
    // Длина наибольшей общей подпоследовательности с конца.
    const w = b.length + 1;
    const table = new Uint32Array((a.length + 1) * w);
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i * w + j] =
          a[i] === b[j]
            ? table[(i + 1) * w + j + 1] + 1
            : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        middle.push({ type: "ctx", text: a[i] });
        i++;
        j++;
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
        middle.push({ type: "del", text: a[i++] });
      } else {
        middle.push({ type: "add", text: b[j++] });
      }
    }
    while (i < a.length) middle.push({ type: "del", text: a[i++] });
    while (j < b.length) middle.push({ type: "add", text: b[j++] });
  }
  return [...head, ...middle, ...tail];
}

export interface Hunk {
  lines: DiffLine[];
  hiddenBefore: number;
  hiddenAfter: number;
}

/** Блоки изменений по `context` строк вокруг. Близкие блоки склеиваются. */
export function buildHunks(lines: readonly DiffLine[], context: number): Hunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === "ctx") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
      keep[k] = true;
    }
  });
  const hunks: Hunk[] = [];
  let index = 0;
  let hiddenBefore = 0;
  while (index < lines.length) {
    if (!keep[index]) {
      hiddenBefore++;
      index++;
      continue;
    }
    const block: DiffLine[] = [];
    while (index < lines.length && keep[index]) block.push(lines[index++]);
    let hiddenAfter = 0;
    let probe = index;
    while (probe < lines.length && !keep[probe]) {
      hiddenAfter++;
      probe++;
    }
    hunks.push({ lines: block, hiddenBefore, hiddenAfter });
    hiddenBefore = 0;
  }
  return hunks;
}

function splitLines(yaml: string | null): string[] {
  if (!yaml) return [];
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const LINE_CLASS: Record<DiffType, string> = {
  ctx: "text-ddc-text-muted",
  del: "bg-ddc-tone-danger-bg text-ddc-tone-danger-fg",
  add: "bg-ddc-tone-success-bg text-ddc-tone-success-fg",
};
const MARK: Record<DiffType, string> = { ctx: " ", del: "-", add: "+" };
const LABEL: Record<DiffType, string> = { ctx: "", del: "Удалено", add: "Добавлено" };

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div
      className={cn("assistant-diff-line flex gap-2 px-2 font-mono text-xs leading-5", LINE_CLASS[line.type])}
      data-diff={line.type}
    >
      <span aria-hidden="true" className="w-3 shrink-0 select-none">
        {MARK[line.type]}
      </span>
      {LABEL[line.type] ? <span className="sr-only">{LABEL[line.type]}</span> : null}
      <span className="min-w-0 whitespace-pre-wrap break-words">{line.text}</span>
    </div>
  );
}

function HiddenNote({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="px-2 py-0.5 text-center text-[11px] text-ddc-text-muted" data-diff="gap">
      {`… ещё ${count} без изменений`}
    </div>
  );
}

export interface YamlDiffViewProps {
  before: string | null;
  after: string | null;
  className?: string;
}

/** Построчная разница с кнопкой «Показать целиком» (панель 617 px). */
export function YamlDiffView({ before, after, className }: YamlDiffViewProps) {
  const [full, setFull] = useState(false);
  const diff = useMemo(() => lineDiff(splitLines(before), splitLines(after)), [before, after]);
  const hunks = useMemo(() => buildHunks(diff, 3), [diff]);

  return (
    <div className={cn("assistant-yaml-diff", className)}>
      {hunks.length === 0 ? (
        <p className="px-2 py-1 text-xs text-ddc-text-muted">Изменений нет</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-ddc-border bg-ddc-surface-muted" role="group" aria-label="Разница">
          {hunks.map((hunk, h) => (
            <div key={h}>
              <HiddenNote count={hunk.hiddenBefore} />
              {hunk.lines.map((line, i) => (
                <DiffRow key={i} line={line} />
              ))}
              {h === hunks.length - 1 ? <HiddenNote count={hunk.hiddenAfter} /> : null}
            </div>
          ))}
        </div>
      )}
      <div className="mt-1.5">
        <Button type="button" variant="link" size="xs" onClick={() => setFull(true)}>
          Показать целиком
        </Button>
      </div>
      <FullDiffSheet open={full} onOpenChange={setFull} diff={diff} />
    </div>
  );
}

function FullDiffSheet({
  open,
  onOpenChange,
  diff,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diff: DiffLine[];
}) {
  const left = diff.filter((l) => l.type !== "add");
  const right = diff.filter((l) => l.type !== "del");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full data-[side=right]:sm:max-w-[617px]" side="right">
        <SheetHeader>
          <SheetTitle>Разница целиком</SheetTitle>
          <SheetDescription>Слева текущее состояние, справа то, что будет после применения.</SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-auto px-4 pb-4">
          <Column title="Сейчас" lines={left} />
          <Column title="Станет" lines={right} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Column({ title, lines }: { title: string; lines: DiffLine[] }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-xs font-semibold text-ddc-heading">{title}</h3>
      <div className="overflow-hidden rounded-lg border border-ddc-border bg-ddc-surface-muted">
        {lines.map((line, i) => (
          <DiffRow key={i} line={line} />
        ))}
      </div>
    </section>
  );
}

/** Предел строк, после которого YAML нового объекта сворачивается. */
export const YAML_COLLAPSE_LINES = 20;

/** YAML нового объекта: после 20 строк свёрнут. */
export function YamlBlock({
  yaml,
  className,
  expanded = false,
}: {
  yaml: string | null;
  className?: string;
  /** Показывать всё без сворачивания (команда карточки harness). */
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const lines = splitLines(yaml);
  if (lines.length === 0) return null;
  const long = !expanded && lines.length > YAML_COLLAPSE_LINES;
  const shown = long && !open ? lines.slice(0, YAML_COLLAPSE_LINES) : lines;
  return (
    <div className={cn("assistant-yaml-block", className)}>
      <pre className="max-h-[420px] overflow-auto rounded-lg border border-ddc-border bg-ddc-surface-muted p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-ddc-text">
        {shown.join("\n")}
      </pre>
      {long ? (
        <Button type="button" variant="link" size="xs" onClick={() => setOpen((v) => !v)}>
          {open ? "Свернуть" : "Показать целиком"}
        </Button>
      ) : null}
    </div>
  );
}
