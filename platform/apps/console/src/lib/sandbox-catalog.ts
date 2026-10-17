import { useQuery } from "@tanstack/react-query";

import { useApi } from "./api";

/**
 * Клиент каталога образов песочницы. Типы повторяют ответ
 * `GET /v1/oma/sandbox-catalog` (docs/plans/environments.md, раздел 1.5,
 * `platform/apps/main-node/src/lib/sandbox-catalog-routes.ts`): образы с
 * дайджестом, ресурсами и составом из манифеста, затем шаблоны окна «Новое
 * окружение».
 *
 * Ответу сервера доверять нельзя: маршрут может быть не подключён (404), сервер
 * может работать без каталога (`enabled: false`), прокси может вернуть страницу
 * вместо JSON. `parseSandboxCatalog` читает ответ, не бросает ошибок и
 * пропускает битые записи. Консоль без каталога работает как раньше: берёт
 * шаблоны из кода и не показывает раздел «Образ».
 */

export const SANDBOX_CATALOG_PATH = "/v1/oma/sandbox-catalog";

export interface SandboxImageResources {
  disk_gb: number | null;
  memory_mib: number | null;
  cpus: number | null;
}

export interface SandboxCatalogImage {
  /** Ключ каталога. Окружение хранит его в `config.image`. */
  key: string;
  label: string;
  built: boolean;
  /** Почему образ нельзя использовать, по-русски. */
  reason: string | null;
  /** Дайджест манифеста OCI: `sha256:` и 64 знака. */
  image_digest: string | null;
  size_bytes: number | null;
  resources: SandboxImageResources;
  /** Манифест, который написала сборка образа. Вид у него свободный. */
  manifest: Record<string, unknown> | null;
}

export type SandboxTemplateNetworking =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allow_mcp_servers: boolean;
      allow_package_managers: boolean;
      allow_web_search: boolean;
      allowed_hosts: string[];
    };

export interface SandboxTemplatePackages {
  type: "packages";
  apt: string[];
  npm: string[];
  pip: string[];
}

export interface SandboxCatalogTemplate {
  id: string;
  label: string;
  description: string | null;
  /** Ключ образа шаблона. */
  image: string;
  /** Ложь, пока образ шаблона не собран. */
  available: boolean;
  /** Готовый `config` для `POST /v1/environments`. */
  config: {
    type: "cloud";
    image: string;
    networking: SandboxTemplateNetworking;
    packages: SandboxTemplatePackages;
  };
  metadata: Record<string, string>;
}

export interface SandboxCatalog {
  /** Ложь у сервера без `SANDBOX_IMAGE_CATALOG`: один образ сервера, шаблонов нет. */
  enabled: boolean;
  default_image: string;
  images: SandboxCatalogImage[];
  templates: SandboxCatalogTemplate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseImage(raw: unknown): SandboxCatalogImage | null {
  if (!isRecord(raw)) return null;
  const key = text(raw.key);
  const label = text(raw.label);
  if (key === null || label === null || typeof raw.built !== "boolean") return null;
  const resources = isRecord(raw.resources) ? raw.resources : {};
  return {
    key,
    label,
    built: raw.built,
    reason: text(raw.reason),
    image_digest: text(raw.image_digest),
    size_bytes: count(raw.size_bytes),
    resources: {
      disk_gb: count(resources.disk_gb),
      memory_mib: count(resources.memory_mib),
      cpus: count(resources.cpus),
    },
    manifest: isRecord(raw.manifest) ? raw.manifest : null,
  };
}

function parseNetworking(raw: unknown): SandboxTemplateNetworking | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "unrestricted") return { type: "unrestricted" };
  if (raw.type !== "limited") return null;
  return {
    type: "limited",
    allow_mcp_servers: raw.allow_mcp_servers === true,
    allow_package_managers: raw.allow_package_managers === true,
    allow_web_search: raw.allow_web_search === true,
    allowed_hosts: stringList(raw.allowed_hosts),
  };
}

