// Installed package inventory of a sandbox VM (docs/plans/environments.md, 5.2).
//
// The VM answers with JSON `{pip, apt, npm, localNpm}`, each a list of
// `{name, version}`. Code in the VM runs as root and can forge that answer,
// so the server trusts none of it: the answer has a size limit, every name
// goes through the 3.2 whitelist again, bad entries are dropped and counted,
// and the result is marked `source: "sandbox"`.

import { isValidPackageName, normalizePipName } from "./package-names.js";

export const MAX_INVENTORY_BYTES = 256 * 1024;

export type InstalledPackageManager = "pip" | "apt" | "npm";

export interface InstalledPackage {
  manager: InstalledPackageManager;
  name: string;
  version: string;
  /** `local` is an npm package of /workspace/package.json, a project
   *  dependency that is never offered for the environment. */
  scope: "global" | "local";
  /** The string the console offers for the environment, null when none. */
  requirement: string | null;
}

export interface InstalledPackages {
  source: "sandbox";
  /** The answer was over the size limit and was not parsed. */
  truncated: boolean;
  /** Entries dropped because their name or version failed the check. */
  rejected: number;
  packages: InstalledPackage[];
}

export interface UpdatedPackage extends InstalledPackage {
  previousVersion: string;
}

export interface InstalledPackagesDiff {
  added: InstalledPackage[];
  updated: UpdatedPackage[];
  removed: InstalledPackage[];
  /** A truncated inventory gives no difference at all. */
  truncated: boolean;
}

const COLLECTIONS = [
  { key: "pip", manager: "pip", scope: "global" },
  { key: "apt", manager: "apt", scope: "global" },
  { key: "npm", manager: "npm", scope: "global" },
  { key: "localNpm", manager: "npm", scope: "local" },
] as const;

// Debian versions use `:`, `~` and `+`; pip and npm versions are a subset.
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$/;

function inventoryError(reason: string): Error {
  return new Error(`Invalid sandbox package inventory: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirementFor(manager: InstalledPackageManager, scope: "global" | "local", name: string, version: string): string | null {
  if (scope === "local") return null;
  // apt goes without a version: Debian security updates change it.
  const candidate = manager === "pip" ? `${name}==${version}` : manager === "npm" ? `${name}@${version}` : name;
  return isValidPackageName(manager, candidate) ? candidate : null;
}

export function parseInstalledPackages(output: string): InstalledPackages {
  // Measure bytes before parsing: a large answer is never parsed.
  if (Buffer.byteLength(output, "utf8") > MAX_INVENTORY_BYTES) {
    return { source: "sandbox", truncated: true, rejected: 0, packages: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw inventoryError("not JSON");
  }
  if (!isRecord(raw)) throw inventoryError("not an object");
  const packages: InstalledPackage[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  for (const { key, manager, scope } of COLLECTIONS) {
    const items = raw[key];
    // A missing list would read as "everything removed".
    if (!Array.isArray(items)) throw inventoryError(`${key} is not a list`);
    for (const item of items) {
      const name = isRecord(item) ? item.name : undefined;
      const version = isRecord(item) ? item.version : undefined;
      if (typeof name !== "string" || typeof version !== "string"
          || !isValidPackageName(manager, name) || !VERSION.test(version)) {
        rejected += 1;
        continue;
      }
      const identity = manager === "pip" ? normalizePipName(name) : name;
      const id = `${manager}:${scope}:${identity}`;
      if (seen.has(id)) throw inventoryError(`duplicate ${manager} package`);
      seen.add(id);
      packages.push({ manager, name: identity, version, scope, requirement: requirementFor(manager, scope, identity, version) });
    }
  }
  return { source: "sandbox", truncated: false, rejected, packages };
}

function identityOf(pkg: InstalledPackage): string {
  return `${pkg.manager}:${pkg.scope}:${pkg.name}`;
}

export function diffInstalledPackages(before: InstalledPackages, after: InstalledPackages): InstalledPackagesDiff {
  if (before.truncated || after.truncated) return { added: [], updated: [], removed: [], truncated: true };
  const previous = new Map(before.packages.map((pkg) => [identityOf(pkg), pkg]));
  const current = new Set(after.packages.map(identityOf));
  const added: InstalledPackage[] = [];
  const updated: UpdatedPackage[] = [];
  for (const pkg of after.packages) {
    const old = previous.get(identityOf(pkg));
    if (old === undefined) added.push(pkg);
    else if (old.version !== pkg.version) updated.push({ ...pkg, previousVersion: old.version });
  }
  const removed = before.packages.filter((pkg) => !current.has(identityOf(pkg)));
  return { added, updated, removed, truncated: false };
}
