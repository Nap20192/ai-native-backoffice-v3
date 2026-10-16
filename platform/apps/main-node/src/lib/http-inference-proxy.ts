// Hosted inference proxy: `/v1/oma/inference-proxy/:sessionId/<protocol>/...`.
//
// An ACP agent in the session sandbox calls the model through this route with
// the short-lived token of its session (`sandbox_inference`, see
// sandbox-inference-token.ts). The proxy resolves the session's model card on
// the host, sends the call to the provider with the card key and swaps the
// agent's model handle for the card's wire model. The key never enters the VM.

import { Hono, type Context } from "hono";
import { routePath } from "hono/route";
import {
  forwardHostedInferenceRequest,
  parseHostedInferenceSubPath,
  resolveProtocolEndpointsFromModelCard,
  type InferenceProtocolEndpoint,
} from "@open-managed-agents/inference-proxy";
import type { ApiKeyResolution } from "@open-managed-agents/auth";

export interface NodeInferenceUpstream {
  wireModel: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  customHeaders?: Record<string, string>;
  /** Per-protocol upstream bases. Without them the proxy derives the
   * endpoints from `provider` (default `anthropic`) and `baseURL`. */
  protocolEndpoints?: readonly InferenceProtocolEndpoint[];
}

export interface NodeHttpInferenceProxyDependencies {
  resolveUpstream(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<NodeInferenceUpstream | null>;
  fetcher?: typeof fetch;
}

type ProxyVariables = {
  tenant_id: string;
  auth_credential?: ApiKeyResolution["credential"];
};

const forbidden = (context: Context) => context.json({ error: "forbidden" }, 403);

/** The request path after the `:sessionId` segment, plus the query string.
 * Read through the matched route so the result does not depend on where the
 * routes are mounted. */
function subPathAfterSession(context: Context): string {
  const routeSegments = routePath(context).split("/");
  const sessionIndex = routeSegments.indexOf(":sessionId");
  const pathSegments = context.req.path.split("/");
  const subPath = sessionIndex < 0 ? "" : pathSegments.slice(sessionIndex + 1).join("/");
  const search = new URL(context.req.url).search;
  return subPath.length === 0 ? "" : `${subPath}${search}`;
}

function upstreamEndpoints(upstream: NodeInferenceUpstream): readonly InferenceProtocolEndpoint[] {
  if (upstream.protocolEndpoints !== undefined && upstream.protocolEndpoints.length > 0) {
    return upstream.protocolEndpoints;
  }
  return resolveProtocolEndpointsFromModelCard({
    providerId: upstream.provider ?? "anthropic",
    baseUrl: upstream.baseURL ?? null,
  });
}

/** `model` of a JSON object body set to the wire model. Any other body
 * (not JSON, not an object, no string `model`) comes back unchanged. */
export function swapModelInJsonBody(body: ArrayBuffer, wireModel: string): ArrayBuffer {
  if (body.byteLength === 0) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return body;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
  const record = parsed as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model === wireModel) return body;
  record.model = wireModel;
  const encoded = new TextEncoder().encode(JSON.stringify(record));
  // TextEncoder output always sits on a plain ArrayBuffer.
  return encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength,
  ) as ArrayBuffer;
}

/** Gemini names the model in the path: `.../models/<name>:generateContent`. */
export function swapModelInGeminiPath(subPath: string, wireModel: string): string {
  return subPath.replace(
    /(^|\/)models\/[^/:?]+:/u,
    (_match, lead: string) => `${lead}models/${encodeURIComponent(wireModel)}:`,
  );
}

// A model name in a path: no `%`, so an escaped slash cannot climb out of it.
const MODEL_NAME = String.raw`(?!\.+(?:$|[:/]))[A-Za-z0-9._@-]+`;

// Calls a sandbox token may make, per protocol segment of the path: model
// calls of every protocol and the model list. Files, batches, fine-tuning,
// stored responses and DELETE stay closed, so a process in the VM cannot use
// the card key for the rest of the provider API.
const SANDBOX_INFERENCE_CALLS: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^anthropic\/v1\/messages(?:\/count_tokens)?$/u },
  { method: "GET", path: new RegExp(String.raw`^anthropic/v1/models(?:/${MODEL_NAME})?$`, "u") },
  { method: "POST", path: /^openai\/v1\/(?:chat\/completions|responses(?:\/compact|\/input_tokens)?)$/u },
  { method: "GET", path: new RegExp(String.raw`^openai/v1/models(?:/${MODEL_NAME})?$`, "u") },
  {
    method: "POST",
    path: new RegExp(String.raw`^gemini/v1(?:beta|alpha)?/models/${MODEL_NAME}:(?:generateContent|streamGenerateContent|countTokens)$`, "u"),
  },
  { method: "GET", path: new RegExp(String.raw`^gemini/v1(?:beta|alpha)?/models(?:/${MODEL_NAME})?$`, "u") },
];

/** True when a sandbox token may make this call: `subPath` is the path after
 * the session segment, with or without its query string. */
export function isSandboxInferenceCall(method: string, subPath: string): boolean {
  const path = subPath.split("?", 1)[0]!;
  const verb = method.toUpperCase();
  return SANDBOX_INFERENCE_CALLS.some((call) => call.method === verb && call.path.test(path));
}

export function buildNodeHttpInferenceProxyRoutes(
  dependencies: NodeHttpInferenceProxyDependencies,
) {
  const routes = new Hono<{ Variables: ProxyVariables }>();
  routes.all("/:sessionId/*", async (context) => {
    const tenantId = context.get("tenant_id");
    const sessionId = context.req.param("sessionId");
    const credential = context.get("auth_credential");
    let subPath = subPathAfterSession(context);
    // Auth already scopes a sandbox token to its session's path; the proxy
    // checks again so a mounting mistake cannot open another session. The
    // token also reaches model calls only, see SANDBOX_INFERENCE_CALLS.
    if (
      credential?.type === "sandbox_inference"
      && (credential.sessionId !== sessionId || !isSandboxInferenceCall(context.req.method, subPath))
    ) {
      return forbidden(context);
    }
    const upstream = await dependencies.resolveUpstream({ tenantId, sessionId });
    if (upstream === null) {
      return forbidden(context);
    }
    const method = context.req.method;
    let body = ["GET", "HEAD"].includes(method.toUpperCase())
      ? null
      : await context.req.raw.arrayBuffer();
    // Every call goes to the card's model, whatever model the agent names:
    // its main turn, count_tokens and light service calls alike.
    if (parseHostedInferenceSubPath(subPath).protocol === "gemini") {
      subPath = swapModelInGeminiPath(subPath, upstream.wireModel);
    } else if (body !== null) {
      body = swapModelInJsonBody(body, upstream.wireModel);
    }
    return forwardHostedInferenceRequest({
      upstream: { ...upstream, protocolEndpoints: upstreamEndpoints(upstream) },
      method,
      subPath,
      inboundHeaders: context.req.raw.headers,
      body,
      fetcher: dependencies.fetcher,
    });
  });
  return routes;
}
