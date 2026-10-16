import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { createHarnessCardStore } from "../src/lib/harness-cards/store";
import { buildHarnessCardRoutes } from "../src/lib/harness-cards/routes";

const input = { harness_id: "local-agent", name: "Мой агент", command: "agent", protocols: ["openai-chat"] };

describe("harness card routes", () => {
  it("serves scoped CRUD and never accepts environment values", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const store = createHarnessCardStore(sql);
    const app = new Hono<{ Variables: { tenant_id: string; user_id: string | null } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", c.req.header("x-workspace") ?? "ws1"); c.set("user_id", "user1"); await next(); });
    app.route("/v1/oma/harness_cards", buildHarnessCardRoutes({ store }));
    const root = "/v1/oma/harness_cards";
    const post = (url: string, body: unknown, ws = "ws1") => app.request(url, { method: "POST", headers: { "content-type": "application/json", "x-workspace": ws }, body: JSON.stringify(body) });
    const created = await post(root, input);
    expect(created.status).toBe(201);
    const card = await created.json();
    expect(card).toMatchObject({ harness_id: input.harness_id, status: "unverified" });
    expect(card).not.toHaveProperty("created_by");
    expect(await sql.prepare("SELECT created_by FROM harness_cards").first()).toEqual({ created_by: "user1" });
    expect((await post(root, input)).status).toBe(409);
    expect((await app.request(`${root}/${card.id}`, { headers: { "x-workspace": "ws2" } })).status).toBe(404);
    expect((await post(`${root}/${card.id}`, { name: "Чужой" }, "ws2")).status).toBe(404);
    expect((await app.request(`${root}/${card.id}`, { method: "DELETE", headers: { "x-workspace": "ws2" } })).status).toBe(404);
    expect(await (await app.request(root, { headers: { "x-workspace": "ws2" } })).json()).toEqual({ data: [], next_cursor: null });
    expect((await post(`${root}/${card.id}`, { harness_id: input.harness_id })).status).toBe(400);
    expect(await (await post(`${root}/${card.id}`, { name: "Изменено" })).json()).toMatchObject({ name: "Изменено" });
    for (const body of [{ ...input, env: { SAFE: "sk-secret-test" } }, { ...input, allowed_env: ["MY_TOKEN"] }]) {
      const response = await post(root, body);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain("sk-secret-test");
    }
    expect(await (await app.request(`${root}/${card.id}`, { method: "DELETE" })).json()).toEqual({ type: "harness_card_deleted", id: card.id });
    expect(await store.listActive("ws1")).toEqual([]);
    expect(await (await app.request(root)).json()).toEqual({ data: [], next_cursor: null });
    expect((await app.request(`${root}/${card.id}`)).status).toBe(200);
    expect((await post(root, input)).status).toBe(409);
    expect((await app.request(`${root}?include_archived=true`)).status).toBe(200);
    expect((await post(root, input, "ws2")).status).toBe(201);
  });
  it("validates JSON, query fields and the workspace context", async () => {
    const sql = await createBetterSqlite3SqlClient(":memory:");
    const routes = buildHarnessCardRoutes({ store: createHarnessCardStore(sql) });
    expect((await routes.request("/")).status).toBe(401);
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", "ws"); await next(); });
    app.route("/cards", routes);
    expect((await app.request("/cards", { method: "POST", body: "{" })).status).toBe(400);
    for (const query of ["limit=0", "limit=101", "limit=1.5", "limit=abc", "cursor=bad", "include_archived=maybe"]) {
      expect((await app.request(`/cards?${query}`)).status).toBe(400);
    }
    expect((await app.request("/cards/missing")).status).toBe(404);
    expect((await app.request("/cards/missing", { method: "DELETE" })).status).toBe(404);
  });
  it("pages tied timestamps through HTTP and supports literal search", async () => {
    const store = createHarnessCardStore(await createBetterSqlite3SqlClient(":memory:"), { now: () => 1700000000000 });
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", "ws"); await next(); });
    app.route("/cards", buildHarnessCardRoutes({ store }));
    for (let i = 0; i < 5; i++) await store.create("ws", { ...input, harness_id: `agent-${i}`, name: i === 0 ? "100%_" : "Другой" });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await (await app.request(`/cards?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json();
      ids.push(...page.data.map((c: { id: string }) => c.id)); cursor = page.next_cursor;
    } while (cursor);
    expect(ids).toHaveLength(5); expect(new Set(ids).size).toBe(5);
    expect((await (await app.request("/cards?q=%25_")).json()).data).toHaveLength(1);
    expect((await (await app.request("/cards?q=AGENT")).json()).data).toHaveLength(5);
  });
});
