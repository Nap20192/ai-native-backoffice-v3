// Archive, restore and delete of model cards (docs/plans/crud.md, 2.8 and
// table 1.3). Agents out of the archive with the card's model_id block both
// operations, the last active card warns about ANTHROPIC_API_KEY, and the
// writes read If-Match. The routes run over the SQL repository on SQLite.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  buildModelCardRoutes,
  type ModelCardDependencyCheck,
} from "@open-managed-agents/http-routes";
import { ModelCardService, SqlModelCardRepo } from "@open-managed-agents/model-cards-store";
import { bootstrapTestDb, type TestDb } from "./_helpers/bootstrap-test-db";

const root = "/v1/oma/model_cards";
let testDb: TestDb | null = null;

afterEach(() => {
  testDb?.cleanup();
  testDb = null;
});

const agentRow = {
  kind: "agent",
  id: "agent_1",
  name: "Writer",
  status: "active",
  note: "агент работает на этой модели",
};

async function setup(blockingModel: string | null) {
  testDb = await bootstrapTestDb();
  let now = 1_790_000_000_000;
  const service = new ModelCardService({
    repo: new SqlModelCardRepo(testDb.db),
    clock: { nowMs: () => (now += 1000) },
    ids: { modelCardId: (() => { let n = 0; return () => `mdl_${++n}`; })() },
  });
  const checks: Array<{ modelId: string; operation: string }> = [];
  const dependencies: ModelCardDependencyCheck = async ({ modelId, operation }) => {
    checks.push({ modelId, operation });
    return {
      blocking: modelId === blockingModel ? [agentRow] : [],
      affected: [],
      truncated: false,
    };
  };
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", "tenant1");
    await next();
  });
  app.route(root, buildModelCardRoutes({ modelCards: service, dependencies }));
  const create = (modelId: string) => service.create({
    tenantId: "tenant1",
    modelId,
    provider: "oai-compatible",
    apiKey: "sk-test-0000",
  });
  const send = (path: string, method: string, ifMatch?: string) =>
    app.request(`${root}${path}`, {
      method,
      headers: ifMatch === undefined ? {} : { "if-match": ifMatch },
    });
  return { app, service, create, send, checks };
}

describe("model cards: archive, restore and delete", () => {
  it("archive is blocked by an agent that uses the model", async () => {
    const { create, send, checks } = await setup("busy");
    const card = await create("busy");
    const response = await send(`/${card.id}/archive`, "POST");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "dependency_conflict_error",
        dependencies: { blocking: [agentRow] },
      },
    });
    expect(checks).toEqual([{ modelId: "busy", operation: "archive" }]);
  });

  it("archive hides the card from the list, restore brings it back", async () => {
    const { app, create, send } = await setup(null);
    const card = await create("free");
    await create("other");
    const stale = await send(`/${card.id}/archive`, "POST", '"2020-01-01T00:00:00.000Z"');
    expect(stale.status).toBe(412);
    const archived = await send(`/${card.id}/archive`, "POST", `"${card.created_at}"`);
    expect(archived.status).toBe(200);
    const body = await archived.json() as { archived_at: string | null; is_default: boolean };
    expect(body.archived_at).not.toBeNull();
    const list = await (await app.request(root)).json() as { data: Array<{ id: string }> };
    expect(list.data.map((item) => item.id)).not.toContain(card.id);
    const all = await (await app.request(`${root}?include_archived=true`)).json() as { data: Array<{ id: string }> };
    expect(all.data.map((item) => item.id)).toContain(card.id);
    const restored = await send(`/${card.id}/unarchive`, "POST", archived.headers.get("etag")!);
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ archived_at: null });
  });

  it("archiving the default card clears the default", async () => {
    const { service, send } = await setup(null);
    const card = await service.create({
      tenantId: "tenant1",
      modelId: "main",
      provider: "oai-compatible",
      apiKey: "sk-test-0000",
      makeDefault: true,
    });
    await service.create({ tenantId: "tenant1", modelId: "spare", provider: "oai-compatible", apiKey: "sk-test-1111" });
    const archived = await send(`/${card.id}/archive`, "POST");
    await expect(archived.json()).resolves.toMatchObject({ is_default: false });
  });

  it("restore of a card out of the archive answers 200 and writes nothing", async () => {
    const { create, send } = await setup(null);
    const card = await create("free");
    const response = await send(`/${card.id}/unarchive`, "POST");
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe(`"${card.created_at}"`);
  });

  it("delete is blocked by an agent, checks If-Match and then removes the card", async () => {
    const { create, send } = await setup("busy");
    const busy = await create("busy");
    const free = await create("free");
    expect((await send(`/${busy.id}`, "DELETE")).status).toBe(409);
    expect((await send(`/${free.id}`, "DELETE", '"2020-01-01T00:00:00.000Z"')).status).toBe(412);
    const deleted = await send(`/${free.id}`, "DELETE", `"${free.created_at}"`);
    expect(deleted.status).toBe(200);
    expect((await send(`/${free.id}`, "DELETE")).status).toBe(404);
  });
});

describe("model cards: the last card", () => {
  it("names the server key in the report of the last active card", async () => {
    const { service } = await setup(null);
    const { modelCardDependencies } = await import("@open-managed-agents/http-routes");
    const card = await service.create({ tenantId: "tenant1", modelId: "only", provider: "oai-compatible", apiKey: "sk-1" });
    const report = await modelCardDependencies({ modelCards: service }, { tenantId: "tenant1", card, operation: "delete" });
    expect(report.affected).toEqual([expect.objectContaining({
      kind: "model_card",
      id: card.id,
      note: "Снова включится ключ ANTHROPIC_API_KEY",
    })]);
    await service.create({ tenantId: "tenant1", modelId: "second", provider: "oai-compatible", apiKey: "sk-2" });
    const later = await modelCardDependencies({ modelCards: service }, { tenantId: "tenant1", card, operation: "delete" });
    expect(later.affected).toEqual([]);
  });
});
