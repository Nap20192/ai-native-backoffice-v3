// Scenarios of POST /v1/vaults/:id/credentials/:credential_id/mcp_oauth_validate
// against the local server of ./oauth-mcp-local-server.ts. Each credential is
// created through /v1, validated, and the answer is checked with node:assert,
// so the file needs no test runner of its own.
//
//   valid      the MCP endpoint accepts the access token
//   refreshed  the endpoint rejects a stale token, the refresh grant gives a
//              new one, the endpoint accepts it; the next check needs no refresh
//   revoked    the endpoint rejects the token and the token endpoint answers
//              invalid_grant
//   unknown    the endpoint answers 503, the probe cannot decide
//
// With `requests`, the run also checks that only the refreshed and the
// revoked credential called the token endpoint.

import assert from "node:assert/strict";
import { OAUTH_MCP_FIXTURE } from "./oauth-mcp-local-server";

export interface McpOauthValidationScenarioInput {
  /** Origin of the server started by startOauthMcpTestServer(). */
  origin: string;
  /** Sends a request to the control plane; `path` starts with `/v1`. */
  request(path: string, init?: RequestInit): Response | Promise<Response>;
  /** `requests` of the started server, `METHOD /path` in order. */
  requests?: readonly string[];
}

const BETA = "managed-agents-2026-04-01";

interface Validation {
  type: string;
  status: "valid" | "invalid" | "unknown";
  credential_id: string;
  vault_id: string;
  has_refresh_token: boolean;
  mcp_probe: { method: string; http_response: { status_code: number } | null } | null;
  refresh: { status: string } | null;
}

export async function runMcpOauthValidationScenarios(input: McpOauthValidationScenarioInput): Promise<void> {
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }> => {
    const response = await input.request(path, {
      method,
      headers: {
        "anthropic-beta": BETA,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  };
  const ok = async (method: string, path: string, body?: unknown): Promise<any> => {
    const answer = await call(method, path, body);
    assert.ok(answer.status < 300, `${method} ${path}: ${answer.status} ${answer.text}`);
    return answer.json;
  };

  const vault = await ok("POST", "/v1/vaults", { display_name: "OAuth validation" });
  // Distinct URLs per credential: the server ignores the query.
  const mcpUrl = (name: string) => `${input.origin}/mcp?case=${name}`;
  const refresh = (refreshToken: string) => ({
    client_id: OAUTH_MCP_FIXTURE.clientId,
    refresh_token: refreshToken,
    token_endpoint: `${input.origin}/token`,
    token_endpoint_auth: { type: "none" },
  });
  const credential = async (name: string, auth: Record<string, unknown>): Promise<string> =>
    (await ok("POST", `/v1/vaults/${vault.id}/credentials`, { display_name: name, auth: { type: "mcp_oauth", ...auth } })).id;
  const validate = async (credentialId: string): Promise<Validation> => {
    const answer = await call("POST", `/v1/vaults/${vault.id}/credentials/${credentialId}/mcp_oauth_validate`);
    assert.equal(answer.status, 200, answer.text);
    for (const secret of Object.values(OAUTH_MCP_FIXTURE)) {
      if (secret === OAUTH_MCP_FIXTURE.clientId) continue;
      assert.ok(!answer.text.includes(secret), `validation answer leaks ${secret}`);
    }
    return answer.json as Validation;
  };

  // valid
  const validId = await credential("valid", {
    access_token: OAUTH_MCP_FIXTURE.liveAccessToken,
    mcp_server_url: mcpUrl("valid"),
  });
  const valid = await validate(validId);
  assert.equal(valid.type, "vault_credential_validation");
  assert.equal(valid.status, "valid");
  assert.equal(valid.credential_id, validId);
  assert.equal(valid.vault_id, vault.id);
  assert.equal(valid.has_refresh_token, false);

  // refreshed, then valid without a refresh: the rotated token was saved
  const refreshedId = await credential("refreshed", {
    access_token: OAUTH_MCP_FIXTURE.staleAccessToken,
    mcp_server_url: mcpUrl("refreshed"),
    refresh: refresh(OAUTH_MCP_FIXTURE.refreshToken),
  });
  const refreshed = await validate(refreshedId);
  assert.equal(refreshed.status, "valid");
  assert.equal(refreshed.has_refresh_token, true);
  assert.equal(refreshed.refresh?.status, "succeeded");
  const again = await validate(refreshedId);
  assert.equal(again.status, "valid");
  assert.equal(again.refresh, null);

  // revoked
  const revokedId = await credential("revoked", {
    access_token: OAUTH_MCP_FIXTURE.staleAccessToken,
    mcp_server_url: mcpUrl("revoked"),
    refresh: refresh(OAUTH_MCP_FIXTURE.revokedRefreshToken),
  });
  const revoked = await validate(revokedId);
  assert.equal(revoked.status, "invalid");
  assert.equal(revoked.mcp_probe?.http_response?.status_code, 401);
  assert.equal(revoked.refresh?.status, "failed");

  // unknown
  const downId = await credential("unknown", {
    access_token: OAUTH_MCP_FIXTURE.liveAccessToken,
    mcp_server_url: `${input.origin}/mcp-down`,
  });
  const down = await validate(downId);
  assert.equal(down.status, "unknown");
  assert.equal(down.mcp_probe?.http_response?.status_code, 503);

  // refreshed (once, the second check needs none) and revoked
  if (input.requests) {
    assert.equal(input.requests.filter((entry) => entry === "POST /token").length, 2, input.requests.join(", "));
  }
}
