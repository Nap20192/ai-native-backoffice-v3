// Environment configuration policy (docs/plans/environments.md, ES1 and 3.2).
//
// The environments application asks this port about `config` on create and
// update. A rejection names the request field and becomes a 400 answer:
//
// - `config.image` must be a key of the sandbox image catalog. A known image
//   that is not built yet is accepted, sessions on it fail by name;
// - while the catalog is enabled, cargo, go and gem packages are refused:
//   catalog images have no such tools;
// - every pip, npm and apt name goes through the shared whitelist of section
//   3.2 from `@open-managed-agents/sandbox/environment`; cargo, go and gem keep
//   the old behaviour without a catalog;
// - the operator file SANDBOX_PACKAGE_POLICY narrows the choice with a deny
//   list and an allow list per manager.
//
// `allow_web_search` only exists on a limited network: the API contract
// refuses it next to `unrestricted`, so it never reaches this port.

import type {
  EnvironmentConfigInput,
  EnvironmentConfigPolicyPort,
  EnvironmentConfigPolicyResult,
  EnvironmentPackagesInput,
} from "@open-managed-agents/managed-agents-application/ports/environments";
import { isValidPackageName } from "@open-managed-agents/sandbox/environment";
import { readFile } from "node:fs/promises";

import type { SandboxCatalog } from "./sandbox-catalog.js";

const POLICY_SETTING = "SANDBOX_PACKAGE_POLICY";

export const ENVIRONMENT_PACKAGE_MANAGERS = ["apt", "pip", "npm", "cargo", "gem", "go"] as const;
export type EnvironmentPackageManager = (typeof ENVIRONMENT_PACKAGE_MANAGERS)[number];

/** Managers whose tools catalog images do not ship. */
const OUTSIDE_CATALOG_IMAGES: readonly EnvironmentPackageManager[] = ["cargo", "go", "gem"];

/** Why `spec` is not a valid package name for `manager`, or null when it is. */
export type PackageNameCheck = (manager: EnvironmentPackageManager, spec: string) => string | null;

/** The 3.2 whitelist for pip, npm and apt. The message leaves the value out:
 *  a rejected string can be an address with a token. */
export const checkPackageRequirementName: PackageNameCheck = (manager, spec) => {
  if (manager !== "pip" && manager !== "npm" && manager !== "apt") return null;
  return isValidPackageName(manager, spec)
    ? null
    : `not a valid ${manager} requirement: options, addresses, paths and shell characters are refused`;
};

export interface SandboxPackagePolicy {
  deny: Partial<Record<EnvironmentPackageManager, string[]>>;
  allow: Partial<Record<EnvironmentPackageManager, string[]>>;
}

export interface EnvironmentConfigPolicyOptions {
  /** The loaded catalog, or a getter when the catalog can be reloaded. */
  catalog: SandboxCatalog | (() => SandboxCatalog);
  /** Defaults to `checkPackageRequirementName`. */
  checkPackageName?: PackageNameCheck;
  packagePolicy?: SandboxPackagePolicy | null;
}

/** The port with a synchronous answer. */
export interface EnvironmentConfigPolicy extends EnvironmentConfigPolicyPort {
  checkConfig(config: EnvironmentConfigInput | null): EnvironmentConfigPolicyResult;
}

/**
 * The name the operator policy compares: no version, extras or tag. pip names
 * are normalized as PEP 503 does (`Python_Dotenv` is `python-dotenv`).
 */
