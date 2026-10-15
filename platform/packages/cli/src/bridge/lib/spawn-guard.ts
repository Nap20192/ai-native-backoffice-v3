/**
 * Daemon-side limits on what the server can make an ACP child do on this
 * machine. The server (and anyone who can create a session in a tenant this
 * runtime serves) controls session.start and the session bundle; the owner
 * of the laptop controls only the daemon's own environment. Every knob here
 * is read from the daemon's environment, never from the server:
 *
 *   OMA_BRIDGE_ENV_ALLOWLIST   comma-separated names of bundle env vars the
 *                              child may receive. Empty (default) = none.
 *                              Runtime-control names are refused even when
 *                              listed (NODE_*, ANTHROPIC_*, CLAUDE*, LD_*,
 *                              PATH, ...).
 *   OMA_BRIDGE_CWD_ROOTS       path-delimiter-separated absolute dirs a
 *                              server-sent session.start.cwd must resolve
 *                              into (realpath). Empty (default) = any
 *                              server cwd is refused.
 *   OMA_BRIDGE_CLAUDE_CODE_OAUTH_TOKEN / OMA_BRIDGE_ANTHROPIC_API_KEY
 *                              the only Claude login a claude-acp child gets.
 *                              Inherited ANTHROPIC_* / CLAUDE* are removed.
 */

import { realpath } from "node:fs/promises";
import { delimiter, isAbsolute, relative, sep } from "node:path";

export interface BridgeSpawnPolicy {
  envAllowlist: ReadonlySet<string>;
  cwdRoots: readonly string[];
  claudeOauthToken?: string;
  anthropicApiKey?: string;
}

const DENIED_ENV_PREFIXES = [
  "NODE_",
  "NPM_CONFIG_",
  "ANTHROPIC_",
  "CLAUDE",
  "LD_",
  "DYLD_",
  "OMA_",
  "GIT_",
  "PYTHON",
  "PERL",
  "RUBY",
  "SSL_CERT_",
];

const DENIED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "IFS",
  "PS4",
  "PROMPT_COMMAND",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function readSpawnPolicy(env: NodeJS.ProcessEnv = process.env): BridgeSpawnPolicy {
  const envAllowlist = new Set(
    (env.OMA_BRIDGE_ENV_ALLOWLIST ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
  const cwdRoots = (env.OMA_BRIDGE_CWD_ROOTS ?? "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter((root) => root.length > 0 && isAbsolute(root));
  const claudeOauthToken = env.OMA_BRIDGE_CLAUDE_CODE_OAUTH_TOKEN?.trim() || undefined;
  const anthropicApiKey = env.OMA_BRIDGE_ANTHROPIC_API_KEY?.trim() || undefined;
  return { envAllowlist, cwdRoots, claudeOauthToken, anthropicApiKey };
}

export function isDeniedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  if (DENIED_ENV_NAMES.has(upper)) return true;
  return DENIED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * Bundle env (session resources of type=env) is chosen by whoever creates
 * the session. Only names the owner allowlisted on this machine pass, and
 * never names that steer the runtime, loader, shell or Claude login.
 */
export function filterBundleEnv(
  vars: ReadonlyArray<{ name: string; value: string }>,
  allowlist: ReadonlySet<string>,
): { env: Record<string, string>; dropped: number } {
  const env: Record<string, string> = {};
  let dropped = 0;
  for (const variable of vars) {
    const name = variable?.name;
    if (
      typeof name !== "string" ||
      typeof variable.value !== "string" ||
      !ENV_NAME.test(name) ||
      !allowlist.has(name) ||
      isDeniedEnvName(name)
    ) {
      dropped += 1;
      continue;
    }
    env[name] = variable.value;
  }
  return { env, dropped };
}

/**
 * Env overrides for the child built from the daemon's own environment:
 * undefined removes an inherited variable (NodeSpawner semantics).
 *
 * Every child loses the "already inside Claude Code" markers and the
 * daemon's own OMA_BRIDGE_* settings. A claude-acp child additionally loses
 * every inherited ANTHROPIC_* / CLAUDE* variable, so its only login is the
 * one the owner handed to the daemon explicitly.
 */
export function daemonEnvOverrides(
  agentId: string,
  policy: BridgeSpawnPolicy,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {
    CLAUDECODE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined,
    CLAUDE_CODE_SSE_PORT: undefined,
  };
  const claude = agentId === "claude-acp";
  for (const name of Object.keys(inherited)) {
    const upper = name.toUpperCase();
    if (upper.startsWith("OMA_BRIDGE_")) out[name] = undefined;
    if (claude && (upper.startsWith("ANTHROPIC_") || upper.startsWith("CLAUDE"))) {
      out[name] = undefined;
    }
  }
  if (claude) {
    if (policy.claudeOauthToken) out.CLAUDE_CODE_OAUTH_TOKEN = policy.claudeOauthToken;
    if (policy.anthropicApiKey) out.ANTHROPIC_API_KEY = policy.anthropicApiKey;
  }
  return out;
}

/**
 * ACP process cwd. Without a server cwd it is the session scratch dir.
 * A server cwd is accepted only when it is absolute, exists, and its
 * realpath lies inside the realpath of one of the owner's OMA_BRIDGE_CWD_ROOTS.
 */
export async function resolveAcpProcessCwd(
  scratchDir: string,
  requestedCwd: string | undefined,
  roots: readonly string[],
): Promise<string> {
  const requested = requestedCwd?.trim();
  if (!requested) return scratchDir;
  if (!isAbsolute(requested)) {
    throw new Error("session.start cwd refused: not an absolute path");
  }
  let target: string;
  try {
    target = await realpath(requested);
  } catch {
    throw new Error("session.start cwd refused: path does not exist on this machine");
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    if (isInside(realRoot, target)) return target;
  }
  throw new Error("session.start cwd refused: outside OMA_BRIDGE_CWD_ROOTS on this machine");
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}
