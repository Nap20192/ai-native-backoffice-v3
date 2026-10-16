import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  buildHarnessCatalogRoutes,
  buildModelOptionsRoutes,
  createWorkspaceCatalog,
  type WorkspaceCatalogDeps,
} from "../src/lib/catalog-routes.js";
import type { CatalogHarnessCard } from "../src/lib/harness-catalog.js";
import type { ModelOptionCard } from "../src/lib/model-options.js";

const READY = {
  rootSecret: "root-secret",
  gatewayBaseUrl: "http://host.boxlite.internal:8795",
  sandboxProvider: "litebox",
};

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

const AIDER_CARD: CatalogHarnessCard = {
  id: "hcard_V1StGXR8Z5jdHi6B",
  harness_id: "aider-local",
  name: "Aider через ACP",
  command: "aider-acp",
  args: [],
  cwd: "/mnt/session/outputs",
  install: { npm: [], pip: ["aider-chat==0.86.1"] },
  protocols: ["openai-chat"],
  allowed_env: ["AIDER_AUTO_COMMITS"],
  status: "unverified",
  created_at: "2026-10-16T10:00:00.000Z",
  archived_at: null,
};

function catalogDeps(overrides: {
  cards?: ModelOptionCard[];
  serverKey?: boolean;
  harnessCards?: CatalogHarnessCard[] | null;
  readiness?: typeof READY | { rootSecret: null; gatewayBaseUrl: string; sandboxProvider: string };
} = {}) {
  const listCards = vi.fn(async (_workspaceId: string) => overrides.cards ?? []);
  const listHarnessCards = vi.fn(async (_workspaceId: string) => overrides.harnessCards ?? []);
  const deps: WorkspaceCatalogDeps = {
    models: {
      listCards,
      serverKey: { available: overrides.serverKey ?? false, baseUrl: null },
    },
    harnesses: {
      ...(overrides.harnessCards === null ? {} : { listHarnessCards }),
      readiness: overrides.readiness ?? READY,
    },
  };
  return { deps, listCards, listHarnessCards };
}

/** Mounted the way WIRE mounts them in node-http.ts. */
function v1App(deps: WorkspaceCatalogDeps, tenant: string | null = "ws_1") {
  const catalog = createWorkspaceCatalog(deps);
  const v1 = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  v1.use("*", async (c, next) => {
    if (tenant !== null) c.set("tenant_id", tenant);
    await next();
  });
  v1.route("/oma/model_options", buildModelOptionsRoutes(catalog));
  v1.route("/oma/harnesses", buildHarnessCatalogRoutes(catalog));
  return v1;
}

describe("GET /oma/model_options", () => {
  it("answers an empty list without cards and without a server key", async () => {
    const res = await v1App(catalogDeps().deps).request("/oma/model_options");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ builtin_available: false, data: [] });
  });

  it("lists the workspace cards with their compatible harnesses", async () => {
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
      harnesses: ["pi", "claude-acp"],
    });
    expect(body.data.slice(1).every((option) => option.source === "builtin")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/api_key|price|cost/);
  });

  it("refuses a request without a workspace", async () => {
    const res = await v1App(catalogDeps().deps, null).request("/oma/model_options");
    expect(res.status).toBe(401);
  });
});

describe("GET /oma/harnesses", () => {
  it("answers built-ins and cards", async () => {
    const { deps, listHarnessCards } = catalogDeps({ harnessCards: [AIDER_CARD] });
    const res = await v1App(deps).request("/oma/harnesses");
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(listHarnessCards).toHaveBeenCalledWith("ws_1");
    expect(body.data.map((entry) => entry.id)).toEqual([
      "pi", "claude-acp", "codex-acp", "gemini", "opencode", "kimi-code", "pi-acp", "aider-local",
    ]);
    expect(body.data.at(-1)).toMatchObject({ source: "card", card_id: "hcard_V1StGXR8Z5jdHi6B", status: "unverified" });
  });

  it("answers built-ins only without a card store", async () => {
    const res = await v1App(catalogDeps({ harnessCards: null }).deps).request("/oma/harnesses");
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((entry) => entry.id)).toContain("claude-acp");
    expect(body.data.some((entry) => entry.id === "aider-local")).toBe(false);
  });

  it("shows why ACP entries cannot run", async () => {
    const { deps } = catalogDeps({ readiness: { ...READY, rootSecret: null } });
    const body = await (await v1App(deps).request("/oma/harnesses")).json() as {
      data: Array<{ id: string; status: string; reason: string | null }>;
    };
    expect(body.data.find((entry) => entry.id === "claude-acp")).toMatchObject({
      status: "unavailable",
      reason: "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
    });
  });

  it("refuses a request without a workspace", async () => {
    const res = await v1App(catalogDeps().deps, null).request("/oma/harnesses");
    expect(res.status).toBe(401);
  });
});

describe("createWorkspaceCatalog", () => {
  it("builds models and harnesses for the guard from one harness listing", async () => {
    const { deps, listHarnessCards, listCards } = catalogDeps({
      cards: [VERIFY_FAKE, { ...VERIFY_FAKE, id: "mc_02", model_id: "verify-oai", model: "gpt-5", provider: "openai", is_default: false }],
      harnessCards: [AIDER_CARD],
    });
    const { catalog } = createWorkspaceCatalog(deps);
    const result = await catalog("ws_1");
    expect(listHarnessCards).toHaveBeenCalledTimes(1);
    expect(listCards).toHaveBeenCalledTimes(1);
    expect(result.harnesses.map((entry) => entry.id)).toContain("aider-local");
    expect(result.models.find((option) => option.handle === "verify-oai")!.harnesses).toContain("aider-local");
  });

  it("keeps compatible harnesses in model options while ACP is unavailable", async () => {
    const { deps } = catalogDeps({ cards: [VERIFY_FAKE], readiness: { ...READY, rootSecret: null } });
    const result = await createWorkspaceCatalog(deps).modelOptions("ws_1");
    expect(result.data[0]!.harnesses).toEqual(["pi", "claude-acp"]);
  });
});
