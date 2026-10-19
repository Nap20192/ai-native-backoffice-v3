import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";

import { loadNodeConfig, type NodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import { loadBuiltinSkills } from "../src/lib/builtin-skills";

const PLATFORM = resolve(import.meta.dirname, "../../..");
const SHIPPED = join(PLATFORM, "skills/builtin");
const SKILLS_BETA = { "anthropic-beta": "skills-2025-10-02" };

const dirs: string[] = [];
const planes: NodeControlPlane[] = [];

afterEach(async () => {
  await Promise.all(planes.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function sampleCatalog(): string {
  const root = tempDir("oma-builtin-skills-");
  writeFiles(root, {
    "sample/SKILL.md":
      "---\nname: sample\ndescription: Sample platform skill\ndisplay_title: Sample (demo)\nmetadata:\n  hermes:\n    tags: [a, b]\n---\n# Sample\n",
    "sample/scripts/run.py": "print('ok')\n",
    "sample/scripts/__pycache__/run.cpython-311.pyc": "junk",
    "sample/.DS_Store": "junk",
    "sample/LICENSE": "MIT",
  });
  return root;
}

function testConfig(overrides: Record<string, string | undefined> = {}): NodeConfig {
  const dir = tempDir("oma-builtin-cp-");
  return loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
    ...overrides,
  });
}

describe("loadBuiltinSkills", () => {
  it("compiles each folder into a platform skill named after the folder", async () => {
    const root = sampleCatalog();
    const [entry, ...rest] = await loadBuiltinSkills(root);
    expect(rest).toEqual([]);
    expect(entry!.skill).toMatchObject({
      id: "sample",
      source: "anthropic",
      displayTitle: "Sample (demo)",
    });
    expect(entry!.skill.latestVersion).toMatch(/^[0-9a-f]{12}$/u);
    expect(entry!.version).toMatchObject({
      skillId: "sample",
      name: "sample",
      directory: "sample",
      description: "Sample platform skill",
      version: entry!.skill.latestVersion,
    });
    expect(Object.keys(unzipSync(entry!.archive.content)).sort()).toEqual([
      "sample/LICENSE",
      "sample/SKILL.md",
      "sample/scripts/run.py",
    ]);
  });

  it("keeps the version across restarts and changes it when a file changes", async () => {
    const root = sampleCatalog();
    const first = (await loadBuiltinSkills(root))[0]!.skill.latestVersion;
    expect((await loadBuiltinSkills(root))[0]!.skill.latestVersion).toBe(first);
    writeFileSync(join(root, "sample/scripts/run.py"), "print('changed')\n");
    expect((await loadBuiltinSkills(root))[0]!.skill.latestVersion).not.toBe(first);
  });

  it("refuses a folder whose SKILL.md name differs from the folder", async () => {
    const root = tempDir("oma-builtin-bad-");
    writeFiles(root, { "sample/SKILL.md": "---\nname: other\ndescription: x\n---\n" });
    await expect(loadBuiltinSkills(root)).rejects.toThrow(/sample.*other/u);
  });

  it("returns no skills when the folder does not exist", async () => {
    await expect(loadBuiltinSkills(join(tmpdir(), "oma-no-such-builtin-dir")))
      .resolves.toEqual([]);
  });
});

describe("shipped document skills", () => {
  it("ships docx, pdf, pptx and xlsx with license, attribution and platform paths", async () => {
    const entries = await loadBuiltinSkills(SHIPPED);
    expect(entries.map((entry) => entry.skill.id).sort()).toEqual(["docx", "pdf", "pptx", "xlsx"]);
    for (const entry of entries) {
      const id = entry.skill.id;
      expect(existsSync(join(SHIPPED, id, "LICENSE")), `${id}/LICENSE`).toBe(true);
      const attribution = readFileSync(join(SHIPPED, id, "ATTRIBUTION.md"), "utf8");
      expect(attribution).toContain("https://github.com/NousResearch/hermes-agent");
      expect(attribution).toMatch(/[0-9a-f]{40}/u);
      const manifest = readFileSync(join(SHIPPED, id, "SKILL.md"), "utf8");
      expect(manifest).toContain(`/workspace/.openma/skills/${id}/latest/${id}/`);
      expect(manifest).toContain("/mnt/session/outputs/");
      expect(entry.skill.displayTitle).toBeTruthy();
      expect(entry.version.description.length).toBeGreaterThan(10);
    }
  });

  it("keep every script and reference that SKILL.md names", async () => {
    const entries = await loadBuiltinSkills(SHIPPED);
    for (const entry of entries) {
      const id = entry.skill.id;
      const manifest = readFileSync(join(SHIPPED, id, "SKILL.md"), "utf8");
      const scripts = new Set(manifest.match(/\b[A-Za-z0-9_]+\.py\b/gu) ?? []);
      const references = new Set(manifest.match(/references\/[A-Za-z0-9_.-]+\.md/gu) ?? []);
      expect(scripts.size, `${id}: SKILL.md names no script`).toBeGreaterThan(0);
      const missing = [
        ...[...scripts].filter((name) => !existsSync(join(SHIPPED, id, "scripts", name))),
        ...[...references].filter((path) => !existsSync(join(SHIPPED, id, path))),
      ];
      expect(missing, `${id}: SKILL.md names files that are not in the skill`).toEqual([]);
    }
  });

  it("are copied into the Docker image", () => {
    const dockerfile = readFileSync(join(PLATFORM, "apps/main-node/Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^COPY skills skills$/mu);
  });
});

describe("OMA_BUILTIN_SKILLS_DIR", () => {
  it("defaults to platform/skills/builtin, takes a path, and turns off", () => {
    expect(testConfig().paths.builtinSkills).toBe(SHIPPED);
    expect(testConfig({ OMA_BUILTIN_SKILLS_DIR: "/srv/skills" }).paths.builtinSkills)
      .toBe("/srv/skills");
    expect(testConfig({ OMA_BUILTIN_SKILLS_DIR: "off" }).paths.builtinSkills).toBeNull();
  });
});

describe("built-in skills through the Skills API", () => {
  async function boot(overrides: Record<string, string>): Promise<NodeControlPlane> {
    const cp = await createNodeControlPlane(await nodeDefaults(testConfig(overrides)));
    planes.push(cp);
    return cp;
  }

  const call = (cp: NodeControlPlane, path: string, init: RequestInit = {}) =>
    cp.fetch(new Request(`http://localhost${path}`, {
      ...init,
      headers: { ...SKILLS_BETA, ...(init.headers as Record<string, string> | undefined) },
    }));

  it("lists a platform skill, serves its archive and refuses to delete or replace it", async () => {
    const cp = await boot({ OMA_BUILTIN_SKILLS_DIR: sampleCatalog() });

    const listed = await call(cp, "/v1/skills?source=anthropic");
    expect(listed.status).toBe(200);
    const page = await listed.json() as { data: Array<Record<string, unknown>> };
    expect(page.data).toEqual([expect.objectContaining({
      id: "sample",
      source: "anthropic",
      display_title: "Sample (demo)",
    })]);
    const version = page.data[0]!.latest_version as string;

    const content = await call(cp, `/v1/skills/sample/versions/${version}/content`);
    expect(content.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await content.arrayBuffer()))))
      .toContain("sample/SKILL.md");

    expect((await call(cp, "/v1/skills/sample", { method: "DELETE" })).status).toBe(404);
    const form = new FormData();
    form.append("files[]", new File(["---\nname: sample\ndescription: y\n---\n"], "sample/SKILL.md"));
    expect((await call(cp, "/v1/skills/sample/versions", { method: "POST", body: form })).status)
      .toBe(404);
    expect((await call(cp, `/v1/skills/sample/versions/${version}`, { method: "DELETE" })).status)
      .toBe(404);
    expect((await call(cp, "/v1/skills/sample")).status).toBe(200);
  });

  it("shows no platform skills when they are turned off", async () => {
    const cp = await boot({ OMA_BUILTIN_SKILLS_DIR: "off" });
    const page = await (await call(cp, "/v1/skills")).json() as { data: unknown[] };
    expect(page.data).toEqual([]);
  });
});
