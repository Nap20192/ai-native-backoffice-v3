// In-memory fake of the `/v1` routes the platform MCP server calls, with the
// real route allowlist and body checks in front of it. Revisions, `ETag` and
// `If-Match` behave like the routes after BP1: a stale `If-Match` gives 412.

import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { Hono } from "hono";
import { buildConfirmRoutes } from "../../src/lib/platform-mcp/confirm-routes";
import { callTool } from "../../src/lib/platform-mcp/handler";
import type {
  ActionRow,
  ActorClaims,
  ConfirmationRow,
  GateHooks,
  PlatformMcpDeps,
  RouteTokenRequest,
} from "../../src/lib/platform-mcp/ports";
import { routeAllowlist } from "../../src/lib/platform-mcp/tool-table";
import { testLibs } from "./platform-mcp-libs";

export const PLATFORM_URL = "http://127.0.0.1:8787/v1/oma/platform-mcp";
export const WS = "ws_1";
export const OWNER = "user_owner";
export const MEMBER = "user_member";
export const ASSISTANT_SESSION = "sesn_assistant";

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const etag = (rev: number) => `"${rev}"`;

type Json = Record<string, any>;

export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

export function createFakePlatform() {
  let clock = Date.parse("2026-10-16T10:00:00.000Z");
  let seq = 0;
  const now = () => new Date((clock += 1000)).toISOString();
  const id = (prefix: string) => `${prefix}_${++seq}`;

  const agents = new Map<string, { versions: Json[]; archived_at: string | null }>();
  const environments = new Map<string, Json & { rev: number }>();
  const sessions = new Map<string, Json & { rev: number }>();
  const events = new Map<string, Json[]>();
  const stores = new Map<string, Json & { rev: number }>();
  const memories = new Map<string, Json>();
  const deployments = new Map<string, Json & { rev: number }>();
  const modelCards = new Map<string, Json>();
  const files = new Map<string, Json & { bytes: Uint8Array }>();
  const skills = new Map<string, Json & { rev: number; versions: Map<string, Record<string, Uint8Array>> }>();
  const credentials: Json[] = [];
  const trajectories = new Map<string, unknown>();
  /** Handles of the built-in catalog, as with a server ANTHROPIC_API_KEY. */
  const builtinModels: string[] = [];
  /** Off by default: older tests use model names no catalog has. */
  let modelCatalog = false;

  const tokens = new Map<string, RouteTokenRequest>();
  const calls: FakeCall[] = [];
  const rejected: { method: string; path: string; reason: string }[] = [];
  const actionRows: ActionRow[] = [];
  const confirmationRows: ConfirmationRow[] = [];
  const owners = new Map<string, string>();
  const known: string[] = [];
  let knownReads = 0;
  let enabled = true;
  let toolCheck: { ok: true } | { ok: false; message: string } = { ok: true };
  const hooks: GateHooks = {};

  const agentView = (agentId: string, version?: number) => {
    const entry = agents.get(agentId);
    if (!entry) return null;
    const snapshot = version ? entry.versions[version - 1] : entry.versions.at(-1);
    return snapshot ? ({ ...snapshot, archived_at: entry.archived_at } as Json) : null;
  };

  const app = new Hono();
  const notFound = (c: any) => c.json({ error: { type: "not_found_error", message: "not found" } }, 404);
  const ifMatchFails = (c: any, current: string) => {
    const header = c.req.header("if-match");
    return header !== undefined && header !== current;
  };
  const page = (data: unknown[]) => ({ data, next_page: null });

  // agents
  app.get("/v1/agents", (c) => c.json(page([...agents.keys()].map((key) => agentView(key)))));
  app.get("/v1/agents/:id", (c) => {
    const view = agentView(c.req.param("id"), c.req.query("version") ? Number(c.req.query("version")) : undefined);
    return view ? c.json(view) : notFound(c);
  });
  app.get("/v1/agents/:id/versions", (c) => {
    const entry = agents.get(c.req.param("id"));
    return entry ? c.json(page(entry.versions)) : notFound(c);
  });
  app.post("/v1/agents", async (c) => {
    const body = await c.req.json();
    const agent = api.addAgent(body);
    return c.json(agent, 200);
  });
  app.post("/v1/agents/:id", async (c) => {
    const entry = agents.get(c.req.param("id"));
    if (!entry) return notFound(c);
    const body = await c.req.json();
    const current = entry.versions.at(-1)!;
    if (body.version !== current.version) return c.json({ error: { message: "version conflict" } }, 409);
    const { version: _v, ...changes } = body;
    const next = { ...current, ...changes, version: current.version + 1, updated_at: now() };
    entry.versions.push(next);
    return c.json(next);
  });

  // environments
  app.get("/v1/environments", (c) => c.json(page([...environments.values()].map(({ rev: _r, ...env }) => env))));
  app.get("/v1/environments/:id", (c) => {
    const env = environments.get(c.req.param("id"));
    if (!env) return notFound(c);
    const { rev, ...rest } = env;
    return c.json(rest, 200, { etag: etag(rev) });
  });
  app.post("/v1/environments", async (c) => {
    const env = api.addEnvironment(await c.req.json());
    return c.json(env, 200, { etag: etag(1) });
  });
  app.post("/v1/environments/:id", async (c) => {
    const env = environments.get(c.req.param("id"));
    if (!env) return notFound(c);
    if (ifMatchFails(c, etag(env.rev))) return c.json({ error: { message: "precondition failed" } }, 412);
    Object.assign(env, await c.req.json(), { rev: env.rev + 1, updated_at: now() });
    const { rev, ...rest } = env;
    return c.json(rest, 200, { etag: etag(rev) });
  });

  // sessions
  const sessionView = (session: Json & { rev: number }) => {
    const { rev: _r, ...rest } = session;
    return rest;
  };
  app.get("/v1/sessions", (c) => c.json(page([...sessions.values()].map(sessionView))));
  app.get("/v1/sessions/:id", (c) => {
    const session = sessions.get(c.req.param("id"));
    return session ? c.json(sessionView(session), 200, { etag: etag(session.rev) }) : notFound(c);
  });
  app.post("/v1/sessions", async (c) => {
    const body = await c.req.json();
    const agent = agentView(body.agent.id, body.agent.version);
    if (!agent || agent.archived_at) return c.json({ error: { message: "agent unavailable" } }, 400);
    const env = environments.get(body.environment_id);
    if (!env || env.archived_at) return c.json({ error: { message: "environment unavailable" } }, 400);
    for (const resource of body.resources ?? []) if (!files.has(resource.file_id)) return c.json({ error: { message: "file missing" } }, 400);
    const session = api.addSession({ agentId: agent.id, agentVersion: agent.version, environmentId: body.environment_id, owner: c.req.header("x-test-user") ?? OWNER, title: body.title, metadata: body.metadata, resources: body.resources });
    return c.json(sessionView(sessions.get(session)!), 200, { etag: etag(1) });
  });
  app.get("/v1/sessions/:id/events", (c) => {
    const list = events.get(c.req.param("id"));
    if (!list) return notFound(c);
    const types = c.req.queries("types");
    return c.json(page(types?.length ? list.filter((event) => types.includes(event.type)) : list));
  });
  app.post("/v1/sessions/:id/events", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return notFound(c);
    if (ifMatchFails(c, etag(session.rev))) return c.json({ error: { message: "precondition failed" } }, 412);
    const body = await c.req.json();
    const written = body.events.map((event: Json) => api.pushEvent(session.id, event));
    return c.json({ data: written }, 200, { etag: etag(session.rev) });
  });
  app.get("/v1/oma/sessions/:id/trajectory", (c) => {
    const value = trajectories.get(c.req.param("id"));
    return value === undefined ? notFound(c) : c.json(value);
  });

  // memory
  const storeView = (store: Json & { rev: number }) => {
    const { rev: _r, ...rest } = store;
    return rest;
  };
  app.get("/v1/memory_stores", (c) => c.json(page([...stores.values()].map(storeView))));
  app.get("/v1/memory_stores/:id", (c) => {
    const store = stores.get(c.req.param("id"));
    return store ? c.json(storeView(store), 200, { etag: etag(store.rev) }) : notFound(c);
  });
  app.post("/v1/memory_stores", async (c) => {
    const store = api.addStore(await c.req.json());
    return c.json(store, 200, { etag: etag(1) });
  });
  app.post("/v1/memory_stores/:id", async (c) => {
    const store = stores.get(c.req.param("id"));
    if (!store) return notFound(c);
    if (ifMatchFails(c, etag(store.rev))) return c.json({ error: { message: "precondition failed" } }, 412);
    Object.assign(store, await c.req.json(), { rev: store.rev + 1 });
    return c.json(storeView(store), 200, { etag: etag(store.rev) });
  });
  const memoryView = (memory: Json, full: boolean) => {
    const { content, ...rest } = memory;
    return full ? { ...rest, content } : rest;
  };
  app.get("/v1/memory_stores/:id/memories", (c) => {
    if (!stores.has(c.req.param("id"))) return notFound(c);
    const prefix = c.req.query("path_prefix") ?? "";
    const list = [...memories.values()].filter((m) => m.memory_store_id === c.req.param("id") && String(m.path).startsWith(prefix));
    return c.json(page(list.map((m) => memoryView(m, false))));
  });
  app.get("/v1/memory_stores/:id/memories/:mid", (c) => {
    const memory = memories.get(c.req.param("mid"));
    return memory ? c.json(memoryView(memory, c.req.query("view") === "full")) : notFound(c);
  });
  app.post("/v1/memory_stores/:id/memories", async (c) => {
    const body = await c.req.json();
    if ([...memories.values()].some((m) => m.memory_store_id === c.req.param("id") && m.path === body.path)) {
      return c.json({ error: { message: "path taken" } }, 409);
    }
    return c.json(memoryView(api.addMemory(c.req.param("id"), body.path, body.content), true));
  });
  app.post("/v1/memory_stores/:id/memories/:mid", async (c) => {
    const memory = memories.get(c.req.param("mid"));
    if (!memory) return notFound(c);
    const body = await c.req.json();
    if (body.precondition?.content_sha256 && body.precondition.content_sha256 !== memory.content_sha256) {
      return c.json({ error: { message: "precondition failed" } }, 409);
    }
    Object.assign(memory, { content: body.content, content_sha256: sha(body.content), updated_at: now() });
    return c.json(memoryView(memory, true));
  });

  // deployments
  const deploymentView = (deployment: Json & { rev: number }) => {
    const { rev: _r, ...rest } = deployment;
    return rest;
  };
  app.get("/v1/deployments", (c) => c.json(page([...deployments.values()].map(deploymentView))));
  app.get("/v1/deployments/:id", (c) => {
    const deployment = deployments.get(c.req.param("id"));
    return deployment ? c.json(deploymentView(deployment), 200, { etag: etag(deployment.rev) }) : notFound(c);
  });
  app.post("/v1/deployments", async (c) => {
    const { _oma, ...body } = await c.req.json();
    const env = environments.get(body.environment_id);
    if (!env || env.archived_at) return c.json({ error: { message: "environment archived" } }, 400);
    const created = api.addDeployment({ ...body, status: _oma?.paused ? "paused" : "active" });
    return c.json(created, 200, { etag: etag(1) });
  });
  app.post("/v1/deployments/:id", async (c) => {
    const deployment = deployments.get(c.req.param("id"));
    if (!deployment) return notFound(c);
    if (ifMatchFails(c, etag(deployment.rev))) return c.json({ error: { message: "precondition failed" } }, 412);
    Object.assign(deployment, await c.req.json(), { rev: deployment.rev + 1, updated_at: now() });
    return c.json(deploymentView(deployment), 200, { etag: etag(deployment.rev) });
  });

  // model cards
  const cardView = ({ api_key: _k, ...card }: Json) => card;
  app.get("/v1/oma/model_cards", (c) => c.json({ data: [...modelCards.values()].map(cardView) }));
  app.get("/v1/oma/model_cards/:id", (c) => {
    const card = modelCards.get(c.req.param("id"));
    return card ? c.json(cardView(card), 200, { etag: card.updated_at ?? card.created_at }) : notFound(c);
  });
  app.post("/v1/oma/model_cards/:id", async (c) => {
    const card = modelCards.get(c.req.param("id"));
    if (!card) return notFound(c);
    if (ifMatchFails(c, card.updated_at ?? card.created_at)) return c.json({ error: { message: "precondition failed" } }, 412);
    Object.assign(card, await c.req.json(), { updated_at: now() });
    return c.json(cardView(card), 200, { etag: card.updated_at });
  });
  // Like GET /v1/oma/model_options: live cards by handle, then built-in models.
  app.get("/v1/oma/model_options", (c) =>
    !modelCatalog ? notFound(c) : c.json({
      builtin_available: builtinModels.length > 0,
      data: [
        ...[...modelCards.values()]
          .filter((card) => !card.archived_at)
          .map((card) => ({ handle: card.model_id, label: card.model_id, source: "card", card_id: card.id, is_default: card.is_default === true, provider: card.provider, wire_model: card.model, harnesses: ["pi"] })),
        ...builtinModels.map((handle) => ({ handle, label: handle, source: "builtin", card_id: null, is_default: false, provider: "anthropic", wire_model: handle, harnesses: ["pi"] })),
      ],
    }),
  );
  app.get("/v1/models", (c) => c.json({ data: [{ id: "qwen3.6-35b", type: "model", display_name: "Qwen", created_at: now() }], next_page: null }));

  // files and skills
  const fileView = ({ bytes: _b, ...file }: Json) => file;
  app.get("/v1/files", (c) => c.json({ data: [...files.values()].map(fileView), has_more: false, first_id: null, last_id: null }));
  app.get("/v1/files/:id", (c) => {
    const file = files.get(c.req.param("id"));
    return file ? c.json(fileView(file)) : notFound(c);
  });
  app.get("/v1/files/:id/content", (c) => {
    const file = files.get(c.req.param("id"));
    return file ? new Response(file.bytes.slice().buffer as ArrayBuffer, { headers: { "content-type": file.mime_type } }) : notFound(c);
  });
  app.post("/v1/files", async (c) => {
    const form = await c.req.formData();
    const file = form.get("file") as File;
    const created = api.addFile(file.name, new Uint8Array(await file.arrayBuffer()), file.type || "text/plain");
    return c.json(fileView(created));
  });
  const skillView = ({ rev: _r, versions: _v, ...skill }: Json) => skill;
  app.get("/v1/skills", (c) => c.json(page([...skills.values()].map(skillView))));
  app.get("/v1/skills/:id", (c) => {
    const skill = skills.get(c.req.param("id"));
    return skill ? c.json(skillView(skill), 200, { etag: etag(skill.rev) }) : notFound(c);
  });
  app.get("/v1/skills/:id/versions/:version/content", (c) => {
    const version = skills.get(c.req.param("id"))?.versions.get(c.req.param("version"));
    if (!version) return notFound(c);
    const zipped = zipSync(Object.fromEntries(Object.entries(version).map(([path, bytes]) => [`skill-dir/${path}`, bytes])));
    return new Response(zipped.slice().buffer as ArrayBuffer, { headers: { "content-type": "application/zip" } });
  });
  const readSkillForm = async (form: FormData) => {
    const out: Record<string, Uint8Array> = {};
    for (const entry of form.getAll("files[]")) out[(entry as File).name] = new Uint8Array(await (entry as File).arrayBuffer());
    return out;
  };
  app.post("/v1/skills", async (c) => {
    const form = await c.req.formData();
    const created = api.addSkill(String(form.get("display_title") ?? ""), await readSkillForm(form));
    return c.json(skillView(created), 200, { etag: etag(1) });
  });
  app.post("/v1/skills/:id/versions", async (c) => {
    const skill = skills.get(c.req.param("id"));
    if (!skill) return notFound(c);
    if (ifMatchFails(c, etag(skill.rev))) return c.json({ error: { message: "precondition failed" } }, 412);
    const version = String(Number(skill.latest_version) + 1);
    skill.versions.set(version, await readSkillForm(await c.req.formData()));
    Object.assign(skill, { latest_version: version, rev: skill.rev + 1 });
    return c.json({ id: id("skillver"), skill_id: skill.id, version, type: "skill_version" }, 200, { etag: etag(skill.rev) });
  });

  // archive, restore and delete (docs/plans/crud.md, 1.1 to 1.4)
  type Report = { blocking: Json[]; affected: Json[]; truncated: boolean };
  const dependencyReports = new Map<string, Report>();
  const reportOf = (kind: string, targetId: string, operation: string): Report =>
    dependencyReports.get(`${kind}:${targetId}:${operation}`) ?? { blocking: [], affected: [], truncated: false };
  const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, "$1");
  const staleIfMatch = (c: any, current: string | number | null | undefined) => {
    const header = c.req.header("if-match");
    return header !== undefined && unquote(header) !== unquote(String(current ?? ""));
  };
  const preconditionFailed = (c: any) => c.json({ type: "error", error: { type: "precondition_failed_error", message: "precondition failed" } }, 412);
  const dependencyConflict = (c: any, report: Report) =>
    c.json({ type: "error", error: { type: "dependency_conflict_error", message: "remove the blocking dependencies first", dependencies: report } }, 409);
  app.get("/v1/oma/dependencies/:kind/:id", (c) => {
    const operation = c.req.query("operation") ?? "";
    if (operation !== "archive" && operation !== "delete") return c.json({ error: { message: "operation" } }, 400);
    const version = c.req.query("version");
    return c.json(reportOf(c.req.param("kind"), version ? `${c.req.param("id")}@${version}` : c.req.param("id"), operation));
  });

  interface Archivable {
    kind: string;
    base: string;
    find(objectId: string): Json | undefined;
    revision(object: Json): string | number;
    view(object: Json): Json;
    bump(object: Json): void;
    remove(objectId: string): void;
  }
  const revBump = (object: Json) => {
    object.rev += 1;
  };
  const archivables: Archivable[] = [
    {
      kind: "agent",
      base: "/v1/agents",
      find: (objectId) => (agents.has(objectId) ? { id: objectId, entry: agents.get(objectId) } : undefined),
      revision: (object) => object.entry.versions.at(-1).version,
      view: (object) => agentView(object.id)!,
      bump: () => {},
      remove: (objectId) => agents.delete(objectId),
    },
    { kind: "environment", base: "/v1/environments", find: (key) => environments.get(key), revision: (o) => etag(o.rev), view: ({ rev: _r, ...o }) => o, bump: revBump, remove: (key) => environments.delete(key) },
    { kind: "session", base: "/v1/sessions", find: (key) => sessions.get(key), revision: (o) => etag(o.rev), view: ({ rev: _r, ...o }) => o, bump: revBump, remove: (key) => sessions.delete(key) },
    { kind: "deployment", base: "/v1/deployments", find: (key) => deployments.get(key), revision: (o) => etag(o.rev), view: ({ rev: _r, ...o }) => o, bump: revBump, remove: (key) => deployments.delete(key) },
    { kind: "memory_store", base: "/v1/memory_stores", find: (key) => stores.get(key), revision: (o) => etag(o.rev), view: ({ rev: _r, ...o }) => o, bump: revBump, remove: (key) => stores.delete(key) },
    { kind: "model_card", base: "/v1/oma/model_cards", find: (key) => modelCards.get(key), revision: (o) => o.updated_at ?? o.created_at, view: ({ api_key: _k, ...o }) => o, bump: (o) => { o.updated_at = now(); }, remove: (key) => modelCards.delete(key) },
  ];
  for (const target of archivables) {
    const state = (action: "archive" | "unarchive") => async (c: any) => {
      const object = target.find(c.req.param("id"));
      if (!object) return notFound(c);
      if (staleIfMatch(c, target.revision(object))) return preconditionFailed(c);
      if (action === "archive") {
        const report = reportOf(target.kind, c.req.param("id"), "archive");
        if (report.blocking.length > 0) return dependencyConflict(c, report);
      }
      const holder = target.kind === "agent" ? object.entry : object;
      holder.archived_at = action === "archive" ? now() : null;
      if (target.kind === "deployment" && action === "unarchive") Object.assign(object, { status: "paused", paused_reason: { type: "manual" } });
      target.bump(object);
      return c.json(target.view(object), 200, { etag: String(target.revision(object)) });
    };
    app.post(`${target.base}/:id/archive`, state("archive"));
    app.post(`${target.base}/:id/unarchive`, state("unarchive"));
    if (target.kind === "deployment") continue;
    app.delete(`${target.base}/:id`, (c) => {
      const object = target.find(c.req.param("id"));
      if (!object) return notFound(c);
      if (staleIfMatch(c, target.revision(object))) return preconditionFailed(c);
      const report = reportOf(target.kind, c.req.param("id"), "delete");
      if (report.blocking.length > 0) return dependencyConflict(c, report);
      target.remove(c.req.param("id"));
      return c.json({ id: c.req.param("id"), type: `${target.kind}_deleted` });
    });
  }
  app.delete("/v1/files/:id", (c) => {
    if (!files.has(c.req.param("id"))) return notFound(c);
    const report = reportOf("file", c.req.param("id"), "delete");
    if (report.blocking.length > 0) return dependencyConflict(c, report);
    files.delete(c.req.param("id"));
    return c.json({ id: c.req.param("id"), type: "file_deleted" });
  });
  app.delete("/v1/skills/:id", (c) => {
    const skill = skills.get(c.req.param("id"));
    if (!skill) return notFound(c);
    if (staleIfMatch(c, etag(skill.rev))) return preconditionFailed(c);
    const report = reportOf("skill", skill.id, "delete");
    if (report.blocking.length > 0) return dependencyConflict(c, report);
    skills.delete(skill.id);
    return c.json({ id: skill.id, type: "skill_deleted" });
  });
  app.get("/v1/skills/:id/versions/:version", (c) => {
    const skill = skills.get(c.req.param("id"));
    if (!skill?.versions.has(c.req.param("version"))) return notFound(c);
    return c.json({ type: "skill_version", skill_id: skill.id, version: c.req.param("version"), name: skill.display_title }, 200, { etag: etag(skill.rev) });
  });
  app.delete("/v1/skills/:id/versions/:version", (c) => {
    const skill = skills.get(c.req.param("id"));
    if (!skill?.versions.has(c.req.param("version"))) return notFound(c);
    if (staleIfMatch(c, etag(skill.rev))) return preconditionFailed(c);
    const report = reportOf("skill_version", `${skill.id}@${c.req.param("version")}`, "delete");
    if (report.blocking.length > 0) return dependencyConflict(c, report);
    skill.versions.delete(c.req.param("version"));
    skill.rev += 1;
    return c.json({ id: c.req.param("version"), type: "skill_version_deleted" }, 200, { etag: etag(skill.rev) });
  });
  app.delete("/v1/memory_stores/:id/memories/:mid", (c) => {
    const memory = memories.get(c.req.param("mid"));
    if (!memory || memory.memory_store_id !== c.req.param("id")) return notFound(c);
    const expected = c.req.query("expected_content_sha256");
    if (expected && expected !== memory.content_sha256) return c.json({ error: { message: "precondition failed" } }, 409);
    memories.delete(memory.id);
    return c.json({ id: memory.id, type: "memory_deleted" });
  });

  // session title, metadata and resources
  app.post("/v1/sessions/:id", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return notFound(c);
    if (staleIfMatch(c, etag(session.rev))) return preconditionFailed(c);
    const body = await c.req.json();
    if (body.title !== undefined) session.title = body.title;
    if (body.metadata !== undefined) {
      const metadata = { ...session.metadata };
      for (const [key, value] of Object.entries(body.metadata ?? {})) {
        if (value === null) delete metadata[key];
        else metadata[key] = value;
      }
      session.metadata = metadata;
    }
    session.rev += 1;
    return c.json(sessionView(session), 200, { etag: etag(session.rev) });
  });
  app.get("/v1/sessions/:id/resources", (c) => {
    const session = sessions.get(c.req.param("id"));
    return session ? c.json(page(session.resources)) : notFound(c);
  });
  app.post("/v1/sessions/:id/resources", async (c) => {
    const session = sessions.get(c.req.param("id"));
    if (!session) return notFound(c);
    const body = await c.req.json();
    if (!files.has(body.file_id)) return c.json({ error: { message: "file missing" } }, 404);
    const resource = { id: id("sesrsc"), type: "file", file_id: body.file_id, mount_path: body.mount_path ?? `/mnt/session/uploads/${body.file_id}`, created_at: now(), updated_at: now() };
    session.resources = [...session.resources, resource];
    session.rev += 1;
    return c.json(resource);
  });
  app.get("/v1/sessions/:id/resources/:rid", (c) => {
    const resource = sessions.get(c.req.param("id"))?.resources.find((item: Json) => item.id === c.req.param("rid"));
    return resource ? c.json(resource) : notFound(c);
  });
  app.delete("/v1/sessions/:id/resources/:rid", (c) => {
    const session = sessions.get(c.req.param("id"));
    const resource = session?.resources.find((item: Json) => item.id === c.req.param("rid"));
    if (!session || !resource) return notFound(c);
    session.resources = session.resources.filter((item: Json) => item.id !== resource.id);
    session.rev += 1;
    return c.json({ id: resource.id, type: "session_resource_deleted" });
  });

  // deployment state
  for (const action of ["pause", "unpause"] as const) {
    app.post(`/v1/deployments/:id/${action}`, (c) => {
      const deployment = deployments.get(c.req.param("id"));
      if (!deployment) return notFound(c);
      if (staleIfMatch(c, etag(deployment.rev))) return preconditionFailed(c);
      if (deployment.archived_at) return c.json({ error: { message: "archived" } }, 409);
      Object.assign(deployment, action === "pause" ? { status: "paused", paused_reason: { type: "manual" } } : { status: "active", paused_reason: null });
      deployment.rev += 1;
      return c.json(deploymentView(deployment), 200, { etag: etag(deployment.rev) });
    });
  }
  const runs: Json[] = [];
  app.post("/v1/deployments/:id/run", (c) => {
    const deployment = deployments.get(c.req.param("id"));
    if (!deployment) return notFound(c);
    if (deployment.archived_at) return c.json({ error: { message: "archived" } }, 409);
    const run = { id: id("deprun"), type: "deployment_run", deployment_id: deployment.id, session_id: id("sesn"), agent: deployment.agent, error: null, created_at: now() };
    runs.push(run);
    return c.json(run);
  });

  // vaults
  app.get("/v1/vaults", (c) => c.json(page([{ id: "vlt_1", type: "vault", display_name: "Главное", metadata: {} }])));
  app.get("/v1/vaults/:id/credentials", (c) => c.json(page(credentials)));
  app.get("/v1/oma/evals/runs", (c) => c.json({ data: [] }));
  app.get("/v1/deployment_runs", (c) => c.json(page(runs.filter((run) => !c.req.query("deployment_id") || run.deployment_id === c.req.query("deployment_id")))));

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    const bytes = new Uint8Array(await request.clone().arrayBuffer());
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const claims = tokens.get(token);
    tokens.delete(token);
    const reject = (reason: string) => {
      rejected.push({ method: request.method, path, reason });
      return new Response(JSON.stringify({ error: { message: reason } }), { status: 403 });
    };
    if (!claims) return reject("no token");
    if (claims.method !== request.method || claims.path !== path || claims.bodySha256 !== sha(bytes)) return reject("token mismatch");
    const rule = routeAllowlist.match(request.method, path);
    if (!rule) return reject("route not in table");
    let body: unknown = null;
    if ((request.headers.get("content-type") ?? "").includes("json") && bytes.length > 0) body = JSON.parse(new TextDecoder().decode(bytes));
    const check = routeAllowlist.checkBody(rule, body, { issuer: claims.issuer, headers: request.headers, toolUseId: claims.toolUseId });
    if (!check.ok) return reject(check.reason);
    calls.push({ method: request.method, path, body, headers: request.headers });
    const headers = new Headers(request.headers);
    headers.set("x-test-user", claims.userId);
    return app.fetch(new Request(request.url, { method: request.method, headers, ...(bytes.length ? { body: bytes } : {}) }));
  };

  let tokenSeq = 0;
  const deps: PlatformMcpDeps = {
    innerFetch: fetch,
    tokens: {
      issueRoute(request) {
        const token = `oma-mcp-v1.test${++tokenSeq}`;
        tokens.set(token, request);
        return token;
      },
    },
    actions: {
      async insert(row) {
        if (actionRows.some((r) => r.sessionId === row.sessionId && r.toolUseId === row.toolUseId && r.opIndex === row.opIndex)) {
          return { inserted: false };
        }
        actionRows.push(row);
        return { inserted: true };
      },
      async findByToolUse(workspaceId, sessionId, toolUseId) {
        return actionRows.filter((r) => r.workspaceId === workspaceId && r.sessionId === sessionId && r.toolUseId === toolUseId);
      },
      async findSessionCreatedBy(workspaceId, assistantSessionId, createdSessionId) {
        return actionRows.some(
          (r) => r.workspaceId === workspaceId && r.sessionId === assistantSessionId && r.tool === "create_session" && r.result === "ok" && r.targetId === createdSessionId,
        );
      },
    },
    confirmations: {
      async insert(row) {
        confirmationRows.push({ ...row });
      },
      async delete(rowId) {
        const index = confirmationRows.findIndex((r) => r.id === rowId);
        if (index >= 0) confirmationRows.splice(index, 1);
      },
      async attachEvent(rowId, eventId) {
        const row = confirmationRows.find((r) => r.id === rowId);
        if (row) row.eventId = eventId;
      },
      async findAllow(workspaceId, sessionId, toolUseId) {
        return confirmationRows.filter((r) => r.workspaceId === workspaceId && r.sessionId === sessionId && r.toolUseId === toolUseId && r.result === "allow").at(-1) ?? null;
      },
      async markUsed(rowId, usedAt) {
        const row = confirmationRows.find((r) => r.id === rowId);
        if (!row || row.usedAt !== null) return false;
        row.usedAt = usedAt;
        return true;
      },
    },
    owners: {
      async ownerOf(_workspaceId, sessionId) {
        const userId = owners.get(sessionId);
        return userId ? { userId, displayName: userId === OWNER ? "Анна" : "Борис" } : null;
      },
    },
    knownSecrets: {
      async collect() {
        knownReads++;
        return [...known];
      },
    },
    sessionToolCheck: { check: async () => toolCheck },
    assistantSwitch: { isEnabled: async () => enabled },
    libs: testLibs,
    schemas: {},
    platformMcpUrl: PLATFORM_URL,
    consoleUrl: "https://console.example.com",
    hooks,
    now: () => new Date(clock),
  };

  const confirmApp = new Hono<{ Variables: { tenant_id?: string; user_id?: string | null } }>();
  confirmApp.use("*", async (c, next) => {
    c.set("tenant_id", WS);
    c.set("user_id", c.req.header("x-user") ?? OWNER);
    await next();
  });
  confirmApp.route("/v1/oma/platform-mcp", buildConfirmRoutes(deps));

  const api = {
    deps,
    calls,
    rejected,
    actionRows,
    confirmationRows,
    known,
    hooks,
    tokens,
    get knownReads() {
      return knownReads;
    },
    setEnabled(value: boolean) {
      enabled = value;
    },
    setToolCheck(value: typeof toolCheck) {
      toolCheck = value;
    },
    writes: () => calls.filter((call) => call.method === "POST"),
    deletes: () => calls.filter((call) => call.method === "DELETE"),
    /** The report of `GET /v1/oma/dependencies/:kind/:id`; a skill version is `skill_id@version`. */
    setDependencies(kind: string, targetId: string, operation: "archive" | "delete", report: Partial<Report>) {
      dependencyReports.set(`${kind}:${targetId}:${operation}`, { blocking: [], affected: [], truncated: false, ...report });
    },
    runs: () => runs,
    hasFile: (fileId: string) => files.has(fileId),
    hasAgent: (agentId: string) => agents.has(agentId),
    addAgent(body: Json): Json {
      const agentId = body.id ?? id("agent");
      const created = now();
      const agent = {
        id: agentId,
        type: "agent",
        name: body.name ?? "Агент",
        description: body.description ?? null,
        model: body.model ?? "qwen3.6-35b",
        system: body.system ?? null,
        tools: body.tools ?? [],
        mcp_servers: body.mcp_servers ?? [],
        skills: body.skills ?? [],
        multiagent: null,
        metadata: body.metadata ?? {},
        version: 1,
        created_at: created,
        updated_at: created,
      };
      agents.set(agentId, { versions: [agent], archived_at: body.archived_at ?? null });
      return { ...agent, archived_at: body.archived_at ?? null };
    },
    archiveAgent(agentId: string) {
      agents.get(agentId)!.archived_at = now();
    },
    editAgent(agentId: string, changes: Json) {
      const entry = agents.get(agentId)!;
      const current = entry.versions.at(-1)!;
      entry.versions.push({ ...current, ...changes, version: current.version + 1 });
    },
    agentVersions: (agentId: string) => agents.get(agentId)!.versions,
    addEnvironment(body: Json): Json {
      const envId = body.id ?? id("env");
      const env = { id: envId, type: "environment", name: body.name ?? "Окружение", description: body.description ?? null, config: body.config ?? { type: "cloud", networking: { type: "unrestricted" } }, metadata: body.metadata ?? {}, archived_at: body.archived_at ?? null, created_at: now(), updated_at: now(), rev: 1 };
      environments.set(envId, env);
      const { rev: _r, ...rest } = env;
      return rest;
    },
    environment: (envId: string) => environments.get(envId)!,
    addSession(input: { agentId: string; agentVersion?: number; environmentId: string; owner?: string; title?: string; metadata?: Json; resources?: Json[]; status?: string; id?: string }): string {
      const sessionId = input.id ?? id("sesn");
      const agent = agentView(input.agentId, input.agentVersion)!;
      sessions.set(sessionId, {
        id: sessionId,
        type: "session",
        status: input.status ?? "idle",
        agent,
        environment_id: input.environmentId,
        title: input.title ?? null,
        metadata: input.metadata ?? {},
        resources: input.resources ?? [],
        vault_ids: [],
        archived_at: null,
        created_at: now(),
        updated_at: now(),
        rev: 1,
      });
      events.set(sessionId, []);
      owners.set(sessionId, input.owner ?? OWNER);
      return sessionId;
    },
    session: (sessionId: string) => sessions.get(sessionId)!,
    events: (sessionId: string) => events.get(sessionId)!,
    pushEvent(sessionId: string, event: Json): Json {
      const session = sessions.get(sessionId)!;
      const written = { id: event.id ?? id("sevt"), processed_at: now(), ...event };
      events.get(sessionId)!.push(written);
      if (event.type === "user.message") session.status = "running";
      session.rev++;
      return written;
    },
    addStore(body: Json): Json {
      const storeId = body.id ?? id("memstore");
      const store = { id: storeId, type: "memory_store", name: body.name ?? "Память", description: body.description, metadata: body.metadata ?? {}, archived_at: null, created_at: now(), updated_at: now(), rev: 1 };
      stores.set(storeId, store);
      const { rev: _r, ...rest } = store;
      return rest;
    },
    store: (storeId: string) => stores.get(storeId)!,
    addMemory(storeId: string, path: string, content: string): Json {
      const memory = { id: id("mem"), type: "memory", memory_store_id: storeId, path, content, content_sha256: sha(content), content_size_bytes: content.length, memory_version_id: id("memver"), created_at: now(), updated_at: now() };
      memories.set(memory.id, memory);
      return memory;
    },
    memory: (memoryId: string) => memories.get(memoryId)!,
    memories: () => [...memories.values()],
    addDeployment(body: Json): Json {
      const deploymentId = body.id ?? id("depl");
      const created = now();
      const deployment = { id: deploymentId, type: "deployment", name: body.name ?? "Деплоймент", description: null, status: body.status ?? "paused", paused_reason: (body.status ?? "paused") === "paused" ? { type: "manual" } : null, agent: body.agent ?? { type: "agent", id: "agent_x", version: 1 }, environment_id: body.environment_id ?? "env_x", schedule: body.schedule ?? null, initial_events: body.initial_events ?? [], resources: body.resources ?? [], vault_ids: body.vault_ids ?? [], metadata: body.metadata ?? {}, archived_at: body.archived_at ?? null, created_at: created, updated_at: created, rev: 1 };
      deployments.set(deploymentId, deployment);
      const { rev: _r, ...rest } = deployment;
      return rest;
    },
    deployment: (deploymentId: string) => deployments.get(deploymentId)!,
    deployments: () => [...deployments.values()],
    addModelCard(body: Json): Json {
      const card = { id: body.id ?? id("mc"), model_id: "qwen3.6-35b", model: "qwen", provider: "oai-compatible", api_key: "", api_key_preview: "", base_url: null, custom_headers: {}, pi_config: null, is_default: false, created_at: now(), updated_at: undefined as string | undefined, archived_at: null, ...body };
      modelCards.set(card.id, card);
      return card;
    },
    modelCard: (cardId: string) => modelCards.get(cardId)!,
    /** Turns on GET /v1/oma/model_options: cards by handle plus these built-in handles. */
    useModelCatalog(builtin: string[] = []) {
      modelCatalog = true;
      builtinModels.push(...builtin);
    },
    addFile(name: string, bytes: Uint8Array, mime = "text/plain"): Json & { bytes: Uint8Array } {
      const file = { id: id("file"), type: "file", filename: name, mime_type: mime, size_bytes: bytes.length, created_at: now(), bytes };
      files.set(file.id, file);
      return file;
    },
    addSkill(title: string, content: Record<string, Uint8Array | string>): Json {
      const skillId = id("skill");
      const encoded = Object.fromEntries(Object.entries(content).map(([path, value]) => [path, typeof value === "string" ? new TextEncoder().encode(value) : value]));
      const skill = { id: skillId, type: "skill", display_title: title, latest_version: "1", source: "custom", created_at: now(), updated_at: now(), rev: 1, versions: new Map([["1", encoded]]) };
      skills.set(skillId, skill);
      return skill;
    },
    skill: (skillId: string) => skills.get(skillId)!,
    addCredential(credential: Json) {
      credentials.push(credential);
    },
    setTrajectory(sessionId: string, value: unknown) {
      trajectories.set(sessionId, value);
    },
    /** The assistant agent, its environment and its session owned by `OWNER`. */
    setupAssistant() {
      const agent = api.addAgent({
        id: "agent_assistant",
        name: "Ассистент",
        mcp_servers: [{ type: "url", name: "platform", url: PLATFORM_URL }],
        tools: [
          { type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] },
          { type: "mcp_toolset", mcp_server_name: "platform" },
        ],
        metadata: { oma_role: "builder" },
      });
      const env = api.addEnvironment({ id: "env_assistant", name: "Ассистент" });
      api.addSession({ id: ASSISTANT_SESSION, agentId: agent.id, environmentId: env.id, owner: OWNER });
      return { agent, env };
    },
    actor(userId = OWNER, sessionId = ASSISTANT_SESSION): ActorClaims {
      return { workspaceId: WS, userId, sessionId };
    },
    /** The model calls a tool: the harness logs `agent.mcp_tool_use` first. */
    async call(name: string, args: unknown, options: { toolUseId?: string; sessionId?: string; skipEvent?: boolean } = {}) {
      const sessionId = options.sessionId ?? ASSISTANT_SESSION;
      let toolUseId = options.toolUseId;
      if (!options.skipEvent && !toolUseId) {
        toolUseId = api.pushEvent(sessionId, { type: "agent.mcp_tool_use", name, mcp_server_name: "platform", input: args, evaluated_permission: "ask" }).id;
      }
      const output = await callTool(deps, api.actor(owners.get(sessionId) ?? OWNER, sessionId), name, args, toolUseId ?? null);
      return { ...output, toolUseId: toolUseId ?? "" };
    },
    /** Logs the tool use without running it, as the harness does for `always_ask`. */
    propose(name: string, args: unknown, sessionId = ASSISTANT_SESSION): string {
      return api.pushEvent(sessionId, { type: "agent.mcp_tool_use", name, mcp_server_name: "platform", input: args, evaluated_permission: "ask" }).id;
    },
    async run(name: string, args: unknown, toolUseId: string, sessionId = ASSISTANT_SESSION) {
      return callTool(deps, api.actor(owners.get(sessionId) ?? OWNER, sessionId), name, args, toolUseId);
    },
    async preview(toolUseId: string, user = OWNER, sessionId = ASSISTANT_SESSION) {
      const response = await confirmApp.request("/v1/oma/platform-mcp/preview", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": user },
        body: JSON.stringify({ session_id: sessionId, tool_use_id: toolUseId }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    },
    async confirm(toolUseId: string, input: { digest?: string; result?: "allow" | "deny"; user?: string; sessionId?: string; denyMessage?: string } = {}) {
      const sessionId = input.sessionId ?? ASSISTANT_SESSION;
      const digest = input.digest ?? (await api.preview(toolUseId, input.user ?? OWNER, sessionId)).body.preview_digest;
      const response = await confirmApp.request("/v1/oma/platform-mcp/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": input.user ?? OWNER },
        body: JSON.stringify({ session_id: sessionId, tool_use_id: toolUseId, result: input.result ?? "allow", preview_digest: digest, ...(input.denyMessage ? { deny_message: input.denyMessage } : {}) }),
      });
      return { status: response.status, body: (await response.json()) as Json };
    },
    /** Propose, confirm as the owner, run. */
    async confirmAndRun(name: string, args: unknown) {
      const toolUseId = api.propose(name, args);
      const confirmed = await api.confirm(toolUseId);
      if (confirmed.status !== 200) throw new Error(`confirm failed: ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
      return { ...(await api.run(name, args, toolUseId)), toolUseId };
    },
  };
  return api;
}

export type FakePlatform = ReturnType<typeof createFakePlatform>;
