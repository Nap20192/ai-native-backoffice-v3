// ETag and If-Match on harness cards (docs/plans/builder-agent.md, 2.5 step 8,
// unit BP1). The revision is `updated_at`. A write with another revision gives
// 412 and changes nothing. Without the header the route works as before.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { createHarnessCardStore } from "../src/lib/harness-cards/store";
import { buildHarnessCardRoutes } from "../src/lib/harness-cards/routes";
import { HarnessCardError } from "../src/lib/harness-cards/types";

const input = { harness_id: "local-agent", name: "Мой агент", command: "agent", protocols: ["openai-chat"] };
const root = "/v1/oma/harness_cards";

async function setup(clock: () => number = (() => {
  let now = 1_790_000_000_000;
  return () => (now += 1000);
})()) {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  const store = createHarnessCardStore(sql, { now: clock });
  const app = new Hono<{ Variables: { tenant_id: string; user_id: string | null } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", "ws1");
    c.set("user_id", "user1");
    await next();
  });
  app.route(root, buildHarnessCardRoutes({ store }));
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const created = await post(root, input);
  const card = (await created.json()) as { id: string; updated_at: string };
  return { app, store, post, created, card };
}

describe("harness cards: ETag and If-Match", () => {
  it("create, get and update answer with ETag from updated_at", async () => {
    const { app, post, created, card } = await setup();
    expect(created.headers.get("etag")).toBe(`"${card.updated_at}"`);
    const found = await app.request(`${root}/${card.id}`);
    expect(found.headers.get("etag")).toBe(`"${card.updated_at}"`);
    const updated = await post(`${root}/${card.id}`, { name: "Новое имя" });
    const body = (await updated.json()) as { updated_at: string };
    expect(updated.headers.get("etag")).toBe(`"${body.updated_at}"`);
    expect(body.updated_at).not.toBe(card.updated_at);
  });

  it("a matching If-Match writes and returns the next ETag", async () => {
    const { post, card } = await setup();
    const response = await post(`${root}/${card.id}`, { name: "Своё" }, { "if-match": `"${card.updated_at}"` });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ name: "Своё" });
    expect(response.headers.get("etag")).not.toBe(`"${card.updated_at}"`);
  });

  it("If-Match without quotes is accepted", async () => {
    const { post, card } = await setup();
    const response = await post(`${root}/${card.id}`, { name: "Своё" }, { "if-match": card.updated_at });
    expect(response.status).toBe(200);
  });

  it("a stale If-Match gives 412 and keeps the edit of the third party", async () => {
    const { app, post, card } = await setup();
    expect((await post(`${root}/${card.id}`, { name: "Третье лицо" })).status).toBe(200);
    const response = await post(`${root}/${card.id}`, { name: "Ассистент" }, { "if-match": `"${card.updated_at}"` });
    expect(response.status).toBe(412);
    const after = await (await app.request(`${root}/${card.id}`)).json();
    expect(after).toMatchObject({ name: "Третье лицо" });
  });

  it("a malformed If-Match gives 400 and writes nothing", async () => {
    const { app, post, card } = await setup();
    for (const value of ['W/"x"', '"yesterday"', `"${card.updated_at}", "${card.updated_at}"`]) {
      const response = await post(`${root}/${card.id}`, { name: "Нет" }, { "if-match": value });
      expect(response.status).toBe(400);
    }
    const after = await (await app.request(`${root}/${card.id}`)).json();
    expect(after).toMatchObject({ name: input.name, updated_at: card.updated_at });
  });

  it("the store compares inside the UPDATE: an edit after its read wins", async () => {
    const { store, card } = await setup();
    await store.update("ws1", card.id, { name: "Третье лицо" });
    await expect(
      store.update("ws1", card.id, { name: "Ассистент" }, { expectedUpdatedAt: card.updated_at }),
    ).rejects.toMatchObject({ status: 412 });
    await expect(store.get("ws1", card.id)).resolves.toMatchObject({ name: "Третье лицо" });
    await expect(
      store.update("ws1", card.id, { name: "Ассистент" }, { expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(HarnessCardError);
  });

  it("two writes in the same millisecond still change the revision", async () => {
    const { post, card } = await setup(() => 1_790_000_000_000);
    const first = await post(`${root}/${card.id}`, { name: "Раз" });
    expect(first.headers.get("etag")).not.toBe(`"${card.updated_at}"`);
    const second = await post(`${root}/${card.id}`, { name: "Два" }, { "if-match": card.updated_at });
    expect(second.status).toBe(412);
  });
});
