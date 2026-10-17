// GET /v1/oma/dependencies/:kind/:id?operation=archive|delete
// (docs/plans/crud.md, 1.2). The console and the assistant read the report
// before they offer archive or delete.
import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import {
  dependencyQuerySchema,
  dependencyReportSchema,
} from "../contracts/dependencies";
import { apiError, invalidRequest, notFound } from "../errors";
import type { DependenciesApplicationPort } from "../ports/dependencies";

export function buildDependencyRoutes(
  source: ApplicationPortSource<DependenciesApplicationPort>,
): Hono {
  const app = new Hono();

  app.get("/:kind/:id", async (c) => {
    const query = dependencyQuerySchema.safeParse({
      kind: c.req.param("kind"),
      id: c.req.param("id"),
      operation: c.req.query("operation"),
      version: c.req.query("version"),
    });
    if (!query.success) {
      const issue = query.error.issues[0];
      return c.json(
        invalidRequest(
          `Invalid request field ${issue?.path.join(".") || "query"}: ${issue?.message ?? "invalid value"}`,
        ),
        400,
      );
    }
    const result = await resolveApplicationPort(source, c).checkDependencies(
      query.data,
    );
    if (result.type === "not_found") {
      return c.json(
        notFound(`${query.data.kind} ${query.data.id} was not found`),
        404,
      );
    }
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = dependencyReportSchema.safeParse(result.report);
    if (!response.success) {
      return c.json(apiError("Application returned an invalid dependency report"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
