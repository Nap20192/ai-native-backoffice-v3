import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { decodeCursor } from "../src/lib/trace/cursor";
import { buildTraceRoutes } from "../src/lib/trace/routes";
import { createTraceStore } from "../src/lib/trace/store";
import { seedTraceSpans } from "../scripts/seed-trace-spans";
import { createHistoryDb, insertSession } from "./_helpers/trace-history-db";

const WS = "ws_pages";
const SESSION = "session_pages";
const UPDATED_AT = 1792600000000;

describe("trace pagination (trace.pagination)", () => {
  it("reads 12 000 spans with one updated_at exactly once by turn pages and by change pages", async () => {
    const sql = await createHistoryDb();
    await insertSession(sql, WS, SESSION);
    const seeded = await seedTraceSpans({ sql, dialect: "sqlite", workspaceId: WS, sessionId: SESSION, turns: 1, spansPerTurn: 12_000, updatedAt: UPDATED_AT });
    expect(seeded.spans).toBe(12_000);
    const now = UPDATED_AT + 60_000;
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => { c.set("tenant_id", WS); await next(); });
    app.route("/v1/oma/sessions", buildTraceRoutes({ sql, dialect: "sqlite", now: () => now }) as never);
    const root = `/v1/oma/sessions/${SESSION}/trace`;
    const turnId = seeded.turnIds[0]!;

    const byTurn = new Map<string, number>();
    let page: string | null = null;
    let pages = 0;
    do {
      const query: string = page === null ? `turn_id=${turnId}` : `turn_id=${turnId}&page=${page}`;
      const body = await (await app.request(`${root}?${query}`)).json() as { spans: Array<{ span_id: string; start_ms: number }>; page_next: string | null };
      expect(body.spans.length).toBeLessThanOrEqual(2000);
      for (const span of body.spans) byTurn.set(span.span_id, (byTurn.get(span.span_id) ?? 0) + 1);
      page = body.page_next;
      pages += 1;
    } while (page !== null);
    expect(pages).toBe(6);
    expect(byTurn.size).toBe(12_000);
    expect([...byTurn.values()].every((count) => count === 1)).toBe(true);

    const first = await (await app.request(root)).json() as { spans: unknown[]; spans_next: string | null };
    expect(first.spans).toHaveLength(2000);
    expect(first.spans_next).not.toBeNull();
    const rest = await (await app.request(`${root}?page=${first.spans_next}`)).json() as { spans: unknown[] };
    expect(rest.spans).toHaveLength(2000);

    const zero = Buffer.from(JSON.stringify({ u: 0, s: "", tu: 0, tt: "" })).toString("base64url");
    const byChange = new Map<string, number>();
    let cursor = zero;
    let rounds = 0;
    for (;;) {
      const body = await (await app.request(`${root}?after=${cursor}`)).json() as { spans: Array<{ span_id: string }>; more: boolean; cursor: string };
      for (const span of body.spans) byChange.set(span.span_id, (byChange.get(span.span_id) ?? 0) + 1);
      cursor = body.cursor;
      rounds += 1;
      if (!body.more) break;
    }
    expect(rounds).toBe(6);
    expect(byChange.size).toBe(12_000);
    expect([...byChange.values()].every((count) => count === 1)).toBe(true);
    expect(decodeCursor(cursor).u).toBe(now - 2000);

    // A row removed by a merge reaches the change feed as deleted.
    const store = createTraceStore({ sql, dialect: "sqlite", now: () => now - 1000 });
    const [victim] = [...byTurn.keys()];
    await store.markDeleted({ workspaceId: WS, sessionId: SESSION }, victim!);
    const changed = await (await app.request(`${root}?after=${cursor}`)).json() as { spans: Array<{ span_id: string; deleted: boolean }>; more: boolean };
    expect(changed.spans).toEqual([expect.objectContaining({ span_id: victim, deleted: true })]);
    const again = await (await app.request(`${root}?turn_id=${turnId}`)).json() as { spans: Array<{ span_id: string }> };
    expect(again.spans.some((span) => span.span_id === victim)).toBe(false);
  });

  it("the seed script refuses to run in production", async () => {
    const sql = await createHistoryDb();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(seedTraceSpans({ sql, dialect: "sqlite", workspaceId: WS, sessionId: SESSION, turns: 1, spansPerTurn: 1 })).rejects.toThrow(/production/u);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
