// GET /v1/oma/dependencies/:kind/:id (docs/plans/crud.md, 1.2).
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildDependencyRoutes } from "../src/index";
import type {
  CheckDependenciesQuery,
  CheckDependenciesResult,
} from "../src/ports";

const report = {
  blocking: [{
    kind: "deployment" as const,
    id: "depl_01",
    name: "Утренний отчёт",
    status: "active",
    note: "запуски упадут",
  }],
  affected: [],
  truncated: false,
};

function api(answer: (query: CheckDependenciesQuery) => CheckDependenciesResult) {
  const calls: CheckDependenciesQuery[] = [];
  const app = new Hono();
  app.route("/v1/oma/dependencies", buildDependencyRoutes(() => ({
    checkDependencies: async (query) => {
      calls.push(query);
      return answer(query);
    },
  })));
  return { app, calls };
}

describe("GET /v1/oma/dependencies/:kind/:id", () => {
  it("returns the report of one operation", async () => {
    const { app, calls } = api(() => ({ type: "report", report }));
    const response = await app.request("/v1/oma/dependencies/agent/agent_01?operation=archive");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(report);
    expect(calls).toEqual([{ kind: "agent", id: "agent_01", operation: "archive" }]);
  });

  it("passes the skill version", async () => {
    const { app, calls } = api(() => ({ type: "report", report }));
    await app.request("/v1/oma/dependencies/skill_version/skill_01?operation=delete&version=3");
    expect(calls).toEqual([{ kind: "skill_version", id: "skill_01", operation: "delete", version: "3" }]);
  });

  it("rejects an unknown kind or operation before the application runs", async () => {
    const { app, calls } = api(() => ({ type: "report", report }));
    expect((await app.request("/v1/oma/dependencies/api_key/key_01?operation=delete")).status).toBe(400);
    expect((await app.request("/v1/oma/dependencies/agent/agent_01?operation=pause")).status).toBe(400);
    expect((await app.request("/v1/oma/dependencies/agent/agent_01")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("maps not_found and invalid_request", async () => {
    const missing = api(() => ({ type: "not_found" }));
    const notFound = await missing.app.request("/v1/oma/dependencies/agent/agent_x?operation=delete");
    expect(notFound.status).toBe(404);
    await expect(notFound.json()).resolves.toMatchObject({ error: { type: "not_found_error" } });

    const invalid = api(() => ({ type: "invalid_request", message: "version is required" }));
    const bad = await invalid.app.request("/v1/oma/dependencies/skill_version/skill_01?operation=delete");
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({
      error: { type: "invalid_request_error", message: "version is required" },
    });
  });
});
