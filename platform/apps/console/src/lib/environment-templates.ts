import { plural } from "../components/session/format-ru";
import { describeImageManifest } from "./image-manifest";
import {
  findCatalogImage,
  type SandboxCatalog,
  type SandboxCatalogImage,
  type SandboxCatalogTemplate,
  type SandboxTemplateNetworking,
} from "./sandbox-catalog";

/**
 * Шаблоны окна «Новое окружение» (docs/plans/environments.md, разделы 1.5 и 2).
 *
 * Сервер с каталогом образов отдаёт шаблоны сам: «Базовое», «Документы и
 * офис», «Данные», «Веб». Каждый несёт готовый `config` (образ, сеть, пакеты) и
 * метку `metadata.oma_template`. Консоль берёт их как есть и ставит «Пустое»
 * первым. Без каталога (сервер без `SANDBOX_IMAGE_CATALOG`, маршрут не
 * подключён, ответ не читается) остаются шаблоны из кода: «Пустое» и
 * «Документы» с пакетами apt и pip, которые сервер ставит при каждом старте
 * песочницы.
 */

export const EMPTY_TEMPLATE_ID = "empty";

export interface TemplatePackages {
  type: "packages";
  apt: string[];
  pip: string[];
  npm?: string[];
}

/** Часть `config` для `POST /v1/environments`, которую задаёт шаблон. */
export interface TemplateConfig {
  type: "cloud";
  image?: string;
  networking?: SandboxTemplateNetworking;
  packages?: TemplatePackages;
}

export interface EnvironmentTemplateFields {
  config: TemplateConfig;
  metadata?: Record<string, string>;
}

export interface EnvironmentTemplate {
  /** `empty`, ключ шаблона каталога или ключ шаблона из кода. */
  id: string;
  label: string;
  /** Одна строка о том, для чего шаблон. Пустая, если назначение неизвестно. */
  hint: string;
  /** Чип образа на карточке. Без каталога образов его нет. */
  imageLabel: string | null;
  /** Чип сети на карточке. */
  networkLabel: string | null;
  /** Строки сводки под рядом карточек: что именно создаст шаблон. */
  details: { image: string | null; network: string | null; packages: string | null };
  /** Ложь, пока образ шаблона не собран. */
  available: boolean;
  unavailableReason: string | null;
  /** Поля тела запроса создания окружения. */
  fields: EnvironmentTemplateFields;
}

const UNRESTRICTED_LABEL = "Без ограничений";

/** Подписи шаблонов. Нужны чипу «Шаблон» на карточке окружения, когда каталога нет. */
const KNOWN_LABELS: Record<string, string> = {
  [EMPTY_TEMPLATE_ID]: "Пустое",
  basic: "Базовое",
  documents: "Документы",
  data: "Данные",
  web: "Веб",
};

/** Назначение шаблонов каталога, пока оператор не задал `description` сам. */
const PURPOSE: Record<string, string> = {
  basic: "Код, скрипты, разбор файлов. Недостающее агент ставит из реестров.",
  documents: "Презентации, Word, Excel и PDF. Конвертация и проверка результата картинкой.",
  data: "SQL по файлам, статистика, графики.",
  web: "Сбор страниц и лент через curl и requests. Выход в интернет без ограничений.",
};

const EMPTY_HINT = "Только то, что есть в образе песочницы. Пакеты можно добавить потом в карточке окружения.";

const FALLBACK_DOCUMENTS_HINT =
  "Для встроенных навыков Word, PDF, PowerPoint и Excel. Сервер ставит пакеты при каждом старте песочницы, поэтому старт дольше.";

/** Пакеты шаблона «Документы» без каталога: шрифт с кириллицей и офисные библиотеки. */
function fallbackDocumentPackages(): TemplatePackages {
  return {
    type: "packages",
    apt: ["python3-pip", "fonts-dejavu-core"],
    pip: ["python-docx", "openpyxl", "python-pptx", "pypdf", "reportlab", "pdfplumber"],
  };
}

type PackageLists = { apt?: readonly string[]; pip?: readonly string[]; npm?: readonly string[] };

