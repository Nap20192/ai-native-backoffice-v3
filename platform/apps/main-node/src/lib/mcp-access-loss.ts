import {
  createAccessLossRuntime,
  type AccessLossRuntime,
} from "@open-managed-agents/mcp-access-loss";
import type { SqlClient } from "@open-managed-agents/sql-client";

/**
 * Node managed-MCP access-loss runtime. Its tables live in the control-plane
 * database. With no provider catalog (docs/plans/cleanup.md, 5.1) it only
 * records a reauthorization request after a refresh that failed with
 * `invalid_grant`; an effect is idempotent, so a repeated result does not error.
 */
export async function createNodeAccessLossRuntime(sql: SqlClient): Promise<AccessLossRuntime> {
  const runtime = createAccessLossRuntime({
    tenantSql: sql,
    integrationsSql: sql,
  });
  await runtime.prepare();
  return runtime;
}
