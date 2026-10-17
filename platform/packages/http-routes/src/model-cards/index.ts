// Model cards — CRUD + capability probe.
//
// Sourced from apps/main/src/routes/model-cards.ts. Same wire shape so the
// Console Model Cards page works against CF and main-node without branching.

import { Hono, type Context } from "hono";
import {
  ModelCardDuplicateModelIdError,
  ModelCardNotFoundError,
  ModelCardPreconditionFailedError,
  type ModelCardRow,
  type ModelCardService,
} from "@open-managed-agents/model-cards-store";
import { modelCardProbeUrl } from "./probe-url";

export { modelCardProbeUrl } from "./probe-url";

interface Vars {
  Variables: { tenant_id: string };
}

function toApiShape(card: ModelCardRow) {
  return {
    id: card.id,
    model_id: card.model_id,
    model: card.model,
    provider: card.provider,
    api_key_preview: card.api_key_preview,
    base_url: card.base_url ?? undefined,
    custom_headers: card.custom_headers ?? undefined,
    pi_config: card.pi_config ?? undefined,
    is_default: card.is_default,
    created_at: card.created_at,
    updated_at: card.updated_at ?? undefined,
    archived_at: card.archived_at,
  };
}

/**
 * Revision of a card for ETag and If-Match (builder-agent.md, 2.5 step 8):
 * `updated_at`, for a card without edits `created_at`.
 */
function revisionTag(card: ModelCardRow): string {
  return `"${card.updated_at ?? card.created_at}"`;
}

/**
 * If-Match as one ISO time, quoted or not. `*` and no header mean no
 * precondition. Anything else is invalid.
 */
function readIfMatch(
  header: string | undefined,
): { type: "absent" } | { type: "time"; value: string } | { type: "invalid" } {
  if (header === undefined || header.trim() === "*") return { type: "absent" };
  const match = /^(?:"([^",]+)"|([^",\s]+))$/.exec(header.trim());
  const value = match?.[1] ?? match?.[2];
  const time = value === undefined ? Number.NaN : Date.parse(value);
  if (Number.isNaN(time) || new Date(time).toISOString() !== value) {
    return { type: "invalid" };
  }
  return { type: "time", value };
}

/**
 * Best-effort capability probe for a freshly-created model card. Calls the
 * provider's smallest available endpoint with the user-supplied api_key /
 * base_url / custom_headers and returns ok=true on 2xx, otherwise ok=false
 * with the upstream's own error message.
 *
 * Bounded to 6s. Failures NEVER roll back the card (it's already persisted).
 */
