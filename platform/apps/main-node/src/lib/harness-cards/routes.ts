// API /v1/oma/harness_cards (docs/plans/models-harness.md, 3.6).
// Errors come back as {"error": "<текст>", "field": "<поле>" | null}.
import { Hono, type Context } from "hono";
import type { HarnessCardStore } from "./store.js";
import { HarnessCardError, isHarnessCardError, type HarnessCardListOptions } from "./types.js";

export interface HarnessCardRoutesDeps {
  store: HarnessCardStore;
}

type Variables = { tenant_id?: string; user_id?: string | null };

export function buildHarnessCardRoutes(deps: HarnessCardRoutesDeps): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.onError((error, c) => {
    if (isHarnessCardError(error)) {
      return c.json({ error: error.message, field: error.field }, error.status);
    }
    throw error;
  });

  app.use("*", async (c, next) => {
    if (!workspaceOf(c)) return c.json({ error: "Нужен вход в рабочее пространство", field: null }, 401);
    return next();
  });

  app.get("/", async (c) => {
    return c.json(await deps.store.list(workspaceOf(c)!, listOptions(c)), 200);
  });

  app.post("/", async (c) => {
    const body = await jsonBody(c);
    const card = await deps.store.create(workspaceOf(c)!, body, c.get("user_id") ?? null);
    return c.json(card, 201);
  });

  app.get("/:id", async (c) => {
    const card = await deps.store.get(workspaceOf(c)!, c.req.param("id"));
    if (card === null) throw new HarnessCardError(404, "Harness не найден");
    return c.json(card, 200);
  });

  app.post("/:id", async (c) => {
    const body = await jsonBody(c);
    return c.json(await deps.store.update(workspaceOf(c)!, c.req.param("id"), body), 200);
  });

  app.delete("/:id", async (c) => {
    const card = await deps.store.archive(workspaceOf(c)!, c.req.param("id"));
    return c.json({ type: "harness_card_deleted", id: card.id }, 200);
  });

  return app;
}

function workspaceOf(c: Context): string | null {
  const workspaceId = (c.var as Variables).tenant_id;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : null;
}

async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HarnessCardError(400, "Тело запроса должно быть JSON");
  }
}

function listOptions(c: Context): HarnessCardListOptions {
  const options: HarnessCardListOptions = {};
  const limit = c.req.query("limit");
  if (limit !== undefined) {
    const value = /^\d{1,3}$/.test(limit) ? Number(limit) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      throw new HarnessCardError(400, "limit: целое число от 1 до 100", "limit");
    }
    options.limit = value;
  }
  const archived = c.req.query("include_archived");
  if (archived !== undefined) {
    if (archived === "true" || archived === "1") options.include_archived = true;
    else if (archived === "false" || archived === "0") options.include_archived = false;
    else throw new HarnessCardError(400, "include_archived: true или false", "include_archived");
  }
  const cursor = c.req.query("cursor");
  if (cursor !== undefined && cursor !== "") options.cursor = cursor;
  const q = c.req.query("q");
  if (q !== undefined && q !== "") options.q = q;
  return options;
}
