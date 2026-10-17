import { useQuery } from "@tanstack/react-query";

import { useApi } from "./api";

/**
 * Клиент каталога моделей. Типы повторяют раздел 2 контракта
 * docs/plans/models-harness.md. Форма агента и карточка агента сами
 * показывают состояние ошибки, поэтому запрос идёт с `quiet`: второй сигнал
 * о том же сбое в виде тоста только шумит.
 */

export const MODEL_OPTIONS_PATH = "/v1/oma/model_options";

/** Протоколы модели (раздел 3.3 контракта). */
export type InferenceProtocol =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-responses"
  | "gemini";

/** Уровни усилия агента. Уровней Pi `minimal` и `off` в API агента нет. */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOption {
  /** Идентификатор, который агент хранит в `model`. */
  handle: string;
  label: string;
  source: "card" | "builtin";
  card_id: string | null;
  is_default: boolean;
  provider: string;
  wire_model: string;
  /** Протокол Pi или `null`. Нужен только для скорости. */
  api: string | null;
  protocols: InferenceProtocol[];
  context_window: number | null;
  max_output_tokens: number | null;
  effort_levels: EffortLevel[];
  speed_fast: boolean;
}

export interface ModelOptionsResponse {
  builtin_available: boolean;
  data: ModelOption[];
}

function useCatalogQuery<T>(key: string, path: string, enabled: boolean) {
  const { api } = useApi();
  return useQuery<T>({
    queryKey: ["catalog", key],
    queryFn: ({ signal }) => api<T>(path, { signal, quiet: true }),
    enabled,
    // Повтор ничего не меняет: форма показывает ошибку сама.
    retry: false,
  });
}

/** Модели для выбора в форме агента: карточки рабочего пространства и ключ сервера. */
export function useModelOptions({ enabled = true }: { enabled?: boolean } = {}) {
  return useCatalogQuery<ModelOptionsResponse>("model_options", MODEL_OPTIONS_PATH, enabled);
}
