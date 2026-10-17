// `config.image` of a cloud Environment reaches the sandbox factory as the
// catalog image (docs/plans/environments.md, 1.5-1.6): the OCI layout, the
// verified digest, the resources and the shell. An environment without it
// keeps the server image; an unknown image fails the session by name before
// any sandbox exists.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxFactory, SandboxFactoryContext } from "@open-managed-agents/sandbox";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DIGEST = `sha256:${"3f".repeat(32)}`;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-env-image-"));
  dirs.push(dir);
  return dir;
}

/** catalog.json with a built `workplace` OCI layout in its image dir. */
function imageCatalog(): { catalogPath: string; imageDir: string } {
  const imageDir = tempDir();
  mkdirSync(join(imageDir, "workplace-2026.10.1"));
  writeFileSync(join(imageDir, "workplace-2026.10.1", "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ digest: DIGEST }] }));
  writeFileSync(join(imageDir, "workplace-2026.10.1.manifest.json"), JSON.stringify({ image_digest: DIGEST, shell: "/bin/bash" }));
  const catalogPath = join(imageDir, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify({
    default_image: "workplace",
    images: { workplace: { label: "Рабочее место агента", oci_dir: "workplace-2026.10.1", disk_gb: 6, memory_mib: 1024, cpus: 2 } },
  }));
  return { catalogPath, imageDir };
}

const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
const request = (method: string, body?: unknown) => ({
  method,
  headers: { "content-type": "application/json", ...beta },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

interface Started {
  cp: NodeControlPlane;
  sessionId: string;
  context: Promise<SandboxFactoryContext>;
}

async function startSession(config: unknown, catalogPath: string, imageDir: string): Promise<Started> {
  let resolveContext!: (ctx: SandboxFactoryContext) => void;
  const context = new Promise<SandboxFactoryContext>((resolve) => { resolveContext = resolve; });
  const sandbox: SandboxFactory = async (ctx) => {
    resolveContext(ctx);
    throw new Error("the test only inspects the factory context");
  };
  const dir = tempDir();
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
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
    ANTHROPIC_API_KEY: "unused",
    SANDBOX_IMAGE_CATALOG: catalogPath,
    SANDBOX_IMAGE_DIR: imageDir,
  }), { sandbox }));
  created.push(cp);
  const json = async (path: string, method: string, body?: unknown) =>
    await (await cp.fetch(new Request(`http://cp${path}`, request(method, body)))).json() as { id: string };
  const env = await json("/v1/environments", "POST", { name: "env-image", config });
  const agent = await json("/v1/agents", "POST", { name: "env-image-agent", model: "claude-sonnet-4-6", system: "hi" });
  const session = await json("/v1/sessions", "POST", { agent: agent.id, environment_id: env.id });
  const sent = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/events`, request("POST", {
    events: [{ type: "user.message", content: [{ type: "text", text: "run" }] }],
  })));
  expect(sent.status).toBe(200);
  return { cp, sessionId: session.id, context };
}

async function within<T>(promise: Promise<T>, ms = 10_000): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

describe("managed runner boots the catalog image of the Environment", () => {
  it("hands the catalog image of config.image to the sandbox factory", async () => {
    const { catalogPath, imageDir } = imageCatalog();
    const { context } = await startSession({
      type: "cloud",
      image: "workplace",
      networking: { type: "limited", allowed_hosts: [], allow_package_managers: true, allow_mcp_servers: false },
    }, catalogPath, imageDir);
    const ctx = await within(context);
    expect(ctx).not.toBe("timeout");
    expect((ctx as SandboxFactoryContext).environment?.image).toEqual({
      key: "workplace",
      source: { type: "oci", dir: join(imageDir, "workplace-2026.10.1") },
      digest: DIGEST,
      manifestSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      manifest: { image_digest: DIGEST, shell: "/bin/bash" },
      resources: { diskGb: 6, memoryMib: 1024, cpus: 2 },
      shell: "bash",
    });
  });

  it("keeps the server image for an environment without config.image", async () => {
    const { catalogPath, imageDir } = imageCatalog();
    const { context } = await startSession({ type: "cloud", networking: { type: "unrestricted" } }, catalogPath, imageDir);
    const ctx = await within(context);
    expect(ctx).not.toBe("timeout");
    expect((ctx as SandboxFactoryContext).environment).toEqual({
      packages: expect.anything(),
      networking: { type: "unrestricted" },
    });
  });

  it("fails the session with the image name and creates no sandbox for an unknown image", async () => {
    const { catalogPath, imageDir } = imageCatalog();
    const { cp, sessionId, context } = await startSession({ type: "cloud", image: "nope" }, catalogPath, imageDir);
    const deadline = Date.now() + 20_000;
    let error: unknown;
    while (error === undefined && Date.now() < deadline) {
      const page = await (await cp.fetch(new Request(`http://cp/v1/sessions/${sessionId}/events?limit=100`, request("GET")))).json() as {
        data: Array<{ type: string }>;
      };
      error = page.data.find((event) => event.type === "session.error");
      if (error === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(JSON.stringify(error)).toContain("Образ песочницы «nope» не найден в каталоге образов");
    await expect(within(context, 200)).resolves.toBe("timeout");
  });
});
