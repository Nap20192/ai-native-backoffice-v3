// Stores of the platform MCP server on Postgres. Skipped without OMA_TEST_POSTGRES_URL.

import { it } from "vitest";
import { createPostgresSqlClient } from "@open-managed-agents/sql-client";
import { cleanupStores, runStoreContract } from "./helpers/platform-mcp-stores-contract";

it.skipIf(!process.env.OMA_TEST_POSTGRES_URL)("passes the store contract on Postgres", async () => {
  const sql = await createPostgresSqlClient(process.env.OMA_TEST_POSTGRES_URL!);
  const ws = `pmcp_${crypto.randomUUID()}`;
  try {
    await runStoreContract(sql, ws);
  } finally {
    await cleanupStores(sql, ws);
    await (sql as unknown as { sql: { end(options: { timeout: number }): Promise<void> } }).sql.end({ timeout: 5 });
  }
});
