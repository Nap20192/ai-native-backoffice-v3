import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { createTraceProjector } from "../src/lib/trace/projector";
import { createTraceStore } from "../src/lib/trace/store";
import type { TraceOp } from "../src/lib/trace/types";
import { count, runTraceStoreContract } from "./_helpers/trace-store-contract";

describe("trace store on SQLite", () => {
  it("passes the store contract", async () => {
    await runTraceStoreContract(async () => ({ sql: await createBetterSqlite3SqlClient(":memory:"), dialect: "sqlite" }));
  });

  it("creates its tables on first access and records the migration", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createTraceStore({ sql, dialect: "sqlite" });
    expect(await store.readTurns({ workspaceId: "ws", sessionId: "s" })).toEqual([]);
    const migrations = await sql.prepare("SELECT id FROM trace_schema_migrations ORDER BY id").all<{ id: string }>();
    expect(migrations.results?.map((row) => row.id)).toEqual(["0001_trace_spans_turns"]);
  });

  it("refuses spans of a turn nobody claimed", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createTraceStore({ sql, dialect: "sqlite" });
    const ops: TraceOp[] = createTraceProjector({ sessionId: "s", harness: "pi" })
      .push({ kind: "execution_started", atMs: 1, events: [{ type: "user.message", id: "u1" }] })
      .filter((op) => op.op !== "claim");
    const result = await store.apply({ workspaceId: "ws", sessionId: "s" }, { turnId: "u1", attemptId: null, ops });
    expect(result.fenced).toBe(true);
    expect(await count(sql, "trace_spans")).toBe(0);
  });
});
