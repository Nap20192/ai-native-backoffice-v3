/**
 * One place that turns a session.start into the ACP child's cwd, env and
 * MCP servers, for both the managed-runtime path (node-session-runtime.ts)
 * and the legacy in-class path (session-manager.ts). Everything the server
 * controls (cwd, bundle files, bundle env) passes through spawn-guard.ts.
 */

import { setupIsolatedClaudeConfigDir } from "./claude-config-dir.js";
import {
  ensureSessionCwd,
  sessionClaudeConfigDirPath,
  sessionScratchDirPath,
  writeBundle,
} from "./session-cwd.js";
import {
  daemonEnvOverrides,
  filterBundleEnv,
  readSpawnPolicy,
  resolveAcpProcessCwd,
} from "./spawn-guard.js";

export interface BundleFile {
  path: string;
  content: string;
}

export interface BundleMcpServer {
  name: string;
  type: "http" | "sse";
  url: string;
}

export interface BundleEnvVar {
  name: string;
  value: string;
}

export interface SessionBundle {
  files: BundleFile[];
  /** Upstream per-agent filter for the owner's ~/.claude/skills. Ignored:
   *  owner skills are no longer shared with bridge sessions. */
  local_skill_blocklist?: string[];
  mcp_servers?: BundleMcpServer[];
  env?: BundleEnvVar[];
}

export interface AcpSpawnPlanInput {
  sessionId: string;
  /** Canonical known-agent id (after alias resolution). */
  agentId: string;
  agentEnv?: Record<string, string | undefined>;
  requestedCwd?: string;
  environment: { apiUrl: string; runtimeToken: string };
  agentApiKey: string;
}

export interface AcpSpawnPlan {
  scratchDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  mcpServers: Array<{
    type: "http" | "sse";
    name: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
  }>;
}

export async function buildAcpSpawnPlan(input: AcpSpawnPlanInput): Promise<AcpSpawnPlan> {
  const policy = readSpawnPolicy();
  const cwd = await resolveAcpProcessCwd(
    sessionScratchDirPath(input.sessionId),
    input.requestedCwd,
    policy.cwdRoots,
  );
  const scratchDir = await ensureSessionCwd(input.sessionId);

  let bundleMcpServers: BundleMcpServer[] = [];
  let bundleEnv: BundleEnvVar[] = [];
  try {
    const bundle = await fetchSessionBundle(input.environment, input.sessionId, input.agentId);
    if (bundle) {
      await writeBundle(scratchDir, Array.isArray(bundle.files) ? bundle.files : []);
      bundleMcpServers = Array.isArray(bundle.mcp_servers) ? bundle.mcp_servers : [];
      bundleEnv = Array.isArray(bundle.env) ? bundle.env : [];
    }
  } catch (error) {
    process.stderr.write(`  ! bundle fetch failed (non-fatal): ${(error as Error).message}\n`);
  }

  const filtered = filterBundleEnv(bundleEnv, policy.envAllowlist);
  const configDir = input.agentId === "claude-acp"
    ? await setupIsolatedClaudeConfigDir(sessionClaudeConfigDirPath(input.sessionId))
    : undefined;

  const env: Record<string, string | undefined> = {
    ...(input.agentEnv ?? {}),
    ...filtered.env,
    ...daemonEnvOverrides(input.agentId, policy),
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };

  const mcpServers = bundleMcpServers.map((server) => ({
    type: server.type,
    name: server.name,
    url: server.url,
    headers: [{ name: "Authorization", value: `Bearer ${input.agentApiKey}` }],
  }));

  process.stderr.write(
    `  → SessionManager.start ${input.agentId} cwd=${cwd}` +
      (cwd === scratchDir ? "" : ` scratch=${scratchDir}`) +
      (configDir ? ` cfg=${configDir} (isolated)` : "") +
      (mcpServers.length ? ` mcp=${mcpServers.length}` : "") +
      (bundleEnv.length ? ` env=${Object.keys(filtered.env).length}/${bundleEnv.length}` : "") +
      "\n",
  );

  return { scratchDir, cwd, env, mcpServers };
}

async function fetchSessionBundle(
  environment: AcpSpawnPlanInput["environment"],
  sessionId: string,
  agentId: string,
): Promise<SessionBundle | null> {
  if (!environment.apiUrl || !environment.runtimeToken) return null;
  const url = new URL(
    `${environment.apiUrl.replace(/\/$/, "")}/agents/runtime/sessions/${encodeURIComponent(sessionId)}/bundle`,
  );
  url.searchParams.set("agent_id", agentId);
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${environment.runtimeToken}` },
  });
  if (!response.ok) {
    throw new Error(`bundle ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return (await response.json()) as SessionBundle;
}
