import { CORE_SCHEMA, load } from "js-yaml";

export interface SkillSpecResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Validates SKILL.md frontmatter. The caller supplies the parent name when known.
 * Length and organization advice remains a warning, not a format restriction. */
export function validateSkillSpec(content: string, directoryName?: string): SkillSpecResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const result = () => ({ valid: errors.length === 0, errors, warnings });
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (lines[0]?.trimEnd() !== "---" || end === -1) {
    errors.push("SKILL.md requires YAML frontmatter enclosed in ---");
    return result();
  }
  let data: unknown;
  try {
    data = load(lines.slice(1, end).join("\n"), { schema: CORE_SCHEMA });
  } catch {
    // Parser errors can contain secret values from the source.
    errors.push("SKILL.md frontmatter must be valid YAML with unique keys");
    return result();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push("SKILL.md frontmatter must be a mapping");
    return result();
  }
  const fields = data as Record<string, unknown>;
  if (typeof fields.name !== "string" || fields.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name)) {
    errors.push("name must contain 1 to 64 lowercase letters, digits or single internal hyphens");
  } else if (directoryName !== undefined && fields.name !== directoryName) {
    errors.push("name must match the parent directory name");
  }
  if (typeof fields.description !== "string" || !fields.description.trim() || fields.description.length > 1024) {
    errors.push("description must be a nonempty string of at most 1024 characters");
  }
  for (const field of ["license", "allowed-tools"]) {
    if (field in fields && typeof fields[field] !== "string") errors.push(`${field} must be a string`);
  }
  if ("compatibility" in fields && (typeof fields.compatibility !== "string" || !fields.compatibility.trim() || fields.compatibility.length > 500)) {
    errors.push("compatibility must be a nonempty string of at most 500 characters");
  }
  if ("metadata" in fields) {
    const metadata = fields.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Object.values(metadata).some((value) => typeof value !== "string")) {
      errors.push("metadata must map string keys to string values");
    }
  }
  if (lines.length >= 500) warnings.push("Keep SKILL.md below 500 lines; move details to references/");
  return result();
}
