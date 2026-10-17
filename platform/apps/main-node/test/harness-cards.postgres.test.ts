import { expect, it } from "vitest";
import { Hono } from "hono";
import { createPostgresSqlClient } from "@open-managed-agents/sql-client";
import { createHarnessCardStore } from "../src/lib/harness-cards/store";
import { buildHarnessCardRoutes } from "../src/lib/harness-cards/routes";
import { ensureHarnessCardSchema } from "../src/lib/harness-cards/schema";

it.skipIf(!process.env.OMA_TEST_POSTGRES_URL)("runs scoped harness CRUD, pagination and validation on Postgres", async () => {
  const sql = await createPostgresSqlClient(process.env.OMA_TEST_POSTGRES_URL!);
  const workspace = `hc_test_${crypto.randomUUID()}`;
  const other = `${workspace}_other`;
  try {
    await Promise.all([ensureHarnessCardSchema(sql), ensureHarnessCardSchema(sql)]);
    expect(Number((await sql.prepare("SELECT COUNT(*) AS n FROM harness_card_schema_migrations WHERE id = ?").bind("0001_harness_cards").first<{ n: string }>())!.n)).toBe(1);
    const store = createHarnessCardStore(sql, { now: () => 1700000000000 });
    const app = new Hono<{ Variables: { tenant_id: string; user_id: string | null } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", c.req.header("x-workspace") ?? workspace); c.set("user_id", null); await next(); });
    app.route("/cards", buildHarnessCardRoutes({ store }));
    const post = (path: string, body: unknown, ws = workspace) => app.request(path, { method: "POST", headers: { "x-workspace": ws }, body: JSON.stringify(body) });
    const input = { harness_id: "local-agent", name: "Агент 100%_", command: "agent", protocols: ["openai-chat"] };
    const created = await post("/cards", input); expect(created.status).toBe(201);
    const card = await created.json();
    expect(card.created_at).toBe("2023-11-14T22:13:20.000Z");
    expect(card).not.toHaveProperty("created_by");
    expect((await post("/cards", input)).status).toBe(409);
    expect((await post("/cards", input, other)).status).toBe(201);
    expect((await app.request(`/cards/${card.id}`, { headers: { "x-workspace": other } })).status).toBe(404);
    expect((await post(`/cards/${card.id}`, { name: "Чужой" }, other)).status).toBe(404);
    expect((await app.request(`/cards/${card.id}`, { method: "DELETE", headers: { "x-workspace": other } })).status).toBe(404);
    expect((await post(`/cards/${card.id}`, { harness_id: "new-id" })).status).toBe(400);
    expect(await (await post(`/cards/${card.id}`, { args: ["--acp"] })).json()).toMatchObject({ args: ["--acp"] });
    for (const body of [{ ...input, env: { X: "sk-test-secret" } }, { ...input, allowed_env: ["OPENAI_API_KEY"] }, { ...input, protocols: ["gemini"] }]) expect((await post("/cards", body)).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await post("/cards", { ...input, harness_id: `agent-${i}`, name: "Другой" })).status).toBe(201);
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const page = await (await app.request(`/cards?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
      ids.push(...page.data.map((c: { id: string }) => c.id)); cursor = page.next_cursor;
    } while (cursor);
    expect(ids).toHaveLength(5); expect(new Set(ids).size).toBe(5);
    expect((await (await app.request("/cards?q=%25_")).json()).data).toHaveLength(1);
    expect((await (await app.request("/cards?q=LOCAL")).json()).data).toHaveLength(1);
    expect((await app.request(`/cards/${card.id}/archive`, { method: "POST" })).status).toBe(200);
    expect(await store.findByHarnessId(workspace, input.harness_id)).toMatchObject({ archived_at: expect.any(String) });
    expect(await store.listActive(workspace)).toHaveLength(4);
    expect((await (await app.request("/cards")).json()).data).toHaveLength(4);
    expect((await (await app.request("/cards?include_archived=true")).json()).data).toHaveLength(5);
    expect((await app.request(`/cards/${card.id}`)).status).toBe(200);
    expect((await post("/cards", input)).status).toBe(409);
    expect((await app.request("/cards/missing")).status).toBe(404);
    const race = await Promise.all([post("/cards", { ...input, harness_id: "race-agent" }), post("/cards", { ...input, harness_id: "race-agent" })]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
  } finally {
    await sql.prepare("DELETE FROM harness_cards WHERE workspace_id IN (?, ?)").bind(workspace, other).run();
    await (sql as unknown as { sql: { end(options: { timeout: number }): Promise<void> } }).sql.end({ timeout: 5 });
  }
});
