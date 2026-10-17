import type { ModelCard } from "@open-managed-agents/api-types";
import { useMemo } from "react";

import { useApi } from "./api";

/** Адрес карточек моделей. Остальные запросы страницы идут через `useApi` напрямую. */
export const MODEL_CARDS_PATH = "/v1/oma/model_cards";

export interface ModelCardTarget {
  id: string;
  /** Ревизия карточки: `updated_at`, у карточки без правок `created_at`. */
  ifMatch?: string;
}

export interface ModelCardDeleted {
  type: "model_card_deleted";
  id: string;
}

/** Ревизия карточки для `If-Match` (docs/plans/crud.md, 1.4). */
export function modelCardRevision(card: Pick<ModelCard, "updated_at" | "created_at">): string {
  return card.updated_at ?? card.created_at;
}

function init(method: string, ifMatch?: string) {
  return {
    method,
    quiet: true,
    ...(ifMatch ? { headers: { "If-Match": ifMatch } } : {}),
  };
}

/**
 * Архив, возврат из архива и удаление карточки модели (docs/plans/crud.md,
 * 2.8). Ошибки 409 и 412 приходят как `ApiError` со списком зависимостей, их
 * показывает окно `DangerDialog`.
 */
export function useModelCardActions() {
  const { api } = useApi();
  return useMemo(
    () => ({
      archive: ({ id, ifMatch }: ModelCardTarget) =>
        api<ModelCard>(`${MODEL_CARDS_PATH}/${encodeURIComponent(id)}/archive`, init("POST", ifMatch)),
      unarchive: ({ id, ifMatch }: ModelCardTarget) =>
        api<ModelCard>(`${MODEL_CARDS_PATH}/${encodeURIComponent(id)}/unarchive`, init("POST", ifMatch)),
      remove: ({ id, ifMatch }: ModelCardTarget) =>
        api<ModelCardDeleted>(`${MODEL_CARDS_PATH}/${encodeURIComponent(id)}`, init("DELETE", ifMatch)),
    }),
    [api],
  );
}
