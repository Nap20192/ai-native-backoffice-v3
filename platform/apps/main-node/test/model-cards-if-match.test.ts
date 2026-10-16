// ETag and If-Match on model cards (docs/plans/builder-agent.md, 2.5 step 8,
// unit BP1). The revision is `updated_at`, for a card without edits
// `created_at`. A write with another revision gives 412 and changes nothing.
// The routes run over the real SQL repository on SQLite.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildModelCardRoutes } from "@open-managed-agents/http-routes";
import {
  ModelCardPreconditionFailedError,
  ModelCardService,
  SqlModelCardRepo,
} from "@open-managed-agents/model-cards-store";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db";

const root = "/v1/oma/model_cards";
let testDb: TestDb | null = null;

afterEach(() => {
  testDb?.cleanup();
  testDb = null;
});

async function setup(nowMs: () => number) {
  testDb = await bootstrapTestDb();
  const repo = new SqlModelCardRepo(testDb.db);
  const service = new ModelCardService({
    repo,
    clock: { nowMs },
    ids: { modelCardId: (() => { let n = 0; return () => `mdl_${++n}`; })() },
  });
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", "tenant1");
    await next();
  });
  app.route(root, buildModelCardRoutes({ modelCards: service }));
  const card = await service.create({
    tenantId: "tenant1",
    modelId: "qwen3.6-35b",
    provider: "oai-compatible",
    model: "qwen3.6-35b",
    apiKey: "sk-test-0000",
  });
  const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${root}/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { app, service, repo, card, post };
}

function ticking() {
  let now = 1_790_000_000_000;
  return () => (now += 1000);
}

describe("model cards: ETag and If-Match", () => {
  it("a card without edits has ETag from created_at, an edit moves it to updated_at", async () => {
    const { app, card, post } = await setup(ticking());
    expect(card.updated_at).toBeNull();
    const found = await app.request(`${root}/${card.id}`);
    expect(found.headers.get("etag")).toBe(`"${card.created_at}"`);

    const updated = await post(card.id, { model: "qwen3.6-35b-a3b" }, { "if-match": `"${card.created_at}"` });
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as { updated_at: string };
    expect(updated.headers.get("etag")).toBe(`"${body.updated_at}"`);
    expect((await app.request(`${root}/${card.id}`)).headers.get("etag")).toBe(`"${body.updated_at}"`);
  });

  it("a stale If-Match gives 412 and keeps the edit of the third party", async () => {
    const { app, card, post } = await setup(ticking());
    expect((await post(card.id, { model: "third-party" })).status).toBe(200);
    const response = await post(card.id, { model: "assistant" }, { "if-match": `"${card.created_at}"` });
    expect(response.status).toBe(412);
    await expect((await app.request(`${root}/${card.id}`)).json()).resolves.toMatchObject({ model: "third-party" });
  });

  it("without If-Match the route works as before", async () => {
    const { card, post } = await setup(ticking());
    const response = await post(card.id, { model: "plain" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ model: "plain" });
  });

  it("a malformed If-Match gives 400 and writes nothing", async () => {
    const { app, card, post } = await setup(ticking());
    for (const value of ['W/"x"', '"yesterday"', `"${card.created_at}", "${card.created_at}"`]) {
      expect((await post(card.id, { model: "nope" }, { "if-match": value })).status).toBe(400);
    }
    await expect((await app.request(`${root}/${card.id}`)).json()).resolves.toMatchObject({ model: "qwen3.6-35b" });
  });

  it("the repository compares inside the UPDATE, also when it makes the card default", async () => {
    const { service, repo, card } = await setup(ticking());
    const other = await service.create({
      tenantId: "tenant1",
      modelId: "other",
      provider: "oai-compatible",
      apiKey: "sk-test-1111",
      makeDefault: true,
    });
    // A third party edits the card right after the repository read it.
    class RacingRepo extends SqlModelCardRepo {
      private raced = false;
      override async get(tenantId: string, cardId: string) {
        const row = await super.get(tenantId, cardId);
        if (!this.raced) {
          this.raced = true;
          await repo.update("tenant1", card.id, { updatedAt: 1_800_000_000_000, model: "third-party" });
        }
        return row;
      }
    }
    const racing = new RacingRepo(testDb!.db);
    await expect(
      racing.update("tenant1", card.id, {
        updatedAt: 1_800_000_001_000,
        model: "assistant",
        isDefault: true,
        expectedUpdatedAt: Date.parse(card.created_at),
      }),
    ).rejects.toBeInstanceOf(ModelCardPreconditionFailedError);
    await expect(repo.get("tenant1", card.id)).resolves.toMatchObject({ model: "third-party", is_default: false });
    await expect(repo.get("tenant1", other.id)).resolves.toMatchObject({ is_default: true });
  });

  it("two writes in the same millisecond still change the revision", async () => {
    const { card, post } = await setup(() => 1_790_000_000_000);
    const first = await post(card.id, { model: "one" });
    const firstTag = first.headers.get("etag");
    expect(firstTag).not.toBe(`"${card.created_at}"`);
    expect((await post(card.id, { model: "two" }, { "if-match": `"${card.created_at}"` })).status).toBe(412);
    expect((await post(card.id, { model: "two" }, { "if-match": firstTag! })).status).toBe(200);
  });
});
