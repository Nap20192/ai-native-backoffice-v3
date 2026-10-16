// ETag and If-Match on the v1 edit routes (docs/plans/builder-agent.md, 2.5
// step 8, unit BP1). The header is optional: without it a route works as
// before. A different revision gives 412 and the application writes nothing.
import { describe, expect, it } from "vitest";
import { deploymentView, makeDeploymentsPort } from "./deployment-fixtures";
import { makeEnvironmentsPort } from "./environment-fixtures";
import { makeMemoryStoresPort, memoryStoreView } from "./memory-fixtures";
import { makeSessionEventsPort } from "./session-event-fixtures";
import { makeSessionsPort, sessionView, sessionWire } from "./session-fixtures";
import {
  makeSkillVersionsPort,
  makeSkillsPort,
  skillVersionView,
  skillView,
} from "./skill-fixtures";
import {
  buildDeploymentsTestApi,
  buildEnvironmentsTestApi,
  buildMemoryTestApi,
  buildSessionEventsTestApi,
  buildSessionsTestApi,
  buildSkillsTestApi,
} from "./test-api";

const BETAS =
  "managed-agents-2026-04-01,skills-2025-10-02,agent-memory-2026-07-22";

const environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" as const },
  createdAt: "2026-08-26T08:10:00.000Z",
  description: null,
  metadata: {},
  name: "base",
  updatedAt: "2026-08-26T08:10:00.000Z",
};

function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = { "anthropic-beta": BETAS, ...init.headers };
  let body: BodyInit | undefined;
  if (init.body instanceof FormData) body = init.body;
  else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  return new Request(`http://openma.test${path}`, {
    method: init.method ?? (body === undefined ? "GET" : "POST"),
    headers,
    ...(body !== undefined && { body }),
  });
}

describe("ETag on reads and writes", () => {
  it("environments: create, retrieve and update carry the revision", async () => {
    const api = buildEnvironmentsTestApi(makeEnvironmentsPort({
      createEnvironment: async () => ({ type: "created", environment, revision: 1 }),
      retrieveEnvironment: async () => ({ type: "found", environment, revision: 3 }),
      updateEnvironment: async () => ({ type: "updated", environment, revision: 4 }),
    }));
    const created = await api.fetch(request("/v1/environments", { body: { name: "base" } }));
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"1"');
    const found = await api.fetch(request("/v1/environments/env_01"));
    expect(found.headers.get("etag")).toBe('"3"');
    const updated = await api.fetch(request("/v1/environments/env_01", { body: { name: "next" } }));
    expect(updated.headers.get("etag")).toBe('"4"');
  });

  it("deployments: create, retrieve and update carry the revision", async () => {
    const api = buildDeploymentsTestApi({
      deployments: makeDeploymentsPort({
        retrieveDeployment: async () => ({ type: "found", deployment: deploymentView, revision: 2 }),
        updateDeployment: async () => ({ type: "updated", deployment: deploymentView, revision: 3 }),
      }),
    });
    const found = await api.fetch(request("/v1/deployments/depl_01"));
    expect(found.status).toBe(200);
    expect(found.headers.get("etag")).toBe('"2"');
    const updated = await api.fetch(request("/v1/deployments/depl_01", { body: { name: "next" } }));
    expect(updated.headers.get("etag")).toBe('"3"');
  });

  it("memory stores: retrieve and update carry the revision", async () => {
    const api = buildMemoryTestApi({
      memoryStores: makeMemoryStoresPort({
        retrieveMemoryStore: async () => ({ type: "found", memoryStore: memoryStoreView, revision: 6 }),
        updateMemoryStore: async () => ({ type: "updated", memoryStore: memoryStoreView, revision: 7 }),
      }),
    });
    const found = await api.fetch(request("/v1/memory_stores/memstore_01"));
    expect(found.status).toBe(200);
    expect(found.headers.get("etag")).toBe('"6"');
    const updated = await api.fetch(request("/v1/memory_stores/memstore_01", { body: { name: "next" } }));
    expect(updated.headers.get("etag")).toBe('"7"');
  });

  it("skills: the skill and its new version carry the skill revision", async () => {
    const api = buildSkillsTestApi(
      makeSkillsPort({
        retrieveSkill: async () => ({ type: "found", skill: skillView, revision: 2 }),
      }),
      makeSkillVersionsPort({
        createSkillVersion: async () => ({ type: "created", version: skillVersionView, skillRevision: 3 }),
      }),
    );
    const found = await api.fetch(request("/v1/skills/skill_01"));
    expect(found.status).toBe(200);
    expect(found.headers.get("etag")).toBe('"2"');
    const created = await api.fetch(request("/v1/skills/skill_01/versions", { body: skillForm() }));
    expect(created.status).toBe(200);
    expect(created.headers.get("etag")).toBe('"3"');
  });

  it("sessions: retrieve carries the session revision", async () => {
    const api = buildSessionsTestApi(makeSessionsPort({
      retrieveSession: async () => ({ type: "found", session: sessionView, revision: 5 }),
    }));
    const found = await api.fetch(request(`/v1/sessions/${sessionWire.id}`));
    expect(found.status).toBe(200);
    expect(found.headers.get("etag")).toBe('"5"');
  });

  it("a port without a revision gives no ETag", async () => {
    const api = buildEnvironmentsTestApi(makeEnvironmentsPort({
      retrieveEnvironment: async () => ({ type: "found", environment }),
    }));
    const found = await api.fetch(request("/v1/environments/env_01"));
    expect(found.status).toBe(200);
    expect(found.headers.get("etag")).toBeNull();
  });
});