/** `apt: a, b; pip: c`. Пустые менеджеры пропускаются, пакетов нет: null. */
export function describePackages(packages: PackageLists | undefined): string | null {
  if (packages === undefined) return null;
  const parts: string[] = [];
  for (const manager of ["apt", "pip", "npm"] as const) {
    const names = packages[manager] ?? [];
    if (names.length > 0) parts.push(`${manager}: ${names.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** Что разрешает сеть: `Ограниченный: менеджеры пакетов и MCP-серверы`. */
export function describeNetworking(networking: SandboxTemplateNetworking): string {
  if (networking.type === "unrestricted") return UNRESTRICTED_LABEL;
  const allowed: string[] = [];
  if (networking.allow_package_managers) allowed.push("менеджеры пакетов");
  if (networking.allow_mcp_servers) allowed.push("MCP-серверы");
  const hosts = networking.allowed_hosts.length;
  if (hosts > 0) allowed.push(`${hosts} ${plural(hosts, "хост", "хоста", "хостов")}`);
  if (networking.allow_web_search) allowed.push("веб-поиск");
  if (allowed.length === 0) return "Ограниченный: внешние хосты закрыты";
  const last = allowed[allowed.length - 1]!;
  const head = allowed.slice(0, -1);
  return `Ограниченный: ${head.length > 0 ? `${head.join(", ")} и ${last}` : last}`;
}

function networkChip(networking: SandboxTemplateNetworking): string {
  return networking.type === "unrestricted" ? UNRESTRICTED_LABEL : "Ограниченный";
}

function emptyTemplate(defaultImageLabel: string | null): EnvironmentTemplate {
  return {
    id: EMPTY_TEMPLATE_ID,
    label: KNOWN_LABELS[EMPTY_TEMPLATE_ID]!,
    hint: EMPTY_HINT,
    imageLabel: null,
    networkLabel: null,
    details: {
      image: defaultImageLabel === null ? null : `По умолчанию: ${defaultImageLabel}`,
      network: UNRESTRICTED_LABEL,
      packages: null,
    },
    available: true,
    unavailableReason: null,
    fields: { config: { type: "cloud" } },
  };
}

/** Шаблоны из кода: сервер без каталога образов. */
export function fallbackTemplates(): EnvironmentTemplate[] {
  const packages = fallbackDocumentPackages();
  return [
    emptyTemplate(null),
    {
      id: "documents",
      label: KNOWN_LABELS.documents!,
      hint: FALLBACK_DOCUMENTS_HINT,
      imageLabel: null,
      networkLabel: null,
      details: { image: null, network: UNRESTRICTED_LABEL, packages: describePackages(packages) },
      available: true,
      unavailableReason: null,
      fields: { config: { type: "cloud", packages }, metadata: { oma_template: "documents" } },
    },
  ];
}

/** Короткая подпись образа для чипа: у образа с LibreOffice это «LibreOffice». */
function imageChip(image: SandboxCatalogImage | undefined, key: string): string {
  if (image === undefined) return key;
  const hasOffice = describeImageManifest(image.manifest)?.utilities.some((utility) =>
    utility.label.startsWith("LibreOffice"),
  );
  return hasOffice ? "LibreOffice" : image.label;
}

function copyConfig(config: SandboxCatalogTemplate["config"]): TemplateConfig {
  const networking = config.networking;
  return {
    type: "cloud",
    image: config.image,
    networking:
      networking.type === "limited"
        ? { ...networking, allowed_hosts: [...networking.allowed_hosts] }
        : { type: "unrestricted" },
    packages: {
      type: "packages",
      apt: [...config.packages.apt],
      npm: [...config.packages.npm],
      pip: [...config.packages.pip],
    },
  };
}

function fromCatalog(template: SandboxCatalogTemplate, catalog: SandboxCatalog): EnvironmentTemplate {
  const image = findCatalogImage(catalog, template.image);
  return {
    id: template.id,
    label: template.label,
    hint: template.description?.trim() || PURPOSE[template.id] || "",
    imageLabel: imageChip(image, template.image),
    networkLabel: networkChip(template.config.networking),
    details: {
      image: image?.label ?? template.image,
      network: describeNetworking(template.config.networking),
      packages: describePackages(template.config.packages),
    },
    available: template.available,
    unavailableReason: template.available ? null : "Образ не собран",
    fields: { config: copyConfig(template.config), metadata: { ...template.metadata } },
  };
}

/** «Пустое» и шаблоны каталога в порядке каталога. */
export function catalogTemplates(catalog: SandboxCatalog): EnvironmentTemplate[] {
  const defaultImage = findCatalogImage(catalog, catalog.default_image);
  return [
    emptyTemplate(defaultImage?.label ?? catalog.default_image),
    ...catalog.templates.map((template) => fromCatalog(template, catalog)),
  ];
}

/**
 * Список карточек окна. Пока каталог грузится, остаётся одно «Пустое», чтобы
 * список шаблонов не менялся под рукой. Без каталога идут шаблоны из кода.
 */
export function templatesFor(state: {
  catalog: SandboxCatalog | null;
  isLoading: boolean;
}): EnvironmentTemplate[] {
  if (state.catalog !== null) return catalogTemplates(state.catalog);
  if (state.isLoading) return [emptyTemplate(null)];
  return fallbackTemplates();
}

/** Шаблон по ключу. Если такого нет (каталог сменился), первый в списке. */
export function pickTemplate(templates: EnvironmentTemplate[], id: string): EnvironmentTemplate {
  return templates.find((template) => template.id === id) ?? templates[0]!;
}

/** Название шаблона по метке `oma_template` окружения. */
export function templateLabel(id: string, catalog: SandboxCatalog | null): string {
  const fromServer = catalog?.templates.find((template) => template.id === id);
  return fromServer?.label ?? KNOWN_LABELS[id] ?? id;
}
