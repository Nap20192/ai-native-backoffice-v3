// SqlSessionExecutionCoordinator against a real PostgreSQL server.
//
// PostgreSQL infers parameter types at parse time and rejects a placeholder
// whose only use is `? IS NULL` (42P18, "could not determine data type of
// parameter $1"); SQLite accepts it. The background execution claim used
// that shape and failed on every poll.
//
// Runs only when OMA_TEST_POSTGRES_URL points at a disposable database, for
// example:
//   docker run -d --name oma-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:55433:5432 postgres:16
//   OMA_TEST_POSTGRES_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     pnpm --filter @open-managed-agents/session-runtime-sql exec vitest run --maxWorkers=2

import { afterAll, describe, expect, it } from "vitest";
import {
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import {
  ensureSessionExecutionCoordinatorSchema,
  SqlSessionExecutionCoordinator,
} from "../src/coordination";
import { sessionExecutionStoreConformance } from
  "../../session-runtime-contract/test/execution-store-conformance";

const url = process.env.OMA_TEST_POSTGRES_URL;
const clients: SqlClient[] = [];

async function freshDatabase(): Promise<SqlClient> {
  const sql = await createPostgresSqlClient(url!);
  clients.push(sql);
  await sql.exec(
    "DROP TABLE IF EXISTS managed_session_executions, managed_session_claim_locks",
  );
  await ensureSessionExecutionCoordinatorSchema(sql);
  return sql;
}

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) =>
    (client as unknown as { sql: { end(options?: { timeout?: number }): Promise<void> } })
      .sql.end({ timeout: 5 })));
});

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 8, 4, 0, 0, seconds)).toISOString();

describe.skipIf(url === undefined)("SqlSessionExecutionCoordinator on PostgreSQL", () => {
  it("claims queued work with and without workspace, session, and lane filters", async () => {
    const sql = await freshDatabase();
    const coordinator = new SqlSessionExecutionCoordinator(sql);
    const admit = (id: string, sessionId: string, seconds: number, laneId?: string) =>
      coordinator.admit({
        execution: {
          id,
          workspaceId: "workspace_01",
          sessionId,
          ...(laneId !== undefined && { laneId }),
          admittedAt: at(seconds),
          events: [{
            id,
            type: "user.message",
            content: [{ type: "text", text: id }],
            processedAt: at(seconds),
          }],
        },
      });
    await admit("a1", "session_a", 1);
    await admit("b1", "session_b", 2, "sthr_sibling");

    await expect(coordinator.claim({
      ownerId: "owner_1",
      attemptId: "attempt_1",
      claimedAt: at(3),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({ type: "claimed", execution: { id: "a1" } });
    await expect(coordinator.claim({
      workspaceId: "workspace_01",
      sessionId: "session_b",
      laneId: "sthr_sibling",
      ownerId: "owner_1",
      attemptId: "attempt_2",
      claimedAt: at(4),
      leaseTtlMs: 30_000,
    })).resolves.toMatchObject({ type: "claimed", execution: { id: "b1" } });
    await expect(coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_a",
      requestedAt: at(5),
    })).resolves.toEqual({ type: "requested" });
    await expect(coordinator.requestInterrupt({
      workspaceId: "workspace_01",
      sessionId: "session_b",
      laneId: "sthr_sibling",
      requestedAt: at(5),
    })).resolves.toEqual({ type: "requested" });
  });
});

if (url !== undefined) {
  sessionExecutionStoreConformance("postgres", {
    async withStore(_fixtureId, run) {
      const sql = await freshDatabase();
      return run(new SqlSessionExecutionCoordinator(sql));
    },
  });
}
