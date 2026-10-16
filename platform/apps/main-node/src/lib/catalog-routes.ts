// Read-only catalog routes (docs/plans/models-harness.md, 2 and 3.1).
// WIRE mounts them in node-http.ts behind the usual /v1 auth:
//   v1.route("/oma/model_options", buildModelOptionsRoutes(catalog));
//   v1.route("/oma/harnesses", buildHarnessCatalogRoutes(catalog));
// and passes `catalog.catalog` to agentConfigGuard.
import { Hono, type Context } from "hono";
import { listHarnesses, type HarnessCatalogDeps, type HarnessEntry } from "./harness-catalog.js";
import {
  listModelOptions,
  type ModelOption,
  type ModelOptionsDeps,
  type ModelOptionsResult,
} from "./model-options.js";

export interface WorkspaceCatalogDeps {
  models: ModelOptionsDeps;
  harnesses: HarnessCatalogDeps;
}

export interface WorkspaceCatalog {
  modelOptions(workspaceId: string): Promise<ModelOptionsResult>;
  harnesses(workspaceId: string): Promise<HarnessEntry[]>;
  /** Models and harnesses from one harness listing; the shape agentConfigGuard takes. */
  catalog(workspaceId: string): Promise<{ models: ModelOption[]; harnesses: HarnessEntry[] }>;
}

export function createWorkspaceCatalog(deps: WorkspaceCatalogDeps): WorkspaceCatalog {
  const harnesses = (workspaceId: string) => listHarnesses(deps.harnesses, workspaceId);
  const modelOptions = async (workspaceId: string) =>
    listModelOptions(deps.models, workspaceId, await harnesses(workspaceId));
  const catalog = async (workspaceId: string) => {
    const entries = await harnesses(workspaceId);
    const options = await listModelOptions(deps.models, workspaceId, entries);
    return { models: options.data, harnesses: entries };
  };
  return { modelOptions, harnesses, catalog };
}

export interface ModelOptionsRoutesDeps {
  modelOptions(workspaceId: string): Promise<ModelOptionsResult>;
}

export interface HarnessCatalogRoutesDeps {
  harnesses(workspaceId: string): Promise<HarnessEntry[]>;
}

export function buildModelOptionsRoutes(deps: ModelOptionsRoutesDeps): Hono {
  const app = new Hono();
  app.get("/", async (c) => {
    const workspaceId = workspaceOf(c);
    if (workspaceId === null) return noWorkspace(c);
    return c.json(await deps.modelOptions(workspaceId), 200);
  });
  return app;
}

export function buildHarnessCatalogRoutes(deps: HarnessCatalogRoutesDeps): Hono {
  const app = new Hono();
  app.get("/", async (c) => {
    const workspaceId = workspaceOf(c);
    if (workspaceId === null) return noWorkspace(c);
    return c.json({ data: await deps.harnesses(workspaceId) }, 200);
  });
  return app;
}

function workspaceOf(c: Context): string | null {
  const workspaceId = (c.var as { tenant_id?: string }).tenant_id;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : null;
}

function noWorkspace(c: Context) {
  return c.json({ error: "Нужен вход в рабочее пространство" }, 401);
}
