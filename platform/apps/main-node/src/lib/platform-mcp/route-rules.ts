// Every `/v1` route the platform MCP server may call (builder-agent.md 2.1, 2.4).
// The token allowlist equals this list, so a route outside it gets 403 even
// after a bug in a tool.

import type { BodyCheckName, RouteRule, RouteTokenIssuerKind } from "./ports";

const get = (pattern: string): RouteRule => ({ method: "GET", pattern, bodyCheck: null, issuers: ["handler"] });
const post = (
  pattern: string,
  bodyCheck: BodyCheckName | null = null,
  issuers: readonly RouteTokenIssuerKind[] = ["handler"],
): RouteRule => ({ method: "POST", pattern, bodyCheck, issuers });

export const ROUTES = {
  agents: get("/v1/agents"),
  agent: get("/v1/agents/:id"),
  agentVersions: get("/v1/agents/:id/versions"),
  agentCreate: post("/v1/agents"),
  agentUpdate: post("/v1/agents/:id"),

  environments: get("/v1/environments"),
  environment: get("/v1/environments/:id"),
  environmentCreate: post("/v1/environments"),
  environmentUpdate: post("/v1/environments/:id"),

  skills: get("/v1/skills"),
  skill: get("/v1/skills/:id"),
  skillVersions: get("/v1/skills/:id/versions"),
  skillVersion: get("/v1/skills/:id/versions/:version"),
  skillContent: get("/v1/skills/:id/versions/:version/content"),
  skillCreate: post("/v1/skills"),
  skillVersionCreate: post("/v1/skills/:id/versions"),

  files: get("/v1/files"),
  file: get("/v1/files/:id"),
  fileContent: get("/v1/files/:id/content"),
  fileUpload: post("/v1/files"),

  memoryStores: get("/v1/memory_stores"),
  memoryStore: get("/v1/memory_stores/:id"),
  memoryStoreCreate: post("/v1/memory_stores"),
  memoryStoreUpdate: post("/v1/memory_stores/:id"),
  memories: get("/v1/memory_stores/:id/memories"),
  memory: get("/v1/memory_stores/:id/memories/:memory_id"),
  memoryCreate: post("/v1/memory_stores/:id/memories"),
  memoryUpdate: post("/v1/memory_stores/:id/memories/:memory_id"),

  vaults: get("/v1/vaults"),
  vault: get("/v1/vaults/:id"),
  credentials: get("/v1/vaults/:id/credentials"),
  credential: get("/v1/vaults/:id/credentials/:credential_id"),

  deployments: get("/v1/deployments"),
  deployment: get("/v1/deployments/:id"),
  deploymentCreate: post("/v1/deployments", "deployment_paused"),
  deploymentUpdate: post("/v1/deployments/:id"),
  deploymentRuns: get("/v1/deployment_runs"),
  deploymentRun: get("/v1/deployment_runs/:id"),

  sessions: get("/v1/sessions"),
  session: get("/v1/sessions/:id"),
  sessionEvents: get("/v1/sessions/:id/events"),
  sessionCreate: post("/v1/sessions", "session_create"),
  sessionEventSend: post("/v1/sessions/:id/events", "session_event", ["handler", "confirm"]),
  trajectory: get("/v1/oma/sessions/:id/trajectory"),

  evalRuns: get("/v1/oma/evals/runs"),
  evalRun: get("/v1/oma/evals/runs/:id"),

  modelCards: get("/v1/oma/model_cards"),
  modelCard: get("/v1/oma/model_cards/:id"),
  modelCardUpdate: post("/v1/oma/model_cards/:id", "model_card_safe"),
  modelOptions: get("/v1/oma/model_options"),

  harnesses: get("/v1/oma/harnesses"),
  harnessCards: get("/v1/oma/harness_cards"),
  harnessCard: get("/v1/oma/harness_cards/:id"),
  harnessCardUpdate: post("/v1/oma/harness_cards/:id", "harness_card_safe"),
} as const satisfies Record<string, RouteRule>;

/** Reads the gate and the `confirm` route make on their own. */
export const INTERNAL_ROUTES: readonly RouteRule[] = [ROUTES.session, ROUTES.sessionEvents, ROUTES.sessionEventSend];
