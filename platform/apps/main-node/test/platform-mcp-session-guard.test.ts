// Guard of the assistant session (builder-agent.md 3.1, 2.5 step 6, 6.1 "охрана сессии").

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Session } from "@open-managed-agents/managed-agents-application";
import { sendableEventSchema } from "../../../packages/managed-agents-api/src/contracts/session-event-inputs";
import {
  CLOSED_EVENT_TYPES,
  OPEN_EVENT_TYPES,
  createSessionGuard,
} from "../src/lib/platform-mcp/session-guard-middleware";
import type { SessionOwner } from "../src/lib/platform-mcp/ports";

const PLATFORM_URL = "http://127.0.0.1:8787/v1/oma/platform-mcp";
const WS = "ws_1";
const OWNER = "user_owner";
const MEMBER = "user_member";
const ADMIN = "user_admin";

function session(id: string, assistant: boolean): Session {
  return {
    id,
    agent: {
      id: "agent_1",
      description: null,
      mcpServers: assistant ? [{ name: "platform", type: "url", url: PLATFORM_URL }] : [],
      model: { id: "qwen3.6-35b" },
      multiagent: null,
      name: "Агент",
      skills: [],
      system: null,
      tools: [],
      version: 1,
    },
    archivedAt: null,
    budget: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    environmentId: "env_1",
    metadata: {},
    outcomeEvaluations: [],
    resources: [],
    stats: {},
    status: "idle",
    title: null,
    updatedAt: "2026-10-16T10:00:00.000Z",
    usage: {},
    vaultIds: [],
  };
}

