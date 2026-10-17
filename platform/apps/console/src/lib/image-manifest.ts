import { plural } from "../components/session/format-ru";
import type { SandboxImageResources } from "./sandbox-catalog";

/**
 * Состав образа песочницы для списка «Что есть в образе». Источник один:
 * манифест, который пишет `platform/sandbox-images/manifest.sh` при сборке
 * (`/etc/oma/image-manifest.json`) и отдаёт каталог образов. Манифест большой
 * (весь dpkg, несколько сотен пакетов), поэтому консоль берёт из него то, что
 * читает человек: систему, Python с библиотеками, Node, известные утилиты и
 * шрифты с кириллицей.
 *
 * Манифест приходит с сервера, и вид у него свободный. Функции здесь не
 * бросают ошибок: что не нашли, того в описании нет.
 */

export interface ImageLibrary {
  name: string;
  version: string;
}

export interface ImageUtility {
  label: string;
  version: string | null;
}

export interface ImageContents {
  /** `Debian GNU/Linux 12 (bookworm), x86_64`. */
  system: string | null;
  user: string | null;
  /** Имя оболочки без пути: `bash`. */
  shell: string | null;
  /** Менеджеры пакетов образа: `apt`, `npm`, `pip`, `uv`. */
  packageManagers: string[];
  python: {
    version: string | null;
    venv: string | null;
    hasPip: boolean;
    uv: string | null;
    libraries: ImageLibrary[];
  };
  node: { version: string | null; npm: string | null } | null;
  utilities: ImageUtility[];
  /** Семейства шрифтов с кириллицей. */
  fonts: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Имя менеджера, как его знает человек: `apt-get` это `apt`. */
function managerName(raw: string): string {
  return raw === "apt-get" ? "apt" : raw;
}

/**
 * Версия программы без эпохи и ревизии Debian: `1:2.39.5-0+deb12u3` это
 * `2.39.5`, `1.6-2.1+deb12u2` это `1.6`.
 */
export function upstreamVersion(debianVersion: string): string {
  const withoutEpoch = debianVersion.replace(/^\d+:/, "");
  const revision = withoutEpoch.lastIndexOf("-");
  return revision > 0 ? withoutEpoch.slice(0, revision) : withoutEpoch;
}

/** Известные утилиты в порядке показа: пакет Debian и подпись. */
const UTILITIES: ReadonlyArray<{ pkg: string; label: string }> = [
  { pkg: "git", label: "git" },
  { pkg: "curl", label: "curl" },
  { pkg: "wget", label: "wget" },
  { pkg: "jq", label: "jq" },
  { pkg: "ripgrep", label: "ripgrep" },
  { pkg: "poppler-utils", label: "poppler (pdftotext, pdftoppm)" },
  { pkg: "tesseract-ocr", label: "tesseract" },
  { pkg: "fontconfig", label: "fontconfig" },
  { pkg: "file", label: "file" },
  { pkg: "unzip", label: "unzip" },
  { pkg: "procps", label: "procps" },
  { pkg: "make", label: "make" },
  { pkg: "gcc", label: "gcc" },
];

function readLibraries(raw: unknown): ImageLibrary[] {
  if (!Array.isArray(raw)) return [];
  const byName = new Map<string, ImageLibrary>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = text(item.name);
    if (name === null || byName.has(name)) continue;
    byName.set(name, { name, version: text(item.version) ?? "" });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

function readDpkg(raw: unknown): Map<string, string> {
  const packages = new Map<string, string>();
  if (!Array.isArray(raw)) return packages;
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = text(item.name);
    if (name !== null) packages.set(name, text(item.version) ?? "");
  }
  return packages;
}

function readUtilities(dpkg: Map<string, string>, libreOffice: string | null): ImageUtility[] {
  const utilities: ImageUtility[] = [];
  if (libreOffice !== null) {
    const found = /\d+(?:\.\d+){1,3}/.exec(libreOffice)?.[0];
    const version = found === undefined ? null : found.split(".").slice(0, 3).join(".");
    utilities.push({ label: "LibreOffice (soffice)", version });
  }
  for (const { pkg, label } of UTILITIES) {
    const raw = dpkg.get(pkg);
    if (raw === undefined) continue;
    let shown = label;
    if (pkg === "tesseract-ocr") {
      const languages = [...dpkg.keys()]
        .map((name) => /^tesseract-ocr-([a-z]{3}(?:-[a-z]+)?)$/.exec(name)?.[1])
        .filter((language): language is string => language !== undefined && language !== "osd")
        .sort();
      if (languages.length > 0) shown = `tesseract (${languages.join(", ")})`;
    }
    if (pkg === "gcc" && dpkg.has("g++")) shown = "gcc и g++";
    utilities.push({ label: shown, version: raw === "" ? null : upstreamVersion(raw) });
  }
  return utilities;
}

function readFonts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const families = new Set<string>();
  for (const line of raw) {
    if (typeof line !== "string") continue;
    // fc-list пишет «семейство<TAB>файл», а у семейства бывает несколько имён через запятую.
    const family = line.split("\t")[0]?.split(",")[0]?.trim();
    if (family) families.add(family);
  }
  return [...families].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** Описание состава образа по манифесту. Возвращает null, если манифеста нет или он не объект. */
export function describeImageManifest(manifest: unknown): ImageContents | null {
  if (!isRecord(manifest)) return null;
  const os = isRecord(manifest.os) ? text(manifest.os.pretty_name) : null;
  const architecture = text(manifest.architecture);
  const shell = text(manifest.shell)?.split("/").pop() ?? null;
  const managers = Array.isArray(manifest.package_managers)
    ? manifest.package_managers
        .filter((name): name is string => typeof name === "string" && name.length > 0)
        .map(managerName)
    : [];
  const packageManagers = [...new Set(managers)];
  const nodeVersion = text(manifest.node_version)?.replace(/^v/, "") ?? null;
  const npmInfo = isRecord(manifest.npm) && isRecord(manifest.npm.npm) ? text(manifest.npm.npm.version) : null;
  const uv = text(manifest.uv_version)?.replace(/^uv\s+/, "") ?? null;
  return {
    system: os !== null && architecture !== null ? `${os}, ${architecture}` : (os ?? architecture),
    user: text(manifest.user),
    shell,
    packageManagers,
    python: {
      version: text(manifest.python_version),
      venv: text(manifest.venv),
      hasPip: packageManagers.includes("pip"),
      uv,
      libraries: readLibraries(manifest.pip),
    },
    node: nodeVersion === null && npmInfo === null ? null : { version: nodeVersion, npm: npmInfo },
    utilities: readUtilities(readDpkg(manifest.dpkg), text(manifest.libreoffice_version)),
    fonts: readFonts(manifest.fonts),
  };
}

/** Короткая сводка для заголовка списка: `Python 3.11.2, 46 библиотек`. */
export function contentsSummary(contents: ImageContents): string {
  const { version, libraries, hasPip } = contents.python;
  if (version === null) return "";
  if (libraries.length > 0) {
    const n = libraries.length;
    return `Python ${version}, ${n} ${plural(n, "библиотека", "библиотеки", "библиотек")}`;
  }
  return hasPip ? `Python ${version}` : `Python ${version} без pip`;
}

function decimalRu(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
}

/** Ресурсы песочницы из каталога: `2 CPU, 1 ГиБ памяти, диск 6 ГБ`. */
export function describeResources(resources: SandboxImageResources): string | null {
  const parts: string[] = [];
  if (resources.cpus !== null) parts.push(`${resources.cpus} CPU`);
  if (resources.memory_mib !== null) {
    parts.push(
      resources.memory_mib >= 1024
        ? `${decimalRu(resources.memory_mib / 1024)} ГиБ памяти`
        : `${resources.memory_mib} МиБ памяти`,
    );
  }
  if (resources.disk_gb !== null) parts.push(`диск ${resources.disk_gb} ГБ`);
  return parts.length > 0 ? parts.join(", ") : null;
}

const PINNING = "Они живут только в этой сессии. Чтобы закрепить пакет, добавьте его в раздел «Пакеты».";

/**
 * Подсказка под списком образов: может ли агент сам ставить пакеты и что делать
 * с поставленным. Текст зависит от образа (есть ли в нём pip) и от сети,
 * которую правят в той же форме.
 */
export function installHint(
  contents: ImageContents | null,
  networking: { type: "unrestricted" | "limited"; allow_package_managers?: boolean },
): string {
  if (networking.type === "limited" && !networking.allow_package_managers) {
    return (
      "Сеть окружения закрывает реестры пакетов, поэтому агент не сможет ставить пакеты сам. " +
      "Чтобы открыть их, включите доступ менеджерам пакетов в разделе «Сеть»."
    );
  }
  if (contents === null) {
    return `Агент может сам ставить пакеты, если сеть окружения это позволяет. ${PINNING}`;
  }
  if (contents.python.hasPip) return `Агент может сам ставить пакеты через pip. ${PINNING}`;
  const managers = contents.packageManagers.filter((name) => name === "apt" || name === "npm");
  if (managers.length === 0) {
    return "В этом образе нет менеджеров пакетов, агент не сможет ставить пакеты сам.";
  }
  return `В этом образе нет pip. Агент может сам ставить пакеты через ${managers.join(" и ")}. ${PINNING}`;
}
