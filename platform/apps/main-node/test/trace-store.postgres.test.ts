// The trace store contract on Postgres. Runs only when OMA_TEST_POSTGRES_URL
// points at a disposable server whose user may create databases, for example:
//   docker run -d --name trace-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55439:5432 postgres:16
//   OMA_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:55439/postgres \
//     ./node_modules/.bin/vitest run --maxWorkers=2 test/trace-store.postgres.test.ts
import { describe, expect, it } from "vitest";
import { createPostgresSqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { createTraceStore } from "../src/lib/trace/store";
import { runTraceStoreContract } from "./_helpers/trace-store-contract";

const url = process.env.OMA_TEST_POSTGRES_URL;

async function end(sql: SqlClient): Promise<void> {
  await (sql as unknown as { sql: { end(options?: { timeout?: number }): Promise<void> } }).sql.end({ timeout: 5 });
}

async function withDatabase<T>(run: (sql: SqlClient) => Promise<T>): Promise<T> {
  const admin = await createPostgresSqlClient(url!);
  const name = `trace_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sql: SqlClient | undefined;
  try {
    await admin.exec(`CREATE DATABASE ${name}`);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    sql = await createPostgresSqlClient(target.toString());
    return await run(sql);
  } finally {
    if (sql !== undefined) await end(sql);
    await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await end(admin);
  }
}

describe.skipIf(!url)("trace store on Postgres", () => {
  it("passes the store contract", async () => {
    await withDatabase((sql) => runTraceStoreContract(async () => ({ sql, dialect: "postgres" })));
  });

  it("creates the tables on first access, twice from two clients", async () => {
    await withDatabase(async (sql) => {
      const first = createTraceStore({ sql, dialect: "postgres" });
      await Promise.all([first.ensureSchema(), first.readTurns({ workspaceId: "ws", sessionId: "s" })]);
      const columns = await sql.prepare(
        "SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = 'trace_spans' AND column_name IN ('start_ms', 'event_ids')",
      ).all<{ name: string; type: string }>();
      expect(Object.fromEntries((columns.results ?? []).map((row) => [row.name, row.type]))).toEqual({ start_ms: "bigint", event_ids: "text" });
    });
  });
});
