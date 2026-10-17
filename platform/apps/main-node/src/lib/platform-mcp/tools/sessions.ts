// create_session and send_message (builder-agent.md 2.2, 2.3). A session from
// create_session is empty and idle. send_message sends only the first message
// into a session this conversation created; the action log says who created it.

import { z } from "zod";
import { getEnabledBuiltinTools } from "@open-managed-agents/agent/harness/tools";
import { classifyCreateSession, classifyEdit, classifySendMessage, isAssistantAgent } from "../classify";
import { ROUTES } from "../route-rules";
import {
  assistantLabels,
  emptyPlan,
  encodeId,
  isRef,
  parseConfig,
  REF_PREFIX,
  revisionOf,
  RouteError,
  writeOutcome,
  type OpContext,
  type OpPlan,
  type ToolDef,
} from "./common";
import { readAllEvents } from "./read";

const createSessionArgs = z
  .object({
    agent: z.object({ id: z.string().min(1), version: z.number().int().min(1).optional() }).strict(),
    environment_id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    files: z
      .array(z.object({ file_id: z.string().min(1), mount_path: z.string().min(1).max(500).optional() }).strict())
      .max(50)
      .optional(),
  })
  .strict();

type CreateSessionArgs = z.infer<typeof createSessionArgs>;

export const SESSION_NOTE = "Сессия создаётся пустой. Агент начнёт работу после первого сообщения";
export const MESSAGE_NOTE = "Агент начнёт работу сразу после отправки";

const STALE_TEXT = "Объект изменился после подтверждения. Покажи новую разницу и спроси снова";

/** Tool names a session of the agent gets: enabled builtins and custom tools. */
function toolNames(tools: unknown): string[] {
  const list = Array.isArray(tools) ? tools : [];
  const names = new Set<string>();
  try {
    for (const name of getEnabledBuiltinTools(list as never)) names.add(name);
  } catch {
    // A malformed tool list shows no builtins; the YAML still has it.
  }
  for (const tool of list) if (tool?.type === "custom" && typeof tool.name === "string") names.add(tool.name);
  return [...names];
}

/** Network of the environment as one line for the card. */
function networkLine(networking: any): string | null {
  if (!networking || typeof networking !== "object") return null;
  if (networking.type === "unrestricted") return "без ограничений";
  if (networking.type === "limited") {
    const hosts = Array.isArray(networking.allowed_hosts) ? networking.allowed_hosts.filter((host: unknown) => typeof host === "string") : [];
    return hosts.length > 0 ? `ограничена: ${hosts.join(", ")}` : "закрыта";
  }
  return typeof networking.type === "string" ? networking.type : null;
}

export function sessionBody(ctx: OpContext, args: CreateSessionArgs, version: number | undefined): Record<string, unknown> {
  return {
    agent: { type: "agent", id: args.agent.id, ...(version === undefined ? {} : { version }) },
    environment_id: args.environment_id,
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.files?.length
      ? { resources: args.files.map((file) => ({ type: "file", file_id: file.file_id, ...(file.mount_path ? { mount_path: file.mount_path } : {}) })) }
      : {}),
    metadata: assistantLabels(ctx.actor.sessionId),
  };
}

function refAgentConfig(ctx: OpContext, id: string): Record<string, unknown> | null {
  const op = ctx.batch?.refs.get(id.slice(REF_PREFIX.length));
  if (!op || op.tool !== "create_agent") return null;
  const parsed = parseConfig(op.args?.config);
  return parsed.ok ? parsed.value : null;
}

