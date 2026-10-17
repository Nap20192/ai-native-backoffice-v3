// The VM image of a cloud environment (docs/plans/environments.md, 1.5-1.6):
// `config.image` names a catalog key, the catalog gives the OCI layout or
// pinned reference, the verified digest, the resources and the shell. No key
// keeps the server image; an unknown or unbuilt image fails by name.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxEnvironmentError } from "@open-managed-agents/sandbox";

import { loadSandboxCatalog, sandboxCatalogSettings } from "../src/lib/sandbox-catalog";
import {
  createSandboxImageSpec,
  sandboxEnvironmentImage,
} from "../src/lib/sandbox-environment-image";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const LEGACY_REF = `docker.io/library/node:22-bookworm@${DIGEST_B}`;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-image-spec-"));
  dirs.push(dir);
  return dir;
}

function writeLayout(imageDir: string, name: string, digest: string): void {
  mkdirSync(join(imageDir, name), { recursive: true });
  writeFileSync(join(imageDir, name, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ digest }] }));
}

/** A catalog with a built `workplace`, an unbuilt `office` and the pinned `legacy`. */
function setup(manifest: Record<string, unknown> = { shell: "/bin/bash" }) {
  const imageDir = tempDir();
  writeLayout(imageDir, "workplace-2026.10.1", DIGEST_A);
  writeFileSync(join(imageDir, "workplace-2026.10.1.manifest.json"), JSON.stringify({ image_digest: DIGEST_A, ...manifest }));
  writeFileSync(join(imageDir, "legacy.manifest.json"), JSON.stringify({ image_digest: DIGEST_B, shell: "/bin/bash" }));
  const catalogPath = join(tempDir(), "catalog.json");
  writeFileSync(catalogPath, JSON.stringify({
    default_image: "legacy",
    images: {
      legacy: { label: "Прежний образ", image: LEGACY_REF, manifest: "legacy.manifest.json", disk_gb: 4, memory_mib: 512, cpus: 1 },
      workplace: { label: "Рабочее место агента", oci_dir: "workplace-2026.10.1", disk_gb: 6, memory_mib: 1024, cpus: 2 },
      office: { label: "Рабочее место с LibreOffice", oci_dir: "workplace-office-2026.10.1", disk_gb: 8, memory_mib: 2048 },
    },
  }));
  const env = { SANDBOX_IMAGE_CATALOG: catalogPath, SANDBOX_IMAGE_DIR: imageDir, SANDBOX_IMAGE: "server:1" };
  return { env, imageDir, catalogPath };
}

describe("sandboxEnvironmentImage", () => {
  it("gives the adapter the OCI layout, digest, manifest hash, resources and shell of a built image", async () => {
    const { env, imageDir } = setup();
    const catalog = await loadSandboxCatalog(sandboxCatalogSettings(env));
    const workplace = catalog.images.find((image) => image.key === "workplace")!;
    expect(sandboxEnvironmentImage(workplace)).toEqual({
      key: "workplace",
      source: { type: "oci", dir: join(imageDir, "workplace-2026.10.1") },
      digest: DIGEST_A,
      manifestSha256: workplace.manifestSha256,
      manifest: { image_digest: DIGEST_A, shell: "/bin/bash" },
      resources: { diskGb: 6, memoryMib: 1024, cpus: 2 },
      shell: "bash",
    });
    expect(workplace.manifestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const legacy = catalog.images.find((image) => image.key === "legacy")!;
    expect(sandboxEnvironmentImage(legacy)).toMatchObject({
      key: "legacy", source: { type: "registry", reference: LEGACY_REF }, digest: DIGEST_B, shell: "bash",
    });
  });

  it("reads the shell from the manifest and leaves an unknown one to the adapter", async () => {
    for (const [manifest, expected] of [[{ shell: "/bin/bash" }, "bash"], [{ shell: "/usr/bin/bash" }, "bash"],
      [{ shell: "/bin/sh" }, "sh"], [{ shell: "/bin/dash" }, "sh"], [{ shell: "/usr/bin/zsh" }, null], [{}, null],
      [{ shell: 42 }, null]] as const) {
      const { env } = setup(manifest);
      const catalog = await loadSandboxCatalog(sandboxCatalogSettings(env));
      expect(sandboxEnvironmentImage(catalog.images.find((image) => image.key === "workplace")!)?.shell).toBe(expected);
    }
  });

  it("returns null for the server image of a server without a catalog", async () => {
    const catalog = await loadSandboxCatalog(sandboxCatalogSettings({ SANDBOX_IMAGE: "server:1" }));
    expect(sandboxEnvironmentImage(catalog.images[0]!)).toBeNull();
  });
});

describe("createSandboxImageSpec", () => {
  it("keeps the server image without config.image and does not read the catalog then", async () => {
    const spec = createSandboxImageSpec({ SANDBOX_IMAGE_CATALOG: join(tempDir(), "missing.json") });
    await expect(spec(undefined)).resolves.toEqual({});
    await expect(spec(null)).resolves.toEqual({});
  });

  it("resolves config.image to the catalog image", async () => {
    const { env, imageDir } = setup();
    await expect(createSandboxImageSpec(env)("workplace")).resolves.toMatchObject({
      image: { key: "workplace", source: { type: "oci", dir: join(imageDir, "workplace-2026.10.1") }, digest: DIGEST_A },
    });
  });

  it("fails by name for an unknown or unbuilt image instead of falling back", async () => {
    const { env } = setup();
    const spec = createSandboxImageSpec(env);
    const unknown = spec("nope");
    await expect(unknown).rejects.toBeInstanceOf(SandboxEnvironmentError);
    await expect(unknown).rejects.toMatchObject({ code: "image_unavailable" });
    await expect(unknown).rejects.toThrow("Образ песочницы «nope» не найден в каталоге образов");
    const unbuilt = spec("office");
    await expect(unbuilt).rejects.toMatchObject({ code: "image_unavailable" });
    await expect(unbuilt).rejects.toThrow("Образ песочницы «office» недоступен: Каталог образа workplace-office-2026.10.1 не найден");
  });

  it("reads the catalog for every VM, so a layout changed after the last VM is caught", async () => {
    const { env, imageDir } = setup();
    const spec = createSandboxImageSpec(env);
    await expect(spec("workplace")).resolves.toMatchObject({ image: { digest: DIGEST_A } });
    writeLayout(imageDir, "workplace-2026.10.1", DIGEST_C);
    await expect(spec("workplace")).rejects.toThrow(/Каталог образа изменён после сборки/);
  });

  it("without a catalog keeps the server image for its own key and refuses catalog keys", async () => {
    const spec = createSandboxImageSpec({ SANDBOX_IMAGE: "server:1" });
    await expect(spec("default")).resolves.toEqual({});
    await expect(spec("workplace")).rejects.toMatchObject({ code: "image_unavailable" });
  });

  it("names SANDBOX_IMAGE_CATALOG when the catalog file is broken", async () => {
    const catalogPath = join(tempDir(), "catalog.json");
    writeFileSync(catalogPath, "{ not json");
    await expect(createSandboxImageSpec({ SANDBOX_IMAGE_CATALOG: catalogPath })("workplace"))
      .rejects.toThrow(/SANDBOX_IMAGE_CATALOG/);
  });
});
