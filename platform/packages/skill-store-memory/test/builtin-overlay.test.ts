import { describe, expect, it } from "vitest";
import type {
  Skill,
  SkillPackageArchive,
  SkillVersion,
} from "@open-managed-agents/domain/skills";
import {
  BuiltinSkillOverlayStore,
  type BuiltinSkill,
} from "@open-managed-agents/skill-store/builtin-overlay";
import { MemorySkillStore } from "../src/index";

const archive = (text: string): SkillPackageArchive => ({
  content: new TextEncoder().encode(text),
  filename: "docx.zip",
  mediaType: "application/zip",
});

const builtin: BuiltinSkill = {
  skill: {
    id: "docx",
    createdAt: "2026-10-16T00:00:00.000Z",
    displayTitle: "Word (docx)",
    latestVersion: "3f9a1c2b4d5e",
    source: "anthropic",
    updatedAt: "2026-10-16T00:00:00.000Z",
  },
  version: {
    id: "skv_builtin_docx_3f9a1c2b4d5e",
    createdAt: "2026-10-16T00:00:00.000Z",
    description: "Create, read, edit Word files.",
    directory: "docx",
    name: "docx",
    skillId: "docx",
    version: "3f9a1c2b4d5e",
  },
  archive: archive("builtin zip"),
};

function customSkill(id: string, createdAt: string): {
  skill: Skill;
  version: SkillVersion;
} {
  const version = `${Date.parse(createdAt)}000`;
  return {
    skill: {
      id,
      createdAt,
      displayTitle: id,
      latestVersion: version,
      source: "custom",
      updatedAt: createdAt,
    },
    version: {
      id: `skv_${id}`,
      createdAt,
      description: `${id} description`,
      directory: id,
      name: id,
      skillId: id,
      version,
    },
  };
}

async function storeWithCustomSkills(): Promise<BuiltinSkillOverlayStore> {
  const inner = new MemorySkillStore();
  for (const [id, createdAt] of [
    ["skill_newer", "2026-10-20T00:00:00.000Z"],
    ["skill_older", "2026-10-01T00:00:00.000Z"],
  ] as const) {
    const { skill, version } = customSkill(id, createdAt);
    await inner.insertWithInitialVersion({
      workspaceId: "ws_a",
      skill,
      version,
      archive: archive(id),
    });
  }
  return new BuiltinSkillOverlayStore(inner, [builtin]);
}