export function packageBaseName(manager: EnvironmentPackageManager, spec: string): string {
  const text = spec.trim();
  switch (manager) {
    case "pip": {
      const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(text)?.[0] ?? text;
      return name.toLowerCase().replace(/[-_.]+/g, "-");
    }
    case "npm": {
      const name = /^(?:@[^/@\s]+\/)?[^@\s]+/.exec(text)?.[0] ?? text;
      return name.toLowerCase();
    }
    case "cargo":
    case "go":
      return text.split("@")[0] ?? text;
    default:
      return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManager(value: string): value is EnvironmentPackageManager {
  return (ENVIRONMENT_PACKAGE_MANAGERS as readonly string[]).includes(value);
}

function parseManagerLists(
  value: unknown,
  path: string,
): Partial<Record<EnvironmentPackageManager, string[]>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${POLICY_SETTING}: ${path} must be an object`);
  const lists: Partial<Record<EnvironmentPackageManager, string[]>> = {};
  for (const [manager, names] of Object.entries(value)) {
    if (!isManager(manager)) {
      throw new Error(`${POLICY_SETTING}: ${path}.${manager} is not a package manager`);
    }
    if (!Array.isArray(names) || !names.every((name) => typeof name === "string" && name.length > 0)) {
      throw new Error(`${POLICY_SETTING}: ${path}.${manager} must be a list of names`);
    }
    lists[manager] = [...names];
  }
  return lists;
}

/** Parses the operator policy: `{"deny": {"pip": [...]}, "allow": {"apt": [...]}}`. */
export function parseSandboxPackagePolicy(value: unknown): SandboxPackagePolicy {
  if (!isRecord(value)) throw new Error(`${POLICY_SETTING}: the policy must be a JSON object`);
  const extra = Object.keys(value).find((key) => key !== "deny" && key !== "allow");
  if (extra !== undefined) throw new Error(`${POLICY_SETTING}: ${extra} is not a known field`);
  return {
    deny: parseManagerLists(value.deny, "deny"),
    allow: parseManagerLists(value.allow, "allow"),
  };
}

/** Reads the file named by SANDBOX_PACKAGE_POLICY. */
export async function readSandboxPackagePolicy(path: string): Promise<SandboxPackagePolicy> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(`${POLICY_SETTING}: cannot read ${path} (${code})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${POLICY_SETTING}: ${path} is not valid JSON`);
  }
  return parseSandboxPackagePolicy(raw);
}

function nameSets(
  lists: Partial<Record<EnvironmentPackageManager, string[]>>,
): Map<EnvironmentPackageManager, Set<string>> {
  const sets = new Map<EnvironmentPackageManager, Set<string>>();
  for (const manager of ENVIRONMENT_PACKAGE_MANAGERS) {
    const names = lists[manager];
    if (names !== undefined) sets.set(manager, new Set(names.map((name) => packageBaseName(manager, name))));
  }
  return sets;
}

const ACCEPTED: EnvironmentConfigPolicyResult = { type: "accepted" };

function rejected(field: string, message: string): EnvironmentConfigPolicyResult {
  return { type: "rejected", field, message };
}

export function createEnvironmentConfigPolicy(
  options: EnvironmentConfigPolicyOptions,
): EnvironmentConfigPolicy {
  const catalogOf = typeof options.catalog === "function" ? options.catalog : () => options.catalog as SandboxCatalog;
  const deny = nameSets(options.packagePolicy?.deny ?? {});
  const allow = nameSets(options.packagePolicy?.allow ?? {});
  const checkName = options.checkPackageName ?? checkPackageRequirementName;

  function checkPackages(
    packages: EnvironmentPackagesInput,
    catalog: SandboxCatalog,
  ): EnvironmentConfigPolicyResult {
    if (catalog.enabled) {
      for (const manager of OUTSIDE_CATALOG_IMAGES) {
        if ((packages[manager] ?? []).length > 0) {
          return rejected(`config.packages.${manager}`, `${manager} packages are not available in catalog images`);
        }
      }
    }
    for (const manager of ENVIRONMENT_PACKAGE_MANAGERS) {
      for (const [index, spec] of (packages[manager] ?? []).entries()) {
        const field = `config.packages.${manager}.${index}`;
        const invalid = checkName(manager, spec);
        if (invalid !== null) return rejected(field, invalid);
        const name = packageBaseName(manager, spec);
        if (deny.get(manager)?.has(name)) {
          return rejected(field, `${manager} package "${name}" is blocked by the operator policy`);
        }
        const allowed = allow.get(manager);
        if (allowed !== undefined && !allowed.has(name)) {
          return rejected(field, `${manager} package "${name}" is not in the operator allow list`);
        }
      }
    }
    return ACCEPTED;
  }

  return {
    checkConfig(config) {
      if (config === null || config.type !== "cloud") return ACCEPTED;
      const catalog = catalogOf();
      if (config.image != null && !catalog.images.some((image) => image.key === config.image)) {
        const known = catalog.images.map((image) => image.key).join(", ");
        return rejected("config.image", `unknown sandbox image "${config.image}"; known images: ${known}`);
      }
      return config.packages == null ? ACCEPTED : checkPackages(config.packages, catalog);
    },
  };
}