export const createSessionTool: ToolDef<CreateSessionArgs> = {
  name: "create_session",
  group: "write",
  description: "Создать пустую сессию агента в окружении, с файлами. Агент не начнёт работу без первого сообщения. Ждёт подтверждения.",
  args: createSessionArgs,
  routes: [ROUTES.sessionCreate],
  precondition: "new_object",
  op: {
    targetKind: "session",
    targetKey: () => null,
    async plan(ctx, args) {
      const notFound = (message: string): OpPlan => ({ ...emptyPlan("create"), notFound: message });
      let agent: any = null;
      let version = args.agent.version;
      if (isRef(args.agent.id)) {
        agent = refAgentConfig(ctx, args.agent.id) ?? {};
      } else {
        const response = await ctx.api.get(`/v1/agents/${encodeId(args.agent.id)}${version ? `?version=${version}` : ""}`);
        if (response.status === 404) return notFound("Агент не найден");
        if (!response.ok) throw new RouteError(response);
        agent = response.json;
        version = typeof agent?.version === "number" ? agent.version : version;
      }
      let environment: any = null;
      let environmentRevision: string | null = null;
      if (!isRef(args.environment_id)) {
        const response = await ctx.api.get(`/v1/environments/${encodeId(args.environment_id)}`);
        if (response.status === 404) return notFound("Окружение не найдено");
        if (!response.ok) throw new RouteError(response);
        environment = response.json;
        environmentRevision = revisionOf(response, environment?.updated_at);
      }
      const filenames = new Map<string, string>();
      for (const file of args.files ?? []) {
        if (isRef(file.file_id)) continue;
        const response = await ctx.api.get(`/v1/files/${encodeId(file.file_id)}`);
        if (response.status === 404) return notFound(`Файл ${file.file_id} не найден`);
        if (!response.ok) throw new RouteError(response);
        if (typeof response.json?.filename === "string") filenames.set(file.file_id, response.json.filename);
      }
      const cls = classifyCreateSession({
        agentIsAssistant: isAssistantAgent(agent, ctx.deps.platformMcpUrl),
        agentArchived: Boolean(agent?.archived_at),
        environmentArchived: Boolean(environment?.archived_at),
      });
      const servers = Array.isArray(agent?.mcp_servers) ? agent.mcp_servers : [];
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        revision: version === undefined ? null : String(version),
        state: {
          agent_version: version ?? null,
          environment_revision: environmentRevision,
          file_ids: (args.files ?? []).map((file) => file.file_id),
        },
        after: sessionBody(ctx, args, version),
        details: {
          agent_name: agent?.name ?? null,
          tools: agent?.tools ?? [],
          mcp_servers: servers.map((server: any) => ({
            name: server?.name,
            type: server?.type,
            ...(typeof server?.url === "string" ? { url: ctx.libs.redactUrl(server.url).url } : {}),
          })),
          skills: agent?.skills ?? [],
          networking: environment?.config?.networking ?? null,
          note: SESSION_NOTE,
          // What the console card shows (builder-agent.md 1.4).
          card: {
            agent_id: args.agent.id,
            agent_name: typeof agent?.name === "string" ? agent.name : null,
            agent_version: version ?? null,
            environment_id: args.environment_id,
            environment_name: typeof environment?.name === "string" ? environment.name : null,
            title: args.title ?? null,
            files: (args.files ?? []).map((file) => ({
              file_id: file.file_id,
              filename: filenames.get(file.file_id) ?? null,
              mount_path: file.mount_path ?? null,
            })),
            tools: toolNames(agent?.tools),
            mcp_servers: servers.map((server: any) => server?.name).filter((name: unknown): name is string => typeof name === "string"),
            skills: (Array.isArray(agent?.skills) ? agent.skills : [])
              .map((skill: any) => skill?.skill_id ?? skill?.name)
              .filter((name: unknown): name is string => typeof name === "string"),
            network: networkLine(environment?.config?.networking),
          },
        },
      };
    },
    async write(ctx, args, plan, revision) {
      // The session request takes no environment revision. Read it once more
      // right before the write: a change after the gate's check stops here.
      const confirmedEnvironment = plan.state.environment_revision ?? null;
      if (confirmedEnvironment !== null && !isRef(args.environment_id)) {
        const current = await ctx.api.get(`/v1/environments/${encodeId(args.environment_id)}`);
        if (current.status === 404) return { type: "error", message: "Окружение не найдено" };
        if (!current.ok) throw new RouteError(current);
        if (revisionOf(current, current.json?.updated_at) !== confirmedEnvironment || current.json?.archived_at) {
          return { type: "stale", message: STALE_TEXT };
        }
      }
      const chosen = revision ?? plan.revision;
      const body = sessionBody(ctx, args, chosen === null ? undefined : Number(chosen));
      const response = await ctx.api.post("/v1/sessions", body);
      return writeOutcome(ctx, response, (json) => ({
        targetId: json?.id ?? null,
        revision: response.headers.get("etag"),
        summary: `Создана сессия ${json?.id}, она ждёт первого сообщения. Отправь его через send_message в следующем ходе`,
      }));
    },
  },
};

const sendMessageArgs = z
  .object({
    session_id: z.string().min(1),
    text: z.string().min(1).max(50000),
    expected_revision: z.string().min(1).optional(),
  })
  .strict();

