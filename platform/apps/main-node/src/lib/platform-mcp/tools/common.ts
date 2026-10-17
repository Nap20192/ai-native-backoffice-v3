// Shared types and helpers of the platform MCP tools (builder-agent.md 2.3).

import yaml from "js-yaml";
import { z } from "zod";
import type { InnerApi, InnerResponse } from "../inner-api";
import { routeErrorMessage } from "../inner-api";
import type {
  ActorClaims,
  OpClass,
  PlatformMcpDeps,
  PlatformMcpLibs,
  RouteRule,
} from "../ports";
import type { DependencyEntry } from "../classify";
import { cleanObject, type ShapeKind } from "../response-shape";

export type ToolGroup = "read" | "draft" | "write" | "batch";

/** A dependency report of archive or delete (crud.md 1.2). */
export interface DependencyReport {
  blocking: DependencyEntry[];
  affected: DependencyEntry[];
  truncated: boolean;
}

export const EMPTY_DEPENDENCIES: DependencyReport = { blocking: [], affected: [], truncated: false };

/** How a write carries the revision the user confirmed (2.5, step 8). */
export type Precondition =
  | "version_in_body"
  | "if_match"
  | "content_sha256_or_new_path"
  | "new_object";

export interface ToolOutput {
  text: string;
  isError?: boolean;
  maskedCount?: number;
  /** The tool scanned what it had to; model arguments in the text stay as they are (2.6). */
  prescanned?: boolean;
}

export interface AssistantSessionInfo {
  agentId: string | null;
  agentVersion: number | null;
  environmentId: string | null;
  model: string | null;
}

export interface CallContext {
  deps: PlatformMcpDeps;
  libs: PlatformMcpLibs;
  actor: ActorClaims;
  api: InnerApi;
  /** Known secret values, read once for this call. */
  known: readonly string[];
  /** Agent and environment of the assistant session, read once. */
  assistant(): Promise<AssistantSessionInfo>;
}

export interface BatchRefs {
  /** `ref` of an earlier operation of the batch and its tool and arguments. */
  refs: Map<string, { tool: string; args: any }>;
}

export interface OpContext extends CallContext {
  batch: BatchRefs | null;
}

export interface OpPlan {
  cls: OpClass;
  reason: string | null;
  targetId: string | null;
  revision: string | null;
  /** Statuses and other state that goes into the digest. */
  state: Record<string, unknown>;
  /** Cleaned current object or null for a new one. */
  before: unknown;
  after: unknown;
  warnings: string[];
  notFound?: string;
  invalid?: string;
  /** `expected_*` from the arguments does not match the current revision. */
  argsStale?: boolean;
  /** Extra lines for the console card, outside the digest. */
  details?: Record<string, unknown>;
  /** Archive and delete: the report read for this plan (crud.md 3.4). It goes into the digest. */
  dependencies?: DependencyReport | null;
  /** Delete: the card says «Это нельзя отменить». */
  irreversible?: boolean;
}

export type WriteOutcome =
  | {
      type: "ok";
      targetId: string | null;
      revision: string | null;
      summary: string;
      /** The usual next step after this write, for the model. */
      next?: string;
    }
  | { type: "stale"; message: string }
  | { type: "error"; message: string };

export interface WriteOp<A> {
  targetKind: string;
  /** The kind from the arguments, for tools that take any of several kinds. */
  kindOf?(args: A): string;
  /** The existing object the operation changes, for the batch check; null for a create. */
  targetKey(args: A): string | null;
  plan(ctx: OpContext, args: A): Promise<OpPlan>;
  write(ctx: OpContext, args: A, plan: OpPlan, revision: string | null): Promise<WriteOutcome>;
}

export interface ToolDef<A = any> {
  name: string;
  group: ToolGroup;
  description: string;
  args: z.ZodType<A>;
  routes: readonly RouteRule[];
  precondition: Precondition | null;
  run?(ctx: CallContext, args: A): Promise<ToolOutput>;
  op?: WriteOp<A>;
}

/** Kind of the operation target: from the arguments when the tool takes several kinds. */
export function targetKindOf(tool: ToolDef, args: unknown): string | null {
  if (!tool.op) return null;
  return tool.op.kindOf ? tool.op.kindOf(args) : tool.op.targetKind;
}

export const REF_PREFIX = "$ref:";

export function isRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(REF_PREFIX);
}

export const configSchema = z.union([z.record(z.string(), z.unknown()), z.string().min(1)]);

/** `config`, `changes` and `body` come as an object or a YAML string. */
export function parseConfig(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (typeof value !== "string") return { ok: true, value: (value ?? {}) as Record<string, unknown> };
  try {
    const parsed = yaml.load(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, message: "Строка YAML должна задавать объект" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, message: "Строка YAML не разбирается" };
  }
}

export function dumpYaml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return yaml.dump(value, { noRefs: true, lineWidth: -1, sortKeys: false });
}

