export interface AccessLossCode {
  code: string;
  resourceType: string;
}

export interface AccessLossPhrase {
  phrase: string;
  code: string;
  resourceType: string;
}

/**
 * Provider-owned description of which upstream failures are terminal.
 * The proxy hard-codes no provider error strings.
 */
export interface AccessLossCatalog {
  provider: string;
  serverNames: readonly string[];
  scopeLost: readonly AccessLossCode[];
  credentialLost: readonly string[];
  phrases: readonly AccessLossPhrase[];
  table: string;
  terminalStatus: string;
  clearPendingScan: boolean;
}

/**
 * The Slack, Linear and GitHub catalogs left with their integrations
 * (docs/plans/cleanup.md, 5.1). With no provider catalog the proxy only
 * records a reauthorization request for a refresh that failed with
 * `invalid_grant` or `invalid_refresh_token`; no scope is ever closed.
 */
export const integrationAccessLossCatalogs: readonly AccessLossCatalog[] = [];

// Scope tables a catalog may close. No catalog ships, so today nothing
// reaches this guard or `closeIntegrationScope`. The names are the
// allowlist a future catalog must hit. The tables stay in the databases
// and migrations without code or TS schema (cleanup.md, 5.1).
const ALLOWED_TABLES = new Set([
  "slack_thread_sessions",
  "linear_issue_sessions",
  "github_issue_sessions",
]);

const ALLOWED_STATUSES = new Set(["completed", "inactive"]);

export function catalogForProvider(provider: string): AccessLossCatalog | null {
  return integrationAccessLossCatalogs.find((catalog) => catalog.provider === provider) ?? null;
}

export function assertCloseableCatalog(catalog: AccessLossCatalog): void {
  if (!ALLOWED_TABLES.has(catalog.table)) {
    throw new Error(`refusing to close unknown scope table ${catalog.table}`);
  }
  if (!ALLOWED_STATUSES.has(catalog.terminalStatus)) {
    throw new Error(`refusing to write unknown scope status ${catalog.terminalStatus}`);
  }
}
