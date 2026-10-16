// Package requirement whitelist (docs/plans/environments.md, 3.2).
//
// A string passes only when it matches the whole grammar of its manager.
// Everything else is refused: options (`--index-url=…`), addresses, paths,
// shell syntax, other alphabets, npm tags and ranges, apt versions and
// architectures, pip `===` and local versions. Every entry point calls this
// one check: the environment API, skill upload, the installed package
// inventory, layer preparation and install scripts. Quoting stays separate.

export const PACKAGE_REQUIREMENT_MANAGERS = ["pip", "npm", "apt"] as const;
export type PackageRequirementManager = (typeof PACKAGE_REQUIREMENT_MANAGERS)[number];

export const MAX_PACKAGE_REQUIREMENT_LENGTH = 214;

export interface PipRequirement {
  manager: "pip";
  /** PEP 503 name: lower case, runs of `-`, `_` and `.` become `-`. */
  name: string;
  extras: string[];
  /** Comma separated constraints, "" when the version is free. */
  constraints: string;
  requirement: string;
}

export interface NpmRequirement {
  manager: "npm";
  name: string;
  /** Exact semver version, null when the version is free. */
  version: string | null;
  requirement: string;
}

export interface AptRequirement {
  manager: "apt";
  name: string;
  requirement: string;
}

export type PackageRequirement = PipRequirement | NpmRequirement | AptRequirement;

// pip: PEP 508 name, optional extras, optional constraints from a PEP 440 subset.
const PIP_NAME = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";
const PIP_RELEASE = "(?:0|[1-9][0-9]*)(?:\\.(?:0|[1-9][0-9]*))*";
const PIP_VERSION = `${PIP_RELEASE}(?:(?:a|b|rc)(?:0|[1-9][0-9]*))?(?:\\.post(?:0|[1-9][0-9]*))?(?:\\.dev(?:0|[1-9][0-9]*))?`;
const PIP_CONSTRAINT = [
  // A prefix match only on the release part, only with == and !=.
  `(?:==|!=)${PIP_RELEASE}\\.\\*`,
  // ~= needs at least two release parts.
  `~=(?:0|[1-9][0-9]*)(?:\\.(?:0|[1-9][0-9]*))+(?:(?:a|b|rc)(?:0|[1-9][0-9]*))?(?:\\.post(?:0|[1-9][0-9]*))?(?:\\.dev(?:0|[1-9][0-9]*))?`,
  `(?:==|!=|>=|<=|>|<)${PIP_VERSION}`,
].join("|");
const PIP_REQUIREMENT = new RegExp(
  `^(${PIP_NAME})(?:\\[(${PIP_NAME}(?:,${PIP_NAME})*)\\])?((?:${PIP_CONSTRAINT})(?:,(?:${PIP_CONSTRAINT}))*)?$`,
);

// npm: optional scope, lower case name, optional exact semver version.
const NPM_PART = "[a-z0-9][a-z0-9._-]*";
const SEMVER_NUMBER = "(?:0|[1-9][0-9]*)";
const SEMVER_PRERELEASE_ID = `(?:${SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER = `${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER}(?:-${SEMVER_PRERELEASE_ID}(?:\\.${SEMVER_PRERELEASE_ID})*)?`;
const NPM_REQUIREMENT = new RegExp(`^((?:@${NPM_PART}/)?${NPM_PART})(?:@(${SEMVER}))?$`);

// apt: Debian package name without version or architecture.
const APT_REQUIREMENT = /^[a-z0-9][a-z0-9+.-]+$/;

function isRequirementManager(manager: string): manager is PackageRequirementManager {
  return (PACKAGE_REQUIREMENT_MANAGERS as readonly string[]).includes(manager);
}

/** PEP 503 normalized pip name. */
export function normalizePipName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Parses a requirement, or returns null when it is outside the whitelist. */
export function tryParsePackageRequirement(manager: string, value: string): PackageRequirement | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PACKAGE_REQUIREMENT_LENGTH) return null;
  if (!isRequirementManager(manager)) return null;
  switch (manager) {
    case "pip": {
      const match = PIP_REQUIREMENT.exec(value);
      if (match === null) return null;
      return {
        manager,
        name: normalizePipName(match[1] ?? ""),
        extras: match[2] === undefined ? [] : match[2].split(",").map(normalizePipName),
        constraints: match[3] ?? "",
        requirement: value,
      };
    }
    case "npm": {
      const match = NPM_REQUIREMENT.exec(value);
      if (match === null) return null;
      return { manager, name: match[1] ?? "", version: match[2] ?? null, requirement: value };
    }
    case "apt":
      return APT_REQUIREMENT.test(value) ? { manager, name: value, requirement: value } : null;
  }
}

export function isValidPackageName(manager: string, value: string): boolean {
  return tryParsePackageRequirement(manager, value) !== null;
}

/** Parses a requirement and throws when it is outside the whitelist. The
 *  message names the manager but not the value, which can hold a token. */
export function parsePackageRequirement(manager: string, value: string): PackageRequirement {
  const parsed = tryParsePackageRequirement(manager, value);
  if (parsed === null) throw new Error(`Invalid ${manager} package requirement`);
  return parsed;
}
