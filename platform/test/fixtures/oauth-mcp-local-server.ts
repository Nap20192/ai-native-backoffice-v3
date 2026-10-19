// Local OAuth-protected MCP endpoint for the credential validation test
// (apps/main-node/test/mcp-oauth-validate.e2e.test.ts).
//
//   POST /mcp       answers the MCP `initialize` with 200 for a live access
//                   token and 401 for any other bearer. A body that is not a
//                   JSON-RPC 2.0 `initialize` request gets 400.
//   POST /mcp-down  always answers 503, so the probe cannot decide.
//   POST /token     OAuth token endpoint, `refresh_token` grant only: a known
//                   refresh token gets a new live access token, any other
//                   one gets 400 `invalid_grant` (revoked).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const OAUTH_MCP_FIXTURE = {
  clientId: "oma-test-client",
  liveAccessToken: "live-access-token-0001",
  staleAccessToken: "stale-access-token-0002",
  refreshToken: "good-refresh-token-0003",
  rotatedAccessToken: "rotated-access-token-0004",
  revokedRefreshToken: "revoked-refresh-token-0005",
} as const;

export interface OauthMcpTestServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  mcpUrl: string;
  /** An MCP endpoint that always answers 503. */
  downMcpUrl: string;
  tokenEndpoint: string;
  /** `METHOD /path` of every request, in order. */
  requests: string[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

export async function startOauthMcpTestServer(): Promise<OauthMcpTestServer> {
  const liveTokens = new Set<string>([OAUTH_MCP_FIXTURE.liveAccessToken]);
  const grants = new Map<string, string>([[OAUTH_MCP_FIXTURE.refreshToken, OAUTH_MCP_FIXTURE.rotatedAccessToken]]);
  const requests: string[] = [];

  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = (request.url ?? "/").split("?")[0]!;
    requests.push(`${request.method} ${path}`);
    if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });

    if (path === "/mcp-down") return sendJson(response, 503, { error: "temporarily_unavailable" });

    if (path === "/mcp") {
      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (!liveTokens.has(token)) {
        return sendJson(response, 401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
      }
      let message: { jsonrpc?: unknown; id?: unknown; method?: unknown } | null = null;
      try {
        message = JSON.parse(body) as { jsonrpc?: unknown; id?: unknown; method?: unknown };
      } catch {
        message = null;
      }
      if (message === null || typeof message !== "object" || message.jsonrpc !== "2.0" || message.method !== "initialize") {
        return sendJson(response, 400, { error: "invalid_request" });
      }
      return sendJson(response, 200, {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "oauth-mcp-test", version: "1.0.0" },
        },
      });
    }

    if (path === "/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "refresh_token") return sendJson(response, 400, { error: "unsupported_grant_type" });
      const refreshToken = form.get("refresh_token") ?? "";
      const accessToken = grants.get(refreshToken);
      if (accessToken === undefined) return sendJson(response, 400, { error: "invalid_grant" });
      liveTokens.add(accessToken);
      return sendJson(response, 200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
      });
    }

    return sendJson(response, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    downMcpUrl: `${origin}/mcp-down`,
    tokenEndpoint: `${origin}/token`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      // The probe's fetch keeps connections alive; do not wait for them.
      server.closeAllConnections();
    }),
  };
}