function setup() {
  const sessions = new Map<string, Session>([
    ["sesn_assistant", session("sesn_assistant", true)],
    ["sesn_plain", session("sesn_plain", false)],
  ]);
  const owners = new Map<string, string>([["sesn_assistant", OWNER], ["sesn_plain", OWNER]]);
  const toolUses = new Map<string, string | null>([["tu_platform", "platform"], ["tu_other", "linear"]]);
  const reached: string[] = [];
  let created = 0;
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", WS);
    const user = c.req.header("x-user");
    if (user) c.set("user_id", user);
    if (c.req.header("x-confirm-token")) {
      c.set("auth_credential", { type: "platform_mcp_actor", kind: "route", issuer: "confirm", toolUseId: c.req.header("x-confirm-token") });
    }
    await next();
  });
  app.use(
    "*",
    createSessionGuard({
      platformMcpUrl: PLATFORM_URL,
      loadSession: async (_ws, id) => sessions.get(id) ?? null,
      owners: {
        async ownerOf(_ws, id): Promise<SessionOwner | null> {
          const userId = owners.get(id);
          return userId ? { userId, displayName: userId === OWNER ? "Анна" : null } : null;
        },
        async record(_ws, id, userId) {
          if (!owners.has(id)) owners.set(id, userId);
        },
      },
      roles: { roleOf: async (_ws, user) => (user === ADMIN ? "admin" : user === OWNER ? "member" : "member") },
      findToolUse: async (_ws, _session, id) => (toolUses.has(id) ? { mcpServerName: toolUses.get(id) ?? null } : null),
    }),
  );
  app.post("/v1/sessions", async (c) => {
    if (c.req.header("x-fail")) return c.json({ error: "bad" }, 400);
    const id = `sesn_new_${++created}`;
    sessions.set(id, session(id, false));
    return c.json({ id, type: "session" }, 200);
  });
  app.all("*", (c) => {
    reached.push(`${c.req.method} ${c.req.path}`);
    return c.json({ ok: true });
  });
  const send = async (method: string, path: string, user: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, {
      method,
      headers: { ...(user ? { "x-user": user } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const event = (type: string) => {
    switch (type) {
      case "user.message":
      case "system.message":
        return { type, content: [{ type: "text", text: "x" }] };
      case "user.tool_confirmation":
        return { type, result: "deny", tool_use_id: "tu_platform" };
      case "user.custom_tool_result":
        return { type, custom_tool_use_id: "tu_1" };
      case "user.tool_result":
        return { type, tool_use_id: "tu_1" };
      case "user.define_outcome":
        return { type, description: "d", rubric: { type: "text", content: "r" } };
      default:
        return { type };
    }
  };
  return { send, reached, owners, event };
}

function schemaTypes(): string[] {
  return sendableEventSchema.options.map((option) => (option.shape.type as unknown as { value: string }).value).sort();
}

describe("event types of the guard", () => {
  it("covers every sendable event type: a new type fails here until someone decides", () => {
    expect([...CLOSED_EVENT_TYPES, ...OPEN_EVENT_TYPES].sort()).toEqual(schemaTypes());
    expect(OPEN_EVENT_TYPES).toEqual(["user.interrupt"]);
  });
});

describe("session guard", () => {
  it.each(CLOSED_EVENT_TYPES.map((type) => [type]))("refuses %s from another member of an assistant session", async (type) => {
    const { send, reached, event } = setup();
    const refused = await send("POST", "/v1/sessions/sesn_assistant/events", MEMBER, { events: [event(type)] });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe("Писать в разговор с ассистентом может только Анна");
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", null, { events: [event(type)] })).status).toBe(403);
    expect(reached).toEqual([]);
  });

  it("lets the owner write and lets anyone write into a plain session", async () => {
    const { send, reached, event } = setup();
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", OWNER, { events: [event("user.message")] })).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_plain/events", MEMBER, { events: [event("user.message")] })).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_plain", MEMBER, { title: "x" })).status).toBe(200);
    expect(reached).toHaveLength(3);
  });

  it("refuses a session edit, resources and confirm from another member; preview answers", async () => {
    const { send, reached } = setup();
    expect((await send("POST", "/v1/sessions/sesn_assistant", MEMBER, { title: "Чужое" })).status).toBe(403);
    expect((await send("POST", "/v1/sessions/sesn_assistant/resources", MEMBER, { type: "file", file_id: "f" })).status).toBe(403);
    expect((await send("POST", "/v1/sessions/sesn_assistant/resources/res_1", MEMBER, {})).status).toBe(403);
    expect((await send("DELETE", "/v1/sessions/sesn_assistant/resources/res_1", MEMBER)).status).toBe(403);
    expect((await send("POST", "/v1/oma/platform-mcp/confirm", MEMBER, { session_id: "sesn_assistant", tool_use_id: "tu_platform", result: "allow" })).status).toBe(403);
    expect(reached).toEqual([]);
    expect((await send("POST", "/v1/oma/platform-mcp/preview", MEMBER, { session_id: "sesn_assistant", tool_use_id: "tu_platform" })).status).toBe(200);
    expect((await send("GET", "/v1/sessions/sesn_assistant/resources", MEMBER)).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_assistant", OWNER, { title: "Своё" })).status).toBe(200);
  });

  it("lets the owner and an admin interrupt or archive; a member gets 403", async () => {
    const { send } = setup();
    const interrupt = { events: [{ type: "user.interrupt" }] };
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", MEMBER, interrupt)).status).toBe(403);
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", ADMIN, interrupt)).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", OWNER, interrupt)).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_assistant/archive", MEMBER)).status).toBe(403);
    expect((await send("DELETE", "/v1/sessions/sesn_assistant", MEMBER)).status).toBe(403);
    expect((await send("POST", "/v1/sessions/sesn_assistant/threads/thr_1/archive", MEMBER)).status).toBe(403);
    expect((await send("POST", "/v1/sessions/sesn_assistant/archive", ADMIN)).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_assistant/archive", OWNER)).status).toBe(200);
  });

  it("refuses a direct allow on a platform call, also from the owner; deny and the confirm token pass", async () => {
    const { send } = setup();
    const allow = (id: string) => ({ events: [{ type: "user.tool_confirmation", result: "allow", tool_use_id: id }] });
    const direct = await send("POST", "/v1/sessions/sesn_assistant/events", OWNER, allow("tu_platform"));
    expect(direct.status).toBe(403);
    expect(direct.body.error.message).toBe("Подтверждайте через карточку");
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", OWNER, allow("tu_unknown"))).status).toBe(403);
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", OWNER, allow("tu_other"))).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", OWNER, { events: [{ type: "user.tool_confirmation", result: "deny", tool_use_id: "tu_platform" }] })).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_assistant/events", OWNER, allow("tu_platform"), { "x-confirm-token": "tu_platform" })).status).toBe(200);
  });

  it("refuses adding the platform server to a session of someone else", async () => {
    const { send } = setup();
    const body = { agent: { mcp_servers: [{ type: "url", name: "platform", url: `${PLATFORM_URL}/` }] } };
    expect((await send("POST", "/v1/sessions/sesn_plain", MEMBER, body)).status).toBe(403);
    expect((await send("POST", "/v1/sessions/sesn_plain", OWNER, body)).status).toBe(200);
    expect((await send("POST", "/v1/sessions/sesn_plain", MEMBER, { agent: { mcp_servers: [{ type: "url", name: "x", url: "https://mcp.test" }] } })).status).toBe(200);
  });

  it("records the owner of a new session from the request user", async () => {
    const { send, owners } = setup();
    const created = await send("POST", "/v1/sessions", MEMBER, { agent: "agent_1", environment_id: "env_1" });
    expect(created.status).toBe(200);
    expect(owners.get(created.body.id)).toBe(MEMBER);
    expect((await send("POST", "/v1/sessions", MEMBER, {}, { "x-fail": "1" })).status).toBe(400);
    expect(owners.size).toBe(3);
    const keyless = await send("POST", "/v1/sessions", null, { agent: "agent_1" });
    expect(owners.has(keyless.body.id)).toBe(false);
  });
});
