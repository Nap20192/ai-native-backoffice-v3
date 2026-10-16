// Target of the MCP proxy for the platform server (builder-agent.md 2.1, 3.3).
// `resolveNodeMcpProxyTarget` asks this resolver first. A server whose `url`
// equals `PLATFORM_MCP_URL` gets a one-time `endpoint` token and `app.fetch`
// as its fetcher, so the request never leaves the process. Any other server
// stays with the vault lookup.

import type { Session } from "@open-managed-agents/managed-agents-application";
import type { NodeMcpProxyTarget } from "../http-mcp-proxy";
import type { ActorTokenClaims, ActorTokens } from "./actor-token";
import type { InnerFetch, OwnerLookup, SessionToolCheck } from "./ports";
import { sameUrl } from "./session-tool-check";

export interface PlatformMcpTargetDeps {
  platformMcpUrl: string;
  loadSession(workspaceId: string, sessionId: string): Promise<Session | null>;
  owners: OwnerLookup;
  toolCheck: SessionToolCheck;
  tokens: ActorTokens;
  /** `app.fetch` of main-node. */
  fetcher: InnerFetch;
}

export type PlatformMcpTargetResult =
  | { kind: "other" }
  /** `target: null` refuses the request: the harness shows «MCP setup failed». */
  | { kind: "platform"; target: NodeMcpProxyTarget | null };

export interface PlatformMcpTargetResolver {
  resolve(input: { tenantId: string; sessionId: string; serverName: string }): Promise<PlatformMcpTargetResult>;
}

type CurrentDeps = Pick<PlatformMcpTargetDeps, "loadSession" | "owners" | "toolCheck">;

/** The session exists and is not archived, the user owns it, the tool set is valid. */
async function sessionServes(deps: CurrentDeps, workspaceId: string, sessionId: string, userId: string | null): Promise<string | null> {
  const session = await deps.loadSession(workspaceId, sessionId);
  if (session === null || session.archivedAt !== null) return null;
  const owner = await deps.owners.ownerOf(workspaceId, sessionId);
  if (owner === null || (userId !== null && owner.userId !== userId)) return null;
  const check = await deps.toolCheck.check(workspaceId, sessionId);
  return check.ok ? owner.userId : null;
}

/** `isCurrent` of the token resolver (3.3). */
export function createActorIsCurrent(deps: CurrentDeps): (claims: ActorTokenClaims) => Promise<boolean> {
  return async (claims) => (await sessionServes(deps, claims.workspaceId, claims.sessionId, claims.userId)) !== null;
}

export function createPlatformMcpTargetResolver(deps: PlatformMcpTargetDeps): PlatformMcpTargetResolver {
  const endpointPath = new URL(deps.platformMcpUrl).pathname;
  const fetcher = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    deps.fetcher(input instanceof Request && init === undefined ? input : new Request(input, init))) as typeof fetch;

  return {
    async resolve({ tenantId, sessionId, serverName }) {
      const session = await deps.loadSession(tenantId, sessionId);
      const server = session?.agent.mcpServers.find((candidate) => candidate.name === serverName);
      if (!server || server.type !== "url" || !sameUrl(server.url, deps.platformMcpUrl)) {
        // Unknown session or another server: not ours. A missing session
        // still fails closed in the vault lookup.
        return { kind: "other" };
      }
      // A session without an owner (static key, deployment, environment key)
      // never gets a token.
      const userId = await sessionServes(deps, tenantId, sessionId, null);
      if (userId === null) return { kind: "platform", target: null };
      const accessToken = deps.tokens.issueEndpoint({ workspaceId: tenantId, userId, sessionId, path: endpointPath });
      return { kind: "platform", target: { upstreamUrl: deps.platformMcpUrl, accessToken, fetcher } };
    },
  };
}
