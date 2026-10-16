// Env policy for ACP agents in the sandbox (docs/plans/models-harness.md, 4.4).
// The model reaches an ACP agent only through the server inference proxy, so
// provider keys and the proxy wiring never come from the agent config.
import { MODEL_PROVIDER_SECRET_ENV_KEYS } from "@open-managed-agents/inference-proxy";
import type { InferenceWireProtocol } from "@open-managed-agents/inference-proxy";

export const INFERENCE_PROTOCOLS: readonly InferenceWireProtocol[] =
  ["anthropic-messages", "openai-chat", "openai-responses", "gemini"];
export const CARD_PROTOCOLS: readonly InferenceWireProtocol[] =
  ["anthropic-messages", "openai-chat", "openai-responses"];

/** Переменные, которые задаёт сервер для модели ACP-агента. */
export const SERVER_INFERENCE_ENV_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL",
  "GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_CLI_CUSTOM_HEADERS",
  "HOSTED_INFERENCE_URL", "HOSTED_INFERENCE_TOKEN",
  "OMA_INFERENCE_PROTOCOL", "OMA_INFERENCE_BASE_URL", "OMA_INFERENCE_TOKEN", "OMA_MODEL",
]);

/** Ключи провайдеров модели: их не бывает ни в env агента, ни в VM. */
export const MODEL_KEY_ENV_NAMES: ReadonlySet<string> = new Set([
  ...MODEL_PROVIDER_SECRET_ENV_KEYS, "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;
const SECRET_VALUE_PREFIX = /^(sk-|AIza|ghp_|gho_|github_pat_|glpat-|xoxb-|xoxp-|xoxa-|AKIA)/;
const JWT_VALUE = /^eyJ[A-Za-z0-9_-]*\.eyJ/;

export function isSecretLikeEnvName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function isSecretLikeEnvValue(value: string): boolean {
  const trimmed = value.trim();
  return SECRET_VALUE_PREFIX.test(trimmed) || JWT_VALUE.test(trimmed);
}

export type AcpEnvProblem = {
  name: string;
  kind: "bad_name" | "server_name" | "secret_name" | "secret_value" | "not_allowed";
};

/** allowed: имена из карточки harness или null для встроенных записей. */
export function checkAcpEnv(
  env: Record<string, string | null> | undefined,
  allowed: readonly string[] | null,
): AcpEnvProblem[] {
  if (env === undefined || env === null) return [];
  const problems: AcpEnvProblem[] = [];
  for (const [name, value] of Object.entries(env)) {
    const kind = nameProblem(name, allowed)
      ?? (typeof value === "string" && isSecretLikeEnvValue(value) ? "secret_value" : null);
    if (kind !== null) problems.push({ name, kind });
  }
  return problems;
}

function nameProblem(
  name: string,
  allowed: readonly string[] | null,
): AcpEnvProblem["kind"] | null {
  if (!ENV_NAME.test(name)) return "bad_name";
  if (SERVER_INFERENCE_ENV_NAMES.has(name)) return "server_name";
  if (MODEL_KEY_ENV_NAMES.has(name) || isSecretLikeEnvName(name)) return "secret_name";
  if (allowed !== null && !allowed.includes(name)) return "not_allowed";
  return null;
}
