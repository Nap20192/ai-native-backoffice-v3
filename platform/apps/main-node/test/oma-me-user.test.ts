// GET /v1/oma/me identifies the signed-in user. The console shows the email
// from it, so main-node must look the user up in the auth store instead of
// answering with an empty email and name.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const BASE = "http://localhost:8080";
const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-me-"));
  dirs.push(dir);
  const config = loadNodeConfig({
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
    PUBLIC_BASE_URL: BASE,
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
  });
  const cp = await createNodeControlPlane(await nodeDefaults(config));
  created.push(cp);
  return cp;
}

function cookiesFrom(response: Response): string {
  return response.headers.getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .join("; ");
}

describe("GET /v1/oma/me on main-node", () => {
  it("returns the signed-in user's email and name", async () => {
    const cp = await boot();
    const signUp = await cp.fetch(new Request(`${BASE}/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({
        email: "ada@verify.test",
        password: "password-123456",
        name: "Ada Lovelace",
      }),
    }));
    expect(signUp.status).toBe(200);
    const cookie = cookiesFrom(signUp);
    expect(cookie).toContain("better-auth.session_token=");

    const me = await cp.fetch(new Request(`${BASE}/v1/oma/me`, { headers: { cookie } }));
    expect(me.status).toBe(200);
    const body = await me.json() as {
      user: { id: string; email: string; name: string | null };
      tenant: { id: string };
    };

    expect(body.user.id).toMatch(/\S/u);
    expect(body.user.email).toBe("ada@verify.test");
    expect(body.user.name).toBe("Ada Lovelace");
    expect(body.tenant.id).toMatch(/^tn_/u);
  });
});
