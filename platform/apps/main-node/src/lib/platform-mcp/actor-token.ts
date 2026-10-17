// One-time tokens of the platform MCP server (docs/plans/builder-agent.md 3.3).
//
// `endpoint` opens one `POST /v1/oma/platform-mcp`, `route` opens one nested
// `/v1/...` request bound to the method, the exact path and the sha256 of the
// raw body. Tokens live only in the memory of this process: a restart drops
// them all. The auth middleware of `P/auth` calls `resolve` through
// `resolveBearerToken`; `createActorTokenGuard` runs after it and checks the
// query string, the body hash and the body rule of the route allowlist.

import { createHash, randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import {
  PLATFORM_MCP_ENDPOINT_PATH,
  type ApiKeyResolution,
  type BearerTokenRequest,
  type PlatformMcpActorCredential,
} from "@open-managed-agents/auth";
import type { ActorClaims, RouteAllowlist, RouteTokenIssuer, RouteTokenIssuerKind, RouteTokenRequest } from "./ports";

export const ACTOR_TOKEN_PREFIX = "oma-mcp-v1.";
export const ACTOR_TOKEN_TTL_MS = 60_000;

export interface ActorTokenClaims {
  kind: "endpoint" | "route";
  issuer?: RouteTokenIssuerKind;
  workspaceId: string;
  userId: string;
  sessionId: string;
  method: string;
  /** Exact path with the query string. */
  path: string;
  bodySha256?: string;
  toolUseId?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface EndpointTokenRequest {
  workspaceId: string;
  userId: string;
  sessionId: string;
  /** Path of `PLATFORM_MCP_URL`; `/v1/oma/platform-mcp` by default. */
  path?: string;
}

export interface ActorTokensOptions {
  /** Epoch milliseconds. */
  now?: () => number;
  ttlMs?: number;
  /**
   * The session exists and is not archived, its owner is the token user and
   * its tool set is valid (3.3, `isCurrent`). Runs on every resolve.
   */
  isCurrent?: (claims: ActorTokenClaims) => Promise<boolean>;
}

export interface ActorTokens extends RouteTokenIssuer {
  issueEndpoint(request: EndpointTokenRequest): string;
  /**
   * Removes the token from the map and returns its claims, in one synchronous
   * step. Of two requests with one token only the first gets the claims.
   */
  take(token: string): ActorTokenClaims | null;
  /** For `resolveBearerToken` of `P/auth`. Null for a token of another kind. */
  resolve(request: BearerTokenRequest): Promise<ApiKeyResolution | null>;
  /** Drops expired tokens. */
  sweep(): void;
  /** Drops every token, as a restart does. */
  clear(): void;
  size(): number;
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function pathnameOf(path: string): string {
  return path.split("?", 1)[0] ?? "";
}

function samePath(a: string, b: string): boolean {
  return a === b || safeDecode(a) === safeDecode(b);
}

function credentialOf(claims: ActorTokenClaims, kind: PlatformMcpActorCredential["kind"]): PlatformMcpActorCredential {
  return {
    type: "platform_mcp_actor",
    kind,
    sessionId: claims.sessionId,
    method: claims.method,
    path: claims.path,
    ...(claims.issuer === undefined ? {} : { issuer: claims.issuer }),
    ...(claims.bodySha256 === undefined ? {} : { bodySha256: claims.bodySha256 }),
    ...(claims.toolUseId === undefined ? {} : { toolUseId: claims.toolUseId }),
    expiresAt: new Date(claims.expiresAt).toISOString(),
  };
}

/** A token that must not open anything: used, expired, unknown or not current. */
function refused(path: string, claims?: ActorTokenClaims): ApiKeyResolution {
  return {
    tenantId: claims?.workspaceId ?? "",
    credential: {
      type: "platform_mcp_actor",
      kind: "refused",
      sessionId: claims?.sessionId ?? "",
      method: claims?.method ?? "",
      path,
      expiresAt: new Date(0).toISOString(),
    },
  };
}

export function createActorTokens(options: ActorTokensOptions = {}): ActorTokens {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? ACTOR_TOKEN_TTL_MS;
  const map = new Map<string, ActorTokenClaims>();

  function sweep(): void {
    const time = now();
    for (const [key, claims] of map) if (claims.expiresAt <= time) map.delete(key);
  }

  function issue(claims: Omit<ActorTokenClaims, "expiresAt">): string {
    sweep();
    const secret = Buffer.from(randomBytes(32)).toString("base64url");
    map.set(secret, { ...claims, method: claims.method.toUpperCase(), expiresAt: now() + ttl });
    return `${ACTOR_TOKEN_PREFIX}${secret}`;
  }

  function take(token: string): ActorTokenClaims | null {
    if (!token.startsWith(ACTOR_TOKEN_PREFIX)) return null;
    const key = token.slice(ACTOR_TOKEN_PREFIX.length);
    const claims = map.get(key);
    if (claims === undefined) return null;
    map.delete(key);
    return claims;
  }

  return {
    issueEndpoint(request) {
      return issue({
        kind: "endpoint",
        workspaceId: request.workspaceId,
        userId: request.userId,
        sessionId: request.sessionId,
        method: "POST",
        path: request.path ?? PLATFORM_MCP_ENDPOINT_PATH,
      });
    },
    issueRoute(request: RouteTokenRequest) {
      return issue({
        kind: "route",
        issuer: request.issuer,
        workspaceId: request.workspaceId,
        userId: request.userId,
        sessionId: request.sessionId,
        method: request.method,
        path: request.path,
        bodySha256: request.bodySha256,
        ...(request.toolUseId === undefined ? {} : { toolUseId: request.toolUseId }),
      });
    },
    take,
    async resolve(request) {
      if (!request.token.startsWith(ACTOR_TOKEN_PREFIX)) return null;
      // `take` runs before the first await: the token is gone before any
      // other request can look it up.
      const claims = take(request.token);
      if (claims === null) return refused(request.path);
      if (claims.expiresAt <= now()) return refused(request.path, claims);
      if (claims.method !== request.method.toUpperCase()) return refused(request.path, claims);
      if (!samePath(pathnameOf(claims.path), request.path)) return refused(request.path, claims);
      if (options.isCurrent && !(await options.isCurrent(claims))) return refused(request.path, claims);
      return { tenantId: claims.workspaceId, userId: claims.userId, credential: credentialOf(claims, claims.kind) };
    },
    sweep,
    clear: () => map.clear(),
    size: () => map.size,
  };
}

export interface ActorTokenGuardOptions {
  allowlist: RouteAllowlist;
  /** Path of `PLATFORM_MCP_URL`. */
  endpointPath?: string;
}

type GuardVariables = {
  Variables: {
    auth_credential?: unknown;
    tenant_id?: string;
    user_id?: string;
    platform_mcp_actor?: ActorClaims;
  };
};

function isActorCredential(value: unknown): value is PlatformMcpActorCredential {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "platform_mcp_actor";
}

function forbidden(message: string): Response {
  return Response.json({ type: "error", error: { type: "permission_error", message } }, { status: 403 });
}

/**
 * Runs after the auth middleware. Requests without a platform MCP token pass
 * untouched. An `endpoint` token sets `platform_mcp_actor`; a `route` token
 * must match the exact path with the query, the body hash, the allowlist and
 * the body rule of its row (2.4). Any mismatch is 403 and the route never runs.
 */
export function createActorTokenGuard(options: ActorTokenGuardOptions): MiddlewareHandler<GuardVariables> {
  const endpointPath = options.endpointPath ?? PLATFORM_MCP_ENDPOINT_PATH;
  return async (c, next) => {
    const credential = c.get("auth_credential");
    if (!isActorCredential(credential)) return next();
    const url = new URL(c.req.url);
    const exactPath = `${url.pathname}${url.search}`;
    if (credential.method !== c.req.method.toUpperCase()) return forbidden("Token method mismatch");
    if (!samePath(credential.path, exactPath)) return forbidden("Token path mismatch");
    const workspaceId = c.get("tenant_id");
    const userId = c.get("user_id");
    if (!workspaceId || !userId) return forbidden("Token without a user");

    if (credential.kind === "endpoint") {
      if (!samePath(url.pathname, endpointPath)) return forbidden("Endpoint token opens only the platform MCP server");
      c.set("platform_mcp_actor", { workspaceId, userId, sessionId: credential.sessionId });
      return next();
    }
    if (credential.kind !== "route" || !credential.issuer) return forbidden("Token is not valid");

    const raw = new Uint8Array(await c.req.raw.clone().arrayBuffer());
    const digest = createHash("sha256").update(raw).digest("hex");
    if (digest !== credential.bodySha256) return forbidden("Token body mismatch");
    const rule = options.allowlist.match(c.req.method, url.pathname);
    if (rule === null) return forbidden("Route is not available to the assistant");
    let body: unknown = null;
    if (rule.bodyCheck !== null) {
      // A DELETE has no body; its rule checks only the headers.
      if (raw.length > 0) {
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return forbidden("Body is not JSON");
        }
      }
    }
    const checked = options.allowlist.checkBody(rule, body, {
      issuer: credential.issuer,
      headers: c.req.raw.headers,
      ...(credential.toolUseId === undefined ? {} : { toolUseId: credential.toolUseId }),
    });
    if (!checked.ok) return forbidden(`Body refused: ${checked.reason}`);
    return next();
  };
}
