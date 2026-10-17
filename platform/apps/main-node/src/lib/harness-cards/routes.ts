// API /v1/oma/harness_cards (docs/plans/models-harness.md, 3.6).
// Errors come back as {"error": "<текст>", "field": "<поле>" | null}.
import { Hono, type Context } from "hono";
import type { HarnessCardStore } from "./store.js";
import { HarnessCardError, isHarnessCardError, type HarnessCardListOptions } from "./types.js";

/** One row of a dependency report (docs/plans/crud.md, 1.2). */
export interface HarnessCardDependencyEntry {
  kind: string;
  id: string;
  name: string | null;
  status: string | null;
  note: string | null;
}

export interface HarnessCardDependencyReport {
  blocking: HarnessCardDependencyEntry[];
  affected: HarnessCardDependencyEntry[];
  truncated: boolean;
}

/**
 * Agents that run on the card (table 1.3): archive looks at agents out of
 * the archive, delete at every version of every agent. Without it archive
 * and delete check nothing.
 */
export type HarnessCardDependencyCheck = (input: {
  workspaceId: string;
  harnessId: string;
  operation: "archive" | "delete";
}) => Promise<HarnessCardDependencyReport>;

export interface HarnessCardRoutesDeps {
  store: HarnessCardStore;
  dependencies?: HarnessCardDependencyCheck;
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
    c.header("ETag", revisionTag(card));
    return c.json(card, 201);
  });

  app.get("/:id", async (c) => {
    const card = await deps.store.get(workspaceOf(c)!, c.req.param("id"));
    if (card === null) throw new HarnessCardError(404, "Harness не найден");
    c.header("ETag", revisionTag(card));
    return c.json(card, 200);
  });

  // If-Match carries updated_at from ETag (builder-agent.md, 2.5 step 8).
  app.post("/:id", async (c) => {
    const expectedUpdatedAt = ifMatchTime(c.req.header("If-Match"));
    const body = await jsonBody(c);
    const card = await deps.store.update(
      workspaceOf(c)!,
      c.req.param("id"),
      body,
      expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt },
    );
    c.header("ETag", revisionTag(card));
    return c.json(card, 200);
  });

  // Archive, restore and delete read If-Match; archive and delete check
  // dependencies (docs/plans/crud.md, 2.8). DELETE removes the card, the
  // archive is POST /:id/archive.
  const blocked = async (
    workspaceId: string,
    id: string,
    operation: "archive" | "delete",
  ): Promise<HarnessCardDependencyReport | null> => {
    if (deps.dependencies === undefined) return null;
    const card = await deps.store.get(workspaceId, id);
    if (card === null) throw new HarnessCardError(404, "Harness не найден");
    const report = await deps.dependencies({ workspaceId, harnessId: card.harness_id, operation });
    return report.blocking.length > 0 ? report : null;
  };
  const conflictBody = (message: string, dependencies: HarnessCardDependencyReport) => ({
    type: "error",
    error: { type: "dependency_conflict_error", message, dependencies },
  });

  app.post("/:id/archive", async (c) => {
    const workspaceId = workspaceOf(c)!;
    const expectedUpdatedAt = ifMatchTime(c.req.header("If-Match"));
    const report = await blocked(workspaceId, c.req.param("id"), "archive");
    if (report !== null) {
      return c.json(conflictBody("Сначала уберите зависимости: harness используют агенты", report), 409);
    }
    const card = await deps.store.archive(
      workspaceId,
      c.req.param("id"),
      expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt },
    );
    c.header("ETag", revisionTag(card));
    return c.json(card, 200);
  });

  app.post("/:id/unarchive", async (c) => {
    const expectedUpdatedAt = ifMatchTime(c.req.header("If-Match"));
    const card = await deps.store.unarchive(
      workspaceOf(c)!,
      c.req.param("id"),
      expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt },
    );
    c.header("ETag", revisionTag(card));
    return c.json(card, 200);
  });

  app.delete("/:id", async (c) => {
    const workspaceId = workspaceOf(c)!;
    const expectedUpdatedAt = ifMatchTime(c.req.header("If-Match"));
    const report = await blocked(workspaceId, c.req.param("id"), "delete");
    if (report !== null) {
      return c.json(conflictBody("Сначала уберите зависимости: harness используют агенты", report), 409);
    }
    await deps.store.delete(
      workspaceId,
      c.req.param("id"),
      expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt },
    );
    return c.json({ type: "harness_card_deleted", id: c.req.param("id") }, 200);
  });

  return app;
}

function revisionTag(card: { updated_at: string }): string {
  return `"${card.updated_at}"`;
}

/** If-Match as one ISO time, quoted or not. `*` and no header: no precondition. */
function ifMatchTime(header: string | undefined): string | undefined {
  if (header === undefined || header.trim() === "*") return undefined;
  const match = /^(?:"([^",]+)"|([^",\s]+))$/.exec(header.trim());
  const value = match?.[1] ?? match?.[2];
  const time = value === undefined ? Number.NaN : Date.parse(value);
  if (Number.isNaN(time) || new Date(time).toISOString() !== value) {
    throw new HarnessCardError(400, "If-Match: нужно значение ETag этой карточки", "If-Match");
  }
  return value;
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