function parseTemplate(raw: unknown): SandboxCatalogTemplate | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id);
  const label = text(raw.label);
  const image = text(raw.image);
  if (id === null || label === null || image === null || typeof raw.available !== "boolean") return null;
  const config = raw.config;
  if (!isRecord(config) || config.type !== "cloud") return null;
  const networking = parseNetworking(config.networking);
  if (networking === null) return null;
  const packages = isRecord(config.packages) ? config.packages : {};
  const metadata: Record<string, string> = {};
  if (isRecord(raw.metadata)) {
    for (const [name, value] of Object.entries(raw.metadata)) {
      if (typeof value === "string") metadata[name] = value;
    }
  }
  return {
    id,
    label,
    description: text(raw.description),
    image,
    available: raw.available,
    config: {
      type: "cloud",
      image: text(config.image) ?? image,
      networking,
      packages: {
        type: "packages",
        apt: stringList(packages.apt),
        npm: stringList(packages.npm),
        pip: stringList(packages.pip),
      },
    },
    metadata: Object.keys(metadata).length > 0 ? metadata : { oma_template: id },
  };
}

/** Читает ответ каталога. Возвращает null, если это не каталог. */
export function parseSandboxCatalog(raw: unknown): SandboxCatalog | null {
  if (!isRecord(raw)) return null;
  const defaultImage = text(raw.default_image);
  if (typeof raw.enabled !== "boolean" || defaultImage === null || !Array.isArray(raw.images)) return null;
  const images = raw.images.map(parseImage).filter((image): image is SandboxCatalogImage => image !== null);
  if (images.length === 0) return null;
  const templates = (Array.isArray(raw.templates) ? raw.templates : [])
    .map(parseTemplate)
    .filter((template): template is SandboxCatalogTemplate => template !== null);
  return { enabled: raw.enabled, default_image: defaultImage, images, templates };
}

/** Образ каталога по ключу. */
export function findCatalogImage(
  catalog: SandboxCatalog | null,
  key: string,
): SandboxCatalogImage | undefined {
  return catalog?.images.find((image) => image.key === key);
}

/**
 * Дайджест коротко: `sha256:3fdbc2…`. Полное значение остаётся в подсказке и
 * в буфере обмена. Короткое значение и строка не в виде `sha256:<hex>` идут как
 * есть.
 */
export function shortDigest(digest: string | null): string | null {
  if (!digest) return null;
  const match = /^(sha256:)([0-9a-f]+)$/i.exec(digest);
  if (match === null || match[2]!.length <= 6) return digest;
  return `${match[1]}${match[2]!.slice(0, 6)}…`;
}

export interface SandboxCatalogState {
  /** Включённый каталог или null: загрузка, ошибка, сервер без каталога. */
  catalog: SandboxCatalog | null;
  isLoading: boolean;
}

/**
 * Каталог образов сервера. Запрос идёт с `quiet`: отсутствие маршрута это
 * обычное состояние сервера без каталога, тост об ошибке здесь только шумит.
 * Страницы окружений показывают то, что есть: без каталога шаблоны из кода и
 * без раздела «Образ».
 */
export function useSandboxCatalog({ enabled = true }: { enabled?: boolean } = {}): SandboxCatalogState {
  const { api } = useApi();
  const query = useQuery<SandboxCatalog | null>({
    queryKey: ["sandbox-catalog"],
    queryFn: async ({ signal }) =>
      parseSandboxCatalog(await api<unknown>(SANDBOX_CATALOG_PATH, { signal, quiet: true })),
    enabled,
    // Повтор ничего не меняет: без маршрута страница работает как раньше.
    retry: false,
    staleTime: 60_000,
  });
  return {
    catalog: query.data?.enabled ? query.data : null,
    isLoading: query.isLoading,
  };
}
