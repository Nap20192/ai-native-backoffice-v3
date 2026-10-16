// Sandbox image catalog (docs/plans/environments.md, 1.5 and 1.6): the server
// reads catalog.json named by SANDBOX_IMAGE_CATALOG, checks every OCI layout
// against the digest build.sh recorded, and serves images and templates at
// GET /v1/oma/sandbox-catalog.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSandboxCatalogRoutes,
  sandboxCatalogResponse,
} from "../src/lib/sandbox-catalog-routes";
import {
  loadSandboxCatalog,
  resolveCatalogImage,
  sandboxCatalogSettings,
  SandboxCatalogError,
  type SandboxCatalog,
} from "../src/lib/sandbox-catalog";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const LEGACY_REF = `docker.io/library/node:22-bookworm@${DIGEST_B}`;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-catalog-"));
  dirs.push(dir);
  return dir;
}

/** An OCI layout as `docker buildx --output type=oci,tar=false` writes it. */
function writeOciLayout(imageDir: string, name: string, digest: string, blob = "layer-bytes"): void {
  const dir = join(imageDir, name);
  mkdirSync(join(dir, "blobs", "sha256"), { recursive: true });
  writeFileSync(join(dir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [{ mediaType: "application/vnd.oci.image.index.v1+json", digest, size: 856 }],
    }),
  );
  writeFileSync(join(dir, "blobs", "sha256", "a".repeat(64)), blob);
}

function writeManifest(imageDir: string, file: string, manifest: Record<string, unknown>): void {
  writeFileSync(join(imageDir, file), JSON.stringify(manifest));
}

const workplaceManifest = {
  image_digest: DIGEST_A,
  os: "Debian GNU/Linux 12 (bookworm)",
  arch: "x86_64",
  user: "root",
  bash: true,
  pip: [{ name: "python-pptx", version: "1.0.2" }],
};

function baseCatalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    default_image: "legacy",
    images: {
      legacy: {
        label: "Node 22 (прежний образ)",
        image: LEGACY_REF,
        manifest: "legacy.manifest.json",
        disk_gb: 4,
        memory_mib: 512,
        cpus: 1,
      },
      workplace: {
        label: "Рабочее место агента",
        oci_dir: "workplace-2026.10.1",
        disk_gb: 6,
        memory_mib: 1024,
        cpus: 2,
      },
    },
    templates: [
      {
        id: "basic",
        label: "Базовое",
        image: "workplace",
        networking: {
          type: "limited",
          allow_package_managers: true,
          allow_mcp_servers: true,
          allow_web_search: false,
          allowed_hosts: [],
        },
        packages: {},
      },
      {
        id: "data",
        label: "Данные",
        description: "SQL по файлам и графики",
        image: "workplace",
        networking: { type: "limited", allow_package_managers: true },
        packages: { pip: ["duckdb", "pyarrow"] },
      },
      {
        id: "web",
        label: "Веб",
        image: "legacy",
        networking: { type: "unrestricted" },
        packages: { pip: ["markdownify"] },
      },
    ],
    ...overrides,
  };
}