export const sendMessageTool: ToolDef<z.infer<typeof sendMessageArgs>> = {
  name: "send_message",
  group: "write",
  description: "Первое сообщение в сессию, которую создал этот разговор. Сообщение запускает агента. Ждёт подтверждения отдельной карточкой.",
  args: sendMessageArgs,
  routes: [ROUTES.sessionEventSend],
  precondition: "if_match",
  op: {
    targetKind: "session",
    targetKey: (args) => `session:${args.session_id}`,
    async plan(ctx, args) {
      const response = await ctx.api.get(`/v1/sessions/${encodeId(args.session_id)}`);
      if (response.status === 404) return { ...emptyPlan("update"), notFound: "Сессия не найдена" };
      if (!response.ok) throw new RouteError(response);
      const session = response.json;
      const revision = revisionOf(response);
      const created = await ctx.deps.actions.findSessionCreatedBy(ctx.actor.workspaceId, ctx.actor.sessionId, args.session_id);
      const events = (await readAllEvents(ctx, args.session_id, ["user.message"])) ?? [];
      const userMessages = events.filter((event) => event?.type === "user.message").length;
      let environmentName: string | null = null;
      if (typeof session?.environment_id === "string") {
        const environment = await ctx.api.get(`/v1/environments/${encodeId(session.environment_id)}`);
        if (environment.ok && typeof environment.json?.name === "string") environmentName = environment.json.name;
      }
      const cls = classifySendMessage({
        createdByThisConversation: created,
        status: session?.status,
        archived: Boolean(session?.archived_at),
        userMessages,
      });
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: args.session_id,
        revision,
        state: { status: session?.status ?? null, archived: Boolean(session?.archived_at), user_messages: userMessages, created_here: created },
        before: { session_id: args.session_id, title: session?.title ?? null, status: session?.status ?? null },
        after: { session_id: args.session_id, message: args.text },
        argsStale: args.expected_revision !== undefined && args.expected_revision !== revision,
        details: {
          agent: session?.agent ? { id: session.agent.id, version: session.agent.version, name: session.agent.name } : null,
          environment_id: session?.environment_id ?? null,
          note: MESSAGE_NOTE,
          // What the console card shows: the full text the agent gets (1.4).
          card: {
            session_id: args.session_id,
            session_title: typeof session?.title === "string" && session.title ? session.title : null,
            text: args.text,
            agent_name: typeof session?.agent?.name === "string" ? session.agent.name : null,
            environment_name: environmentName,
          },
        },
      };
    },
    async write(ctx, args, _plan, revision) {
      const response = await ctx.api.post(
        `/v1/sessions/${encodeId(args.session_id)}/events`,
        { events: [{ type: "user.message", content: [{ type: "text", text: args.text }] }] },
        revision ? { headers: { "if-match": revision } } : undefined,
      );
      return writeOutcome(ctx, response, () => ({
        targetId: args.session_id,
        revision: response.headers.get("etag"),
        summary: `Сообщение отправлено в сессию ${args.session_id}, агент начал работу. Читай ход через get_session_events`,
      }));
    },
  },
};

// ---------- title, metadata and resources (crud.md 3.2) ----------

export const OMA_METADATA_INVALID = "Ключи oma_* в метаданных меняет только платформа";