describe("BuiltinSkillOverlayStore", () => {
  it("serves a catalog skill and its version in every workspace", async () => {
    const store = new BuiltinSkillOverlayStore(new MemorySkillStore(), [builtin]);
    for (const workspaceId of ["ws_a", "ws_b"]) {
      await expect(store.findSkill({ workspaceId, skillId: "docx" }))
        .resolves.toEqual({ skill: builtin.skill, revision: 1 });
      await expect(store.listVersions({ workspaceId, skillId: "docx", limit: 5 }))
        .resolves.toEqual([{ version: builtin.version, archive: builtin.archive }]);
      await expect(store.findVersion({
        workspaceId,
        skillId: "docx",
        version: "3f9a1c2b4d5e",
      })).resolves.toEqual({ version: builtin.version, archive: builtin.archive });
      await expect(store.listSkills({ workspaceId: "ws_b", limit: 20 }))
        .resolves.toEqual([{ skill: builtin.skill, revision: 1 }]);
    }
    await expect(store.findVersion({
      workspaceId: "ws_a",
      skillId: "docx",
      version: "other",
    })).resolves.toBeNull();
  });

  it("hands out copies, so a caller cannot change the catalog", async () => {
    const store = new BuiltinSkillOverlayStore(new MemorySkillStore(), [builtin]);
    const found = await store.findVersion({
      workspaceId: "ws_a",
      skillId: "docx",
      version: "3f9a1c2b4d5e",
    });
    found!.archive.content[0] = 0;
    found!.version.name = "changed";
    await expect(store.findVersion({
      workspaceId: "ws_b",
      skillId: "docx",
      version: "3f9a1c2b4d5e",
    })).resolves.toEqual({ version: builtin.version, archive: builtin.archive });
  });

  it("merges catalog and workspace skills newest first, with the source filter", async () => {
    const store = await storeWithCustomSkills();
    const ids = async (source?: string) =>
      (await store.listSkills({
        workspaceId: "ws_a",
        limit: 20,
        ...(source !== undefined && { source }),
      })).map((record) => record.skill.id);

    await expect(ids()).resolves.toEqual(["skill_newer", "docx", "skill_older"]);
    await expect(ids("anthropic")).resolves.toEqual(["docx"]);
    await expect(ids("custom")).resolves.toEqual(["skill_newer", "skill_older"]);
  });

  it("pages through the merged list once per skill", async () => {
    const store = await storeWithCustomSkills();
    const seen: string[] = [];
    let position: { createdAt: string; skillId: string } | undefined;
    for (;;) {
      const page = await store.listSkills({
        workspaceId: "ws_a",
        limit: 1,
        ...(position !== undefined && { position }),
      });
      if (page.length === 0) break;
      const last = page.at(-1)!.skill;
      seen.push(...page.map((record) => record.skill.id));
      position = { createdAt: last.createdAt, skillId: last.id };
    }
    expect(seen).toEqual(["skill_newer", "docx", "skill_older"]);
  });

  it("refuses to delete or change a catalog skill", async () => {
    const store = new BuiltinSkillOverlayStore(new MemorySkillStore(), [builtin]);
    const location = { workspaceId: "ws_a", skillId: "docx" };
    await expect(store.deleteSkill(location)).resolves.toEqual({ type: "not_found" });
    await expect(store.appendVersion({
      ...location,
      expectedSkillRevision: 1,
      nextSkill: { ...builtin.skill, latestVersion: "next" },
      version: { ...builtin.version, id: "skv_next", version: "next" },
      archive: archive("next"),
    })).resolves.toEqual({ type: "not_found" });
    await expect(store.deleteVersion({
      ...location,
      version: "3f9a1c2b4d5e",
      expectedSkillRevision: 1,
      nextSkill: { ...builtin.skill, latestVersion: null },
    })).resolves.toEqual({ type: "not_found" });
    await expect(store.findSkill(location))
      .resolves.toEqual({ skill: builtin.skill, revision: 1 });
    await expect(store.findLatestVersionExcluding({
      ...location,
      excludedVersion: "3f9a1c2b4d5e",
    })).resolves.toBeNull();
    await expect(store.findLatestVersionExcluding({
      ...location,
      excludedVersion: "other",
    })).resolves.toEqual({ version: builtin.version, archive: builtin.archive });
  });

  it("passes workspace skills through to the inner store", async () => {
    const store = await storeWithCustomSkills();
    await expect(store.deleteSkill({ workspaceId: "ws_a", skillId: "skill_older" }))
      .resolves.toEqual({ type: "deleted" });
    await expect(store.findSkill({ workspaceId: "ws_a", skillId: "skill_older" }))
      .resolves.toBeNull();
    await expect(store.findSkill({ workspaceId: "ws_b", skillId: "skill_newer" }))
      .resolves.toBeNull();
    expect(store.isBuiltin("docx")).toBe(true);
    expect(store.isBuiltin("skill_newer")).toBe(false);
  });

  it("rejects a catalog whose skill and version disagree", () => {
    expect(() => new BuiltinSkillOverlayStore(new MemorySkillStore(), [{
      ...builtin,
      version: { ...builtin.version, version: "mismatch" },
    }])).toThrow(/inconsistent/u);
    expect(() => new BuiltinSkillOverlayStore(new MemorySkillStore(), [builtin, builtin]))
      .toThrow(/duplicate/u);
  });
});