async function probeModelCard(opts: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string | null;
  customHeaders: Record<string, string> | null;
}): Promise<{ ok: boolean; message?: string } | { ok: null; reason: "unsupported_provider" }> {
  const provider = opts.provider.toLowerCase();
  const isAnt = /^(ant|anthropic|ant-compatible)$/.test(provider);
  const isOai = /^(oai|openai|oai-compatible)$/.test(provider);
  if (!isAnt && !isOai) return { ok: null, reason: "unsupported_provider" };

  const url = modelCardProbeUrl(opts.provider, opts.baseUrl);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(opts.customHeaders ?? {}),
  };
  let body: string;
  if (isAnt) {
    headers["x-api-key"] = opts.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = JSON.stringify({
      model: opts.model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  } else {
    headers["authorization"] = `Bearer ${opts.apiKey}`;
    body = JSON.stringify({
      model: opts.model,
      max_completion_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  }

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const upstream = await res.text().catch(() => "");
    let detail = upstream.slice(0, 240).trim();
    try {
      const j = JSON.parse(upstream) as { error?: { message?: string } | string };
      const m =
        typeof j.error === "string"
          ? j.error
          : typeof j.error === "object" && j.error?.message
            ? j.error.message
            : "";
      if (m) detail = m.slice(0, 240);
    } catch {
      /* keep raw */
    }
    return {
      ok: false,
      message: `Provider returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Probe failed: ${msg.slice(0, 120)}` };
  }
}

function parsePageQuery(c: {
  req: { query: (k: string) => string | undefined };
}): {
  limit?: number;
  cursor?: string;
  q?: string;
} {
  const limitParam = c.req.query("limit");
  const cursor = c.req.query("cursor") || c.req.query("page") || undefined;
  const limit = limitParam ? parseInt(limitParam, 10) : undefined;
  const qRaw = c.req.query("q");
  const q = qRaw && qRaw.trim() ? qRaw.trim() : undefined;
  return {
    limit: limit !== undefined && !isNaN(limit) ? limit : undefined,
    cursor,
    q,
  };
}

/** One row of a dependency report (docs/plans/crud.md, 1.2). */
export interface ModelCardDependencyEntry {
  kind: string;
  id: string;
  name: string | null;
  status: string | null;
  note: string | null;
}

export interface ModelCardDependencyReport {
  blocking: ModelCardDependencyEntry[];
  affected: ModelCardDependencyEntry[];
  truncated: boolean;
}

/**
 * Agents that use the card's `model_id` (table 1.3 of docs/plans/crud.md).
 * Without it archive and delete check nothing.
 */
export type ModelCardDependencyCheck = (input: {
  tenantId: string;
  modelId: string;
  operation: "archive" | "delete";
}) => Promise<ModelCardDependencyReport>;

export interface ModelCardRoutesDeps {
  modelCards: ModelCardService;
  dependencies?: ModelCardDependencyCheck;
}

/**
 * The dependency report of archiving or deleting one card. The last active
 * card adds a row: without cards the server key ANTHROPIC_API_KEY works again.
 */
export async function modelCardDependencies(
  deps: ModelCardRoutesDeps,
  input: { tenantId: string; card: ModelCardRow; operation: "archive" | "delete" },
): Promise<ModelCardDependencyReport> {
  const report = deps.dependencies === undefined
    ? { blocking: [], affected: [], truncated: false }
    : await deps.dependencies({
        tenantId: input.tenantId,
        modelId: input.card.model_id,
        operation: input.operation,
      });
  if (input.card.archived_at !== null) return report;
  const active = (await deps.modelCards.list({ tenantId: input.tenantId }))
    .filter((card) => card.archived_at === null);
  if (active.length !== 1 || active[0]?.id !== input.card.id) return report;
  return {
    ...report,
    affected: [
      ...report.affected,
      {
        kind: "model_card",
        id: input.card.id,
        name: input.card.model_id,
        status: "active",
        note: "Снова включится ключ ANTHROPIC_API_KEY",
      },
    ],
  };
}

function dependencyConflictBody(message: string, dependencies: ModelCardDependencyReport) {
  return {
    type: "error",
    error: { type: "dependency_conflict_error", message, dependencies },
  };
}

export function buildModelCardRoutes(deps: ModelCardRoutesDeps) {
  const app = new Hono<Vars>();
  const { modelCards } = deps;

  // POST / — create
  app.post("/", async (c) => {
    const t = c.var.tenant_id;
    const body = await c.req.json<{
      model_id: string;
      model?: string;
      provider: string;
      api_key: string;
      base_url?: string;
      custom_headers?: Record<string, string>;
      pi_config?: Record<string, unknown>;
      is_default?: boolean;
    }>();

    if (!body.model_id || !body.provider || !body.api_key) {
      return c.json({ error: "model_id, provider, and api_key are required" }, 400);
    }
    if (
      body.pi_config !== undefined
      && (body.pi_config === null || typeof body.pi_config !== "object" || Array.isArray(body.pi_config))
    ) {
      return c.json({ error: "pi_config must be a JSON object" }, 400);
    }
    try {
      const card = await modelCards.create({
        tenantId: t,
        modelId: body.model_id,
        provider: body.provider,
        model: body.model,
        apiKey: body.api_key,
        baseUrl: body.base_url ?? null,
        customHeaders: body.custom_headers ?? null,
        piConfig: body.pi_config ?? null,
        makeDefault: !!body.is_default,
      });
      const probe = await probeModelCard({
        provider: body.provider,
        model: body.model ?? body.model_id,
        apiKey: body.api_key,
        baseUrl: body.base_url ?? null,
        customHeaders: body.custom_headers ?? null,
      });
      c.header("ETag", revisionTag(card));
      return c.json({ ...toApiShape(card), probe }, 201);
    } catch (err) {
      if (err instanceof ModelCardDuplicateModelIdError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  // GET / — list (cursor-paginated)
  app.get("/", async (c) => {
    // Pi provider ids are open: built-ins and custom providers share the
    // same exact-match filter. OpenMA does not own an enum here.
    const providerRaw = c.req.query("provider");
    const provider = providerRaw?.trim() || undefined;

    const parseMs = (
      raw: string | undefined,
      field: string,
    ): { value: number | undefined; err?: Response } => {
      if (raw === undefined) return { value: undefined };
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) {
        return {
          value: undefined,
          err: c.json(
            {
              error: {
                type: "invalid_request_error",
                code: "invalid_timestamp",
                message: `Invalid ${field} '${raw}'; expected ISO-8601 timestamp.`,
              },
            },
            400,
          ),
        };
      }
      return { value: ms };
    };
    const createdAfterRes = parseMs(c.req.query("created_after"), "created_after");
    if (createdAfterRes.err) return createdAfterRes.err;
    const createdBeforeRes = parseMs(c.req.query("created_before"), "created_before");
    if (createdBeforeRes.err) return createdBeforeRes.err;

    const page = await modelCards.listPage({
      tenantId: c.var.tenant_id,
      ...parsePageQuery(c),
      ...(provider !== undefined ? { provider } : {}),
      ...(createdAfterRes.value !== undefined
        ? { createdAfter: createdAfterRes.value }
        : {}),
      ...(createdBeforeRes.value !== undefined
        ? { createdBefore: createdBeforeRes.value }
        : {}),
    });
    // Archived cards show only with include_archived=true (docs/plans/crud.md, 4.2).
    const includeArchived = c.req.query("include_archived") === "true";
    const filteredItems = includeArchived
      ? page.items
      : page.items.filter((card) => card.archived_at === null);
    const data = filteredItems.map(toApiShape);
    if (!page.nextCursor) return c.json({ data });
    return c.json({
      data,
      next_page: page.nextCursor,
      next_cursor: page.nextCursor,
    });
  });

  // GET /:id
  app.get("/:id", async (c) => {
    const card = await modelCards.get({
      tenantId: c.var.tenant_id,
      cardId: c.req.param("id"),
    });
    if (!card) return c.json({ error: "Model card not found" }, 404);
    c.header("ETag", revisionTag(card));
    return c.json(toApiShape(card));
  });

  // POST /:id — update
  app.post("/:id", async (c) => {
    const id = c.req.param("id");
    const precondition = readIfMatch(c.req.header("If-Match"));
    if (precondition.type === "invalid") {
      return c.json({ error: "If-Match must be the ETag of this model card" }, 400);
    }
    const body = await c.req.json<{
      model_id?: string;
      model?: string;
      provider?: string;
      api_key?: string;
      base_url?: string | null;
      custom_headers?: Record<string, string> | null;
      pi_config?: Record<string, unknown> | null;
      is_default?: boolean;
    }>();
    if (
      body.pi_config !== undefined
      && body.pi_config !== null
      && (typeof body.pi_config !== "object" || Array.isArray(body.pi_config))
    ) {
      return c.json({ error: "pi_config must be a JSON object or null" }, 400);
    }
    try {
      const updated = await modelCards.update({
        tenantId: c.var.tenant_id,
        cardId: id,
        modelId: body.model_id,
        model: body.model,
        provider: body.provider,
        baseUrl:
          body.base_url === undefined ? undefined : body.base_url || null,
        customHeaders:
          body.custom_headers === undefined
            ? undefined
            : body.custom_headers || null,
        piConfig: body.pi_config,
        apiKey: body.api_key,
        isDefault: body.is_default,
        ...(precondition.type === "time" && {
          expectedUpdatedAt: precondition.value,
        }),
      });
      c.header("ETag", revisionTag(updated));
      return c.json(toApiShape(updated));
    } catch (err) {
      if (err instanceof ModelCardNotFoundError) {
        return c.json({ error: "Model card not found" }, 404);
      }
      if (err instanceof ModelCardPreconditionFailedError) {
        return c.json({ error: err.message }, 412);
      }
      if (err instanceof ModelCardDuplicateModelIdError) {
        return c.json({ error: err.message }, 409);
      }
      throw err;
    }
  });

  // POST /:id/archive, /:id/unarchive and DELETE /:id read If-Match and
  // check dependencies (docs/plans/crud.md, 2.8).
  const changeState = async (
    c: Context<Vars>,
    action: "archive" | "unarchive" | "delete",
  ): Promise<Response> => {
    const id = c.req.param("id")!;
    const tenantId = c.var.tenant_id;
    const precondition = readIfMatch(c.req.header("If-Match"));
    if (precondition.type === "invalid") {
      return c.json({ error: "If-Match must be the ETag of this model card" }, 400);
    }
    const expected = precondition.type === "time"
      ? { expectedUpdatedAt: precondition.value }
      : {};
    try {
      const card = await modelCards.get({ tenantId, cardId: id });
      if (card === null) throw new ModelCardNotFoundError();
      if (precondition.type === "time"
        && Date.parse(precondition.value) !== Date.parse(card.updated_at ?? card.created_at)) {
        throw new ModelCardPreconditionFailedError();
      }
      if (action !== "unarchive") {
        const report = await modelCardDependencies(deps, { tenantId, card, operation: action });
        if (report.blocking.length > 0) {
          return c.json(
            dependencyConflictBody(
              `Cannot ${action} model card ${id}: remove the blocking dependencies first`,
              report,
            ),
            409,
          );
        }
      }
      if (action === "delete") {
        await modelCards.delete({ tenantId, cardId: id, ...expected });
        return c.json({ type: "model_card_deleted", id });
      }
      const changed = action === "archive"
        ? await modelCards.archive({ tenantId, cardId: id, ...expected })
        : await modelCards.unarchive({ tenantId, cardId: id, ...expected });
      c.header("ETag", revisionTag(changed));
      return c.json(toApiShape(changed));
    } catch (err) {
      if (err instanceof ModelCardNotFoundError) {
        return c.json({ error: "Model card not found" }, 404);
      }
      if (err instanceof ModelCardPreconditionFailedError) {
        return c.json({ error: err.message }, 412);
      }
      throw err;
    }
  };

  app.post("/:id/archive", (c) => changeState(c, "archive"));
  app.post("/:id/unarchive", (c) => changeState(c, "unarchive"));
  app.delete("/:id", (c) => changeState(c, "delete"));

  // GET /:id/key — cleartext key (agent / internal consumers)
  app.get("/:id/key", async (c) => {
    const apiKey = await modelCards.getApiKey({
      tenantId: c.var.tenant_id,
      cardId: c.req.param("id"),
    });
    if (apiKey === null) return c.json({ error: "Key not found" }, 404);
    return c.json({ api_key: apiKey });
  });

  return app;
}
