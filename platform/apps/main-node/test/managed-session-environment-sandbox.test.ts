// The managed runner must hand the session's cloud Environment (packages and
// networking) to the sandbox factory. Without it a VM adapter such as LiteBox
// cannot install the environment's packages or apply limited networking.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxFactory, SandboxFactoryContext } from "@open-managed-agents/sandbox";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults, type NodeComponentOverrides } from "../src/components";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function controlPlane(overrides: NodeComponentOverrides): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-env-sandbox-"));
  dirs.push(dir);
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
  }), overrides));
  created.push(cp);
  return cp;
}

const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...beta },
  body: JSON.stringify(body),
});

async function sandboxContextFor(config: unknown): Promise<SandboxFactoryContext> {
  let resolveContext!: (ctx: SandboxFactoryContext) => void;
  const seen = new Promise<SandboxFactoryContext>((resolve) => { resolveContext = resolve; });
  const sandbox: SandboxFactory = async (ctx) => {
    resolveContext(ctx);
    throw new Error("the test only inspects the factory context");
  };
  const cp = await controlPlane({ sandbox });
  const env = await (await cp.fetch(new Request("http://cp/v1/environments", post({
    name: "env-sandbox", config,
  })))).json() as { id: string };
  const agent = await (await cp.fetch(new Request("http://cp/v1/agents", post({
    name: "env-sandbox-agent", model: "claude-sonnet-4-6", system: "hi",
  })))).json() as { id: string };
  const session = await (await cp.fetch(new Request("http://cp/v1/sessions", post({
    agent: agent.id, environment_id: env.id,
  })))).json() as { id: string };
  const sent = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/events`, post({
    events: [{ type: "user.message", content: [{ type: "text", text: "run" }] }],
  })));
  expect(sent.status).toBe(200);
  const ctx = await Promise.race([
    seen,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
  ]);
  expect(ctx).not.toBe("timeout");
  return ctx as SandboxFactoryContext;
}

describe("managed runner passes the cloud Environment to the sandbox factory", () => {
  it("hands over packages and limited networking", async () => {
    const ctx = await sandboxContextFor({
      type: "cloud",
      packages: { apt: ["jq"], pip: ["requests==2.32.3"] },
      networking: {
        type: "limited",
        allowed_hosts: ["example.org"],
        allow_package_managers: true,
        allow_mcp_servers: false,
      },
    });

    expect(ctx.environment?.packages).toMatchObject({ apt: ["jq"], pip: ["requests==2.32.3"] });
    expect(ctx.environment?.networking).toEqual({
      type: "limited",
      allowedHosts: ["example.org"],
      allowPackageManagers: true,
      allowMcpServers: false,
    });
  });

  it("hands over unrestricted networking", async () => {
    const ctx = await sandboxContextFor({
      type: "cloud",
      networking: { type: "unrestricted" },
    });

    expect(ctx.environment?.networking).toEqual({ type: "unrestricted" });
  });
});
