/**
 * Черновик карточки модели (раздел 1.4 плана). Ассистент карточку не создаёт:
 * он готовит черновик, а форму открывает и подтверждает человек. Поля, которых
 * нет в белом списке, до формы не доходят. Ключ, заголовки и адрес в черновик
 * не попадают: чужой адрес получил бы ключ, который человек введёт в форме.
 *
 * Ключ состояния маршрута читает окно карточки (BK5). Оно обязано отфильтровать
 * состояние ещё раз: страница получает его из истории браузера.
 */

export const MODEL_CARD_DRAFT_STATE_KEY = "modelCardDraft";

export interface ModelCardDraft {
  provider?: string;
  model_id?: string;
  model?: string;
  pi_config?: Record<string, unknown>;
  is_default?: boolean;
}

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function sanitizeModelCardDraft(raw: unknown): ModelCardDraft {
  const r = rec(raw);
  const out: ModelCardDraft = {};
  if (typeof r.provider === "string") out.provider = r.provider;
  if (typeof r.model_id === "string") out.model_id = r.model_id;
  const wire = typeof r.model === "string" ? r.model : typeof r.wire_model === "string" ? r.wire_model : null;
  if (wire !== null) out.model = wire;
  if (r.pi_config !== null && typeof r.pi_config === "object" && !Array.isArray(r.pi_config)) {
    out.pi_config = r.pi_config as Record<string, unknown>;
  }
  if (typeof r.is_default === "boolean") out.is_default = r.is_default;
  return out;
}
