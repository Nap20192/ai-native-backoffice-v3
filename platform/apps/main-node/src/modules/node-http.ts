
/**
 * apps/main-node — Node control-plane assembly for the Open Managed Agents API.
 *
 * createNodeControlPlane(components) is the composition root: it receives the
 * components a deployment chose (see components.ts — database, secrets, auth,
 * email, sandbox, realtime, blobs, store overrides — and the plain NodeConfig
 * from config.ts), builds the stores, Session runtimes and background
 * workers on top of them, mounts the route bundles from
 * @open-managed-agents/http-routes and the Managed Agents API, and returns a
 * handle that owns all of it. Route bodies live in packages/http-routes;
 * storage adapters in their respective packages.
 *
 * nodeDefaults(config) builds the components from configuration alone;
 * index.ts is the executable entrypoint (process.env, listen, signals).
 */

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { requestMetrics, tracerMiddleware } from "@open-managed-agents/observability";

import { listAuthProviders } from "@open-managed-agents/shared";

import { buildModelCardRoutes, buildSessionRoutes, buildTenantRoutes, buildMeRoutes, buildApiKeyRoutes, buildEvalRoutes, sha256Hex } from "@open-managed-agents/http-routes";
import { buildAgentRoutes as buildManagedAgentRoutes, buildManagedSessionsApi } from "@open-managed-agents/managed-agents-api";
import { SessionRuntimeProjectionApplicationService } from "@open-managed-agents/managed-agents-application";

import { managedAgentsPortTokens } from "@open-managed-agents/app/managed-agents";

