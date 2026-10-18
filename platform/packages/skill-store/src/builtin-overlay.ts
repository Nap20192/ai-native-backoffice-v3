import type {
  Skill,
  SkillPackageArchive,
  SkillVersion,
} from "@open-managed-agents/domain/skills";
import type {
  AppendSkillVersion,
  AppendSkillVersionResult,
  DeleteSkillRecord,
  DeleteSkillRecordResult,
  DeleteSkillVersionRecord,
  DeleteSkillVersionRecordResult,
  FindLatestSkillVersionExcluding,
  InsertedSkillWithInitialVersion,
  InsertSkillWithInitialVersion,
  ListSkillRecords,
  ListSkillVersionRecords,
  SkillListPosition,
  SkillLocation,
  SkillStore,
  SkillVersionListPosition,
  SkillVersionLocation,
  StoredSkill,
  StoredSkillVersion,
} from "./index";

/** One immutable platform skill: its record, its only version and archive. */
export interface BuiltinSkill {
  skill: Skill;
  version: SkillVersion;
  archive: SkillPackageArchive;
}

const BUILTIN_REVISION = 1;

function copySkill(entry: BuiltinSkill): StoredSkill {
  return { skill: structuredClone(entry.skill), revision: BUILTIN_REVISION };
}

function copyVersion(entry: BuiltinSkill): StoredSkillVersion {
  return {
    version: structuredClone(entry.version),
    archive: {
      ...entry.archive,
      content: Uint8Array.from(entry.archive.content),
    },
  };
}

/** Same order as the SQL store: created_at DESC, id DESC. */
function newerFirst(left: Skill, right: Skill): number {
  const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (byTime !== 0) return byTime;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

/** Strictly after the cursor in created_at DESC, id DESC order. */
function afterSkillPosition(skill: Skill, position: SkillListPosition): boolean {
  const time = Date.parse(skill.createdAt);
  const positionTime = Date.parse(position.createdAt);
  return time < positionTime || (time === positionTime && skill.id < position.skillId);
}

function afterVersionPosition(
  version: SkillVersion,
  position: SkillVersionListPosition,
): boolean {
  const time = Date.parse(version.createdAt);
  const positionTime = Date.parse(position.createdAt);
  return time < positionTime
    || (time === positionTime && version.id < position.skillVersionId);
}

/**
 * A SkillStore that adds a fixed catalog of platform skills to every
 * workspace. Reads of a catalog id never reach the inner store and ignore the
 * workspace; deletes and new versions of a catalog id answer `not_found`.
 * Everything else goes to the inner (per-workspace) store unchanged.
 */
export class BuiltinSkillOverlayStore implements SkillStore {
  private readonly catalog = new Map<string, BuiltinSkill>();

  constructor(
    private readonly inner: SkillStore,
    builtins: readonly BuiltinSkill[],
  ) {
    for (const entry of builtins) {
      if (
        entry.version.skillId !== entry.skill.id
        || entry.skill.latestVersion !== entry.version.version
      ) {
        throw new Error(`Built-in Skill ${entry.skill.id} is inconsistent with its version`);
      }
      if (this.catalog.has(entry.skill.id)) {
        throw new Error(`Built-in Skill ${entry.skill.id} is a duplicate`);
      }
      this.catalog.set(entry.skill.id, structuredClone(entry));
    }
  }

  isBuiltin(skillId: string): boolean {
    return this.catalog.has(skillId);
  }

  insertWithInitialVersion(
    input: InsertSkillWithInitialVersion,
  ): Promise<InsertedSkillWithInitialVersion> {
    if (this.catalog.has(input.skill.id)) {
      throw new Error(`Skill ID ${input.skill.id} is reserved by a built-in Skill`);
    }
    return this.inner.insertWithInitialVersion(input);
  }

  async findSkill(input: SkillLocation): Promise<StoredSkill | null> {
    const entry = this.catalog.get(input.skillId);
    return entry === undefined ? this.inner.findSkill(input) : copySkill(entry);
  }

  async listSkills(input: ListSkillRecords): Promise<StoredSkill[]> {
    const builtins = [...this.catalog.values()]
      .map((entry) => entry.skill)
      .filter((skill) => input.source === undefined || skill.source === input.source)
      .filter((skill) =>
        input.position === undefined || afterSkillPosition(skill, input.position))
      .map((skill) => copySkill(this.catalog.get(skill.id)!));
    if (builtins.length === 0) return this.inner.listSkills(input);
    // Each side returns its first `limit` rows after the cursor, so the
    // first `limit` rows of the merge are the first `limit` rows overall.
    const stored = (await this.inner.listSkills(input))
      .filter((record) => !this.catalog.has(record.skill.id));
    return [...builtins, ...stored]
      .sort((left, right) => newerFirst(left.skill, right.skill))
      .slice(0, input.limit);
  }

  async deleteSkill(input: DeleteSkillRecord): Promise<DeleteSkillRecordResult> {
    if (this.catalog.has(input.skillId)) return { type: "not_found" };
    return this.inner.deleteSkill(input);
  }

  async findVersion(
    input: SkillVersionLocation,
  ): Promise<StoredSkillVersion | null> {
    const entry = this.catalog.get(input.skillId);
    if (entry === undefined) return this.inner.findVersion(input);
    return entry.version.version === input.version ? copyVersion(entry) : null;
  }

  async listVersions(
    input: ListSkillVersionRecords,
  ): Promise<StoredSkillVersion[]> {
    const entry = this.catalog.get(input.skillId);
    if (entry === undefined) return this.inner.listVersions(input);
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Skill Version list limit must be a positive integer");
    }
    if (
      input.position !== undefined
      && !afterVersionPosition(entry.version, input.position)
    ) return [];
    return [copyVersion(entry)];
  }

  async appendVersion(
    input: AppendSkillVersion,
  ): Promise<AppendSkillVersionResult> {
    if (this.catalog.has(input.skillId)) return { type: "not_found" };
    return this.inner.appendVersion(input);
  }

  async findLatestVersionExcluding(
    input: FindLatestSkillVersionExcluding,
  ): Promise<StoredSkillVersion | null> {
    const entry = this.catalog.get(input.skillId);
    if (entry === undefined) return this.inner.findLatestVersionExcluding(input);
    return entry.version.version === input.excludedVersion ? null : copyVersion(entry);
  }

  async deleteVersion(
    input: DeleteSkillVersionRecord,
  ): Promise<DeleteSkillVersionRecordResult> {
    if (this.catalog.has(input.skillId)) return { type: "not_found" };
    return this.inner.deleteVersion(input);
  }
}
