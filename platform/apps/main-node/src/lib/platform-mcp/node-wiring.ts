// Wiring of the platform MCP server into main-node (docs/plans/builder-agent.md, BS3).
//
// `createPlatformMcpNode` builds the stores of BS2, the one-time tokens, the
// proxy target and the deps of BS1 from what main-node already has.
// `node-managed.ts` creates it next to `resolveNodeMcpProxyTarget`,
// `node-http.ts` mounts its middleware and routes and binds `app.fetch`.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { JSON_SCHEMA, load } from "js-yaml";
import {
  agentCreateBodySchema,
  agentUpdateBodySchema,
  deploymentCreateBodySchema,
  deploymentUpdateBodySchema,
  environmentCreateBodySchema,
  environmentUpdateBodySchema,
  memoryCreateBodySchema,
  memoryStoreCreateBodySchema,
  memoryStoreUpdateBodySchema,
  memoryUpdateBodySchema,
  sessionCreateBodySchema,
  userDefineOutcomeEventInputSchema,
} from "@open-managed-agents/managed-agents-api";
import type { Session } from "@open-managed-agents/managed-agents-application";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { NodeMcpProxyTarget } from "../http-mcp-proxy.js";
import { createActionStore, type ActionStore } from "./action-store.js";
import { buildActionsRoutes } from "./actions-routes.js";
import { createActorTokenGuard, createActorTokens, type ActorTokens } from "./actor-token.js";
import { buildBuilderBundleRoutes } from "./builder-bundle.js";
import { assistantDir } from "./builder-template.js";
import { canonicalJson } from "./canonical-json.js";
import { createConfirmationStore, type ConfirmationListStore } from "./confirmation-store.js";
import { buildDocsIndex, searchDocs, type DocsSection } from "./docs-search.js";
import { createKnownSecrets, type KnownSecretSources } from "./known-secrets.js";
import { createSessionOwnerStore, type SessionOwnerStore } from "./owner-store.js";
import type { ContractSchemas, GateHooks, InnerFetch, PlatformMcpDeps, PlatformMcpLibs } from "./ports.js";
import { createActorIsCurrent, createPlatformMcpTargetResolver, type PlatformMcpTargetResolver } from "./proxy-target.js";
import { buildConfirmRoutes, buildPlatformMcpRoutes } from "./routes.js";
import { scanSecrets } from "./secret-scan.js";
import { createSessionGuard } from "./session-guard-middleware.js";
import { createSessionToolCheck } from "./session-tool-check.js";
import { buildSettingsRoutes } from "./settings-routes.js";
import { createMembershipRoles, createSettingsStore, type MembershipRoles, type SettingsStore } from "./settings-store.js";
import { validateSkillSpec } from "./skill-spec.js";
import { routeAllowlist } from "./tool-table.js";
import { redactUrl } from "./url-redact.js";
import { yamlDiff } from "./yaml-diff.js";

export const PLATFORM_MCP_PATH = "/v1/oma/platform-mcp";

/** zod schemas of `P/managed-agents-api` the tools check a body with. */
export const contractSchemas: ContractSchemas = {
  agent: { create: agentCreateBodySchema, update: agentUpdateBodySchema },
  environment: { create: environmentCreateBodySchema, update: environmentUpdateBodySchema },
  deployment: { create: deploymentCreateBodySchema, update: deploymentUpdateBodySchema },
  memory: { create: memoryCreateBodySchema, update: memoryUpdateBodySchema },
  memory_store: { create: memoryStoreCreateBodySchema, update: memoryStoreUpdateBodySchema },
  session: { create: sessionCreateBodySchema },
  outcome: { create: userDefineOutcomeEventInputSchema },
};

// ---------- BX2 helpers behind the ports of BS1 ----------

function parseYaml(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: load(text, { schema: JSON_SCHEMA }) ?? null };
  } catch {
    return { ok: false };
  }
}

