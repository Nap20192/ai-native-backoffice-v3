// Official Session turns on a PostgreSQL control plane: the background
// execution poller must claim accepted input, and an interrupt must cancel
// it. PostgreSQL rejects a placeholder used only as `? IS NULL` (42P18), which
// broke both the claim and the interrupt statements.
//
// Runs only when OMA_TEST_POSTGRES_URL points at a disposable server whose
// user may create databases, for example:
//   docker run -d --name oma-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55433:5432 postgres:16
//   OMA_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     pnpm --filter @open-managed-agents/main-node exec vitest run --maxWorkers=2 \
//     test/managed-session-execution.postgres.test.ts

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxFactory } from "@open-managed-agents/sandbox";
import { createPostgresSqlClient } from "@open-managed-agents/sql-client";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";

const baseUrl = process.env.OMA_TEST_POSTGRES_URL;
const created: NodeControlPlane[] = [];
const dirs: string[] = [];
const databases: string[] = [];
const urls: string[] = [];

async function admin<T>(run: (sql: Awaited<ReturnType<typeof createPostgresSqlClient>>) => Promise<T>): Promise<T> {
  const sql = await createPostgresSqlClient(baseUrl!);
  try {
    return await run(sql);
  } finally {
    await (sql as unknown as { sql: { end(options?: { timeout?: number }): Promise<void> } })
      .sql.end({ timeout: 5 });
  }
}

// cp.stop() interrupts only the execution poller: a turn that is still
// settling would be cut by DROP DATABASE … WITH (FORCE) and log a level-50
// `session_execution.settle outcome=error`. Wait until every execution row
// of the test database is settled first.
async function waitForSettledExecutions(url: string): Promise<void> {
  const sql = await createPostgresSqlClient(url);
  try {
    for (let i = 0; i < 150; i += 1) {
      const row = await sql
        .prepare("SELECT COUNT(*) AS n FROM managed_session_executions WHERE settled_at_ms IS NULL")
        .first<{ n: number | string }>();
      if (Number(row?.n ?? 0) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`executions of ${url} did not settle within 15 s`);
  } finally {
    await (sql as unknown as { sql: { end(options?: { timeout?: number }): Promise<void> } })
      .sql.end({ timeout: 5 });
  }
}

afterEach(async () => {
  const settled = await Promise.allSettled(urls.splice(0).map(waitForSettledExecutions));
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  const names = databases.splice(0);
  if (names.length > 0) {
    await admin(async (sql) => {
      for (const name of names) await sql.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    });
  }
  for (const result of settled) if (result.status === "rejected") throw result.reason;
});

async function postgresControlPlane(sandbox: SandboxFactory): Promise<NodeControlPlane> {
  const name = `oma_exec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin((sql) => sql.exec(`CREATE DATABASE ${name}`));
  databases.push(name);
  const url = new URL(baseUrl!);
  url.pathname = `/${name}`;
  urls.push(url.toString());
  const dir = mkdtempSync(join(tmpdir(), "oma-exec-pg-"));
  dirs.push(dir);
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    DATABASE_URL: url.toString(),
    MEMORY_QUEUE: "disabled",
    AUTH_DATABASE_PATH: join(dir, "unused-auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    ANTHROPIC_API_KEY: "unused",
  }), { sandbox }));
  created.push(cp);
  return cp;
}

const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...beta },
  body: JSON.stringify(body),
});

describe.skipIf(baseUrl === undefined)("official Session execution on PostgreSQL", () => {
  it("claims an accepted turn in the background and accepts an interrupt", async () => {
    const calls: string[] = [];
    const sandbox: SandboxFactory = async (ctx) => {
      calls.push(ctx.sessionId);
      throw new Error("injected sandbox factory was called");
    };
    const cp = await postgresControlPlane(sandbox);
    const env = await (await cp.fetch(new Request("http://cp/v1/environments", post({
      name: "pg-env", config: { type: "cloud", networking: { type: "unrestricted" } },
    })))).json() as { id: string };
    const agent = await (await cp.fetch(new Request("http://cp/v1/agents", post({
      name: "pg-agent", model: "claude-sonnet-4-6", system: "hi",
    })))).json() as { id: string };
    const session = await (await cp.fetch(new Request("http://cp/v1/sessions", post({
      agent: agent.id, environment_id: env.id,
    })))).json() as { id: string };
    expect(session.id).toMatch(/^session_/);

    await cp.start();
    const sent = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/events`, post({
      events: [{ type: "user.message", content: [{ type: "text", text: "ping" }] }],
    })));
    expect(sent.status).toBe(200);

    for (let i = 0; i < 150 && calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(calls).toContain(session.id);

    const interrupted = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/events`, post({
      events: [{ type: "user.interrupt" }],
    })));
    expect(interrupted.status).toBe(200);
  });
});