/** Writes catalog.json plus a built `workplace` and the `legacy` manifest. */
function fixture(catalog: Record<string, unknown> = baseCatalog()) {
  const imageDir = tempDir();
  writeOciLayout(imageDir, "workplace-2026.10.1", DIGEST_A);
  writeManifest(imageDir, "workplace-2026.10.1.manifest.json", workplaceManifest);
  writeManifest(imageDir, "legacy.manifest.json", { image_digest: DIGEST_B, os: "Debian 12" });
  const catalogPath = join(tempDir(), "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(catalog));
  return { imageDir, catalogPath };
}

function image(catalog: SandboxCatalog, key: string) {
  const found = catalog.images.find((entry) => entry.key === key);
  if (!found) throw new Error(`no image ${key}`);
  return found;
}

describe("sandboxCatalogSettings", () => {
  it("reads the catalog path, the image folder and the fallback image from env", () => {
    expect(sandboxCatalogSettings({})).toEqual({
      catalogPath: null,
      imageDir: "./data/sandbox-images",
      fallbackImage: null,
    });
    expect(
      sandboxCatalogSettings({
        SANDBOX_IMAGE_CATALOG: " /etc/oma/catalog.json ",
        SANDBOX_IMAGE_DIR: "~/.cache/ai-backoffice-v3/environments/sandbox-images",
        SANDBOX_IMAGE: "node:22-bookworm",
      }),
    ).toEqual({
      catalogPath: "/etc/oma/catalog.json",
      imageDir: join(homedir(), ".cache/ai-backoffice-v3/environments/sandbox-images"),
      fallbackImage: "node:22-bookworm",
    });
    expect(sandboxCatalogSettings({ SANDBOX_IMAGE_CATALOG: "  " }).catalogPath).toBeNull();
  });
});

describe("loadSandboxCatalog", () => {
  it("serves one default image from SANDBOX_IMAGE when no catalog is configured", async () => {
    const catalog = await loadSandboxCatalog({
      catalogPath: null,
      imageDir: "./data/sandbox-images",
      fallbackImage: "node:22-bookworm",
    });

    expect(catalog.enabled).toBe(false);
    expect(catalog.defaultImage).toBe("default");
    expect(catalog.templates).toEqual([]);
    expect(catalog.images).toHaveLength(1);
    expect(catalog.images[0]).toMatchObject({
      key: "default",
      built: true,
      reason: null,
      digest: null,
      source: { type: "server_default", reference: "node:22-bookworm" },
    });
  });

  it("loads OCI and registry images with digest, size, resources and manifest", async () => {
    const settings = fixture();
    const catalog = await loadSandboxCatalog({ ...settings, fallbackImage: null });

    expect(catalog.enabled).toBe(true);
    expect(catalog.defaultImage).toBe("legacy");
    expect(catalog.images.map((entry) => entry.key)).toEqual(["legacy", "workplace"]);

    const workplace = image(catalog, "workplace");
    expect(workplace).toMatchObject({
      label: "Рабочее место агента",
      built: true,
      reason: null,
      digest: DIGEST_A,
      resources: { diskGb: 6, memoryMib: 1024, cpus: 2 },
      manifest: workplaceManifest,
      source: { type: "oci", dir: join(settings.imageDir, "workplace-2026.10.1") },
    });
    expect(workplace.sizeBytes).toBeGreaterThan(0);
    expect(workplace.manifestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    const legacy = image(catalog, "legacy");
    expect(legacy).toMatchObject({
      built: true,
      reason: null,
      digest: DIGEST_B,
      sizeBytes: null,
      resources: { diskGb: 4, memoryMib: 512, cpus: 1 },
      manifest: { image_digest: DIGEST_B, os: "Debian 12" },
      source: { type: "registry", reference: LEGACY_REF },
    });
  });

  it("marks an image unbuilt when its OCI folder is missing", async () => {
    const settings = fixture();
    rmSync(join(settings.imageDir, "workplace-2026.10.1"), { recursive: true });

    const workplace = image(await loadSandboxCatalog({ ...settings, fallbackImage: null }), "workplace");

    expect(workplace.built).toBe(false);
    expect(workplace.reason).toBe("Каталог образа workplace-2026.10.1 не найден");
    expect(workplace.digest).toBeNull();
  });

  it("marks an image unbuilt when index.json and the recorded digest differ", async () => {
    const settings = fixture();
    writeManifest(settings.imageDir, "workplace-2026.10.1.manifest.json", {
      ...workplaceManifest,
      image_digest: DIGEST_B,
    });

    const workplace = image(await loadSandboxCatalog({ ...settings, fallbackImage: null }), "workplace");

    expect(workplace.built).toBe(false);
    expect(workplace.reason).toBe("Каталог образа изменён после сборки");
    expect(workplace.digest).toBe(DIGEST_A);
  });

  it("marks an image unbuilt when build.sh left no manifest next to the folder", async () => {
    const settings = fixture();
    rmSync(join(settings.imageDir, "workplace-2026.10.1.manifest.json"));

    const workplace = image(await loadSandboxCatalog({ ...settings, fallbackImage: null }), "workplace");

    expect(workplace.built).toBe(false);
    expect(workplace.reason).toBe("Нет манифеста образа workplace-2026.10.1.manifest.json");
  });

  it("marks an image unbuilt when index.json has no digest", async () => {
    const settings = fixture();
    writeFileSync(
      join(settings.imageDir, "workplace-2026.10.1", "index.json"),
      JSON.stringify({ schemaVersion: 2, manifests: [] }),
    );

    const workplace = image(await loadSandboxCatalog({ ...settings, fallbackImage: null }), "workplace");

    expect(workplace.built).toBe(false);
    expect(workplace.reason).toBe("В каталоге образа нет index.json с дайджестом");
  });

  it("refuses a registry reference without a digest", async () => {
    const catalog = baseCatalog();
    (catalog.images as Record<string, Record<string, unknown>>).legacy!.image = "node:22-bookworm";
    const settings = fixture(catalog);

    const legacy = image(await loadSandboxCatalog({ ...settings, fallbackImage: null }), "legacy");

    expect(legacy.built).toBe(false);
    expect(legacy.reason).toBe("Ссылка на образ без дайджеста @sha256");
    expect(legacy.digest).toBeNull();
  });

  it.each([
    ["without image_digest", { os: "Debian 12" }],
    ["with a null image_digest", { image_digest: null, os: "Debian 12" }],
  ])("marks a registry image unbuilt when its manifest is %s", async (_case, manifest) => {
    // manifest.sh inside a build writes null: such a file proves nothing about the reference.
    const settings = fixture();
    writeManifest(settings.imageDir, "legacy.manifest.json", manifest);

    const legacy = image(await loadSandboxCatalog({ ...settings, fallbackImage: null }), "legacy");

    expect(legacy.built).toBe(false);
    expect(legacy.reason).toBe("В манифесте образа нет image_digest");
    expect(legacy.manifest).toBeNull();
  });

  it("marks a registry image unbuilt when its manifest belongs to another image", async () => {
    const settings = fixture();
    writeManifest(settings.imageDir, "legacy.manifest.json", { image_digest: DIGEST_A });

    const legacy = image(await loadSandboxCatalog({ ...settings, fallbackImage: null }), "legacy");

    expect(legacy.built).toBe(false);
    expect(legacy.reason).toBe("Манифест снят с другого образа");
  });

  it("builds templates as ready create bodies with defaults filled in", async () => {
    const catalog = await loadSandboxCatalog({ ...fixture(), fallbackImage: null });

    expect(catalog.templates.map((template) => template.id)).toEqual(["basic", "data", "web"]);
    expect(catalog.templates[1]).toEqual({
      id: "data",
      label: "Данные",
      description: "SQL по файлам и графики",
      image: "workplace",
      config: {
        type: "cloud",
        image: "workplace",
        networking: {
          type: "limited",
          allow_mcp_servers: false,
          allow_package_managers: true,
          allow_web_search: false,
          allowed_hosts: [],
        },
        packages: { type: "packages", apt: [], npm: [], pip: ["duckdb", "pyarrow"] },
      },
      metadata: { oma_template: "data" },
    });
    expect(catalog.templates[2]?.config.networking).toEqual({ type: "unrestricted" });
    expect(catalog.templates[0]?.description).toBeNull();
  });

  it("rejects a catalog the operator broke, naming the setting", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unknown default image", baseCatalog({ default_image: "missing" })],
      [
        "template on an unknown image",
        baseCatalog({
          templates: [{ id: "x", label: "X", image: "missing", networking: { type: "unrestricted" } }],
        }),
      ],
      [
        "template with cargo packages",
        baseCatalog({
          templates: [
            { id: "x", label: "X", image: "workplace", networking: { type: "unrestricted" }, packages: { cargo: ["ripgrep"] } },
          ],
        }),
      ],
      [
        "web search on an unrestricted template",
        baseCatalog({
          templates: [
            { id: "x", label: "X", image: "workplace", networking: { type: "unrestricted", allow_web_search: true } },
          ],
        }),
      ],
      [
        "duplicate template id",
        baseCatalog({
          templates: [
            { id: "x", label: "X", image: "workplace", networking: { type: "unrestricted" } },
            { id: "x", label: "Y", image: "workplace", networking: { type: "unrestricted" } },
          ],
        }),
      ],
      ["oci_dir leaving the image folder", baseCatalog({ images: { legacy: { label: "L", oci_dir: "../elsewhere" } } })],
      ["absolute oci_dir", baseCatalog({ images: { legacy: { label: "L", oci_dir: "/srv/images/x" } } })],
      ["both image and oci_dir", baseCatalog({ images: { legacy: { label: "L", oci_dir: "x", image: LEGACY_REF } } })],
      ["neither image nor oci_dir", baseCatalog({ images: { legacy: { label: "L" } } })],
      ["bad image key", baseCatalog({ default_image: "Legacy Image", images: { "Legacy Image": { label: "L", image: LEGACY_REF } } })],
      ["negative memory", baseCatalog({ images: { legacy: { label: "L", image: LEGACY_REF, memory_mib: -1 } } })],
    ];

    for (const [name, catalog] of cases) {
      const settings = fixture(catalog);
      await expect(
        loadSandboxCatalog({ ...settings, fallbackImage: null }),
        name,
      ).rejects.toThrow(/SANDBOX_IMAGE_CATALOG/);
    }
  });

  it("fails with the setting name when the catalog file is missing or not JSON", async () => {
    const dir = tempDir();
    await expect(
      loadSandboxCatalog({ catalogPath: join(dir, "nope.json"), imageDir: dir, fallbackImage: null }),
    ).rejects.toBeInstanceOf(SandboxCatalogError);

    const broken = join(dir, "catalog.json");
    writeFileSync(broken, "{ not json");
    await expect(
      loadSandboxCatalog({ catalogPath: broken, imageDir: dir, fallbackImage: null }),
    ).rejects.toThrow(/SANDBOX_IMAGE_CATALOG/);
  });
});

