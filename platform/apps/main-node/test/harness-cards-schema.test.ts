import { describe, expect, it, vi } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureHarnessCardSchema } from "../src/lib/harness-cards/schema";

describe("harness card schema", () => {
  it("creates lazily and records the migration once under concurrent calls", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    await Promise.all([ensureHarnessCardSchema(sql), ensureHarnessCardSchema(sql)]);
    await ensureHarnessCardSchema(sql);
    expect((await sql.prepare("SELECT id FROM harness_card_schema_migrations").all()).results).toEqual([{ id: "0001_harness_cards" }]);
    expect(await sql.prepare("SELECT * FROM harness_cards").all()).toMatchObject({ results: [] });
  });
  it("retries after a failed migration", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const exec = vi.spyOn(sql, "exec").mockRejectedValueOnce(new Error("temporary"));
    await expect(ensureHarnessCardSchema(sql)).rejects.toThrow("temporary");
    await ensureHarnessCardSchema(sql);
    expect(exec.mock.calls.length).toBeGreaterThan(1);
  });
});
