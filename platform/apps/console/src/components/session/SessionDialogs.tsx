import { useEffect, useId, useState, type FormEvent } from "react";
import type {
  BetaManagedAgentsBudgetLimit,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { BetaManagedAgentsUserDefineOutcomeEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "../Field";
import { Modal } from "../Modal";
import { formatCentsRu, formatUsdMicrosRu } from "./format-ru";

/**
 * Окна страницы сессии: бюджет, результат и горячие клавиши. Окна только
 * собирают тело запроса, само обращение к серверу делает страница.
 */

// ── Бюджет ───────────────────────────────────────────────────────────────

export type BudgetParams = BetaManagedAgentsBudgetLimit;

export type BudgetParse =
  | { ok: true; cents: number | null }
  | { ok: false; reason: "format" | "decimals" | "positive" };

/** Доллары из поля в центы без плавающей запятой. Пустое поле снимает бюджет. */
export function parseBudgetInput(raw: string): BudgetParse {
  const text = raw.trim().replace(",", ".");
  if (text === "") return { ok: true, cents: null };
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return { ok: false, reason: "format" };
  const fraction = match[2] ?? "";
  if (fraction.length > 2) return { ok: false, reason: "decimals" };
  const cents = Number(match[1]) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return { ok: false, reason: "format" };
  if (cents <= 0) return { ok: false, reason: "positive" };
  return { ok: true, cents };
}

const BUDGET_ERROR: Record<"format" | "decimals" | "positive", string> = {
  format: "Введите сумму в долларах, например 5 или 7,50.",
  decimals: "Не больше двух знаков после запятой.",
  positive: "Сумма должна быть больше нуля. Чтобы снять бюджет, очистите поле.",
};

/** Бюджет для поля: «5,00» из 500 центов. */
function budgetDraft(cents: number | null): string {
  return cents === null ? "" : formatCentsRu(cents).slice(1);
}

export interface EditBudgetDialogProps {
  open: boolean;
  onClose(): void;
  /** Текущий бюджет в центах, null без бюджета. */
  budgetCents: number | null;
  /** Расход в миллионных долях доллара, null без цены. */
  spentMicros: number | null;
  /** Тело `budget` для POST /v1/sessions/:id; null снимает бюджет. */
  onSave(budget: BudgetParams | null): Promise<void>;
}

export function EditBudgetDialog({
  open,
  onClose,
  budgetCents,
  spentMicros,
  onSave,
}: EditBudgetDialogProps) {
  const [draft, setDraft] = useState(() => budgetDraft(budgetCents));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldId = useId();

  useEffect(() => {
    if (!open) return;
    setDraft(budgetDraft(budgetCents));
    setError(null);
  }, [open, budgetCents]);

  const submit = async () => {
    const parsed = parseBudgetInput(draft);
    if (!parsed.ok) {
      setError(BUDGET_ERROR[parsed.reason]);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(
        parsed.cents === null
          ? null
          : {
              type: "limit",
              max_list_cost: { amount: String(parsed.cents), currency: "USD" },
            },
      );
      onClose();
    } catch {
      // Обращение к серверу уже показало ошибку: окно остаётся открытым.
    } finally {
      setSaving(false);
    }
  };

  const spent =
    spentMicros === null
      ? "Расход посчитать нельзя, цены нет."
      : `Потрачено ${formatUsdMicrosRu(spentMicros)}.`;
  const hint =
    budgetCents === null
      ? `Бюджета нет. ${spent}`
      : `Сейчас ${formatCentsRu(budgetCents)}. ${spent} Если очистить поле, бюджет снимется.`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Изменить бюджет"
      maxWidth="max-w-sm"
      closeDisabled={saving}
      footer={
        <Button onClick={() => void submit()} loading={saving}>
          Сохранить
        </Button>
      }
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Label htmlFor={`${fieldId}-input`} className="mb-1.5 block text-xs leading-4 font-medium text-ddc-label">
          Бюджет
        </Label>
        <InputGroup>
          <InputGroupAddon>$</InputGroupAddon>
          <InputGroupInput
            id={`${fieldId}-input`}
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={saving}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${fieldId}-hint`}
          />
        </InputGroup>
        <p
          id={`${fieldId}-hint`}
          className={`mt-1.5 text-xs leading-4 ${error ? "text-ddc-danger-text" : "text-ddc-text-muted"}`}
        >
          {error ?? hint}
        </p>
      </form>
    </Modal>
  );
}

// ── Результат ────────────────────────────────────────────────────────────

export type OutcomeParams = BetaManagedAgentsUserDefineOutcomeEventParams;

const MAX_ITERATIONS_LIMIT = 20;

export interface DefineOutcomeDialogProps {
  open: boolean;
  onClose(): void;
  /** Событие user.define_outcome для POST /v1/sessions/:id/events. */
  onSubmit(event: OutcomeParams): Promise<void>;
}

export function DefineOutcomeDialog({ open, onClose, onSubmit }: DefineOutcomeDialogProps) {
  const [description, setDescription] = useState("");
  const [rubric, setRubric] = useState("");
  const [iterations, setIterations] = useState("");
  const [iterationsError, setIterationsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDescription("");
    setRubric("");
    setIterations("");
    setIterationsError(null);
  }, [open]);

  const ready = description.trim() !== "" && rubric.trim() !== "";

  const submit = async () => {
    if (!ready) return;
    let maxIterations: number | undefined;
    if (iterations.trim() !== "") {
      const value = Number(iterations);
      if (!Number.isInteger(value) || value < 1 || value > MAX_ITERATIONS_LIMIT) {
        setIterationsError(`Укажите число от 1 до ${MAX_ITERATIONS_LIMIT}.`);
        return;
      }
      maxIterations = value;
    }
    setIterationsError(null);
    setSaving(true);
    try {
      await onSubmit({
        type: "user.define_outcome",
        description: description.trim(),
        rubric: { type: "text", content: rubric.trim() },
        ...(maxIterations === undefined ? {} : { max_iterations: maxIterations }),
      });
      onClose();
    } catch {
      // Обращение к серверу уже показало ошибку: окно остаётся открытым.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Задать результат"
      maxWidth="max-w-lg"
      closeDisabled={saving}
      footer={
        <Button onClick={() => void submit()} disabled={!ready} loading={saving}>
          Задать результат
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Описание" hint="Что должна выдать сессия.">
          <Textarea
            autoFocus
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Например, план миграции биллинга с шагами отката на каждой фазе"
            disabled={saving}
          />
        </Field>
        <Field label="Критерии" hint="По каким критериям оценивать результат.">
          <Textarea
            value={rubric}
            onChange={(event) => setRubric(event.target.value)}
            placeholder={"У каждой фазы есть проверенный откат\nПри переключении нет простоя\nСтоимость оценена по фазам"}
            rows={4}
            disabled={saving}
          />
        </Field>
        <Field
          label="Максимум итераций (необязательно)"
          hint="Сколько раз оценщик проверит работу и вернёт её на доработку, прежде чем признает результат невыполненным. По умолчанию 3, не больше 20."
          error={iterationsError}
        >
          <Input
            type="number"
            min={1}
            max={MAX_ITERATIONS_LIMIT}
            inputMode="numeric"
            placeholder="3"
            value={iterations}
            onChange={(event) => setIterations(event.target.value)}
            disabled={saving}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ── Горячие клавиши ──────────────────────────────────────────────────────

export interface ShortcutRow {
  action: string;
  keys: readonly string[];
}

export const SHORTCUT_ROWS: readonly ShortcutRow[] = [
  { action: "Предыдущее или следующее событие", keys: ["↑", "↓", "K", "J"] },
  { action: "Раскрыть или свернуть вызов", keys: ["←", "→"] },
  { action: "Найти в разговоре", keys: ["/"] },
  { action: "Следующее или предыдущее совпадение (в поле поиска)", keys: ["Enter", "Shift", "Enter"] },
  { action: "Показать или скрыть инспектор", keys: ["D"] },
  { action: "Свернуть вызов, затем снять выбор", keys: ["Esc"] },
  { action: "Показать это окно", keys: ["?"] },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Modal open={open} onClose={onClose} title="Горячие клавиши" maxWidth="max-w-lg">
      <ul className="divide-y divide-ddc-divider">
        {SHORTCUT_ROWS.map((row) => (
          <li key={row.action} className="flex items-center justify-between gap-4 py-2.5">
            <span className="min-w-0 text-sm text-ddc-text">{row.action}</span>
            <span className="flex flex-none items-center gap-1">
              {row.keys.map((key, index) => (
                <kbd
                  key={`${key}-${index}`}
                  className="inline-flex h-5 items-center rounded-md bg-ddc-surface-sunken px-1.5 text-2xs font-medium text-ddc-label"
                >
                  {key}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
