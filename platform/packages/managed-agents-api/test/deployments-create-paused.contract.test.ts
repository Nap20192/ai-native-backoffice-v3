// POST /v1/deployments with `_oma: {paused: true}` (docs/plans/builder-agent.md,
// 2.3 and BP1): the deployment is created already paused by one insert.
// Claude API clients do not send `_oma`, for them the route works as before.
import { describe, expect, it } from "vitest";
import { deploymentView, makeDeploymentsPort } from "./deployment-fixtures";
import { buildDeploymentsTestApi } from "./test-api";

const body = {
  agent: { type: "agent", id: "agent_01", version: 3 },
  environment_id: "env_01",
  initial_events: [
    { type: "user.message", content: [{ type: "text", text: "Inspect the repository" }] },
  ],
  name: "nightly",
  schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
};

function create(payload: unknown, calls: unknown[]) {
  const api = buildDeploymentsTestApi({
    deployments: makeDeploymentsPort({
      createDeployment: async (command) => {
        calls.push(command);
        return {
          type: "created",
          deployment: {
            ...deploymentView,
            status: command.initialStatus === "paused" ? "paused" : "active",
            pausedReason: command.initialStatus === "paused" ? { kind: "manual" } : null,
          },
          revision: 1,
        };
      },
    }),
  });
  return api.fetch(new Request("http://openma.test/v1/deployments", {
    method: "POST",
    headers: {
      "anthropic-beta": "managed-agents-2026-04-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  }));
}

describe("Managed Agents API — POST /v1/deployments with _oma.paused", () => {
  it("_oma.paused true asks the application for a paused deployment", async () => {
    const calls: unknown[] = [];
    const response = await create({ ...body, _oma: { paused: true } }, calls);
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"1"');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ initialStatus: "paused", name: "nightly" });
    await expect(response.json()).resolves.toMatchObject({
      status: "paused",
      paused_reason: { type: "manual" },
    });
  });

  it("_oma.paused false is an active deployment", async () => {
    const calls: unknown[] = [];
    const response = await create({ ...body, _oma: { paused: false } }, calls);
    expect(response.status).toBe(201);
    expect(calls[0]).toMatchObject({ initialStatus: "active" });
  });

  it("without _oma the command has no initialStatus", async () => {
    const calls: unknown[] = [];
    const response = await create(body, calls);
    expect(response.status).toBe(201);
    expect(calls[0]).not.toHaveProperty("initialStatus");
    await expect(response.json()).resolves.toMatchObject({ status: "active" });
  });

  it.each([
    [{ paused: true, status: "paused" }],
    [{ archived: true }],
    [{}],
    [{ paused: "yes" }],
  ])("_oma %j gives 400 and calls nothing", async (oma) => {
    const calls: unknown[] = [];
    const response = await create({ ...body, _oma: oma }, calls);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
