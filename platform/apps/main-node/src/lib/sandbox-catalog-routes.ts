// GET /v1/oma/sandbox-catalog (docs/plans/environments.md, 1.5): images with
// their build state, digest, size, resources and manifest, and the templates
// of the "New environment" page. The console and the environment prompt
// block read it. Host paths of OCI layouts stay on the server.
//
// ES3 mounts these routes in node-http.ts.

import { Hono } from "hono";

import type { JsonObject, SandboxCatalog, SandboxCatalogTemplate } from "./sandbox-catalog.js";

export interface SandboxCatalogImageResponse {
  key: string;
  label: string;
  built: boolean;
  reason: string | null;
  image_digest: string | null;
  size_bytes: number | null;
  resources: { disk_gb: number | null; memory_mib: number | null; cpus: number | null };
  manifest: JsonObject | null;
}

export interface SandboxCatalogTemplateResponse {
  id: string;
  label: string;
  description: string | null;
  image: string;
  /** False while the template's image is not built. */
  available: boolean;
  config: SandboxCatalogTemplate["config"];
  metadata: SandboxCatalogTemplate["metadata"];
}

export interface SandboxCatalogResponse {
  /** False without SANDBOX_IMAGE_CATALOG: one server image, no templates. */
  enabled: boolean;
  default_image: string;
  images: SandboxCatalogImageResponse[];
  templates: SandboxCatalogTemplateResponse[];
}

export function sandboxCatalogResponse(catalog: SandboxCatalog): SandboxCatalogResponse {
  const built = new Map(catalog.images.map((image) => [image.key, image.built]));
  return {
    enabled: catalog.enabled,
    default_image: catalog.defaultImage,
    images: catalog.images.map((image) => ({
      key: image.key,
      label: image.label,
      built: image.built,
      reason: image.reason,
      image_digest: image.digest,
      size_bytes: image.sizeBytes,
      resources: {
        disk_gb: image.resources.diskGb,
        memory_mib: image.resources.memoryMib,
        cpus: image.resources.cpus,
      },
      manifest: image.manifest,
    })),
    templates: catalog.templates.map((template) => ({
      id: template.id,
      label: template.label,
      description: template.description,
      image: template.image,
      available: built.get(template.image) === true,
      config: template.config,
      metadata: template.metadata,
    })),
  };
}

export interface SandboxCatalogRoutesOptions {
  /** The loaded catalog; a getter so a reload can swap it. */
  catalog: () => SandboxCatalog | Promise<SandboxCatalog>;
}

/** Mounted at /v1/oma/sandbox-catalog. */
export function buildSandboxCatalogRoutes(options: SandboxCatalogRoutesOptions): Hono {
  const app = new Hono();
  app.get("/", async (c) => c.json(sandboxCatalogResponse(await options.catalog())));
  return app;
}
