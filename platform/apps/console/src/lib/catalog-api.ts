import { useQuery } from "@tanstack/react-query";

import { useApi } from "./api";

/**
 * Клиент каталога моделей и harness. Типы повторяют разделы 2 и 3 контракта
 * docs/plans/models-harness.md один в один. Форма агента и карточка агента сами
 * показывают состояние ошибки, поэтому запросы идут с `quiet`: второй сигнал
 * о том же сбое в виде тоста только шумит.
 */

export const MODEL_OPTIONS_PATH = "/v1/oma/model_options";
export const HARNESSES_PATH = "/v1/oma/harnesses";

/** Протоколы модели: единые имена для модели, harness и прокси (раздел 3.3). */
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
  /** Id записей каталога harness, с которыми модель совместима по протоколу. */
  harnesses: string[];
}

export interface ModelOptionsResponse {
  builtin_available: boolean;
  data: ModelOption[];
}

export type HarnessStatus = "ready" | "unverified" | "unavailable";

/** Блок `_oma.acp` агента, как его пишет каталог (раздел 3.4). */
export interface HarnessAcpBlock {
  agent: {
    id: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string | null>;
  };
  per_turn_timeout_ms?: number;
  [key: string]: unknown;
}

export interface HarnessEntry {
  id: string;
  source: "builtin" | "card";
  /** У встроенных записей английская подпись, русскую даёт `harness-text.ts`. */
  label: string;
  status: HarnessStatus;
  /** Причина, если запись недоступна. */
  reason: string | null;
  /** `acp-sandbox` для ACP-записей, `null` для встроенного цикла. */
  runtime_harness: string | null;
  /** Протоколы модели. `["*"]` означает любую модель. */
  protocols: string[];
  supports: { effort: boolean; speed: boolean; platform_tools: boolean; mcp: boolean };
  acp: HarnessAcpBlock | null;
  install: { npm: string[]; pip: string[] };
  install_hint: string | null;
  /** Имена переменных окружения, которые разрешает карточка. `null` у встроенных. */
  allowed_env: string[] | null;
  card_id: string | null;
}

export interface HarnessesResponse {
  data: HarnessEntry[];
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

/** Каталог harness: встроенный цикл, ACP-агенты и свои карточки. */
export function useHarnesses({ enabled = true }: { enabled?: boolean } = {}) {
  return useCatalogQuery<HarnessesResponse>("harnesses", HARNESSES_PATH, enabled);
}
