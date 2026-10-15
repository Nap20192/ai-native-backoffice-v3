import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ArrowDownIcon, ArrowUpIcon, FileTextIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PlainButton } from "@/components/ui/plain-button";
import { cn } from "@/lib/utils";
import type { TranscriptBlock } from "../../lib/session-stats";
import { Markdown } from "../Markdown";
import "./transcript.css";

type Block<K extends TranscriptBlock["kind"]> = Extract<TranscriptBlock, { kind: K }>;

/** Общий вид карточки блока разговора. Фон берёт переменная
 *  --session-card-bg из transcript.css: под неё же затухает длинный текст. */
export const SESSION_CARD_CLASS =
  "rounded-xl border border-ddc-border px-3 py-2 text-sm leading-6 text-ddc-text";

/** Рамка выбранного блока, цвет кольца фокуса DDC. */
export const SESSION_CARD_SELECTED_CLASS = "ring-2 ring-ddc-ring";

/** Идёт ли выделение текста: тогда клик по карточке завершает выделение и
 *  блок выбирать не нужно. */
export function isSelectingText(): boolean {
  if (typeof window === "undefined" || typeof window.getSelection !== "function") return false;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
}

/** Маленькая текстовая кнопка карточки. Видимая высота 24px, зона нажатия
 *  расширена до 32px (правило 13 DDC). */
export function InlineTextButton({
  children,
  className,
  ...props
}: ComponentProps<typeof PlainButton>) {
  return (
    <PlainButton
      data-search-skip
      className={cn(
        "relative inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs leading-4 whitespace-nowrap text-ddc-label transition-colors after:absolute after:-inset-y-1 after:inset-x-0 after:content-[''] hover:bg-ddc-ghost-hover hover:text-ddc-text disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        className,
      )}
      {...props}
    >
      {children}
    </PlainButton>
  );
}

/* ---------- Читать дальше ---------- */

/** Высота, выше которой текст сворачивается: 15rem, см. transcript.css. */
const CLAMP_REM = 15;

function clampLimitPx(): number {
  const root =
    typeof window !== "undefined" && typeof window.getComputedStyle === "function"
      ? Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)
      : Number.NaN;
  return CLAMP_REM * (Number.isFinite(root) && root > 0 ? root : 16);
}

/**
 * Длинный текст ограничен по высоте с затуханием и кнопкой «Читать дальше»,
 * после раскрытия внизу «Свернуть». Короткий текст остаётся как есть.
 * Раскрыть блок снаружи можно событием `session-clamp-expand` на корне
 * (так поиск по разговору показывает совпадение в свёрнутой части).
 */
export function ClampedContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [tall, setTall] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setTall(element.scrollHeight > clampLimitPx());
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const expand = () => setExpanded(true);
    element.addEventListener("session-clamp-expand", expand);
    return () => element.removeEventListener("session-clamp-expand", expand);
  }, []);

  const state = !tall ? "none" : expanded ? "expanded" : "collapsed";

  return (
    <div className={cn("relative min-w-0", className)}>
      <div data-clamp-state={state} data-session-clamp ref={ref}>
        {children}
        {state === "collapsed" ? (
          <InlineTextButton
            data-session-clamp-toggle="more"
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(true);
            }}
          >
            Читать дальше
          </InlineTextButton>
        ) : null}
      </div>
      {state === "expanded" ? (
        <InlineTextButton
          className="mt-1"
          data-session-clamp-toggle="less"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(false);
          }}
        >
          Свернуть
        </InlineTextButton>
      ) : null}
    </div>
  );
}

/* ---------- Задан результат ---------- */

export function OutcomeDefinedBlock({
  block,
  selected,
  onSelect,
}: {
  block: Block<"outcome_defined">;
  selected: boolean;
  onSelect(): void;
}) {
  const { outcome } = block;
  const rubric = outcome.rubric;
  const rubricText = rubric.type === "text" ? rubric.content.trim() : "";

  return (
    <div
      className={cn(SESSION_CARD_CLASS, "space-y-2", selected && SESSION_CARD_SELECTED_CLASS)}
      data-block-id={block.id}
      data-selected={selected ? "true" : "false"}
      data-session-card
      data-tone="muted"
      onClick={() => {
        if (!isSelectingText()) onSelect();
      }}
    >
      <p className="text-sm font-semibold text-ddc-heading">Задан результат</p>
      {outcome.description ? (
        <div className="min-w-0">
          <Markdown>{outcome.description}</Markdown>
        </div>
      ) : null}
      {rubricText || rubric.type === "file" ? (
        <div className="min-w-0">
          <p className="text-xs text-ddc-text-muted">Критерии</p>
          {rubric.type === "file" ? (
            <p className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-ddc-surface-sunken px-2 py-0.5 font-mono text-xs text-ddc-label">
              <FileTextIcon aria-hidden="true" className="size-3.5" />
              <span>{rubric.fileId}</span>
            </p>
          ) : (
            <Markdown>{rubricText}</Markdown>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------- Оценка ---------- */

const RESULT_PRESENTATION: Record<
  string,
  { label: string; variant: "success" | "warning" | "neutral" | "destructive" }
> = {
  satisfied: { label: "Выполнено", variant: "success" },
  needs_revision: { label: "Нужна доработка", variant: "warning" },
  max_iterations_reached: { label: "Итерации исчерпаны", variant: "neutral" },
  failed: { label: "Оценка не удалась", variant: "destructive" },
  interrupted: { label: "Прервано", variant: "neutral" },
};

export function GradingBlock({
  block,
  selected,
  onSelect,
  onJumpToRubric,
  onPrev,
  onNext,
}: {
  block: Block<"grading">;
  selected: boolean;
  onSelect(): void;
  onJumpToRubric(): void;
  onPrev?(): void;
  onNext?(): void;
}) {
  const { evaluation } = block;
  const presentation = RESULT_PRESENTATION[evaluation.result];
  const explanation = evaluation.explanation.trim();
  const stop = (action: (() => void) | undefined) => (event: MouseEvent) => {
    event.stopPropagation();
    action?.();
  };

  return (
    <div
      className={cn(SESSION_CARD_CLASS, "space-y-1", selected && SESSION_CARD_SELECTED_CLASS)}
      data-block-id={block.id}
      data-selected={selected ? "true" : "false"}
      data-session-card
      onClick={() => {
        if (!isSelectingText()) onSelect();
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-ddc-heading">Оценка</span>
        <span className="text-xs text-ddc-text-muted">Итерация {evaluation.iteration + 1}</span>
        <Badge variant={presentation?.variant ?? "neutral"}>
          {presentation?.label ?? evaluation.result}
        </Badge>
        <div className="ml-auto flex items-center gap-0.5">
          <InlineTextButton onClick={stop(onJumpToRubric)}>Критерии</InlineTextButton>
          <InlineTextButton
            aria-label="Назад"
            disabled={!onPrev || block.index <= 0}
            onClick={stop(onPrev)}
            title="Назад"
          >
            <ArrowUpIcon aria-hidden="true" className="size-3" />
            Назад
          </InlineTextButton>
          <InlineTextButton
            aria-label="Далее"
            disabled={!onNext || block.index >= block.count - 1}
            onClick={stop(onNext)}
            title="Далее"
          >
            <ArrowDownIcon aria-hidden="true" className="size-3" />
            Далее
          </InlineTextButton>
        </div>
      </div>
      {explanation ? (
        <ClampedContent>
          <Markdown>{explanation}</Markdown>
        </ClampedContent>
      ) : null}
    </div>
  );
}
