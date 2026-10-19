// The old vault routes under /v1/oma/vaults are gone (docs/plans/cleanup.md,
// 3.1). They read the legacy `vaults` and `credentials` tables, which /v1
// sessions never read, so the console "CLI" tab wrote nowhere useful.
// Vaults live under /v1/vaults only.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const API_KEY = "test-static-api-key";
const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-legacy-vaults-"));
  dirs.push(dir);
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
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
    PLATFORM_ROOT_SECRET: Buffer.alloc(32, 7).toString("base64"),
    ANTHROPIC_API_KEY: "sk-server-unused",
  })));
  created.push(cp);
  return cp;
}

function call(cp: NodeControlPlane, method: string, path: string, body?: unknown) {
  return cp.fetch(new Request(`http://cp${path}`, {
    method,
    headers: {
      "x-api-key": API_KEY,
      "anthropic-beta": "managed-agents-2026-04-01",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

describe("legacy /v1/oma/vaults routes", () => {
  it("answer 404 while /v1/vaults keeps working", async () => {
    const cp = await boot();
    const vault = await call(cp, "POST", "/v1/vaults", { display_name: "Legacy probe" });
    expect(vault.status, await vault.clone().text()).toBeLessThan(300);
    const { id } = await vault.json() as { id: string };

    // Only the list tells the removed routes apart by status. The old routes
    // looked a managed vault id up in the legacy `vaults` table and also gave
    // 404, but with "Vault not found". A body without that text proves the
    // legacy handler did not answer.
    expect((await call(cp, "GET", "/v1/oma/vaults")).status).toBe(404);
    const byId = await call(cp, "GET", `/v1/oma/vaults/${id}`);
    expect(byId.status).toBe(404);
    expect(await byId.text()).not.toContain("Vault not found");
    const credential = await call(cp, "POST", `/v1/oma/vaults/${id}/credentials`, {
      display_name: "cli",
      auth: { type: "cap_cli", cli_id: "gh", token: "unused-token" },
    });
    expect(credential.status).toBe(404);
    expect(await credential.text()).not.toContain("Vault not found");

    expect((await call(cp, "GET", "/v1/vaults")).status).toBe(200);
    expect((await call(cp, "GET", `/v1/vaults/${id}/credentials`)).status).toBe(200);
  });
});
