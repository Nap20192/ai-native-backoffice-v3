// Package requirements a skill declares (docs/plans/environments.md, 6.1-6.2).
//
// The agentskills.io format has no dependency field, so a skill declares
// packages in `metadata` under `oma.requires.<manager>`: a string of
// requirements separated by spaces. Each one passes the 3.2 whitelist or the
// upload fails with the key name. The skill only declares; the environment
// decides what gets installed.

import { isValidPackageName } from "@open-managed-agents/sandbox/environment";
import { CORE_SCHEMA, load } from "js-yaml";

export interface SkillRequirements {
  apt: string[];
  pip: string[];
  npm: string[];
}

const PREFIX = "oma.requires.";
const MANAGERS = ["apt", "pip", "npm"] as const;
type Manager = (typeof MANAGERS)[number];

export class SkillRequirementsError extends Error {
  override name = "SkillRequirementsError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManager(value: string): value is Manager {
  return (MANAGERS as readonly string[]).includes(value);
}

/** The YAML between the opening and closing `---`, or null without frontmatter. */
function frontmatter(skillMd: string): string | null {
  const text = skillMd.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) throw new SkillRequirementsError("SKILL.md frontmatter has no closing ---");
  return lines.slice(1, end).join("\n");
}

/** Reads `metadata.oma.requires.*` from a SKILL.md. Throws on a bad value,
 *  naming the key but not the value. */
export function parseSkillRequirements(skillMd: string): SkillRequirements {
  const requirements: SkillRequirements = { apt: [], pip: [], npm: [] };
  const yaml = frontmatter(skillMd);
  if (yaml === null) return requirements;
  let data: unknown;
  try {
    // CORE_SCHEMA keeps numbers, booleans and null apart from strings, and
    // js-yaml refuses duplicate keys.
    data = load(yaml, { schema: CORE_SCHEMA });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "parse error";
    throw new SkillRequirementsError(`SKILL.md frontmatter is not valid YAML: ${reason}`);
  }
  if (data === undefined || data === null) return requirements;
  if (!isRecord(data)) throw new SkillRequirementsError("SKILL.md frontmatter must be a mapping");
  const metadata = data.metadata;
  if (metadata === undefined || metadata === null) return requirements;
  if (!isRecord(metadata)) throw new SkillRequirementsError("metadata must be a mapping");
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.startsWith(PREFIX)) continue;
    const manager = key.slice(PREFIX.length);
    if (!isManager(manager)) {
      throw new SkillRequirementsError(`metadata.${key}: supported managers are apt, pip and npm`);
    }
    if (typeof value !== "string") {
      throw new SkillRequirementsError(`metadata.${key} must be a string of requirements separated by spaces`);
    }
    for (const requirement of value.split(/[ ]+/).filter(Boolean)) {
      if (!isValidPackageName(manager, requirement)) {
        throw new SkillRequirementsError(`metadata.${key} has an invalid ${manager} requirement`);
      }
      requirements[manager].push(requirement);
    }
  }
  return requirements;
}