/** The session and whether it is the assistant's own conversation. */
async function readSession(ctx: OpContext, sessionId: string): Promise<{ session: any; revision: string | null; own: boolean } | null> {
  const response = await ctx.api.get(`/v1/sessions/${encodeId(sessionId)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new RouteError(response);
  const session = response.json;
  const own = sessionId === ctx.actor.sessionId || isAssistantAgent(session?.agent, ctx.deps.platformMcpUrl);
  return { session, revision: revisionOf(response), own };
}

const updateSessionArgs = z
  .object({
    session_id: z.string().min(1),
    title: z.string().max(200).nullable().optional(),
    metadata: z.record(z.string().min(1).max(64), z.string().max(512).nullable()).optional(),
    expected_revision: z.string().min(1).optional(),
  })
  .strict();

type UpdateSessionArgs = z.infer<typeof updateSessionArgs>;

function sessionPatch(args: UpdateSessionArgs): Record<string, unknown> {
  return {
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
  };
}

export const updateSessionTool: ToolDef<UpdateSessionArgs> = {
  name: "update_session",
  group: "write",
  description: "Изменить название и метаданные сессии. null в metadata убирает ключ. Ключи oma_* меняет платформа. Ждёт подтверждения.",
  args: updateSessionArgs,
  routes: [ROUTES.session, ROUTES.sessionUpdate],
  precondition: "if_match",
  op: {
    targetKind: "session",
    targetKey: (args) => `session:${args.session_id}`,
    async plan(ctx, args) {
      const found = await readSession(ctx, args.session_id);
      if (!found) return { ...emptyPlan("update"), notFound: "Сессия не найдена" };
      const cls = classifyEdit({ archived: Boolean(found.session?.archived_at), ownAssistantTarget: found.own });
      const patch = sessionPatch(args);
      const before = { title: found.session?.title ?? null, metadata: found.session?.metadata ?? {} };
      const metadataAfter = { ...before.metadata } as Record<string, unknown>;
      for (const [key, value] of Object.entries(args.metadata ?? {})) {
        if (value === null) delete metadataAfter[key];
        else metadataAfter[key] = value;
      }
      const omaKey = Object.keys(args.metadata ?? {}).some((key) => key.startsWith("oma_"));
      return {
        ...emptyPlan(cls.cls),
        reason: cls.reason,
        targetId: args.session_id,
        revision: found.revision,
        state: { archived: Boolean(found.session?.archived_at), status: found.session?.status ?? null },
        before,
        after: { title: "title" in patch ? patch.title : before.title, metadata: metadataAfter },
        invalid: omaKey ? OMA_METADATA_INVALID : Object.keys(patch).length === 0 ? "Нужен title или metadata" : undefined,
        argsStale: args.expected_revision !== undefined && args.expected_revision !== found.revision,
      };
    },
    async write(ctx, args, _plan, revision) {
      // The session route takes If-Match; a change after the gate's check also stops here.
      const current = await readSession(ctx, args.session_id);
      if (!current) return { type: "error", message: "Сессия не найдена" };
      if (revision !== null && current.revision !== null && current.revision !== revision) return { type: "stale", message: STALE_TEXT };
      const response = await ctx.api.post(
        `/v1/sessions/${encodeId(args.session_id)}`,
        sessionPatch(args),
        revision ? { headers: { "if-match": revision } } : undefined,
      );
      return writeOutcome(ctx, response, () => ({
        targetId: args.session_id,
        revision: response.headers.get("etag"),
        summary: `Сессия ${args.session_id} изменена`,
      }));
    },
  },
};

const addResourceArgs = z
  .object({
    session_id: z.string().min(1),
    file_id: z.string().min(1),
    mount_path: z.string().min(1).max(500).optional(),
  })
  .strict();

export const addSessionResourceTool: ToolDef<z.infer<typeof addResourceArgs>> = {
  name: "add_session_resource",
  group: "write",
  description: "Подключить файл к сессии. Удаляет ресурс delete_object с kind session_resource. Ждёт подтверждения.",
  args: addResourceArgs,
  routes: [ROUTES.session, ROUTES.file, ROUTES.sessionResourceAdd],
  precondition: "new_object",
  op: {
    targetKind: "session_resource",
    targetKey: () => null,
    async plan(ctx, args) {
      const found = await readSession(ctx, args.session_id);
      if (!found) return { ...emptyPlan("create"), notFound: "Сессия не найдена" };
      if (!isRef(args.file_id)) {
        const file = await ctx.api.get(`/v1/files/${encodeId(args.file_id)}`);
        if (file.status === 404) return { ...emptyPlan("create"), notFound: `Файл ${args.file_id} не найден` };
        if (!file.ok) throw new RouteError(file);
      }
      const cls = classifyEdit({ archived: Boolean(found.session?.archived_at), ownAssistantTarget: found.own });
      return {
        ...emptyPlan(cls.cls === "update" ? "create" : cls.cls),
        reason: cls.reason,
        targetId: args.session_id,
        state: { archived: Boolean(found.session?.archived_at), session: args.session_id },
        after: { type: "file", file_id: args.file_id, ...(args.mount_path ? { mount_path: args.mount_path } : {}) },
      };
    },
    async write(ctx, args) {
      const response = await ctx.api.post(`/v1/sessions/${encodeId(args.session_id)}/resources`, {
        type: "file",
        file_id: args.file_id,
        ...(args.mount_path ? { mount_path: args.mount_path } : {}),
      });
      return writeOutcome(ctx, response, (json) => ({
        targetId: json?.id ?? null,
        revision: null,
        summary: `Файл подключён к сессии ${args.session_id}, ресурс ${json?.id}`,
      }));
    },
  },
};

export const SESSION_TOOLS = [createSessionTool, sendMessageTool, updateSessionTool, addSessionResourceTool];
