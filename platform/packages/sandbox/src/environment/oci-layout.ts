// OCI layout of a catalog image (docs/plans/environments.md, 1.6).
//
// platform/sandbox-images/build.sh writes one image per layout. Its
// `index.json` points to the image manifest by digest, and that digest fixes
// the image content. The server compares it with the digest the build
// recorded when it loads the catalog; the LiteBox adapter compares it again
// right before it boots a VM from the layout.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The manifest digest `index.json` of the layout in `dir` points to, or
 *  null when the index is missing, unreadable or has no valid digest. */
export async function readOciIndexDigest(dir: string): Promise<string | null> {
  try {
    const index: unknown = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    if (!isRecord(index) || !Array.isArray(index.manifests)) return null;
    const first: unknown = index.manifests[0];
    const digest = isRecord(first) ? first.digest : undefined;
    return typeof digest === "string" && DIGEST.test(digest) ? digest : null;
  } catch {
    return null;
  }
}
