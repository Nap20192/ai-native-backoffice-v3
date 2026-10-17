// The environment page asks GET /v1/oma/sandbox-catalog for the image list
// (docs/plans/environments.md, 1.5). 2026-10-18: the route existed in
// lib/sandbox-catalog-routes.ts but was never mounted, so the page got 404.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const ROOT_SECRET = Buffer.alloc(32, 7).toString("base64");
const API_KEY = "test-static-api-key";
const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-sandbox-catalog-"));
  dirs.push(dir);
  const env: Record<string, string | undefined> = {
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    API_KEY,
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    PLATFORM_ROOT_SECRET: ROOT_SECRET,
  };
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig(env)));
  created.push(cp);
  return cp;
}

describe("GET /v1/oma/sandbox-catalog", () => {
  it("answers with the image list on a booted server", async () => {
    const cp = await boot();

    const response = await cp.fetch(new Request("http://cp/v1/oma/sandbox-catalog", { headers: { "x-api-key": API_KEY } }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { images?: unknown[]; templates?: unknown[] };
    expect(Array.isArray(body.images)).toBe(true);
    expect(Array.isArray(body.templates)).toBe(true);
  });

  it("needs a signed-in caller", async () => {
    const cp = await boot();

    const response = await cp.fetch(new Request("http://cp/v1/oma/sandbox-catalog"));

    expect(response.status).toBe(401);
  });
});
