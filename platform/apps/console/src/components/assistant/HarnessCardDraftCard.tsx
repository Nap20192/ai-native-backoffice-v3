import { SparklesIcon } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";

import { HARNESS_CARD_DRAFT_STATE_KEY, sanitizeHarnessCardDraft } from "../../lib/assistant/drafts";

/**
 * Черновик карточки harness (раздел 1.4 плана). Команда карточки работает в VM
 * от root, поэтому в черновике её нет: ID, команду, аргументы и рабочую папку
 * вводит пользователь. Кнопка открывает окно «Новый harness» на `/harnesses`
 * с названием, пакетами, протоколами и `allowed_env`.
 */

function Row({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2">
      <dt className="text-ddc-text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap gap-1">
        {values.map((v) => (
          <span key={v} className="assistant-chip font-mono">
            {v}
          </span>
        ))}
      </dd>
    </div>
  );
}

export function HarnessCardDraftCard({ body }: { body: Record<string, unknown> }) {
  const navigate = useNavigate();
  const draft = sanitizeHarnessCardDraft(body);
  return (
    <article className="assistant-card flex min-w-0 flex-col gap-2 rounded-xl border border-ddc-border bg-ddc-surface p-3" data-kind="harness_card_draft">
      <header className="flex items-start gap-2">
        <SparklesIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-(--assistant-accent)" />
        <h4 className="text-sm leading-5 font-semibold text-ddc-heading">Черновик карточки harness</h4>
      </header>
      <dl className="flex flex-col gap-1 text-xs">
        {draft.name ? (
          <div className="grid grid-cols-[7.5rem_1fr] gap-2">
            <dt className="text-ddc-text-muted">Название</dt>
            <dd className="min-w-0 break-words text-ddc-text">{draft.name}</dd>
          </div>
        ) : null}
        <Row label="Пакеты npm" values={draft.install?.npm ?? []} />
        <Row label="Пакеты pip" values={draft.install?.pip ?? []} />
        <Row label="Протоколы" values={draft.protocols ?? []} />
        <Row label="Переменные" values={draft.allowed_env ?? []} />
      </dl>
      <p className="text-xs text-ddc-text-muted">
        ID, команду, аргументы и рабочую папку вводит пользователь в форме. Команда работает в VM от root
      </p>
      <div>
        <Button
          type="button"
          size="sm"
          onClick={() => navigate("/harnesses", { state: { [HARNESS_CARD_DRAFT_STATE_KEY]: draft } })}
        >
          Открыть форму
        </Button>
      </div>
    </article>
  );
}
