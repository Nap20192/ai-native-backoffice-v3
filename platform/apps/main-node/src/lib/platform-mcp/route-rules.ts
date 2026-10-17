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
const del = (pattern: string, bodyCheck: BodyCheckName | null = null): RouteRule => ({ method: "DELETE", pattern, bodyCheck, issuers: ["handler"] });
/** Archive and delete of an object with a revision carry `If-Match` (crud.md 1.4, 3.3). */
const IF_MATCH = "if_match_required";

export const ROUTES = {
  agents: get("/v1/agents"),
  agent: get("/v1/agents/:id"),
  agentVersions: get("/v1/agents/:id/versions"),
  agentCreate: post("/v1/agents"),
  agentUpdate: post("/v1/agents/:id"),
  agentArchive: post("/v1/agents/:id/archive", IF_MATCH),
  agentUnarchive: post("/v1/agents/:id/unarchive"),
  agentDelete: del("/v1/agents/:id", IF_MATCH),

  environments: get("/v1/environments"),
  environment: get("/v1/environments/:id"),
  environmentCreate: post("/v1/environments"),
  environmentUpdate: post("/v1/environments/:id"),
  environmentArchive: post("/v1/environments/:id/archive", IF_MATCH),
  environmentUnarchive: post("/v1/environments/:id/unarchive"),
  environmentDelete: del("/v1/environments/:id", IF_MATCH),

  skills: get("/v1/skills"),
  skill: get("/v1/skills/:id"),
  skillVersions: get("/v1/skills/:id/versions"),
  skillVersion: get("/v1/skills/:id/versions/:version"),
  skillContent: get("/v1/skills/:id/versions/:version/content"),
  skillCreate: post("/v1/skills"),
  skillVersionCreate: post("/v1/skills/:id/versions"),
  skillDelete: del("/v1/skills/:id", IF_MATCH),
  skillVersionDelete: del("/v1/skills/:id/versions/:version", IF_MATCH),

  files: get("/v1/files"),
  file: get("/v1/files/:id"),
  fileContent: get("/v1/files/:id/content"),
  fileUpload: post("/v1/files"),
  fileDelete: del("/v1/files/:id"),

  memoryStores: get("/v1/memory_stores"),
  memoryStore: get("/v1/memory_stores/:id"),
  memoryStoreCreate: post("/v1/memory_stores"),
  memoryStoreUpdate: post("/v1/memory_stores/:id"),
  memoryStoreArchive: post("/v1/memory_stores/:id/archive", IF_MATCH),
  memoryStoreUnarchive: post("/v1/memory_stores/:id/unarchive"),
  memoryStoreDelete: del("/v1/memory_stores/:id", IF_MATCH),
  memories: get("/v1/memory_stores/:id/memories"),
  memory: get("/v1/memory_stores/:id/memories/:memory_id"),
  memoryCreate: post("/v1/memory_stores/:id/memories"),
  memoryUpdate: post("/v1/memory_stores/:id/memories/:memory_id"),
  /** The revision goes in `?expected_content_sha256=`. */
  memoryDelete: del("/v1/memory_stores/:id/memories/:memory_id"),

  vaults: get("/v1/vaults"),
  vault: get("/v1/vaults/:id"),
  credentials: get("/v1/vaults/:id/credentials"),
  credential: get("/v1/vaults/:id/credentials/:credential_id"),

  deployments: get("/v1/deployments"),
  deployment: get("/v1/deployments/:id"),
  deploymentCreate: post("/v1/deployments", "deployment_paused"),
  deploymentUpdate: post("/v1/deployments/:id"),
  deploymentPause: post("/v1/deployments/:id/pause"),
  deploymentUnpause: post("/v1/deployments/:id/unpause"),
  deploymentStart: post("/v1/deployments/:id/run"),
  deploymentArchive: post("/v1/deployments/:id/archive", IF_MATCH),
  deploymentUnarchive: post("/v1/deployments/:id/unarchive"),
  deploymentRuns: get("/v1/deployment_runs"),
  deploymentRun: get("/v1/deployment_runs/:id"),

  sessions: get("/v1/sessions"),
  session: get("/v1/sessions/:id"),
  sessionEvents: get("/v1/sessions/:id/events"),
  sessionCreate: post("/v1/sessions", "session_create"),
  sessionEventSend: post("/v1/sessions/:id/events", "session_event", ["handler", "confirm"]),
  sessionUpdate: post("/v1/sessions/:id", "session_update"),
  sessionArchive: post("/v1/sessions/:id/archive", IF_MATCH),
  sessionUnarchive: post("/v1/sessions/:id/unarchive"),
  sessionDelete: del("/v1/sessions/:id", IF_MATCH),
  sessionResources: get("/v1/sessions/:id/resources"),
  sessionResource: get("/v1/sessions/:id/resources/:resource_id"),
  sessionResourceAdd: post("/v1/sessions/:id/resources", "session_resource"),
  sessionResourceDelete: del("/v1/sessions/:id/resources/:resource_id"),
  trajectory: get("/v1/oma/sessions/:id/trajectory"),

  evalRuns: get("/v1/oma/evals/runs"),
  evalRun: get("/v1/oma/evals/runs/:id"),

  modelCards: get("/v1/oma/model_cards"),
  modelCard: get("/v1/oma/model_cards/:id"),
  modelCardUpdate: post("/v1/oma/model_cards/:id", "model_card_safe"),
  modelCardArchive: post("/v1/oma/model_cards/:id/archive", IF_MATCH),
  modelCardUnarchive: post("/v1/oma/model_cards/:id/unarchive"),
  modelCardDelete: del("/v1/oma/model_cards/:id", IF_MATCH),
  modelOptions: get("/v1/oma/model_options"),

  harnesses: get("/v1/oma/harnesses"),
  harnessCards: get("/v1/oma/harness_cards"),
  harnessCard: get("/v1/oma/harness_cards/:id"),
  harnessCardUpdate: post("/v1/oma/harness_cards/:id", "harness_card_safe"),
  harnessCardArchive: post("/v1/oma/harness_cards/:id/archive", IF_MATCH),
  harnessCardUnarchive: post("/v1/oma/harness_cards/:id/unarchive"),
  harnessCardDelete: del("/v1/oma/harness_cards/:id", IF_MATCH),
} as const satisfies Record<string, RouteRule>;

/**
 * Dependency reports by kind (crud.md 1.2). One row per kind, so a vault
 * report stays outside the allowlist.
 */
export const DEPENDENCY_KINDS = [
  "agent",
  "environment",
  "session",
  "deployment",
  "file",
  "skill",
  "skill_version",
  "memory_store",
  "model_card",
  "harness_card",
] as const;

export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export const DEPENDENCY_ROUTES: Readonly<Record<DependencyKind, RouteRule>> = Object.fromEntries(
  DEPENDENCY_KINDS.map((kind) => [kind, get(`/v1/oma/dependencies/${kind}/:id`)]),
) as Record<DependencyKind, RouteRule>;

/** Reads the gate and the `confirm` route make on their own. */
export const INTERNAL_ROUTES: readonly RouteRule[] = [ROUTES.session, ROUTES.sessionEvents, ROUTES.sessionEventSend];