function skillForm(): FormData {
  const form = new FormData();
  form.append("files[]", new File(["# Skill"], "skill/SKILL.md", { type: "text/markdown" }));
  return form;
}

type Case = {
  name: string;
  /** Builds the API; `calls` receives each write command. */
  api(calls: unknown[], result: "ok" | "stale"): { fetch(request: Request): Response | Promise<Response> };
  write(headers: Record<string, string>): Request;
};

const cases: Case[] = [
  {
    name: "POST /v1/environments/:id",
    api: (calls, result) => buildEnvironmentsTestApi(makeEnvironmentsPort({
      updateEnvironment: async (command) => {
        calls.push(command);
        return result === "ok"
          ? { type: "updated", environment, revision: 4 }
          : { type: "precondition_failed", message: "Environment env_01 is at revision 4, not 3" };
      },
    })),
    write: (headers) => request("/v1/environments/env_01", { headers, body: { name: "next" } }),
  },
  {
    name: "POST /v1/deployments/:id",
    api: (calls, result) => buildDeploymentsTestApi({
      deployments: makeDeploymentsPort({
        updateDeployment: async (command) => {
          calls.push(command);
          return result === "ok"
            ? { type: "updated", deployment: deploymentView, revision: 4 }
            : { type: "precondition_failed", message: "Deployment depl_01 is at revision 4, not 3" };
        },
      }),
    }),
    write: (headers) => request("/v1/deployments/depl_01", { headers, body: { name: "next" } }),
  },
  {
    name: "POST /v1/memory_stores/:id",
    api: (calls, result) => buildMemoryTestApi({
      memoryStores: makeMemoryStoresPort({
        updateMemoryStore: async (command) => {
          calls.push(command);
          return result === "ok"
            ? { type: "updated", memoryStore: memoryStoreView, revision: 4 }
            : { type: "precondition_failed", message: "Memory store memstore_01 is at revision 4, not 3" };
        },
      }),
    }),
    write: (headers) => request("/v1/memory_stores/memstore_01", { headers, body: { name: "next" } }),
  },
  {
    name: "POST /v1/skills/:id/versions",
    api: (calls, result) => buildSkillsTestApi(
      makeSkillsPort({}),
      makeSkillVersionsPort({
        createSkillVersion: async (command) => {
          calls.push({ skillId: command.skillId, expectedRevision: command.expectedRevision });
          return result === "ok"
            ? { type: "created", version: skillVersionView, skillRevision: 4 }
            : { type: "precondition_failed", message: "Skill skill_01 is at revision 4, not 3" };
        },
      }),
    ),
    write: (headers) => request("/v1/skills/skill_01/versions", { headers, body: skillForm() }),
  },
];