function linesDiff(before: string, after: string): string {
  const oldLines = before.trim() === "" ? [] : before.trimEnd().split("\n");
  const newLines = after.trim() === "" ? [] : after.trimEnd().split("\n");
  return [
    "--- before",
    "+++ after",
    `@@ -${oldLines.length === 0 ? 0 : 1},${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join("\n") + "\n";
}

function skillDirectory(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

/** The ports of BS1 over the pure functions of BX2. `documents` feed `search_docs`. */
export function createPlatformMcpLibs(documents: readonly { name: string; content: string }[]): PlatformMcpLibs {
  const index: DocsSection[] = buildDocsIndex(documents);
  return {
    canonicalJson,
    scan(text, known) {
      const result = scanSecrets(text, known);
      return { text: result.text, count: result.masked_count };
    },
    hasKeyPattern: (text) => scanSecrets(text, []).masked_count > 0,
    redactUrl,
    yamlDiff(before, after) {
      if (before === after) return "";
      if (before.trim() === "") return linesDiff("", after);
      const a = parseYaml(before);
      const b = parseYaml(after);
      if (!a.ok || !b.ok) return linesDiff(before, after);
      return yamlDiff(a.value, b.value).diff;
    },
    checkSkill(files) {
      const skill = files.find((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
      if (!skill) return { ok: false, errors: ["Нет файла SKILL.md"] };
      const result = validateSkillSpec(skill.content, skillDirectory(skill.path));
      return { ok: result.valid, errors: result.errors };
    },
    searchDocs(query, limit) {
      return searchDocs(index, query, limit).map((section) => ({
        document: section.document,
        heading: section.heading,
        text: section.content,
      }));
    },
  };
}

/** Documents of `K/docs` for `search_docs`. An image without the folder gets no documents. */
export function readAssistantDocs(dir = join(assistantDir(), "docs")): { name: string; content: string }[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
  } catch {
    return [];
  }
}

// ---------- known secrets ----------

function snakeKey(key: string): string {
  if (key === "openma") return "_oma";
  if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) return key;
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** A stored camelCase document in the snake_case API shape that `secret-fields.ts` paths use. */
export function apiShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(apiShape);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeKey(key), apiShape(item)]));
}

const PAGE = 200;

async function allPages<T>(page: (last: T | undefined) => Promise<T[]>): Promise<T[]> {
  const found: T[] = [];
  let last: T | undefined;
  for (;;) {
    const rows = await page(last);
    found.push(...rows);
    if (rows.length < PAGE) return found;
    last = rows[rows.length - 1];
  }
}

interface Paged<P> {
  list(input: { workspaceId: string; limit: number; includeArchived: boolean; position?: P }): Promise<unknown[]>;
}

export interface NodeKnownSecretStores {
  sql: SqlClient;
  vaults: Paged<{ createdAt: string; vaultId: string }>;
  credentials: {
    list(input: {
      workspaceId: string;
      vaultId: string;
      limit: number;
      includeArchived: boolean;
      position?: { createdAt: string; credentialId: string };
    }): Promise<Array<{ credential: unknown }>>;
  };
  deployments: Paged<{ createdAt: string; deploymentId: string }>;
  tunnels: Paged<{ createdAt: string; tunnelId: string }>;
  /** The token of a tunnel, as `reveal_token` derives it. */
  tunnelToken(workspaceId: string, tunnel: unknown): Promise<string | null>;
  modelCards: {
    list(input: { tenantId: string }): Promise<Array<{ id: string }>>;
    getApiKey(input: { tenantId: string; cardId: string }): Promise<string | null>;
  };
  /** Opens a sealed GitHub token of a session resource. */
  openSessionSecret(sealed: string): Promise<string>;
}

const field = (value: unknown, key: string): any => (value as Record<string, unknown> | null | undefined)?.[key];

/** Sources of `known-secrets.ts`: every field labelled `secret`, archived objects too, decrypted in memory. */
export function createNodeKnownSecretSources(stores: NodeKnownSecretStores): KnownSecretSources {
  const documents = async (sqlText: string, workspaceId: string) => {
    const rows = await stores.sql.prepare(sqlText).bind(workspaceId).all<{ document: string }>();
    return (rows.results ?? []).map((row) => apiShape(JSON.parse(row.document)));
  };
  return {
    agentVersions: (workspaceId) =>
      documents("SELECT document FROM managed_agent_versions WHERE workspace_id = ?", workspaceId),
    async sessions(workspaceId) {
      const sessions = await documents("SELECT document FROM managed_sessions WHERE workspace_id = ?", workspaceId);
      const rows = await stores.sql
        .prepare("SELECT sealed_value FROM managed_session_resource_secrets WHERE workspace_id = ?")
        .bind(workspaceId)
        .all<{ sealed_value: string }>();
      const tokens = await Promise.all((rows.results ?? []).map((row) => stores.openSessionSecret(row.sealed_value)));
      return [...sessions, { resources: tokens.map((token) => ({ authorization_token: token })) }];
    },
    async deployments(workspaceId) {
      const records = await allPages((last) =>
        stores.deployments.list({
          workspaceId,
          limit: PAGE,
          includeArchived: true,
          ...(last === undefined
            ? {}
            : { position: { createdAt: field(field(last, "deployment"), "createdAt"), deploymentId: field(field(last, "deployment"), "id") } }),
        }),
      );
      return records.map((record) => ({
        ...(apiShape(field(record, "deployment")) as object),
        resources: ((field(record, "resourceSecrets") ?? []) as unknown[]).map((secret) => ({
          authorization_token: field(secret, "authorizationToken"),
        })),
      }));
    },
    async credentials(workspaceId) {
      const vaults = await allPages((last) =>
        stores.vaults.list({
          workspaceId,
          limit: PAGE,
          includeArchived: true,
          ...(last === undefined ? {} : { position: { createdAt: field(field(last, "vault"), "createdAt"), vaultId: field(field(last, "vault"), "id") } }),
        }),
      );
      const found: unknown[] = [];
      for (const vault of vaults) {
        const vaultId = field(field(vault, "vault"), "id") as string;
        const records = await allPages<{ credential: unknown }>((last) =>
          stores.credentials.list({
            workspaceId,
            vaultId,
            limit: PAGE,
            includeArchived: true,
            ...(last === undefined
              ? {}
              : { position: { createdAt: field(last.credential, "createdAt"), credentialId: field(last.credential, "id") } }),
          }),
        );
        for (const record of records) found.push(apiShape(record.credential));
      }
      return found;
    },
    async modelCards(workspaceId) {
      const cards = await stores.modelCards.list({ tenantId: workspaceId });
      return Promise.all(
        cards.map(async (card) => ({
          ...card,
          api_key: await stores.modelCards.getApiKey({ tenantId: workspaceId, cardId: card.id }).catch(() => null),
        })),
      );
    },
    async tunnels(workspaceId) {
      const records = await allPages((last) =>
        stores.tunnels.list({
          workspaceId,
          limit: PAGE,
          includeArchived: true,
          ...(last === undefined
            ? {}
            : { position: { createdAt: field(field(field(last, "aggregate"), "tunnel"), "createdAt"), tunnelId: field(field(field(last, "aggregate"), "tunnel"), "id") } }),
        }),
      );
      return Promise.all(
        records.map(async (record) => ({ tunnel_token: await stores.tunnelToken(workspaceId, field(field(record, "aggregate"), "tunnel")) })),
      );
    },
  };
}

// ---------- the node runtime of the server ----------

export interface PlatformMcpNodeInput {
  sql: SqlClient;
  platformMcpUrl: string;
  consoleUrl?: string;
  loadSession(workspaceId: string, sessionId: string): Promise<Session | null>;
  knownSecretSources: KnownSecretSources;
  displayNameOf?(userId: string): Promise<string | null>;
  documents?: readonly { name: string; content: string }[];
}

export interface PlatformMcpNode {
  platformMcpUrl: string;
  tokens: ActorTokens;
  deps: PlatformMcpDeps;
  /** Test hooks of the gate and the confirm route. Production leaves them empty. */
  hooks: GateHooks;
  target: PlatformMcpTargetResolver;
  owners: SessionOwnerStore;
  actions: ActionStore;
  confirmations: ConfirmationListStore;
  settings: SettingsStore;
  roles: MembershipRoles;
  loadSession: PlatformMcpNodeInput["loadSession"];
  /** `app.fetch` of main-node: nested requests and the proxy target use it. */
  bindApp(fetch: InnerFetch): void;
  /** Answer of `resolveNodeMcpProxyTarget` for the platform server, `undefined` for any other server. */
  resolveProxyTarget(input: { tenantId: string; sessionId: string; serverName: string }): Promise<NodeMcpProxyTarget | null | undefined>;
}

export function createPlatformMcpNode(input: PlatformMcpNodeInput): PlatformMcpNode {
  let appFetch: InnerFetch | null = null;
  const innerFetch: InnerFetch = (request) => {
    if (appFetch === null) return Promise.reject(new Error("platform MCP: app.fetch is not bound yet"));
    return appFetch(request);
  };
  const owners = createSessionOwnerStore(input.sql, input.displayNameOf ? { displayNameOf: input.displayNameOf } : {});
  const actions = createActionStore(input.sql);
  const confirmations = createConfirmationStore(input.sql);
  const settings = createSettingsStore(input.sql);
  const roles = createMembershipRoles(input.sql);
  const toolCheck = createSessionToolCheck({ platformMcpUrl: input.platformMcpUrl, loadSession: input.loadSession });
  const tokens = createActorTokens({
    isCurrent: createActorIsCurrent({ loadSession: input.loadSession, owners, toolCheck }),
  });
  const target = createPlatformMcpTargetResolver({
    platformMcpUrl: input.platformMcpUrl,
    loadSession: input.loadSession,
    owners,
    toolCheck,
    tokens,
    fetcher: innerFetch,
  });
  const hooks: GateHooks = {};
  const deps: PlatformMcpDeps = {
    innerFetch,
    tokens,
    actions,
    confirmations,
    owners,
    knownSecrets: createKnownSecrets(input.knownSecretSources),
    sessionToolCheck: toolCheck,
    assistantSwitch: settings,
    libs: createPlatformMcpLibs(input.documents ?? readAssistantDocs()),
    schemas: contractSchemas,
    platformMcpUrl: input.platformMcpUrl,
    ...(input.consoleUrl === undefined ? {} : { consoleUrl: input.consoleUrl }),
    hooks,
  };
  return {
    platformMcpUrl: input.platformMcpUrl,
    tokens,
    deps,
    hooks,
    target,
    owners,
    actions,
    confirmations,
    settings,
    roles,
    loadSession: input.loadSession,
    bindApp(fetch) {
      appFetch = fetch;
    },
    async resolveProxyTarget(request) {
      const result = await target.resolve(request);
      return result.kind === "platform" ? result.target : undefined;
    },
  };
}

type V1 = Hono<any>;

export interface MountPlatformMcpOptions {
  sql: SqlClient;
}

/**
 * Middleware right after the auth middleware of `/v1`, before every route:
 * the token guard checks path, body hash and body rule of a `route` token,
 * the session guard keeps the assistant session to its owner and records the
 * owner of every new session.
 */
export function mountPlatformMcpMiddleware(v1: V1, node: PlatformMcpNode, options: MountPlatformMcpOptions): void {
  v1.use("*", createActorTokenGuard({ allowlist: routeAllowlist, endpointPath: new URL(node.platformMcpUrl).pathname }));
  v1.use(
    "*",
    createSessionGuard({
      platformMcpUrl: node.platformMcpUrl,
      loadSession: node.loadSession,
      owners: node.owners,
      roles: node.roles,
      findToolUse: (workspaceId, sessionId, toolUseId) => findToolUse(options.sql, workspaceId, sessionId, toolUseId),
    }),
  );
}

/** Routes of the server under `/v1/oma/platform-mcp`. */
export function mountPlatformMcpRoutes(v1: V1, node: PlatformMcpNode): void {
  v1.route("/oma/platform-mcp/settings", buildSettingsRoutes({ settings: node.settings, roles: node.roles }));
  v1.route("/oma/platform-mcp/actions", buildActionsRoutes({ actions: node.actions, confirmations: node.confirmations }));
  v1.route("/oma/platform-mcp/builder-bundle", buildBuilderBundleRoutes({ platformMcpUrl: node.platformMcpUrl }));
  v1.route("/oma/platform-mcp", buildConfirmRoutes(node.deps));
  v1.route("/oma/platform-mcp", buildPlatformMcpRoutes(node.deps));
}

async function findToolUse(
  sql: SqlClient,
  workspaceId: string,
  sessionId: string,
  toolUseId: string,
): Promise<{ mcpServerName: string | null } | null> {
  const row = await sql
    .prepare("SELECT type, document FROM managed_session_events WHERE workspace_id = ? AND session_id = ? AND id = ?")
    .bind(workspaceId, sessionId, toolUseId)
    .first<{ type: string; document: string }>();
  if (row === null) return null;
  if (row.type !== "agent.mcp_tool_use" && row.type !== "agent.tool_use" && row.type !== "agent.custom_tool_use") return null;
  let document: Record<string, unknown> = {};
  try {
    document = JSON.parse(row.document) as Record<string, unknown>;
  } catch {
    document = {};
  }
  const name = document.mcpServerName ?? document.mcp_server_name;
  return { mcpServerName: row.type === "agent.mcp_tool_use" ? (typeof name === "string" ? name : null) : "" };
}
