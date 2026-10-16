// How an ACP agent in the session VM reaches its model: through the hosted
// inference proxy of its session (`/v1/oma/inference-proxy/<session>/...`)
// with the sandbox inference token of the turn. No provider key enters the VM.
//
// - A built-in ACP entry with a model adapter (Claude Code and others) gets
//   `ctx.env.hostedInference` from `buildSandboxHostedInference`; the adapter
//   in @open-managed-agents/harness-inference-adapters writes its variables.
// - A harness card has no adapter. It gets the variables of `cardInferenceEnv`
//   on top of the agent's `_oma.acp.agent.env`.
// - `resolveSandboxGatewayBaseUrl` is the server address the VM calls:
//   SANDBOX_GATEWAY_BASE_URL, else PUBLIC_BASE_URL. 127.0.0.1 inside a VM
//   points at the VM itself, so a local LiteBox needs
//   `http://host.boxlite.internal:<port>`.

import {
  buildHostedInferenceBaseUrl,
  resolveProtocolEndpointsFromModelCard,
  type InferenceProtocolEndpoint,
  type InferenceWireProtocol,
} from "@open-managed-agents/inference-proxy";

export interface SandboxHostedInference {
  gatewayBaseUrl: string;
  sessionsToken: string;
  model: {
    providerId: string;
    baseUrl: string | null;
    protocolEndpoints: readonly InferenceProtocolEndpoint[];
  };
}

/** Upstream of the session model as the host resolves it: a model card, or
 * the server key (no provider, ANTHROPIC_BASE_URL of the server or none). */
export interface SandboxInferenceUpstream {
  provider?: string | null;
  baseURL?: string | null;
}

/** `ctx.env.hostedInference` for a turn of a built-in ACP entry. */
export function buildSandboxHostedInference(input: {
  gatewayBaseUrl: string;
  token: string;
  upstream: SandboxInferenceUpstream;
}): SandboxHostedInference {
  const providerId = input.upstream.provider ?? "anthropic";
  const baseUrl = input.upstream.baseURL ?? null;
  return {
    gatewayBaseUrl: input.gatewayBaseUrl,
    sessionsToken: input.token,
    model: {
      providerId,
      baseUrl,
      protocolEndpoints: resolveProtocolEndpointsFromModelCard({ providerId, baseUrl }),
    },
  };
}

const PROXY_PROTOCOLS: readonly InferenceWireProtocol[] = [
  "anthropic-messages",
  "openai-chat",
  "openai-responses",
  "gemini",
];

function isProxyProtocol(name: string): name is InferenceWireProtocol {
  return (PROXY_PROTOCOLS as readonly string[]).includes(name);
}

/** Protocol of the turn: the first protocol of the harness entry that the
 * model has. An entry with `*` takes the first protocol of the model. */
export function selectTurnProtocol(
  harnessProtocols: readonly string[],
  modelProtocols: readonly string[],
): InferenceWireProtocol | null {
  const model = modelProtocols.filter(isProxyProtocol);
  if (harnessProtocols.includes("*")) return model[0] ?? null;
  return harnessProtocols.filter(isProxyProtocol).find((protocol) => model.includes(protocol)) ?? null;
}

/** Proxy path segment per protocol. Same values as INFERENCE_PROTOCOL_PROXY_PATH
 * (packages/inference-proxy/src/protocol-types.ts), which the package does
 * not export. */
const PROXY_PATH_SEGMENT: Record<InferenceWireProtocol, string> = {
  "anthropic-messages": "anthropic",
  "openai-chat": "openai/v1",
  "openai-responses": "openai/v1",
  gemini: "gemini",
};

/** Variables of a harness card turn. The token stands in for every key:
 * OPENAI_API_KEY holds the short-lived session token, not a provider key.
 * The model is the agent's handle; the proxy swaps it for the wire model. */
export function cardInferenceEnv(input: {
  gatewayBaseUrl: string;
  sessionId: string;
  token: string;
  protocol: InferenceWireProtocol;
  modelHandle: string;
}): Record<string, string> {
  const baseUrl = `${buildHostedInferenceBaseUrl(input.gatewayBaseUrl, input.sessionId)}/${PROXY_PATH_SEGMENT[input.protocol]}`;
  const env: Record<string, string> = {
    OMA_INFERENCE_PROTOCOL: input.protocol,
    OMA_INFERENCE_BASE_URL: baseUrl,
    OMA_INFERENCE_TOKEN: input.token,
    OMA_MODEL: input.modelHandle,
  };
  if (input.protocol === "anthropic-messages") {
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = input.token;
    env.ANTHROPIC_MODEL = input.modelHandle;
  } else if (input.protocol === "openai-chat" || input.protocol === "openai-responses") {
    env.OPENAI_BASE_URL = baseUrl;
    env.OPENAI_API_KEY = input.token;
    env.OPENAI_MODEL = input.modelHandle;
  }
  return env;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

/** SANDBOX_GATEWAY_BASE_URL as an http or https origin without a path.
 * Null when unset; throws on any other value so config loading reports it. */
export function normalizeSandboxGatewayBaseUrl(value: string | null | undefined): string | null {
  const raw = nonEmpty(value);
  if (raw === null) return null;
  const problem = new Error(
    `SANDBOX_GATEWAY_BASE_URL must be an http or https origin without a path, got ${JSON.stringify(raw)}`,
  );
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw problem;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw problem;
  }
  return url.origin;
}

/** Server address the VM calls: SANDBOX_GATEWAY_BASE_URL, else the origin of
 * PUBLIC_BASE_URL; null when neither gives an http or https address. */
export function resolveSandboxGatewayBaseUrl(input: {
  sandboxGatewayBaseUrl?: string | null;
  publicBaseUrl?: string | null;
}): string | null {
  const gateway = normalizeSandboxGatewayBaseUrl(input.sandboxGatewayBaseUrl);
  if (gateway !== null) return gateway;
  const publicBaseUrl = nonEmpty(input.publicBaseUrl);
  if (publicBaseUrl === null) return null;
  try {
    const url = new URL(publicBaseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
