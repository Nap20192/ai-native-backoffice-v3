// Sandbox image catalog (docs/plans/environments.md, sections 1.5 and 1.6).
//
// The operator names a catalog.json in SANDBOX_IMAGE_CATALOG. It lists images
// by key: an OCI layout built by platform/sandbox-images/build.sh into
// SANDBOX_IMAGE_DIR, or a registry reference pinned by digest. The key picks
// the image, the digest fixes its content. On load the server compares the
// digest in each layout's index.json with the one build.sh recorded in the
// manifest next to it. An image that is missing or changed stays in the
// catalog with `built: false` and a reason; sessions on it fail by name and
// never fall back to another image.
//
// Without SANDBOX_IMAGE_CATALOG the catalog holds one `default` image from
// SANDBOX_IMAGE and no templates, which is how the server worked before.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export const DEFAULT_SANDBOX_IMAGE_DIR = "./data/sandbox-images";
export const SERVER_DEFAULT_IMAGE_KEY = "default";

const CATALOG_SETTING = "SANDBOX_IMAGE_CATALOG";
/** Catalog keys and template ids. The API contract caps `config.image` at 64. */
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PINNED_REFERENCE = /^[^\s@]+@(sha256:[0-9a-f]{64})$/;

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface SandboxCatalogSettings {
  /** SANDBOX_IMAGE_CATALOG; null keeps the single server image. */
  catalogPath: string | null;
  /** SANDBOX_IMAGE_DIR: OCI layouts and their manifests. */
  imageDir: string;
  /** SANDBOX_IMAGE: the image used when no catalog is configured. */
  fallbackImage: string | null;
}

export interface SandboxImageResources {
  diskGb: number | null;
  memoryMib: number | null;
  cpus: number | null;
}

export type SandboxImageSource =
  /** OCI layout on the host, absolute path. */
  | { type: "oci"; dir: string }
  /** Registry reference pinned with `@sha256:`. */
  | { type: "registry"; reference: string }
  /** SANDBOX_IMAGE without a catalog; null means the adapter default. */
  | { type: "server_default"; reference: string | null };

