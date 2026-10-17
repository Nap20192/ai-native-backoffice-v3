// Dependencies of archive and delete in main-node (docs/plans/crud.md, 1.2,
// A4, A13, A14). node-http.ts mounts the route and hands the check to the
// model card routes; the logic stays here.
//
// - GET /v1/oma/dependencies/:kind/:id?operation=archive|delete answers the
//   report of the workspace application. A model card is found by its id
//   here and turns into the agents with that model_id.
// - modelCardDependencyCheck: the check the card routes run before archive
//   and delete.
import { Hono, type Context } from "hono";
import { buildDependencyRoutes } from "@open-managed-agents/managed-agents-api";
import type { DependenciesApplicationPort } from "@open-managed-agents/managed-agents-application";
import {
  modelCardDependencies,
  type ModelCardDependencyCheck,
} from "@open-managed-agents/http-routes";
import type { ModelCardService } from "@open-managed-agents/model-cards-store";

export type DependenciesForWorkspace = (workspaceId: string) => DependenciesApplicationPort;

export interface CrudDependencyRoutesDeps {
  dependenciesFor: DependenciesForWorkspace;
  modelCards: ModelCardService;
}

/** The report of one card or an empty report, as the card routes expect it. */
async function reportOf(
  dependencies: DependenciesApplicationPort,
  kind: "model",
  id: string,
  operation: "archive" | "delete",
) {
  const result = await dependencies.checkDependencies({ kind, id, operation });
  return result.type === "report"
    ? result.report
    : { blocking: [], affected: [], truncated: false };
}

export function modelCardDependencyCheck(
  dependenciesFor: DependenciesForWorkspace,
): ModelCardDependencyCheck {
  return ({ tenantId, modelId, operation }) =>
    reportOf(dependenciesFor(tenantId), "model", modelId, operation);
}

function workspaceOf(c: Context): string {
  return (c.var as { tenant_id: string }).tenant_id;
}

function operationOf(c: Context): "archive" | "delete" | null {
  const operation = c.req.query("operation");
  return operation === "archive" || operation === "delete" ? operation : null;
}

function invalidOperation(c: Context): Response {
  return c.json({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "Invalid request field operation: expected archive or delete",
    },
  }, 400);
}

function cardNotFound(c: Context, kind: string, id: string): Response {
  return c.json({
    type: "error",
    error: { type: "not_found_error", message: `${kind} ${id} was not found` },
  }, 404);
}

export function buildCrudDependencyRoutes(deps: CrudDependencyRoutesDeps): Hono {
  const app = new Hono();

  app.get("/model_card/:id", async (c) => {
    const operation = operationOf(c);
    if (operation === null) return invalidOperation(c);
    const tenantId = workspaceOf(c);
    const card = await deps.modelCards.get({ tenantId, cardId: c.req.param("id") });
    if (card === null) return cardNotFound(c, "model_card", c.req.param("id"));
    return c.json(await modelCardDependencies(
      {
        modelCards: deps.modelCards,
        dependencies: modelCardDependencyCheck(deps.dependenciesFor),
      },
      { tenantId, card, operation },
    ), 200);
  });

  app.route("/", buildDependencyRoutes((c) => deps.dependenciesFor(workspaceOf(c))));
  return app;
}