describe("resolveCatalogImage", () => {
  it("picks the default for null, refuses unknown keys and names unbuilt images", async () => {
    const settings = fixture();
    rmSync(join(settings.imageDir, "workplace-2026.10.1"), { recursive: true });
    const catalog = await loadSandboxCatalog({ ...settings, fallbackImage: null });

    const byDefault = resolveCatalogImage(catalog, null);
    expect(byDefault.type).toBe("ready");
    expect(byDefault.type === "ready" && byDefault.image.key).toBe("legacy");
    expect(resolveCatalogImage(catalog, undefined).type).toBe("ready");
    expect(resolveCatalogImage(catalog, "nope")).toEqual({ type: "unknown", key: "nope" });

    const unbuilt = resolveCatalogImage(catalog, "workplace");
    expect(unbuilt.type).toBe("not_built");
    expect(unbuilt.type === "not_built" && unbuilt.reason).toBe(
      "Каталог образа workplace-2026.10.1 не найден",
    );
  });
});

describe("GET /v1/oma/sandbox-catalog", () => {
  it("answers images and templates without host paths", async () => {
    const settings = fixture();
    const catalog = await loadSandboxCatalog({ ...settings, fallbackImage: null });
    const app = buildSandboxCatalogRoutes({ catalog: () => catalog });

    const response = await app.request("/");

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReturnType<typeof sandboxCatalogResponse>;
    expect(body).toEqual(JSON.parse(JSON.stringify(sandboxCatalogResponse(catalog))));
    expect(body.enabled).toBe(true);
    expect(body.default_image).toBe("legacy");
    expect(body.images.find((entry) => entry.key === "workplace")).toEqual({
      key: "workplace",
      label: "Рабочее место агента",
      built: true,
      reason: null,
      image_digest: DIGEST_A,
      size_bytes: image(catalog, "workplace").sizeBytes,
      resources: { disk_gb: 6, memory_mib: 1024, cpus: 2 },
      manifest: workplaceManifest,
    });
    expect(body.templates.map((template) => [template.id, template.available])).toEqual([
      ["basic", true],
      ["data", true],
      ["web", true],
    ]);
    expect(JSON.stringify(body)).not.toContain(settings.imageDir);
  });

  it("marks a template unavailable while its image is not built", async () => {
    const settings = fixture();
    rmSync(join(settings.imageDir, "workplace-2026.10.1"), { recursive: true });
    const catalog = await loadSandboxCatalog({ ...settings, fallbackImage: null });

    const body = sandboxCatalogResponse(catalog);

    expect(body.templates.map((template) => [template.id, template.available])).toEqual([
      ["basic", false],
      ["data", false],
      ["web", true],
    ]);
    expect(body.images.find((entry) => entry.key === "workplace")).toMatchObject({
      built: false,
      reason: "Каталог образа workplace-2026.10.1 не найден",
      size_bytes: null,
    });
  });

  it("answers the single default image when no catalog is configured", async () => {
    const catalog = await loadSandboxCatalog({
      catalogPath: null,
      imageDir: "./data/sandbox-images",
      fallbackImage: null,
    });

    const body = sandboxCatalogResponse(catalog);

    expect(body).toEqual({
      enabled: false,
      default_image: "default",
      images: [
        {
          key: "default",
          label: "Образ сервера",
          built: true,
          reason: null,
          image_digest: null,
          size_bytes: null,
          resources: { disk_gb: null, memory_mib: null, cpus: null },
          manifest: null,
        },
      ],
      templates: [],
    });
  });
});
