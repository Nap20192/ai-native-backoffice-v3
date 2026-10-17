import type {
  BetaCloudConfig,
  BetaCloudConfigParams,
  BetaEnvironment,
  BetaLimitedNetwork,
  BetaLimitedNetworkParams,
  BetaSelfHostedConfig,
  BetaSelfHostedConfigParams,
  BetaUnrestrictedNetwork,
  EnvironmentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments/environments";

/**
 * Поля окружения, которые сервер добавил к схеме Managed Agents
 * (docs/plans/environments.md, разделы 1.5 и 7.3). SDK их не знает:
 *
 * - `config.image` это ключ образа из каталога `GET /v1/oma/sandbox-catalog`.
 *   `null` значит образ по умолчанию на момент создания песочницы;
 * - `networking.allow_web_search` разрешает веб-поиск в ограниченной сети.
 *
 * Сервер до каталога образов этих полей не отдаёт, поэтому в типах ответа они
 * необязательные. Консоль пишет их обратно только тогда, когда они пришли.
 */

export type OmaLimitedNetwork = BetaLimitedNetwork & { allow_web_search?: boolean };

export type OmaCloudConfig = Omit<BetaCloudConfig, "networking"> & {
  image?: string | null;
  networking: BetaUnrestrictedNetwork | OmaLimitedNetwork;
};

export type OmaEnvironment = Omit<BetaEnvironment, "config"> & {
  config: OmaCloudConfig | BetaSelfHostedConfig;
};

export type OmaLimitedNetworkParams = BetaLimitedNetworkParams & { allow_web_search?: boolean | null };

export type OmaCloudConfigParams = Omit<BetaCloudConfigParams, "networking"> & {
  image?: string | null;
  networking?: BetaUnrestrictedNetwork | OmaLimitedNetworkParams | null;
};

/** Тело правки окружения: как в SDK, но с полями сервера в `config`. */
export type OmaEnvironmentUpdateParams = Omit<EnvironmentUpdateParams, "config" | "betas"> & {
  config?: OmaCloudConfigParams | BetaSelfHostedConfigParams | null;
};

/** Метки платформы начинаются с `oma_` (например, `oma_template`). Редактор метаданных их не показывает. */
export const PLATFORM_METADATA_PREFIX = "oma_";

export function isPlatformMetadataKey(key: string): boolean {
  return key.startsWith(PLATFORM_METADATA_PREFIX);
}
