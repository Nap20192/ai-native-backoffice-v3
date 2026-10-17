// Read-only catalog route (docs/plans/models-harness.md, 2). node-http.ts
// mounts it behind the usual /v1 auth:
//   v1.route("/oma/model_options", buildModelOptionsRoutes(catalog));
// and passes the model options to agentConfigGuard. Only the built-in Pi loop
// runs agents, so there is no harness catalog (D41).
import { Hono, type Context } from "hono";
import {
  listModelOptions,
  type ModelOptionsDeps,
  type ModelOptionsResult,
} from "./model-options.js";

export interface WorkspaceCatalog {
  modelOptions(workspaceId: string): Promise<ModelOptionsResult>;
}

export function createWorkspaceCatalog(deps: ModelOptionsDeps): WorkspaceCatalog {
  return { modelOptions: (workspaceId) => listModelOptions(deps, workspaceId) };
}

export interface ModelOptionsRoutesDeps {
  modelOptions(workspaceId: string): Promise<ModelOptionsResult>;
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

function workspaceOf(c: Context): string | null {
  const workspaceId = (c.var as { tenant_id?: string }).tenant_id;
  return typeof workspaceId === "string" && workspaceId.length > 0 ? workspaceId : null;
}

function noWorkspace(c: Context) {
  return c.json({ error: "Нужен вход в рабочее пространство" }, 401);
}
