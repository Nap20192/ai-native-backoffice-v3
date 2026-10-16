// Nested calls of the platform MCP server into `/v1/...` (builder-agent.md 2.1).
// Every request gets its own one-time `route` token bound to the method, the
// exact path and the sha256 of the raw body, and goes through `app.fetch`.

import { createHash } from "node:crypto";
import type { ActorClaims, PlatformMcpDeps, RouteTokenIssuerKind } from "./ports";

const BASE = "http://platform-mcp.internal";
export const INNER_BETAS = [
  "managed-agents-2026-04-01",
  "files-api-2025-04-14",
  "skills-2025-10-02",
  "agent-memory-2026-07-22",
].join(",");

export interface InnerResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Parsed JSON or null. */
  json: any;
  text: string;
  bytes: Uint8Array;
}

export interface InnerRequestOptions {
  headers?: Record<string, string>;
}

export interface InnerApi {
  get(path: string): Promise<InnerResponse>;
  post(path: string, body: unknown, options?: InnerRequestOptions): Promise<InnerResponse>;
  postForm(path: string, form: FormData, options?: InnerRequestOptions): Promise<InnerResponse>;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function createInnerApi(
  deps: Pick<PlatformMcpDeps, "innerFetch" | "tokens">,
  actor: ActorClaims,
  options: { issuer?: RouteTokenIssuerKind; toolUseId?: string } = {},
): InnerApi {
  const issuer = options.issuer ?? "handler";

  async function send(
    method: "GET" | "POST",
    path: string,
    body: Uint8Array | null,
    contentType: string | null,
    extra: Record<string, string> | undefined,
  ): Promise<InnerResponse> {
    const bytes = body ?? new Uint8Array();
    const token = deps.tokens.issueRoute({
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      sessionId: actor.sessionId,
      method,
      path,
      bodySha256: sha256Hex(bytes),
      issuer,
      ...(options.toolUseId === undefined ? {} : { toolUseId: options.toolUseId }),
    });
    const headers = new Headers(extra);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("anthropic-beta", INNER_BETAS);
    if (contentType) headers.set("content-type", contentType);
    const response = await deps.innerFetch(
      new Request(`${BASE}${path}`, {
        method,
        headers,
        ...(body === null ? {} : { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer }),
      }),
    );
    const raw = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder().decode(raw);
    let json: unknown = null;
    if ((response.headers.get("content-type") ?? "").includes("json") || /^\s*[[{]/.test(text)) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, ok: response.ok, headers: response.headers, json, text, bytes: raw };
  }

  return {
    get: (path) => send("GET", path, null, null, undefined),
    post: (path, body, opts) =>
      send("POST", path, new TextEncoder().encode(JSON.stringify(body)), "application/json", opts?.headers),
    async postForm(path, form, opts) {
      const encoded = new Response(form);
      const contentType = encoded.headers.get("content-type");
      return send("POST", path, new Uint8Array(await encoded.arrayBuffer()), contentType, opts?.headers);
    },
  };
}

/** Error text of an API response, without the request values. */
export function routeErrorMessage(response: InnerResponse): string {
  const json = response.json as { error?: { message?: unknown } | string; message?: unknown } | null;
  const message =
    (typeof json?.error === "object" && typeof json.error?.message === "string" && json.error.message) ||
    (typeof json?.error === "string" && json.error) ||
    (typeof json?.message === "string" && json.message) ||
    response.text.slice(0, 300);
  return `Маршрут ответил ${response.status}: ${message}`;
}