import { ingestEnvironmentWorkRuntimeEvents, authenticateEnvironmentWorkSessionBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { isCurrentEnvironmentWorkClaim } from "@open-managed-agents/environment-work-store";

import { buildOmaModelsHttpRoutes } from "@open-managed-agents/managed-agents-adapters-http";
import { NodeSessionRouter } from "../lib/node-session-router.js";
import { nodeOutputsAdapter } from "../lib/node-outputs-adapter.js";

import { createAuthMiddleware as buildAuthMw, type ApiKeyResolution } from "@open-managed-agents/auth";
import { ensureTenantSqlite } from "@open-managed-agents/auth-config";

import { join, relative } from "node:path";
import { readFileSync } from "node:fs";
import {
  BRANDING_PATH,
  brandIndexHtml,
  loadConsoleBranding,
  safeBrandingFile,
  staticRoot,
} from "../lib/console-branding.js";

import { buildNodeSkillsRoutes } from "../lib/node-skills-routes.js";
import { buildSkillSourcesRoutes, createSourceFetcher } from "../lib/skill-sources.js";
import { SqlKvStore } from "@open-managed-agents/kv-store/adapters/sql";

import { agentConfigGuard, storedAgentForGuard } from "../lib/agent-config-guard.js";
import { buildModelOptionsRoutes, createWorkspaceCatalog } from "../lib/catalog-routes.js";
import { buildSandboxCatalogRoutes } from "../lib/sandbox-catalog-routes.js";
import { loadSandboxCatalog, sandboxCatalogSettings } from "../lib/sandbox-catalog.js";
import { dependenciesPort } from "@open-managed-agents/app/modules/dependencies";
import {
  buildCrudDependencyRoutes,
  modelCardDependencyCheck,
} from "../lib/crud-dependencies.js";
import { buildNodeHttpMcpProxyRoutes } from "../lib/http-mcp-proxy.js";
import { createNodeAccessLossRuntime } from "../lib/mcp-access-loss.js";
import { buildTraceRoutes } from "../lib/trace/routes.js";
import { mountPlatformMcpMiddleware, mountPlatformMcpRoutes } from "../lib/platform-mcp/node-wiring.js";

import { Disposables } from "../lifecycle.js";

import type { NodeRuntime } from "./node-runtime.js";
import type { NodeControlPlaneApp } from "./node-assembly.js";

export async function mountNodeHttp(runtime: NodeRuntime, disposables: Disposables): Promise<NodeControlPlaneApp> {
  const {
    config,
    logger,
    metrics,
    tracer,
    sql,
    dialect,
    drizzleDb,
    backendDescription,
    authDisabled,
    auth,
    agentsService,
    evalsService,
    environmentsService,
    modelCardsService,
    memoryBlobDescription,
    outputsRoot,
    sessionOutputs,
    filesBlob,
    filesBlobDescription,
    newEventLog,
    hub,
    realtimeDescription,
    sessionRegistry,
    resolveNodeMcpProxyTarget,
    managedSessionRuntimeStream,
    nodeSessionLifecycleHooks,
    managedSessionsComposition,
    managedEnvironmentWorkSessionTokenCrypto,
    managedEnvironmentWorkStore,
    managedDeploymentsRoutes,
    managedDeploymentRunsRoutes,
    managedEnvironmentsRoutes,
    managedEnvironmentWorkRoutes,
    managedDreamsRoutes,
    managedModelsRoutes,
    managedTunnelsRoutes,
    managedTunnelCertificateRoutes,
    managedFilesRoutes,
    managedMemoryStoresRoutes,
    managedMemoriesRoutes,
    managedMemoryVersionsRoutes,
    managedSkillsRoutes,
    managedSkillVersionsRoutes,
    managedPlatform,
    managedVaultsRoutes,
    managedCredentialsRoutes,
    managedUserProfilesRoutes,
    services,
    apiKeyStorage,
    platformMcp,
  } = runtime;
  // ─── HTTP ───────────────────────────────────────────────────────────────

  const app = new Hono<{
    Variables: {
      tenant_id: string;
      user_id?: string;
      auth_credential?: ApiKeyResolution["credential"];
    };
  }>();

  // Observability middleware first so it captures auth failures, rate-limit
  // rejects, and unhandled exceptions. Mirrors apps/main's CF wiring.
  app.use("*", requestMetrics({ recorder: metrics }));
  app.use("*", tracerMiddleware({ tracer }));

  // Prometheus scrape endpoint. When METRICS_BIND_TOKEN is set, callers must
  // pass it in `x-metrics-token`; absent, the endpoint is open on the same
  // port (acceptable for self-host single-operator deploys, documented in
  // .env.example). For prod, ops should either set the token or front the
  // app with a reverse proxy that filters /metrics.
  const metricsToken = config.http.metricsToken;
  app.get("/metrics", async (c) => {
    if (metricsToken && c.req.header("x-metrics-token") !== metricsToken) {
      return c.text("forbidden", 403);
    }
    const text = await metrics.getPromText();
    return new Response(text, {
      headers: { "Content-Type": metrics.promContentType() },
    });
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      runtime: "node",
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      auth: auth === null ? "disabled" : auth.description,
      backends: {
        agents: dialect,
        events: dialect,
        hub: realtimeDescription,
        memory_blobs: memoryBlobDescription,
        files_blobs: filesBlobDescription,
        v1_stream: managedSessionRuntimeStream === null ? "in-memory" : "sql-replicated",
        db: backendDescription,
      },
    }),
  );

  const signInMethods = auth?.signInMethods;
  app.get("/auth-info", (c) =>
    c.json({
      providers: authDisabled
        ? []
        : listAuthProviders({
            emailOtp: config.auth.requireEmailVerify,
            emailPassword: signInMethods?.emailPassword ?? true,
            googleClientId: config.auth.google.clientId,
            googleClientSecret: config.auth.google.clientSecret,
            githubClientId: config.auth.github.clientId,
            githubClientSecret: config.auth.github.clientSecret,
          }),
      // Deployment-configured OpenID Connect providers: [{ id, name }].
      oidc: authDisabled ? [] : signInMethods?.oidc ?? [],
      email_password: !authDisabled && (signInMethods?.emailPassword ?? true),
    }),
  );

  if (auth) {
    app.on(["GET", "POST"], "/auth/*", (c) => auth.handler(c.req.raw));
  }

  // Auth middleware via packages/auth — same five-priority resolution as
  // apps/main on CF.
  const authMw = buildAuthMw({
    disabled: authDisabled,
    bypassPath: (path) => path === "/health" || path.startsWith("/auth/"),
    resolveSession: (headers) => auth ? auth.resolveSession(headers) : Promise.resolve(null),
    resolveApiKey: async (apiKey) => {
      if (config.http.apiKey && apiKey === config.http.apiKey) {
        return { tenantId: "default" };
      }
      const hash = await sha256Hex(apiKey);
      const rec = await apiKeyStorage.findByHash(hash);
      if (!rec) return null;
      return {
        tenantId: rec.tenant_id,
        userId: rec.user_id,
        credential: rec.credential,
      };
    },
    resolveBearerToken: async ({ token, method, path }) => {
      // A one-time token of the platform MCP server (oma-mcp-v1.) opens one
      // request; any other token gives null here (builder-agent.md, 3.3).
      const platformMcpActor = await platformMcp.tokens.resolve({ token, method, path });
      if (platformMcpActor !== null) return platformMcpActor;
      if (managedEnvironmentWorkSessionTokenCrypto === null) return null;
      const scoped = await authenticateEnvironmentWorkSessionBearer({
        token,
        method,
        path,
        crypto: managedEnvironmentWorkSessionTokenCrypto,
        now: () => new Date(),
        isCurrent: (claim) => isCurrentEnvironmentWorkClaim({
          store: managedEnvironmentWorkStore,
          now: () => new Date(),
        }, claim),
      });
      return scoped === null
        ? null
        : {
            tenantId: scoped.workspaceId,
            credential: {
              type: "environment_work_session",
              environmentId: scoped.environmentId,
              sessionId: scoped.sessionId,
              workId: scoped.workId,
              claimedAt: scoped.claimedAt,
              generation: scoped.generation,
            },
          };
    },
    defaultTenantForUser: async (userId) => {
      const row = await sql
        .prepare(
          `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
        )
        .bind(userId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
    hasMembership: async (userId, tenantId) => {
      const row = await sql
        .prepare(
          `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
        )
        .bind(userId, tenantId)
        .first<{ one: number }>();
      return row !== null;
    },
    ensureTenantForUser: (s) => ensureTenantSqlite(sql, s.userId, s.name, s.email),
  });

  const v1 = new Hono<{
    Variables: {
      tenant_id: string;
      user_id?: string;
      auth_credential?: ApiKeyResolution["credential"];
    };
  }>();
  v1.use("*", authMw);
  // Platform MCP server of the assistant: the token guard and the session
  // guard run before every route (docs/plans/builder-agent.md, BS3).
  mountPlatformMcpMiddleware(v1, platformMcp, { sql });
  mountPlatformMcpRoutes(v1, platformMcp);

  v1.post("/oma/sessions/:sessionId/runtime-events", async (c) => {
    const credential = c.get("auth_credential");
    if (credential?.type !== "environment_work_session") {
      return c.json({ error: "Environment Work session credential required" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be valid JSON" }, 400);
    }
    const result = await ingestEnvironmentWorkRuntimeEvents({
      claim: {
        workspaceId: c.get("tenant_id"),
        environmentId: credential.environmentId,
        sessionId: credential.sessionId,
        workId: credential.workId,
        generation: credential.generation,
      },
      sessionId: c.req.param("sessionId"),
      body,
      projection: new SessionRuntimeProjectionApplicationService({
        workspaceId: c.get("tenant_id"),
        persistence: managedSessionsComposition.runtimeProjection,
      }),
      publish: async () => {},
    });
    if (result.type === "recorded") {
      return c.json({ data: result.eventIds.map((id) => ({ id })) }, 200);
    }
    if (result.type === "invalid_request") {
      return c.json({ error: result.message }, 400);
    }
    if (result.type === "not_found") return c.json({ error: "Session not found" }, 404);
    if (result.type === "forbidden") return c.json({ error: "Forbidden" }, 403);
    return c.json({ error: result.type }, 409);
  });

  // Models (docs/plans/models-harness.md): the model catalog route and the
  // guard that checks an agent's model and harness before the shared route
  // stores it. Only the built-in Pi loop runs agents (D41).
  const catalog = createWorkspaceCatalog({
    listCards: (workspaceId) => modelCardsService.list({ tenantId: workspaceId }),
    serverKey: {
      available: Boolean(config.model.apiKey?.trim()),
      baseUrl: config.model.baseUrl ?? null,
    },
  });
  v1.route("/oma/model_options", buildModelOptionsRoutes(catalog));
  // Image catalog for the environment page (docs/plans/environments.md, 1.5).
  // Read on each request, like the VM image lookup in node-managed.ts.
  const sandboxCatalog = sandboxCatalogSettings(config.sandbox.environment);
  v1.route("/oma/sandbox-catalog", buildSandboxCatalogRoutes({ catalog: () => loadSandboxCatalog(sandboxCatalog) }));
  // Archive and delete check dependencies (docs/plans/crud.md, 1.2 and 1.3).
  const crudDependenciesFor = (workspaceId: string) =>
    managedPlatform.app({ workspaceId }).port(dependenciesPort);
  v1.route("/oma/dependencies", buildCrudDependencyRoutes({
    dependenciesFor: crudDependenciesFor,
    modelCards: modelCardsService,
  }));
  v1.use("/agents/*", agentConfigGuard({
    models: async (workspaceId) => (await catalog.modelOptions(workspaceId)).data,
    loadAgent: async (workspaceId, agentId) => {
      const found = await managedPlatform
        .app({ workspaceId })
        .port(managedAgentsPortTokens.agents)
        .retrieveAgent({ agentId });
      return found.type === "found" ? storedAgentForGuard(found.agent) : null;
    },
  }));

  // Mount route bundles. The legacy duplicates /v1/oma/agents, environments,
  // memory_stores, files and dreams were removed (docs/plans/cleanup.md, 4.6);
  // the legacy session stack under /v1/oma/sessions stays.
  v1.route("/agents", buildManagedAgentRoutes((context) =>
    managedPlatform
      .app({
        workspaceId: (context.var as { tenant_id: string }).tenant_id,
      })
      .port(managedAgentsPortTokens.agents),
  ));
  const sessionRouter = new NodeSessionRouter({
    sql,
    hub,
    registry: sessionRegistry,
    newEventLog,
  });
  v1.route("/sessions", buildManagedSessionsApi({
    sessions: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessions,
    sessionEvents: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessionEvents,
    sessionResources: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessionResources,
    sessionThreads: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessionThreads,
    sessionThreadEvents: (context) =>
      managedSessionsComposition.portsFor(
        (context.var as { tenant_id: string }).tenant_id,
      ).sessionThreadEvents,
  }, {
    outputs: {
      workspaceId: (context) =>
        (context.var as { tenant_id: string }).tenant_id,
      store: sessionOutputs,
    },
  }));
  // Agent trace (docs/plans/agent-trace.md, 3.2): GET /:id/trace, its search
  // and the OTLP download, mounted before the generic /oma/sessions routes.
  v1.route("/oma/sessions", buildTraceRoutes({ sql, dialect }));
  v1.route("/oma/sessions", buildSessionRoutes({
    services,
    router: sessionRouter,
    outputs: nodeOutputsAdapter(outputsRoot),
    lifecycle: nodeSessionLifecycleHooks,
    // Node has no per-tenant cloud environments on this legacy route. The
    // loadEnvironment hook returns a synthetic snapshot for the environment_id
    // the request names, so session create doesn't 404.
    loadEnvironment: async ({ environmentId }) => {
      return {
        id: environmentId,
        runtime: "local",
        sandbox_template: null,
      } as unknown as import("@open-managed-agents/shared").EnvironmentConfig;
    },
  }));
  v1.route("/oma/mcp-proxy", buildNodeHttpMcpProxyRoutes({
    resolveTarget: resolveNodeMcpProxyTarget,
    accessLoss: await createNodeAccessLossRuntime(sql),
  }));
  v1.route("/vaults", managedVaultsRoutes);
  v1.route("/vaults", managedCredentialsRoutes);
  v1.route("/user_profiles", managedUserProfilesRoutes);
  v1.route("/memory_stores", managedMemoryStoresRoutes);
  v1.route("/memory_stores", managedMemoriesRoutes);
  v1.route("/memory_stores", managedMemoryVersionsRoutes);
  v1.route("/models", managedModelsRoutes);
  v1.route("/skills", managedSkillsRoutes);
  v1.route("/skills", managedSkillVersionsRoutes);
  v1.route("/deployments", managedDeploymentsRoutes);
  v1.route("/deployment_runs", managedDeploymentRunsRoutes);
  v1.route("/environments", managedEnvironmentWorkRoutes);
  v1.route("/dreams", managedDreamsRoutes);
  v1.route("/tunnels", managedTunnelsRoutes);
  v1.route("/tunnels", managedTunnelCertificateRoutes);
  v1.route("/oma/me", buildMeRoutes({
    services,
    authDisabled,
    loadUser: async (userId) => {
      const user = auth ? await auth.findUser(userId) : null;
      return user ? { id: userId, email: user.email ?? "", name: user.name } : null;
    },
    loadTenant: async (tenantId) => {
      const r = await sql
        .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
        .bind(tenantId)
        .first<{ id: string; name: string }>();
      return r ?? null;
    },
    listMemberships: async (userId) => {
      const r = await sql
        .prepare(
          `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
             FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
            WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
        )
        .bind(userId)
        .all<{ id: string; name: string; role: string; created_at: number }>();
      return r.results ?? [];
    },
  }));
  v1.route("/oma/tenants", buildTenantRoutes({ services, memberSql: sql, loadMemberUser: async (id) => {
    const user = auth ? await auth.findUser(id) : null;
    return user ? { name: user.name, email: user.email ?? undefined } : null;
  } }));
  v1.route("/oma/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
  v1.route("/oma/evals", buildEvalRoutes({
    evals: evalsService,
    agents: agentsService,
    environments: environmentsService,
  }));

  async function countManagedPages(
    load: (cursor?: string) => Promise<{
      items: readonly unknown[];
      nextCursor: string | null;
    }>,
  ): Promise<number> {
    let total = 0;
    let cursor: string | undefined;
    const visited = new Set<string>();

    for (;;) {
      const page = await load(cursor);
      total += page.items.length;
      if (page.nextCursor === null) return total;
      if (visited.has(page.nextCursor)) {
        throw new Error(`Managed stats pagination repeated cursor ${page.nextCursor}`);
      }
      visited.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  // OMA-only stubs used by the self-hosted console.
  v1.route("/oma/skills", buildNodeSkillsRoutes({ db: drizzleDb, blobs: filesBlob }));
  v1.route("/oma/skill-sources", buildSkillSourcesRoutes({
    fetcher: createSourceFetcher({ allowHosts: config.skillSources.allowHosts }),
    kvFor: (tenantId) => new SqlKvStore({ db: drizzleDb, tenantId }),
    skillsFor: (tenantId) => {
      const managedApp = managedPlatform.app({ workspaceId: tenantId });
      return {
        skills: managedApp.port(managedAgentsPortTokens.skills),
        versions: managedApp.port(managedAgentsPortTokens.skillVersions),
      };
    },
  }));
  v1.get("/oma/stats", async (c) => {
    const tenantId = c.get("tenant_id");
    const managedApp = managedPlatform.app({ workspaceId: tenantId });
    const managedAgents = managedApp.port(managedAgentsPortTokens.agents);
    const managedEnvironments = managedApp.port(managedAgentsPortTokens.environments);
    const managedSessions = managedSessionsComposition.portsFor(tenantId).sessions;
    const managedSkills = managedPlatform
      .app({ workspaceId: tenantId })
      .port(managedAgentsPortTokens.skills);
    const managedVaults = managedPlatform
      .app({ workspaceId: tenantId })
      .port(managedAgentsPortTokens.vaults);
    const [
      agents,
      sessions,
      environments,
      vaults,
      skills,
      modelCards,
      apiKeys,
    ] = await Promise.all([
      countManagedPages(async (cursor) => {
        const result = await managedAgents.listAgents({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.agents, nextCursor: result.page.nextCursor };
      }),
      countManagedPages(async (cursor) => {
        const result = await managedSessions.listSessions({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.sessions, nextCursor: result.page.nextCursor };
      }),
      countManagedPages(async (cursor) => {
        const result = await managedEnvironments.listEnvironments({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.environments, nextCursor: result.page.nextCursor };
      }),
      countManagedPages(async (cursor) => {
        const result = await managedVaults.listVaults({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.vaults, nextCursor: result.page.nextCursor };
      }),
      countManagedPages(async (cursor) => {
        const result = await managedSkills.listSkills({
          pageSize: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (result.type !== "page") throw new Error(result.message);
        return { items: result.page.skills, nextCursor: result.page.nextCursor };
      }),
      modelCardsService.list({ tenantId }),
      apiKeyStorage.listByTenant(tenantId),
    ]);

    return c.json({
      agents,
      sessions,
      environments,
      vaults,
      skills,
      model_cards: modelCards.filter((card) => card.archived_at === null).length,
      api_keys: apiKeys.length,
    });
  });
  v1.route("/environments", managedEnvironmentsRoutes);
  v1.route("/files", managedFilesRoutes);
  v1.route("/oma/model_cards", buildModelCardRoutes({
    modelCards: modelCardsService,
    dependencies: modelCardDependencyCheck(crudDependenciesFor),
  }));
  v1.route("/oma/models", buildOmaModelsHttpRoutes({
    fetch: (input, init) => fetch(input, init),
  }));

  app.route("/v1", v1);

  // ── Console branding (optional) ──
  // Served whether or not this process serves the console, so a console on
  // another origin (or the Vite dev server's proxy) can read it too.
  const brandingDir = config.http.brandingDir;
  const branding = brandingDir ? loadConsoleBranding(brandingDir) : null;
  if (brandingDir && branding) {
    const brandingRoot = staticRoot(brandingDir);
    app.get(`${BRANDING_PATH}/branding.json`, (c) =>
      c.json(branding, 200, { "cache-control": "no-cache" }),
    );
    app.get(`${BRANDING_PATH}/*`, async (c, next) => {
      const name = c.req.path.slice(BRANDING_PATH.length + 1);
      if (!safeBrandingFile(name)) return c.json({ error: "not found" }, 404);
      return serveStatic({
        root: brandingRoot,
        rewriteRequestPath: (path) => path.slice(BRANDING_PATH.length),
      })(c, next);
    });
    logger.info({ op: "main-node.console_branding", dir: brandingDir, product_name: branding.product_name }, "console branding served");
  }

  // ── Console UI (optional) ──
  const consoleDir = config.http.consoleDir;
  if (consoleDir) {
    const cwd = process.cwd();
    const rootRel = consoleDir.startsWith("/")
      ? relative(cwd, consoleDir)
      : consoleDir;
    // With branding, index.html carries the title, favicon, and stylesheet
    // so the first paint is already branded.
    let brandedIndex: string | null = null;
    const indexHtml = branding
      ? () => (brandedIndex ??= brandIndexHtml(readFileSync(join(consoleDir, "index.html"), "utf8"), branding))
      : null;
    if (indexHtml) {
      app.get("/", (c) => c.html(indexHtml()));
      app.get("/index.html", (c) => c.html(indexHtml()));
    }
    app.use("/*", serveStatic({ root: rootRel }));
    // SPA fallback for client-side routes ONLY. Never serve index.html for
    // API/auth/health paths — a missing /v1/* handler used to fall through
    // here and the console would fail with
    // `Unexpected token '<' ... is not valid JSON` (HTML parsed as JSON).
    app.get("/*", async (c, next) => {
      const p = c.req.path;
      if (
        p === "/health" ||
        p.startsWith("/v1/") ||
        p.startsWith("/auth") ||
        p.startsWith(BRANDING_PATH)
      ) {
        return next();
      }
      if (indexHtml) return c.html(indexHtml());
      return serveStatic({ root: rootRel, path: "index.html" })(c, next);
    });
    logger.info({ op: "main-node.console_ui", dir: consoleDir, cwd_rel: rootRel }, "console UI served");
  }

  // Nested requests of the platform MCP server never leave the process.
  platformMcp.bindApp((request) => Promise.resolve(app.fetch(request)));

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    logger.error({ err, op: "main-node.unhandled" }, "unhandled error");
    return c.json({ error: "internal_error", message: err.message }, 500);
  });

  return app;
}
