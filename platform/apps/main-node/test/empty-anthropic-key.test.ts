// `.env` templates often carry `ANTHROPIC_API_KEY=` with no value. An empty
// value means "not configured" (model cards supply credentials), so it must
// not reach adapters that reject an empty key and abort startup.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("empty Anthropic model settings", () => {
  it("treats empty ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL as unset", () => {
    const config = loadNodeConfig({
      NODE_ENV: "test",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "  ",
    });
    expect(config.model.apiKey).toBeUndefined();
    expect(config.model.baseUrl).toBeUndefined();
    expect(loadNodeConfig({ NODE_ENV: "test", ANTHROPIC_API_KEY: "sk-set" }).model.apiKey)
      .toBe("sk-set");
  });

  it("assembles the control plane when ANTHROPIC_API_KEY is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-empty-key-"));
    dirs.push(dir);
    const config = loadNodeConfig({
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
      ANTHROPIC_API_KEY: "",
    });
    const cp = await createNodeControlPlane(await nodeDefaults(config));
    created.push(cp);
    const health = await cp.fetch(new Request("http://cp/health"));
    expect(health.status).toBe(200);
  });
});