export interface SandboxCatalogImage {
  key: string;
  label: string;
  source: SandboxImageSource;
  built: boolean;
  /** Why the image is not usable, shown in the console. */
  reason: string | null;
  /** OCI manifest digest from index.json or from the pinned reference. */
  digest: string | null;
  sizeBytes: number | null;
  resources: SandboxImageResources;
  /** image-manifest.json as build.sh wrote it. */
  manifest: JsonObject | null;
  /** sha256 of the manifest file, for the VM snapshot (plan 4.5). */
  manifestSha256: string | null;
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

/** A template as a ready `POST /v1/environments` config plus its label. */
export interface SandboxCatalogTemplate {
  id: string;
  label: string;
  description: string | null;
  image: string;
  config: {
    type: "cloud";
    image: string;
    networking: SandboxTemplateNetworking;
    packages: { type: "packages"; apt: string[]; npm: string[]; pip: string[] };
  };
  metadata: { oma_template: string };
}

export interface SandboxCatalog {
  /** False when SANDBOX_IMAGE_CATALOG is not set. */
  enabled: boolean;
  defaultImage: string;
  images: SandboxCatalogImage[];
  templates: SandboxCatalogTemplate[];
}

export class SandboxCatalogError extends Error {
  override name = "SandboxCatalogError";
}

export type CatalogImageResolution =
  | { type: "ready"; image: SandboxCatalogImage }
  | { type: "unknown"; key: string }
  | { type: "not_built"; image: SandboxCatalogImage; reason: string };

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Reads the catalog settings from the process environment. */
export function sandboxCatalogSettings(
  env: Readonly<Record<string, string | undefined>>,
): SandboxCatalogSettings {
  const catalogPath = env.SANDBOX_IMAGE_CATALOG?.trim();
  const imageDir = env.SANDBOX_IMAGE_DIR?.trim();
  const fallbackImage = env.SANDBOX_IMAGE?.trim();
  return {
    catalogPath: catalogPath ? expandHome(catalogPath) : null,
    imageDir: imageDir ? expandHome(imageDir) : DEFAULT_SANDBOX_IMAGE_DIR,
    fallbackImage: fallbackImage || null,
  };
}

function serverDefaultCatalog(fallbackImage: string | null): SandboxCatalog {
  return {
    enabled: false,
    defaultImage: SERVER_DEFAULT_IMAGE_KEY,
    images: [
      {
        key: SERVER_DEFAULT_IMAGE_KEY,
        label: "Образ сервера",
        source: { type: "server_default", reference: fallbackImage },
        built: true,
        reason: null,
        digest: null,
        sizeBytes: null,
        resources: { diskGb: null, memoryMib: null, cpus: null },
        manifest: null,
        manifestSha256: null,
      },
    ],
    templates: [],
  };
}

// ── catalog.json ────────────────────────────────────────────────────

interface CatalogImageEntry {
  key: string;
  label: string;
  reference: string | null;
  ociDir: string | null;
  manifest: string | null;
  resources: SandboxImageResources;
}

interface CatalogFile {
  defaultImage: string;
  images: CatalogImageEntry[];
  templates: SandboxCatalogTemplate[];
}

function fail(path: string, message: string): never {
  throw new SandboxCatalogError(`${CATALOG_SETTING}: ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !KEY_PATTERN.test(value)) {
    fail(path, "must be a key of lowercase letters, digits, '.', '_' or '-', up to 64 characters");
  }
  return value;
}

function readText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be a non-empty string");
  return value;
}

function readOptionalText(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : readText(value, path);
}

function readPositiveInteger(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(path, "must be a positive integer");
  }
  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") fail(path, "must be true or false");
  return value;
}

function readStringList(value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
    fail(path, "must be a list of non-empty strings");
  }
  return [...value];
}

/** A path inside SANDBOX_IMAGE_DIR: relative, without `..`. */
function readInsidePath(value: unknown, path: string): string {
  const text = readText(value, path);
  const normalized = normalize(text);
  if (isAbsolute(text) || normalized === "." || normalized.split(sep).includes("..")) {
    fail(path, "must be a path inside SANDBOX_IMAGE_DIR");
  }
  return normalized;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) fail(`${path}.${extra}`, "is not a known field");
}

function parseImageEntry(key: string, value: unknown): CatalogImageEntry {
  const path = `images.${key}`;
  readKey(key, path);
  if (!isRecord(value)) fail(path, "must be an object");
  const hasReference = value.image !== undefined;
  const hasOciDir = value.oci_dir !== undefined;
  if (hasReference === hasOciDir) fail(path, "needs exactly one of image and oci_dir");
  return {
    key,
    label: readText(value.label, `${path}.label`),
    reference: hasReference ? readText(value.image, `${path}.image`) : null,
    ociDir: hasOciDir ? readInsidePath(value.oci_dir, `${path}.oci_dir`) : null,
    manifest:
      value.manifest === undefined || value.manifest === null
        ? null
        : readInsidePath(value.manifest, `${path}.manifest`),
    resources: {
      diskGb: readPositiveInteger(value.disk_gb, `${path}.disk_gb`),
      memoryMib: readPositiveInteger(value.memory_mib, `${path}.memory_mib`),
      cpus: readPositiveInteger(value.cpus, `${path}.cpus`),
    },
  };
}

function parseTemplateNetworking(value: unknown, path: string): SandboxTemplateNetworking {
  if (!isRecord(value)) fail(path, "must be an object");
  if (value.type === "unrestricted") {
    onlyKeys(value, ["type"], path);
    return { type: "unrestricted" };
  }
  if (value.type !== "limited") fail(`${path}.type`, "must be unrestricted or limited");
  onlyKeys(
    value,
    ["type", "allow_mcp_servers", "allow_package_managers", "allow_web_search", "allowed_hosts"],
    path,
  );
  return {
    type: "limited",
    allow_mcp_servers: readBoolean(value.allow_mcp_servers, `${path}.allow_mcp_servers`),
    allow_package_managers: readBoolean(value.allow_package_managers, `${path}.allow_package_managers`),
    allow_web_search: readBoolean(value.allow_web_search, `${path}.allow_web_search`),
    allowed_hosts: readStringList(value.allowed_hosts, `${path}.allowed_hosts`),
  };
}

function parseTemplatePackages(
  value: unknown,
  path: string,
): SandboxCatalogTemplate["config"]["packages"] {
  if (value === undefined || value === null) return { type: "packages", apt: [], npm: [], pip: [] };
  if (!isRecord(value)) fail(path, "must be an object");
  for (const manager of ["cargo", "gem", "go"]) {
    if (value[manager] !== undefined) fail(`${path}.${manager}`, "is not available in catalog images");
  }
  onlyKeys(value, ["type", "apt", "npm", "pip"], path);
  if (value.type !== undefined && value.type !== "packages") fail(`${path}.type`, "must be packages");
  return {
    type: "packages",
    apt: readStringList(value.apt, `${path}.apt`),
    npm: readStringList(value.npm, `${path}.npm`),
    pip: readStringList(value.pip, `${path}.pip`),
  };
}

function parseTemplate(value: unknown, index: number, imageKeys: ReadonlySet<string>): SandboxCatalogTemplate {
  const path = `templates.${index}`;
  if (!isRecord(value)) fail(path, "must be an object");
  const id = readKey(value.id, `${path}.id`);
  const image = readKey(value.image, `${path}.image`);
  if (!imageKeys.has(image)) fail(`${path}.image`, `names unknown image "${image}"`);
  return {
    id,
    label: readText(value.label, `${path}.label`),
    description: readOptionalText(value.description, `${path}.description`),
    image,
    config: {
      type: "cloud",
      image,
      networking: parseTemplateNetworking(value.networking, `${path}.networking`),
      packages: parseTemplatePackages(value.packages, `${path}.packages`),
    },
    metadata: { oma_template: id },
  };
}

function parseCatalogFile(raw: unknown): CatalogFile {
  if (!isRecord(raw)) fail("catalog", "must be a JSON object");
  if (!isRecord(raw.images) || Object.keys(raw.images).length === 0) {
    fail("images", "must be an object with at least one image");
  }
  const images = Object.entries(raw.images).map(([key, value]) => parseImageEntry(key, value));
  const imageKeys = new Set(images.map((entry) => entry.key));
  const defaultImage = readKey(raw.default_image, "default_image");
  if (!imageKeys.has(defaultImage)) fail("default_image", `names unknown image "${defaultImage}"`);
  const rawTemplates = raw.templates ?? [];
  if (!Array.isArray(rawTemplates)) fail("templates", "must be a list");
  const templates = rawTemplates.map((value, index) => parseTemplate(value, index, imageKeys));
  const seen = new Set<string>();
  for (const [index, template] of templates.entries()) {
    if (seen.has(template.id)) fail(`templates.${index}.id`, `repeats "${template.id}"`);
    seen.add(template.id);
  }
  return { defaultImage, images, templates };
}

// ── Images on disk ──────────────────────────────────────────────────

type ManifestRead =
  | { type: "missing" }
  | { type: "invalid" }
  | { type: "ok"; manifest: JsonObject; sha256: string };

async function readManifest(file: string): Promise<ManifestRead> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    return { type: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed)) return { type: "invalid" };
    return {
      type: "ok",
      manifest: parsed as JsonObject,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } catch {
    return { type: "invalid" };
  }
}

/** The OCI manifest digest that `index.json` of a layout points to. */
export async function readOciIndexDigest(dir: string): Promise<string | null> {
  try {
    const index: unknown = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    if (!isRecord(index) || !Array.isArray(index.manifests)) return null;
    const first: unknown = index.manifests[0];
    const digest = isRecord(first) ? first.digest : undefined;
    return typeof digest === "string" && DIGEST_PATTERN.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Apparent size of every file under `dir`, as `du -sb` counts it. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

function manifestDigest(manifest: JsonObject): string | null {
  const digest = manifest.image_digest;
  return typeof digest === "string" ? digest : null;
}

async function inspectRegistryImage(entry: CatalogImageEntry, reference: string, imageDir: string) {
  const base = {
    key: entry.key,
    label: entry.label,
    source: { type: "registry" as const, reference },
    sizeBytes: null,
    resources: entry.resources,
  };
  const pinned = PINNED_REFERENCE.exec(reference);
  if (pinned === null) {
    return {
      ...base,
      built: false,
      reason: "Ссылка на образ без дайджеста @sha256",
      digest: null,
      manifest: null,
      manifestSha256: null,
    };
  }
  const digest = pinned[1] ?? null;
  const read: ManifestRead =
    entry.manifest === null ? { type: "missing" } : await readManifest(join(imageDir, entry.manifest));
  if (read.type === "invalid") {
    return { ...base, built: false, reason: "Манифест образа не читается как JSON", digest, manifest: null, manifestSha256: null };
  }
  if (read.type === "missing") {
    return { ...base, built: true, reason: null, digest, manifest: null, manifestSha256: null };
  }
  // A manifest proves its image only by the digest it records. manifest.sh
  // inside a build writes null, so such a file may describe any image.
  const recorded = manifestDigest(read.manifest);
  if (recorded === null) {
    return { ...base, built: false, reason: "В манифесте образа нет image_digest", digest, manifest: null, manifestSha256: null };
  }
  if (recorded !== digest) {
    return { ...base, built: false, reason: "Манифест снят с другого образа", digest, manifest: null, manifestSha256: null };
  }
  return { ...base, built: true, reason: null, digest, manifest: read.manifest, manifestSha256: read.sha256 };
}

async function inspectOciImage(entry: CatalogImageEntry, ociDir: string, imageDir: string) {
  const dir = join(imageDir, ociDir);
  const base = {
    key: entry.key,
    label: entry.label,
    source: { type: "oci" as const, dir },
    resources: entry.resources,
  };
  const unbuilt = (reason: string, digest: string | null = null) => ({
    ...base,
    built: false,
    reason,
    digest,
    sizeBytes: null,
    manifest: null,
    manifestSha256: null,
  });
  if (!(await isDirectory(dir))) return unbuilt(`Каталог образа ${ociDir} не найден`);
  const digest = await readOciIndexDigest(dir);
  if (digest === null) return unbuilt("В каталоге образа нет index.json с дайджестом");
  const manifestFile = entry.manifest ?? `${ociDir}.manifest.json`;
  const read = await readManifest(join(imageDir, manifestFile));
  if (read.type === "missing") return unbuilt(`Нет манифеста образа ${manifestFile}`, digest);
  if (read.type === "invalid") return unbuilt("Манифест образа не читается как JSON", digest);
  const recorded = manifestDigest(read.manifest);
  if (recorded === null) return unbuilt("В манифесте образа нет image_digest", digest);
  if (recorded !== digest) {
    return unbuilt("Каталог образа изменён после сборки", digest);
  }
  return {
    ...base,
    built: true,
    reason: null,
    digest,
    sizeBytes: await directorySize(dir),
    manifest: read.manifest,
    manifestSha256: read.sha256,
  };
}

function inspectImage(entry: CatalogImageEntry, imageDir: string): Promise<SandboxCatalogImage> {
  if (entry.reference !== null) return inspectRegistryImage(entry, entry.reference, imageDir);
  if (entry.ociDir !== null) return inspectOciImage(entry, entry.ociDir, imageDir);
  return Promise.reject(new SandboxCatalogError(`${CATALOG_SETTING}: images.${entry.key}: has no source`));
}

/**
 * Loads the catalog named by the settings. A broken catalog file throws
 * SandboxCatalogError naming SANDBOX_IMAGE_CATALOG, so the server does not
 * start on it. Images that are missing or changed on disk do not throw.
 */
export async function loadSandboxCatalog(settings: SandboxCatalogSettings): Promise<SandboxCatalog> {
  if (settings.catalogPath === null) return serverDefaultCatalog(settings.fallbackImage);
  let text: string;
  try {
    text = await readFile(settings.catalogPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "read error";
    throw new SandboxCatalogError(`${CATALOG_SETTING}: cannot read ${settings.catalogPath} (${code})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SandboxCatalogError(`${CATALOG_SETTING}: ${settings.catalogPath} is not valid JSON`);
  }
  const file = parseCatalogFile(raw);
  const imageDir = resolve(settings.imageDir);
  return {
    enabled: true,
    defaultImage: file.defaultImage,
    images: await Promise.all(file.images.map((entry) => inspectImage(entry, imageDir))),
    templates: file.templates,
  };
}

export function findCatalogImage(catalog: SandboxCatalog, key: string): SandboxCatalogImage | undefined {
  return catalog.images.find((image) => image.key === key);
}

/** The image a VM gets for `config.image`; null or undefined means the default. */
export function resolveCatalogImage(
  catalog: SandboxCatalog,
  key: string | null | undefined,
): CatalogImageResolution {
  const wanted = key ?? catalog.defaultImage;
  const image = findCatalogImage(catalog, wanted);
  if (image === undefined) return { type: "unknown", key: wanted };
  if (!image.built) return { type: "not_built", image, reason: image.reason ?? "Образ не собран" };
  return { type: "ready", image };
}
