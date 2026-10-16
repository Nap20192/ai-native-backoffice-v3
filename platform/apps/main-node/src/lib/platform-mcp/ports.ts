// Ports of the platform MCP server (docs/plans/builder-agent.md, 2 and 3).
// BS1 (handler, tools, gate) depends only on these types. BS2 implements the
// stores, tokens and checks, BX2 the pure helpers, BS3 wires them in main-node.

import type { z } from "zod";

/** Operation class, ordered from the safest to the one v1 refuses (2.2). */
export type OpClass = "read" | "draft" | "create" | "update" | "out_of_v1";

export const OP_CLASS_ORDER: Readonly<Record<OpClass, number>> = {
  read: 0,
  draft: 1,
  create: 2,
  update: 3,
  out_of_v1: 4,
};

export function maxOpClass(classes: readonly OpClass[]): OpClass {
  let top: OpClass = "read";
  for (const cls of classes) if (OP_CLASS_ORDER[cls] > OP_CLASS_ORDER[top]) top = cls;
  return top;
}

export type ActionResult =
  | "ok"
  | "error"
  | "denied"
  | "refused_confirmation"
  | "refused_stale"
  | "refused_class"
  | "refused_disabled";

/** Who calls the server. The `endpoint` token carries these claims (3.3). */
export interface ActorClaims {
  workspaceId: string;
  userId: string;
  /** The assistant session that calls the tool. */
  sessionId: string;
}

/** One row of `platform_mcp_actions` (3.6). */
export interface ActionRow {
  id: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
  agentId: string | null;
  agentVersion: number | null;
  model: string | null;
  tool: string;
  class: OpClass;
  toolUseId: string;
  opIndex: number;
  inputDigest: string;
  inputRedacted: unknown;
  targetKind: string | null;
  targetId: string | null;
  targetRevision: string | null;
  result: ActionResult;
  errorMessage: string | null;
  confirmationId: string | null;
  previewDigest: string | null;
  maskedCount: number;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface ActionLog {
  /** `(session_id, tool_use_id, op_index)` is unique; a repeat returns `inserted: false`. */
  insert(row: ActionRow): Promise<{ inserted: boolean }>;
  findByToolUse(workspaceId: string, sessionId: string, toolUseId: string): Promise<ActionRow[]>;
  /**
   * True when the log has a `create_session` row with result `ok`, the given
   * assistant session and `target_id` equal to the created session (2.2).
   */
  findSessionCreatedBy(
    workspaceId: string,
    assistantSessionId: string,
    createdSessionId: string,
  ): Promise<boolean>;
}

export interface SessionOwner {
  userId: string;
  displayName: string | null;
}

export interface OwnerLookup {
  ownerOf(workspaceId: string, sessionId: string): Promise<SessionOwner | null>;
}

/** One row of `platform_mcp_confirmations` (3.6). */
export interface ConfirmationRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  toolUseId: string;
  userId: string;
  result: "allow" | "deny";
  previewDigest: string;
  /** Class of every operation, by `op_index`. */
  opClasses: OpClass[];
  /** Revision of every operation target from the digest, by `op_index`. */
  targetRevisions: (string | null)[];
  eventId: string | null;
  createdAt: string;
  usedAt: string | null;
}

export interface ConfirmationStore {
  insert(row: ConfirmationRow): Promise<void>;
  delete(id: string): Promise<void>;
  attachEvent(id: string, eventId: string): Promise<void>;
  /** The newest `allow` row for the call. */
  findAllow(workspaceId: string, sessionId: string, toolUseId: string): Promise<ConfirmationRow | null>;
  /** `UPDATE … SET used_at = ? WHERE id = ? AND used_at IS NULL`; false when no row changed. */
  markUsed(id: string, usedAt: string): Promise<boolean>;
}

export type RouteTokenIssuerKind = "handler" | "confirm";

export interface RouteTokenRequest {
  workspaceId: string;
  userId: string;
  sessionId: string;
  method: string;
  /** Exact path with the query string. */
  path: string;
  bodySha256: string;
  issuer: RouteTokenIssuerKind;
  /** Set by the `confirm` route: the only `tool_use_id` the token may confirm. */
  toolUseId?: string;
}

export interface RouteTokenIssuer {
  /** A one-time `route` token for exactly this request (3.3). */
  issueRoute(request: RouteTokenRequest): string;
}

