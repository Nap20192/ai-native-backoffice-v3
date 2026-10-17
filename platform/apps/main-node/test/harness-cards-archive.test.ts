// Archive, restore and delete of harness cards (docs/plans/crud.md, 2.8 and
// table 1.3). Archive looks at agents out of the archive, delete at every
// version of every agent; both read If-Match.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { createHarnessCardStore } from "../src/lib/harness-cards/store";
import {
  buildHarnessCardRoutes,
  type HarnessCardDependencyCheck,
} from "../src/lib/harness-cards/routes";

const input = { harness_id: "local-agent", name: "Мой агент", command: "agent", protocols: ["openai-chat"] };
const root = "/v1/oma/harness_cards";
const agentRow = { kind: "agent", id: "agent_1", name: "Old", status: "archived", note: "агент в архиве, его ход читает карточку" };

async function setup(blockingOn: "archive" | "delete" | null) {
  let time = 1_700_000_000_000;
  const store = createHarnessCardStore(await createBetterSqlite3SqlClient(":memory:"), { now: () => (time += 1000) });
  const checks: Array<{ harnessId: string; operation: string }> = [];
  const dependencies: HarnessCardDependencyCheck = async ({ harnessId, operation }) => {
    checks.push({ harnessId, operation });
    return { blocking: operation === blockingOn ? [agentRow] : [], affected: [], truncated: false };
  };
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => { c.set("tenant_id", "ws1"); await next(); });
  app.route(root, buildHarnessCardRoutes({ store, dependencies }));
  const card = await store.create("ws1", input);
  const send = (path: string, method: string, ifMatch?: string) =>
    app.request(`${root}${path}`, { method, headers: ifMatch === undefined ? {} : { "if-match": ifMatch } });
  return { store, card, send, checks };
}

describe("harness cards: archive, restore and delete", () => {
  it("archive is blocked by agents and then hides the card from the catalog", async () => {
    const blocked = await setup("archive");
    const response = await blocked.send(`/${blocked.card.id}/archive`, "POST");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "dependency_conflict_error", dependencies: { blocking: [agentRow] } },
    });
    expect(blocked.checks).toEqual([{ harnessId: "local-agent", operation: "archive" }]);

    const free = await setup(null);
    expect((await free.send(`/${free.card.id}/archive`, "POST", '"2020-01-01T00:00:00.000Z"')).status).toBe(412);
    const archived = await free.send(`/${free.card.id}/archive`, "POST", `"${free.card.updated_at}"`);
    expect(archived.status).toBe(200);
    expect(await free.store.listActive("ws1")).toEqual([]);
    const restored = await free.send(`/${free.card.id}/unarchive`, "POST", archived.headers.get("etag")!);
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({ archived_at: null });
    expect(await free.store.listActive("ws1")).toHaveLength(1);
  });

  it("restore of a card out of the archive answers 200", async () => {
    const { card, send } = await setup(null);
    const response = await send(`/${card.id}/unarchive`, "POST");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: card.id, updated_at: card.updated_at });
  });

  it("delete is blocked by any agent version and then removes the row", async () => {
    const blocked = await setup("delete");
    expect((await blocked.send(`/${blocked.card.id}`, "DELETE")).status).toBe(409);
    expect(await blocked.store.get("ws1", blocked.card.id)).not.toBeNull();

    const free = await setup(null);
    expect((await free.send(`/${free.card.id}`, "DELETE", '"2020-01-01T00:00:00.000Z"')).status).toBe(412);
    const deleted = await free.send(`/${free.card.id}`, "DELETE", `"${free.card.updated_at}"`);
    expect(deleted.status).toBe(200);
    expect(await free.store.get("ws1", free.card.id)).toBeNull();
    expect(await free.store.findByHarnessId("ws1", "local-agent")).toBeNull();
    expect((await free.send(`/${free.card.id}`, "DELETE")).status).toBe(404);
  });
});