describe.each(cases)("If-Match on $name", (testCase) => {
  it("passes the revision to the command", async () => {
    const calls: unknown[] = [];
    const response = await testCase.api(calls, "ok").fetch(testCase.write({ "if-match": '"3"' }));
    expect(response.status).toBeLessThan(300);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ expectedRevision: 3 });
  });

  it("accepts the revision without quotes", async () => {
    const calls: unknown[] = [];
    await testCase.api(calls, "ok").fetch(testCase.write({ "if-match": "3" }));
    expect(calls[0]).toMatchObject({ expectedRevision: 3 });
  });

  it("answers 412 when the application reports another revision", async () => {
    const calls: unknown[] = [];
    const response = await testCase.api(calls, "stale").fetch(testCase.write({ "if-match": '"3"' }));
    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "precondition_failed_error" },
    });
  });

  it("without the header the command has no expectedRevision", async () => {
    const calls: unknown[] = [];
    const response = await testCase.api(calls, "ok").fetch(testCase.write({}));
    expect(response.status).toBeLessThan(300);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { expectedRevision?: number }).expectedRevision).toBeUndefined();
  });

  it("If-Match: * is no precondition", async () => {
    const calls: unknown[] = [];
    await testCase.api(calls, "ok").fetch(testCase.write({ "if-match": "*" }));
    expect((calls[0] as { expectedRevision?: number }).expectedRevision).toBeUndefined();
  });

  it.each(['W/"3"', '"abc"', '"3", "4"', '"0"', '"3'])("rejects If-Match %s with 400 before the application", async (value) => {
    const calls: unknown[] = [];
    const response = await testCase.api(calls, "ok").fetch(testCase.write({ "if-match": value }));
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("If-Match on POST /v1/sessions/:id/events", () => {
  const body = { events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] };

  function eventsApi(calls: unknown[], result: "accepted" | "version_conflict") {
    return buildSessionEventsTestApi(makeSessionEventsPort({
      sendSessionEvents: async (command) => {
        calls.push(command);
        return result === "accepted"
          ? { type: "accepted", events: [] }
          : { type: "version_conflict", message: "Session changed after input validation" };
      },
    }));
  }

  it("passes the session revision as expectedRevision", async () => {
    const calls: unknown[] = [];
    const response = await eventsApi(calls, "accepted").fetch(
      request(`/v1/sessions/${sessionWire.id}/events`, { headers: { "if-match": '"5"' }, body }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ sessionId: sessionWire.id, expectedRevision: 5, events: body.events }]);
  });

  it("answers 412 instead of 409 when the revision moved", async () => {
    const calls: unknown[] = [];
    const response = await eventsApi(calls, "version_conflict").fetch(
      request(`/v1/sessions/${sessionWire.id}/events`, { headers: { "if-match": '"5"' }, body }),
    );
    expect(response.status).toBe(412);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "precondition_failed_error" },
    });
  });

  it("without the header a conflict stays 409 and no expectedRevision is sent", async () => {
    const calls: unknown[] = [];
    const response = await eventsApi(calls, "version_conflict").fetch(
      request(`/v1/sessions/${sessionWire.id}/events`, { body }),
    );
    expect(response.status).toBe(409);
    expect(calls).toEqual([{ sessionId: sessionWire.id, events: body.events }]);
  });

  it("rejects a malformed If-Match with 400 and sends nothing", async () => {
    const calls: unknown[] = [];
    const response = await eventsApi(calls, "accepted").fetch(
      request(`/v1/sessions/${sessionWire.id}/events`, { headers: { "if-match": "W/\"5\"" }, body }),
    );
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