/** `app.fetch` of main-node. The nested request never leaves the process. */
export type InnerFetch = (request: Request) => Promise<Response>;

export interface KnownSecrets {
  /** Values of every field labelled `secret` in `secret-fields.ts`, read anew on every call. */
  collect(workspaceId: string): Promise<readonly string[]>;
}

export type SessionToolCheckResult = { ok: true } | { ok: false; message: string };

export interface SessionToolCheck {
  /** The tool set of an assistant session (3.2). */
  check(workspaceId: string, sessionId: string): Promise<SessionToolCheckResult>;
}

export interface AssistantSwitch {
  /** No row means on (3.7). Read without a cache. */
  isEnabled(workspaceId: string): Promise<boolean>;
}

export type BodyCheckName =
  | "deployment_paused"
  | "model_card_safe"
  | "harness_card_safe"
  | "session_create"
  | "session_event";

export interface RouteRule {
  method: "GET" | "POST";
  /** Path pattern with `:param` segments and no query string. */
  pattern: string;
  bodyCheck: BodyCheckName | null;
  issuers: readonly RouteTokenIssuerKind[];
}

export interface BodyCheckContext {
  issuer: RouteTokenIssuerKind;
  headers: Headers;
  /** `toolUseId` of a `confirm` token. */
  toolUseId?: string;
}

export type BodyCheckResult = { ok: true } | { ok: false; reason: string };

export interface RouteAllowlist {
  match(method: string, path: string): RouteRule | null;
  /** Called by the token middleware after method, path and body hash match (2.4). */
  checkBody(rule: RouteRule, body: unknown, context: BodyCheckContext): BodyCheckResult;
}

export interface GateHookInfo {
  workspaceId: string;
  sessionId: string;
  toolUseId: string;
  tool: string;
}

/** Test hooks. Production code leaves them empty. */
export interface GateHooks {
  /** After the last digest check and before the nested write. */
  afterDigestCheck?(info: GateHookInfo): Promise<void> | void;
  /** After the `confirm` route wrote its row and before it sends the event. */
  afterConfirm?(info: GateHookInfo): Promise<void> | void;
}

/** Pure helpers of BX2 (`canonical-json.ts`, `secret-scan.ts`, `url-redact.ts`, `yaml-diff.ts`, `skill-spec.ts`, `docs-search.ts`). */
export interface PlatformMcpLibs {
  canonicalJson(value: unknown): string;
  /** Masks key patterns and every known value (also URL- and base64-encoded) with `[скрыто]`. */
  scan(text: string, known: readonly string[]): { text: string; count: number };
  /** True when the text has a well-known key pattern (`sk-`, `ghp_`, …). */
  hasKeyPattern(text: string): boolean;
  /** Drops user, password, query and fragment; returns them as secrets. */
  redactUrl(url: string): { url: string; secrets: string[] };
  yamlDiff(before: string, after: string): string;
  checkSkill(files: readonly { path: string; content: string }[]): { ok: boolean; errors: string[] };
  searchDocs(query: string, limit: number): { document: string; heading: string; text: string }[];
}

/** Kinds that `preview_change` validates and `help` describes. */
export type SchemaKind =
  | "agent"
  | "environment"
  | "deployment"
  | "memory"
  | "memory_store"
  | "session"
  | "outcome";

/** zod schemas of `P/managed-agents-api` by kind. */
export type ContractSchemas = Partial<
  Record<SchemaKind, { create?: z.ZodType; update?: z.ZodType }>
>;

export interface PlatformMcpDeps {
  innerFetch: InnerFetch;
  tokens: RouteTokenIssuer;
  actions: ActionLog;
  confirmations: ConfirmationStore;
  owners: OwnerLookup;
  knownSecrets: KnownSecrets;
  sessionToolCheck: SessionToolCheck;
  assistantSwitch: AssistantSwitch;
  libs: PlatformMcpLibs;
  schemas: ContractSchemas;
  /** `PLATFORM_MCP_URL`; an agent with an MCP server at this URL is an assistant. */
  platformMcpUrl: string;
  /** Console origin for `request_secret` links; relative links without it. */
  consoleUrl?: string;
  hooks?: GateHooks;
  now?: () => Date;
  randomId?: () => string;
}
