import { starterCardsFor, type PageKind } from "../../lib/assistant/page-context";
import { PlainButton } from "@/components/ui/plain-button";

/**
 * Пустое состояние панели «Чем помочь?» и четыре карточки по странице
 * (раздел 1.2 плана). Клик по карточке отправляет её текст.
 */
export function StarterCards({
  kind,
  onPick,
  disabled = false,
}: {
  kind: PageKind;
  onPick: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 px-3 py-4" aria-label="Подсказки">
      <h3 className="text-base font-semibold text-ddc-heading">Чем помочь?</h3>
      <div className="grid grid-cols-2 gap-2">
        {starterCardsFor(kind).map((card) => (
          <PlainButton
            key={card.title}
            type="button"
            disabled={disabled}
            onClick={() => onPick(card.prompt)}
            className="assistant-starter min-h-16 rounded-xl border border-ddc-border bg-ddc-surface p-3 text-left text-sm font-medium text-ddc-text transition hover:bg-ddc-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {card.title}
          </PlainButton>
        ))}
      </div>
    </section>
  );
}
