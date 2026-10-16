import { SparklesIcon } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";

import { MODEL_CARD_DRAFT_STATE_KEY, sanitizeModelCardDraft } from "../../lib/assistant/drafts";

/**
 * Черновик карточки модели (раздел 1.4 плана). Ассистент карточку не создаёт:
 * маршрут создания требует ключ. Кнопка открывает окно карточки на
 * `/model-cards` с полями черновика, ключ вводит пользователь. Поля ключа,
 * заголовков и адреса не показываются и в окно не передаются.
 */

export function ModelCardDraftCard({ body }: { body: Record<string, unknown> }) {
  const navigate = useNavigate();
  const draft = sanitizeModelCardDraft(body);
  const rows: Array<[string, string]> = [];
  if (draft.model_id) rows.push(["Идентификатор", draft.model_id]);
  if (draft.model) rows.push(["Модель", draft.model]);
  if (draft.provider) rows.push(["Провайдер", draft.provider]);
  if (draft.pi_config) rows.push(["Параметры", JSON.stringify(draft.pi_config)]);
  if (draft.is_default !== undefined) rows.push(["По умолчанию", draft.is_default ? "да" : "нет"]);

  return (
    <article className="assistant-card flex min-w-0 flex-col gap-2 rounded-xl border border-ddc-border bg-ddc-surface p-3" data-kind="model_card_draft">
      <header className="flex items-start gap-2">
        <SparklesIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-(--assistant-accent)" />
        <h4 className="text-sm leading-5 font-semibold text-ddc-heading">Черновик карточки модели</h4>
      </header>
      <dl className="flex flex-col gap-1 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[7.5rem_1fr] gap-2">
            <dt className="text-ddc-text-muted">{label}</dt>
            <dd className="min-w-0 break-words text-ddc-text">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-ddc-text-muted">Ключ API и адрес в черновик не входят. Их вводит пользователь в форме</p>
      <div>
        <Button
          type="button"
          size="sm"
          onClick={() => navigate("/model-cards", { state: { [MODEL_CARD_DRAFT_STATE_KEY]: draft } })}
        >
          Открыть форму
        </Button>
      </div>
    </article>
  );
}
