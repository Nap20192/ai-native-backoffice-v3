import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  buildModelOptionsRoutes,
  createWorkspaceCatalog,
} from "../src/lib/catalog-routes.js";
import type { ModelOptionCard, ModelOptionsDeps } from "../src/lib/model-options.js";

const VERIFY_FAKE: ModelOptionCard = {
  id: "mc_01",
  model_id: "verify-fake",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  base_url: "https://fake.test",
  pi_config: null,
  is_default: true,
  created_at: "2026-10-16T00:00:00.000Z",
  archived_at: null,
};

function catalogDeps(overrides: { cards?: ModelOptionCard[]; serverKey?: boolean } = {}) {
  const listCards = vi.fn(async (_workspaceId: string) => overrides.cards ?? []);
  const deps: ModelOptionsDeps = {
    listCards,
    serverKey: { available: overrides.serverKey ?? false, baseUrl: null },
  };
  return { deps, listCards };
}

/** Mounted the way node-http.ts mounts it. */
function v1App(deps: ModelOptionsDeps, tenant: string | null = "ws_1") {
  const catalog = createWorkspaceCatalog(deps);
  const v1 = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  v1.use("*", async (c, next) => {
    if (tenant !== null) c.set("tenant_id", tenant);
    await next();
  });
  v1.route("/oma/model_options", buildModelOptionsRoutes(catalog));
  return v1;
}

describe("GET /oma/model_options", () => {
  it("answers an empty list without cards and without a server key", async () => {
    const res = await v1App(catalogDeps().deps).request("/oma/model_options");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ builtin_available: false, data: [] });
  });

  it("lists the workspace cards with the one harness pi", async () => {
    const { deps, listCards } = catalogDeps({ cards: [VERIFY_FAKE], serverKey: true });
    const res = await v1App(deps).request("/oma/model_options");
    const body = await res.json() as { builtin_available: boolean; data: Array<Record<string, unknown>> };
    expect(listCards).toHaveBeenCalledWith("ws_1");
    expect(body.builtin_available).toBe(true);
    expect(body.data[0]).toMatchObject({
      handle: "verify-fake",
      source: "card",
      card_id: "mc_01",
      is_default: true,
      provider: "anthropic",
      wire_model: "claude-sonnet-4-6",
      protocols: ["anthropic-messages"],
      speed_fast: true,
      harnesses: ["pi"],
    });
    expect(body.data.slice(1).every((option) => option.source === "builtin")).toBe(true);
    expect(body.data.every((option) => JSON.stringify(option.harnesses) === "[\"pi\"]")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/api_key|price|cost/);
  });

  it("refuses a request without a workspace", async () => {
    const res = await v1App(catalogDeps().deps, null).request("/oma/model_options");
    expect(res.status).toBe(401);
  });

  it("has no harness catalog route", async () => {
    const res = await v1App(catalogDeps().deps).request("/oma/harnesses");
    expect(res.status).toBe(404);
  });
});
