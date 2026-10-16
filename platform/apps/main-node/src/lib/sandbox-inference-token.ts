// Sandbox inference token (`sandbox_inference`).
//
// An ACP agent in the session VM calls the model through the hosted inference
// proxy of its session and presents this token instead of a provider key.
// The token is `oma_sbx_` plus base64url of the cipher text of
// `{"v":1,"ws":"<workspace>","ses":"<session>","exp":<ms>}`, sealed with the
// `managed.sandbox-inference` cipher. Auth lets it reach
// `/v1/oma/inference-proxy/<its session>/...` and nothing else
// (`allowsApiKeyRequest` in @open-managed-agents/auth). The server issues one
// per turn, so it lives one turn timeout plus a grace period.

import type { ApiKeyResolution } from "@open-managed-agents/auth";

export const SANDBOX_INFERENCE_TOKEN_PREFIX = "oma_sbx_";
export const SANDBOX_INFERENCE_CIPHER_PURPOSE = "managed.sandbox-inference";

/** Turn timeout of `acp-sandbox` when the agent sets none
 * (`DEFAULT_TURN_TIMEOUT_MS` in apps/agent/src/harness/acp-sandbox-loop.ts). */
export const DEFAULT_ACP_TURN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_GRACE_MS = 15 * 60_000;
export const SANDBOX_INFERENCE_TOKEN_MAX_TTL_MS = 6 * 60 * 60_000;

export interface SandboxInferenceCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

interface SandboxInferenceClaims {
  v: 1;
  ws: string;
  ses: string;
  exp: number;
}

export function sandboxInferenceCipher(secrets: {
  cipherFor(purpose: string): SandboxInferenceCipher;
}): SandboxInferenceCipher {
  return secrets.cipherFor(SANDBOX_INFERENCE_CIPHER_PURPOSE);
}

/** Token lifetime for one turn: the agent's turn timeout
 * (`_oma.acp.per_turn_timeout_ms`, five minutes by default) plus fifteen
 * minutes, at most six hours. */
export function sandboxInferenceTokenTtlMs(perTurnTimeoutMs: number | null | undefined): number {
  const timeout = typeof perTurnTimeoutMs === "number"
    && !Number.isNaN(perTurnTimeoutMs)
    && perTurnTimeoutMs > 0
    ? Math.floor(perTurnTimeoutMs)
    : DEFAULT_ACP_TURN_TIMEOUT_MS;
  return Math.min(SANDBOX_INFERENCE_TOKEN_MAX_TTL_MS, timeout + TOKEN_GRACE_MS);
}

export async function issueSandboxInferenceToken(input: {
  cipher: SandboxInferenceCipher;
  workspaceId: string;
  sessionId: string;
  ttlMs: number;
  /** Epoch milliseconds; `Date.now()` by default. */
  now?: number;
}): Promise<string> {
  if (input.workspaceId.length === 0 || input.sessionId.length === 0) {
    throw new Error("Sandbox inference token needs a workspace and a session");
  }
  if (
    !Number.isSafeInteger(input.ttlMs)
    || input.ttlMs <= 0
    || input.ttlMs > SANDBOX_INFERENCE_TOKEN_MAX_TTL_MS
  ) {
    throw new RangeError("Sandbox inference token lifetime must be 1 ms to 6 hours");
  }
  const claims: SandboxInferenceClaims = {
    v: 1,
    ws: input.workspaceId,
    ses: input.sessionId,
    exp: (input.now ?? Date.now()) + input.ttlMs,
  };
  const sealed = await input.cipher.encrypt(JSON.stringify(claims));
  return `${SANDBOX_INFERENCE_TOKEN_PREFIX}${Buffer.from(sealed, "utf8").toString("base64url")}`;
}

function parseClaims(value: unknown): SandboxInferenceClaims | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  if (claims.v !== 1) return null;
  if (typeof claims.ws !== "string" || claims.ws.length === 0) return null;
  if (typeof claims.ses !== "string" || claims.ses.length === 0) return null;
  if (typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp)) return null;
  return { v: 1, ws: claims.ws, ses: claims.ses, exp: claims.exp };
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Workspace and session of a valid, unexpired sandbox token. A token
 * without the prefix gives null before any decryption, so the bearer chain
 * moves on to the Work token and the API key. A damaged, foreign or expired
 * token gives null too, and auth answers 401. */
export async function resolveSandboxInferenceBearer(input: {
  cipher: SandboxInferenceCipher;
  token: string;
  /** Epoch milliseconds; `Date.now()` by default. */
  now?: number;
}): Promise<ApiKeyResolution | null> {
  if (!input.token.startsWith(SANDBOX_INFERENCE_TOKEN_PREFIX)) return null;
  const body = input.token.slice(SANDBOX_INFERENCE_TOKEN_PREFIX.length);
  if (!BASE64URL.test(body)) return null;
  let claims: SandboxInferenceClaims | null;
  try {
    const sealed = Buffer.from(body, "base64url").toString("utf8");
    // Node decodes base64 leniently; only the exact encoding is the token.
    if (Buffer.from(sealed, "utf8").toString("base64url") !== body) return null;
    claims = parseClaims(JSON.parse(await input.cipher.decrypt(sealed)));
  } catch {
    return null;
  }
  if (claims === null || claims.exp <= (input.now ?? Date.now())) return null;
  return {
    tenantId: claims.ws,
    credential: {
      type: "sandbox_inference",
      sessionId: claims.ses,
      expiresAt: new Date(claims.exp).toISOString(),
    },
  };
}
