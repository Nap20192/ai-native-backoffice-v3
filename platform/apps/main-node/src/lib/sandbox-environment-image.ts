// The VM image of a cloud environment (docs/plans/environments.md, 1.5-1.6).
//
// `config.image` names a key of the sandbox image catalog. The catalog gives
// the OCI layout or the registry reference pinned by digest, the digest it
// verified, the hash of the image manifest, the VM resources and the shell
// the manifest names. The sandbox adapter boots exactly that image; LiteBox
// checks the digest of a layout once more right before the VM.
//
// The catalog is read for every VM: a layout rebuilt or edited since the
// last VM is caught here, without a server restart. An environment without
// `config.image` keeps the server image (SANDBOX_IMAGE), as before the
// catalog, and the catalog is not read for it. An unknown key or an image
// that is not built fails the sandbox with the image name; no other image
// takes its place. The session error is in Russian like the catalog reasons
// it carries: the console shows it to the user.

import {
  SandboxEnvironmentError,
  type SandboxEnvironmentImage,
  type SandboxShell,
} from "@open-managed-agents/sandbox";

import {
  loadSandboxCatalog,
  resolveCatalogImage,
  sandboxCatalogSettings,
  type JsonObject,
  type SandboxCatalogImage,
} from "./sandbox-catalog.js";

/** `/bin/bash` → bash, `/bin/sh` or dash → sh; anything else is unknown. */
function manifestShell(manifest: JsonObject | null): SandboxShell | null {
  const shell = manifest?.shell;
  if (typeof shell !== "string") return null;
  const name = shell.slice(shell.lastIndexOf("/") + 1);
  if (name === "bash") return "bash";
  return name === "sh" || name === "dash" ? "sh" : null;
}

/** What the sandbox adapter needs of a built catalog image; null for the
 *  server image entry of a server without a catalog. */
export function sandboxEnvironmentImage(image: SandboxCatalogImage): SandboxEnvironmentImage | null {
  if (image.source.type === "server_default") return null;
  if (image.digest === null) {
    // The catalog marks an image without a digest as not built.
    throw new SandboxEnvironmentError("image_unavailable", `У образа песочницы «${image.key}» нет проверенного дайджеста`);
  }
  return {
    key: image.key,
    source: image.source.type === "oci"
      ? { type: "oci", dir: image.source.dir }
      : { type: "registry", reference: image.source.reference },
    digest: image.digest,
    manifestSha256: image.manifestSha256,
    manifest: image.manifest,
    resources: { ...image.resources },
    shell: manifestShell(image.manifest),
  };
}

/**
 * `config.image` of an environment → the `image` part of the sandbox
 * environment spec. `{}` keeps the server image. `env` holds the catalog
 * settings (SANDBOX_IMAGE_CATALOG, SANDBOX_IMAGE_DIR, SANDBOX_IMAGE).
 */
export function createSandboxImageSpec(
  env: Readonly<Record<string, string | undefined>>,
): (key: string | null | undefined) => Promise<{ image?: SandboxEnvironmentImage }> {
  const settings = sandboxCatalogSettings(env);
  return async (key) => {
    if (key === null || key === undefined) return {};
    const resolution = resolveCatalogImage(await loadSandboxCatalog(settings), key);
    if (resolution.type === "unknown") {
      throw new SandboxEnvironmentError("image_unavailable", `Образ песочницы «${key}» не найден в каталоге образов`);
    }
    if (resolution.type === "not_built") {
      throw new SandboxEnvironmentError("image_unavailable", `Образ песочницы «${key}» недоступен: ${resolution.reason}`);
    }
    const image = sandboxEnvironmentImage(resolution.image);
    return image === null ? {} : { image };
  };
}
