/**
 * Чистые функции выбора модели агента: модель по умолчанию для новой формы и
 * поиск модели каталога по handle. Сети и React здесь нет.
 */
import type { ModelOption } from "../../lib/catalog-api";

/**
 * Модель для формы по умолчанию: карточка `is_default`, иначе первая карточка,
 * иначе первая встроенная модель.
 */
export function pickDefaultModel(options: ModelOption[]): ModelOption | null {
  const cards = options.filter((option) => option.source === "card");
  return (
    cards.find((option) => option.is_default) ??
    cards[0] ??
    options.find((option) => option.source === "builtin") ??
    null
  );
}

/** Модель каталога по handle или `undefined`. */
export function findModel(options: ModelOption[] | undefined, handle: string): ModelOption | undefined {
  return options?.find((option) => option.handle === handle);
}
