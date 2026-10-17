// The tool table of the platform MCP server (builder-agent.md 2.3, 2.4).
// Every row has a group, routes and a precondition; the token allowlist is the
// union of the rows' routes, and some routes check the body (2.4).

import { z } from "zod";
import { HELP_TOPICS, helpText } from "./help";
import type { BodyCheckContext, BodyCheckResult, RouteAllowlist, RouteRule } from "./ports";
import { INTERNAL_ROUTES } from "./route-rules";
import { applyChangesTool } from "./tools/batch";
import { isRecord, type ToolDef } from "./tools/common";
import { CREATE_TOOLS } from "./tools/create";
import { DANGER_TOOLS } from "./tools/danger";
import { previewChangeTool } from "./tools/draft";
import { READ_TOOLS } from "./tools/read";
import { searchConfigTool, searchDocsTool } from "./tools/search";
import { SESSION_TOOLS } from "./tools/sessions";
import { UPDATE_TOOLS } from "./tools/update";

const helpArgs = z.object({ topic: z.enum(HELP_TOPICS) }).strict();

export const helpTool: ToolDef<z.infer<typeof helpArgs>> = {
  name: "help",
  group: "read",
  description: "Правила и поля объектов по теме: overview, agent, environment, session, skill, deployment, memory, model_card, outcome, danger, limits.",
  args: helpArgs,
  routes: [],
  precondition: null,
  async run(ctx, args) {
    return { text: helpText(args.topic, ctx.deps.schemas, TOOL_TABLE) };
  },
};

const ORDERED: ToolDef[] = [
  helpTool,
  searchDocsTool,
  searchConfigTool,
  ...READ_TOOLS,
  previewChangeTool,
  ...CREATE_TOOLS,
  ...SESSION_TOOLS,
  ...UPDATE_TOOLS,
  ...DANGER_TOOLS,
  applyChangesTool,
] as ToolDef[];

export const TOOL_TABLE: ReadonlyMap<string, ToolDef> = new Map(ORDERED.map((tool) => [tool.name, tool]));

/** Tools of the «черновик» set (1.1). */
export const DRAFT_SET = ["help", "list", "get", "preview_change"] as const;

/** Template policy: reads and the draft never ask (1.5). */
export function defaultPolicy(tool: ToolDef): "always_allow" | "always_ask" {
  return tool.group === "read" || tool.group === "draft" ? "always_allow" : "always_ask";
}

export function allRouteRules(): RouteRule[] {
  const rules = new Map<string, RouteRule>();
  for (const tool of TOOL_TABLE.values()) for (const rule of tool.routes) rules.set(`${rule.method} ${rule.pattern}`, rule);
  for (const rule of INTERNAL_ROUTES) {
    const key = `${rule.method} ${rule.pattern}`;
    const existing = rules.get(key);
    rules.set(key, existing ? { ...existing, issuers: [...new Set([...existing.issuers, ...rule.issuers])] } : rule);
  }
  return [...rules.values()];
}

function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("?")[0].split("/");
  if (want.length !== got.length) return false;
  return want.every((segment, index) => (segment.startsWith(":") ? got[index].length > 0 : segment === got[index]));
}

const ok: BodyCheckResult = { ok: true };
const refuse = (reason: string): BodyCheckResult => ({ ok: false, reason });

const MODEL_CARD_FORBIDDEN = ["api_key", "custom_headers", "provider", "base_url"];
const SESSION_METADATA = new Set(["oma_created_via", "oma_assistant_session"]);

function checkSessionCreate(body: unknown): BodyCheckResult {
  if (!isRecord(body)) return refuse("body is not an object");
  const agent = body.agent;
  if (!isRecord(agent) || agent.type !== "agent" || typeof agent.id !== "string" || !Number.isInteger(agent.version)) {
    return refuse("agent must be {type: agent, id, version}");
  }
  for (const field of ["initial_events", "budget", "vault_ids"]) if (field in body) return refuse(`${field} is not allowed`);
  const resources = body.resources ?? [];
  if (!Array.isArray(resources) || resources.some((resource) => !isRecord(resource) || resource.type !== "file")) {
    return refuse("only file resources are allowed");
  }
  const metadata = body.metadata ?? {};
  if (!isRecord(metadata) || Object.keys(metadata).some((key) => !SESSION_METADATA.has(key))) {
    return refuse("only oma_* metadata is allowed");
  }
  return ok;
}

function checkSessionEvent(body: unknown, context: BodyCheckContext): BodyCheckResult {
  if (!isRecord(body) || !Array.isArray(body.events) || body.events.length !== 1) return refuse("exactly one event");
  const event = body.events[0];
  if (!isRecord(event)) return refuse("event is not an object");
  if (context.issuer === "confirm") {
    if (event.type !== "user.tool_confirmation") return refuse("confirm tokens send user.tool_confirmation only");
    if (!context.toolUseId || event.tool_use_id !== context.toolUseId) return refuse("tool_use_id of another confirmation");
    return ok;
  }
  if (event.type !== "user.message") return refuse("handler tokens send user.message only");
  const content = event.content;
  if (!Array.isArray(content) || content.length === 0 || content.some((block) => !isRecord(block) || block.type !== "text")) {
    return refuse("text blocks only");
  }
  if (!context.headers.get("if-match")) return refuse("If-Match is required");
  return ok;
}

const SESSION_UPDATE_ALLOWED = new Set(["title", "metadata"]);
const SESSION_RESOURCE_TYPES = new Set(["file", "memory_store"]);

/** Title and metadata only: tools, MCP servers, budget and vaults stay with the human (crud.md 3.3). */
function checkSessionUpdate(body: unknown): BodyCheckResult {
  if (!isRecord(body) || Object.keys(body).some((key) => !SESSION_UPDATE_ALLOWED.has(key))) return refuse("only title and metadata are allowed");
  const metadata = body.metadata;
  if (metadata === undefined || metadata === null) return ok;
  if (!isRecord(metadata)) return refuse("metadata is not an object");
  return Object.keys(metadata).some((key) => key.startsWith("oma_")) ? refuse("oma_* metadata is not allowed") : ok;
}

function checkSessionResource(body: unknown): BodyCheckResult {
  if (!isRecord(body) || typeof body.type !== "string" || !SESSION_RESOURCE_TYPES.has(body.type)) {
    return refuse("only file and memory_store resources are allowed");
  }
  return "authorization_token" in body ? refuse("authorization_token is not allowed") : ok;
}

export const routeAllowlist: RouteAllowlist = {
  match(method, path) {
    const upper = method.toUpperCase();
    return allRouteRules().find((rule) => rule.method === upper && matches(rule.pattern, path)) ?? null;
  },
  checkBody(rule, body, context) {
    if (!rule.issuers.includes(context.issuer)) return refuse(`issuer ${context.issuer} cannot call this route`);
    switch (rule.bodyCheck) {
      case null:
        return ok;
      case "deployment_paused":
        return isRecord(body) && isRecord(body._oma) && body._oma.paused === true ? ok : refuse("_oma.paused: true is required");
      case "model_card_safe":
        return isRecord(body) && !MODEL_CARD_FORBIDDEN.some((key) => key in body) ? ok : refuse("key, URL, provider and headers are not allowed");
      case "session_create":
        return checkSessionCreate(body);
      case "session_event":
        return checkSessionEvent(body, context);
      case "session_update":
        return checkSessionUpdate(body);
      case "if_match_required":
        return context.headers.get("if-match") ? ok : refuse("If-Match is required");
      case "session_resource":
        return checkSessionResource(body);
    }
  },
};
