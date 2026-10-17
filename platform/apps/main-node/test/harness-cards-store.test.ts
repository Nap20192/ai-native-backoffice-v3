import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { createHarnessCardStore } from "../src/lib/harness-cards/store";

const input = { harness_id: "local-agent", name: "Мой агент", command: "agent", protocols: ["openai-chat"] };

describe("harness card store", () => {
  it("creates, updates, archives and scopes every lookup", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    let time = 1700000000000;
    const store = createHarnessCardStore(sql, { now: () => time, ids: () => "hcard_1234567890123456" });
    const card = await store.create("ws1", input, "user1");
    expect(card).toMatchObject({ id: "hcard_1234567890123456", status: "unverified", archived_at: null, created_at: new Date(time).toISOString() });
    expect(card).not.toHaveProperty("created_by");
    expect(await sql.prepare("SELECT created_by FROM harness_cards").first()).toEqual({ created_by: "user1" });
    expect(await store.get("ws2", card.id)).toBeNull();
    expect(await store.findByHarnessId("ws2", input.harness_id)).toBeNull();
    await expect(store.update("ws2", card.id, { name: "Чужой" })).rejects.toMatchObject({ status: 404 });
    await expect(store.archive("ws2", card.id)).rejects.toMatchObject({ status: 404 });
    time += 1000;
    const updated = await store.update("ws1", card.id, { name: "Новое имя", args: ["--acp"] });
    expect(updated).toMatchObject({ name: "Новое имя", command: "agent", args: ["--acp"], updated_at: new Date(time).toISOString() });
    await store.archive("ws1", card.id);
    expect(await store.listActive("ws1")).toEqual([]);
    expect((await store.list("ws1")).data).toEqual([]);
    expect((await store.list("ws1", { include_archived: true })).data).toHaveLength(1);
    // The revision always moves: the archive in the same millisecond as the edit lands 1 ms later.
    expect(await store.findByHarnessId("ws1", input.harness_id)).toMatchObject({ archived_at: new Date(time + 1).toISOString() });
    await expect(store.create("ws1", input)).rejects.toMatchObject({ status: 409, field: "harness_id" });
  });
  it("paginates tied timestamps and escapes search wildcard characters", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    let sequence = 0;
    const store = createHarnessCardStore(sql, { now: () => 1700000000000, ids: () => `hcard_${String(++sequence).padStart(16, "0")}` });
    for (let i = 0; i < 5; i++) await store.create("ws", { ...input, harness_id: `local-${i}`, name: i === 0 ? "Агент 100%_\\" : "ДРУГОЙ" });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list("ws", { limit: 2, cursor });
      seen.push(...page.data.map((card) => card.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort().reverse());
    expect((await store.list("ws", { q: "%_\\" })).data).toHaveLength(1);
    expect((await store.list("ws", { q: "LOCAL-" })).data).toHaveLength(5);
    await expect(store.list("ws", { cursor: "bad" })).rejects.toMatchObject({ status: 400, field: "cursor" });
    expect((await store.list("other")).data).toEqual([]);
  });
  it("maps a concurrent unique-index collision to 409", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createHarnessCardStore(sql);
    const results = await Promise.allSettled([store.create("ws", input), store.create("ws", input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await store.create("other", input)).toMatchObject({ harness_id: input.harness_id });
  });
  it("validates direct writes before persistence", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createHarnessCardStore(sql);
    await expect(store.create("ws", { ...input, env: { X: "sk-secret-test" } })).rejects.toMatchObject({ status: 400, field: "env" });
    expect((await store.list("ws")).data).toEqual([]);
  });
});