export function assistantLabels(sessionId: string): Record<string, string> {
  return { oma_created_via: "assistant", oma_assistant_session: sessionId };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `ожидается ${issue.expected}`;
    case "unrecognized_keys":
      return `поля ${issue.keys.join(", ")} не принимаются`;
    case "too_big":
      return `больше предела ${String(issue.maximum)}`;
    case "too_small":
      return `меньше предела ${String(issue.minimum)}`;
    case "invalid_value":
      return `допустимо ${issue.values.map((value) => JSON.stringify(value)).join(", ")}`;
    case "invalid_format":
      return `ожидается формат ${issue.format}`;
    case "custom":
      return issue.message;
    default:
      return "значение не подходит";
  }
}

/** Own text of a schema error: the field and the expectation, never the value. */
export function formatSchemaError(error: z.ZodError): string {
  const lines = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join(".") || "аргументы";
    return `${path}: ${describeIssue(issue)}`;
  });
  return `Аргументы не прошли схему. ${lines.join("; ")}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge, arrays and scalars replace. */
export function mergeAfter(before: unknown, patch: unknown): unknown {
  if (!isRecord(before) || !isRecord(patch)) return patch;
  const out: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isRecord(value) && isRecord(before[key]) ? mergeAfter(before[key], value) : value;
  }
  return out;
}

function entryOf(value: unknown): DependencyEntry | null {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.id !== "string") return null;
  const text = (field: unknown) => (typeof field === "string" ? field : null);
  return { kind: value.kind, id: value.id, name: text(value.name), status: text(value.status), note: text(value.note) };
}

/** The report from a route answer; anything malformed counts as no rows. */
export function dependencyReportOf(value: unknown): DependencyReport {
  const list = (rows: unknown) => (Array.isArray(rows) ? rows.map(entryOf).filter((row): row is DependencyEntry => row !== null) : []);
  return isRecord(value)
    ? { blocking: list(value.blocking), affected: list(value.affected), truncated: value.truncated === true }
    : EMPTY_DEPENDENCIES;
}

/** Kind, id and status of every row: what the digest holds (crud.md 3.4). */
export function dependencyDigest(report: DependencyReport | null | undefined): unknown {
  if (!report) return null;
  const rows = (entries: readonly DependencyEntry[]) => entries.map((entry) => ({ kind: entry.kind, id: entry.id, status: entry.status }));
  return { blocking: rows(report.blocking), affected: rows(report.affected), truncated: report.truncated };
}

/** Revision from `ETag`, otherwise the fallback field value. */
export function revisionOf(response: InnerResponse, fallback?: unknown): string | null {
  const etag = response.headers.get("etag");
  if (etag) return etag;
  return fallback === undefined || fallback === null ? null : String(fallback);
}

export interface ReadObject {
  status: number;
  raw: any;
  clean: any;
  revision: string | null;
  response: InnerResponse;
}

/** GET an object, shape and scan it. `null` on 404. */
export async function readObject(
  ctx: CallContext,
  kind: ShapeKind,
  path: string,
  revisionField?: string,
): Promise<ReadObject | null> {
  const response = await ctx.api.get(path);
  if (response.status === 404) return null;
  if (!response.ok) throw new RouteError(response);
  const raw = response.json;
  return {
    status: response.status,
    raw,
    clean: cleanObject(kind, raw, ctx.known, ctx.libs).value,
    revision: revisionOf(response, revisionField ? raw?.[revisionField] : undefined),
    response,
  };
}

export class RouteError extends Error {
  constructor(readonly response: InnerResponse) {
    super(routeErrorMessage(response));
  }
}

/** Outcome of a nested write. 409 and 412 mean the object changed; a 409 with dependencies means one appeared. */
export function writeOutcome(
  ctx: CallContext,
  response: InnerResponse,
  summary: (json: any) => { targetId: string | null; revision: string | null; summary: string; next?: string },
): WriteOutcome {
  if (response.status === 409 || response.status === 412) {
    return { type: "stale", message: "Объект изменился после подтверждения. Покажи новую разницу и спроси снова" };
  }
  if (response.status === 404) return { type: "error", message: "Объект не найден" };
  if (!response.ok) {
    return { type: "error", message: ctx.libs.scan(routeErrorMessage(response), ctx.known).text };
  }
  return { type: "ok", ...summary(response.json) };
}

/** A known secret value of 8 and more characters inside the arguments (2.6). */
export function hasKnownSecret(value: unknown, known: readonly string[]): boolean {
  const long = known.filter((secret) => secret.length >= 8);
  if (long.length === 0) return false;
  const walk = (node: unknown): boolean => {
    if (typeof node === "string") return long.some((secret) => node.includes(secret));
    if (Array.isArray(node)) return node.some(walk);
    if (isRecord(node)) return Object.entries(node).some(([key, child]) => walk(key) || walk(child));
    return false;
  };
  return walk(value);
}

export function encodeId(id: string): string {
  return encodeURIComponent(id);
}

/** Query of the memory list that holds the entry at `path`: the route takes a folder prefix that starts and ends with `/`. */
export function memoryListQuery(path: string): string {
  const folder = path.startsWith("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  return new URLSearchParams({ ...(folder ? { path_prefix: folder } : {}), limit: "100" }).toString();
}

export const emptyPlan = (cls: OpClass): OpPlan => ({
  cls,
  reason: null,
  targetId: null,
  revision: null,
  state: {},
  before: null,
  after: null,
  warnings: [],
});
