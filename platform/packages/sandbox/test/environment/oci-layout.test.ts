import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOciIndexDigest } from "../../src/environment/oci-layout.js";

const DIGEST = `sha256:${"3f".repeat(32)}`;
const dirs: string[] = [];

function layout(index: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-oci-layout-"));
  dirs.push(dir);
  if (index !== undefined) {
    writeFileSync(join(dir, "index.json"), typeof index === "string" ? index : JSON.stringify(index));
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readOciIndexDigest", () => {
  it("reads the manifest digest that index.json of an OCI layout points to", async () => {
    const dir = layout({ schemaVersion: 2, manifests: [{ digest: DIGEST, size: 3344 }, { digest: `sha256:${"0".repeat(64)}` }] });
    await expect(readOciIndexDigest(dir)).resolves.toBe(DIGEST);
  });

  it("returns null for a missing, broken or unexpected index", async () => {
    for (const index of [undefined, "not json", [], { manifests: [] }, { manifests: [{ digest: "sha256:short" }] },
      { manifests: [{ digest: DIGEST.toUpperCase() }] }, { manifests: ["x"] }]) {
      await expect(readOciIndexDigest(layout(index))).resolves.toBeNull();
    }
    await expect(readOciIndexDigest(join(tmpdir(), "oma-oci-layout-missing-dir"))).resolves.toBeNull();
  });
});
