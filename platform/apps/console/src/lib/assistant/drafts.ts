/**
 * Черновики карточек модели и harness (раздел 1.4 плана). Ассистент карточки не
 * создаёт: он готовит черновик, а форму открывает и подтверждает человек.
 * Поля, которых нет в белом списке, до формы не доходят. Ключ, заголовки и
 * адрес в черновик не попадают: чужой адрес получил бы ключ, который человек
 * введёт в форме. ID, команду, аргументы и рабочую папку harness человек тоже
 * вводит сам.
 *
 * Ключи состояния маршрута читают окна карточек (BK5). Они обязаны отфильтровать
 * состояние ещё раз: страница получает его из истории браузера.
 */

export const MODEL_CARD_DRAFT_STATE_KEY = "modelCardDraft";
export const HARNESS_CARD_DRAFT_STATE_KEY = "harnessCardDraft";

export interface ModelCardDraft {
  provider?: string;
  model_id?: string;
  model?: string;
  pi_config?: Record<string, unknown>;
  is_default?: boolean;
}

export interface HarnessCardDraft {
  name?: string;
  install?: { npm: string[]; pip: string[] };
  protocols?: string[];
  allowed_env?: string[];
}

const PROTOCOLS = ["anthropic-messages", "openai-chat", "openai-responses"] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function rec(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];

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

export function sanitizeHarnessCardDraft(raw: unknown): HarnessCardDraft {
  const r = rec(raw);
  const out: HarnessCardDraft = {};
  if (typeof r.name === "string" && r.name.trim()) out.name = r.name;
  if (r.install !== undefined) {
    const install = rec(r.install);
    out.install = { npm: strings(install.npm), pip: strings(install.pip) };
  }
  if (r.protocols !== undefined) {
    out.protocols = strings(r.protocols).filter((p) => (PROTOCOLS as readonly string[]).includes(p));
  }
  if (r.allowed_env !== undefined) {
    out.allowed_env = strings(r.allowed_env).filter((n) => ENV_NAME.test(n));
  }
  return out;
}
