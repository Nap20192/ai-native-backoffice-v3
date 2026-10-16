// Platform skills that ship with the control plane (platform/skills/builtin).
//
// Each folder is one skill: SKILL.md at its root, the folder name equal to
// the SKILL.md `name`. The loader compiles a folder with the same compiler as
// a Skills API upload, so the zip, limits and frontmatter rules match. The
// version is a digest of the files: stable across restarts, new after an edit.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { ZipSkillPackageCompiler } from "@open-managed-agents/managed-agents-adapters-runtime";
import type { BuiltinSkill } from "@open-managed-agents/platform-node";

import { computeFilesDigest } from "./skill-sources.js";

/** Built-in skills have no upload time; one fixed date keeps them ordered. */
export const BUILTIN_SKILLS_CREATED_AT = "2026-10-16T12:00:00.000Z";

/** Mirrors the Anthropic API: platform-provided skills report `anthropic`. */
export const BUILTIN_SKILL_SOURCE = "anthropic";

function skipped(name: string): boolean {
  return name.startsWith(".") || name === "__pycache__" || name.endsWith(".pyc");
}

function readTree(root: string, dir: string, files: Map<string, Uint8Array>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipped(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) readTree(root, path, files);
    else if (entry.isFile()) {
      files.set(relative(root, path).split(sep).join("/"), readFileSync(path));
    }
  }
}

/** Optional single-line `display_title:` in the SKILL.md frontmatter. */
function displayTitle(manifest: Uint8Array | undefined): string | null {
  if (manifest === undefined) return null;
  const text = new TextDecoder().decode(manifest).replaceAll("\r\n", "\n");
  const end = text.startsWith("---\n") ? text.indexOf("\n---", 4) : -1;
  if (end < 0) return null;
  const match = /^display_title:[ \t]*(.+)$/mu.exec(text.slice(4, end));
  const value = match?.[1]?.trim().replace(/^(["'])(.*)\1$/u, "$2");
  return value ? value : null;
}

/**
 * Read every skill folder under `dir`. A missing `dir` yields no skills; a
 * folder that fails to compile stops startup with the folder name.
 */
export async function loadBuiltinSkills(dir: string): Promise<BuiltinSkill[]> {
  if (!existsSync(dir)) {
    console.warn(`[builtin-skills] ${dir} does not exist, no platform skills loaded`);
    return [];
  }
  const compiler = new ZipSkillPackageCompiler();
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !skipped(entry.name))
    .map((entry) => entry.name)
    .sort();
  const skills: BuiltinSkill[] = [];
  for (const name of names) {
    const files = new Map<string, Uint8Array>();
    readTree(join(dir, name), join(dir, name), files);
    const compiled = await compiler.compile({
      files: [...files].map(([path, content]) => ({
        filename: `${name}/${path}`,
        mimeType: "application/octet-stream",
        content,
      })),
    });
    if (compiled.type === "invalid_request") {
      throw new Error(`Built-in skill ${name}: ${compiled.message}`);
    }
    if (compiled.package.name !== name) {
      throw new Error(
        `Built-in skill ${name}: SKILL.md name ${compiled.package.name} must equal the folder name`,
      );
    }
    const version = computeFilesDigest(files).replace(/^sha256:/u, "").slice(0, 12);
    skills.push({
      skill: {
        id: name,
        createdAt: BUILTIN_SKILLS_CREATED_AT,
        displayTitle: displayTitle(files.get("SKILL.md")),
        latestVersion: version,
        source: BUILTIN_SKILL_SOURCE,
        updatedAt: BUILTIN_SKILLS_CREATED_AT,
      },
      version: {
        id: `skv_builtin_${name}_${version}`,
        createdAt: BUILTIN_SKILLS_CREATED_AT,
        description: compiled.package.description,
        directory: compiled.package.directory,
        name: compiled.package.name,
        skillId: name,
        version,
      },
      archive: compiled.package.archive,
    });
  }
  return skills;
}
