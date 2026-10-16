import { describe, expect, it } from "vitest";
import { ASSISTANT_SESSION, createFakePlatform, MEMBER, OWNER, PLATFORM_URL } from "./helpers/platform-mcp-fake";

function setup() {
  const fake = createFakePlatform();
  fake.setupAssistant();
  const agent = fake.addAgent({ name: "Рабочий", tools: [{ type: "agent_toolset_20260401" }] });
  const env = fake.addEnvironment({ name: "Рабочее", config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["api.github.com"] } } });
  return { fake, agent, env };
}

async function createSession(fake: ReturnType<typeof setup>["fake"], agentId: string, envId: string, extra: Record<string, unknown> = {}) {
  const result = await fake.confirmAndRun("create_session", { agent: { id: agentId }, environment_id: envId, ...extra });
  expect(result.isError, result.text).toBe(false);
  return fake.actionRows.filter((row) => row.tool === "create_session" && row.result === "ok").at(-1)!.targetId!;
}

describe("platform MCP sessions", () => {
  it("create_session makes one request and an idle session with the version from the card", async () => {
    const { fake, agent, env } = setup();
    const file = fake.addFile("data.csv", new TextEncoder().encode("a,b"));
    const toolUseId = fake.propose("create_session", { agent: { id: agent.id }, environment_id: env.id, title: "Разбор", files: [{ file_id: file.id, mount_path: "/data/data.csv" }] });
    const preview = await fake.preview(toolUseId);
    expect(preview.body.operations[0].details).toMatchObject({
      tools: [{ type: "agent_toolset_20260401" }],
      networking: { type: "limited", allowed_hosts: ["api.github.com"] },
      note: "Сессия создаётся пустой. Агент начнёт работу после первого сообщения",
    });
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.hooks.afterDigestCheck = () => fake.editAgent(agent.id, { system: "после последней сверки" });
    const result = await fake.run("create_session", { agent: { id: agent.id }, environment_id: env.id, title: "Разбор", files: [{ file_id: file.id, mount_path: "/data/data.csv" }] }, toolUseId);
    fake.hooks.afterDigestCheck = undefined;
    expect(result.isError, result.text).toBe(false);
    const posts = fake.calls.filter((call) => call.method === "POST" && call.path === "/v1/sessions");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      agent: { type: "agent", id: agent.id, version: 1 },
      environment_id: env.id,
      title: "Разбор",
      resources: [{ type: "file", file_id: file.id, mount_path: "/data/data.csv" }],
      metadata: { oma_created_via: "assistant", oma_assistant_session: ASSISTANT_SESSION },
    });
    const sessionId = fake.actionRows.at(-1)!.targetId!;
    expect(fake.session(sessionId)).toMatchObject({ status: "idle", agent: { version: 1 } });
    expect(fake.events(sessionId)).toEqual([]);
    expect(await fake.deps.owners.ownerOf("ws_1", sessionId)).toMatchObject({ userId: OWNER });
  });

  it("refuses with refused_stale when the agent got a new version after the card", async () => {
    const { fake, agent, env } = setup();
    const args = { agent: { id: agent.id }, environment_id: env.id };
    const toolUseId = fake.propose("create_session", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.editAgent(agent.id, { system: "новая версия" });
    const result = await fake.run("create_session", args, toolUseId);
    expect(result.text).toContain("Объект изменился после подтверждения");
    expect(fake.calls.filter((call) => call.method === "POST" && call.path === "/v1/sessions")).toHaveLength(0);
  });

  it("leaves no session when the agent or a file is gone", async () => {
    const { fake, agent, env } = setup();
    const missingFile = fake.propose("create_session", { agent: { id: agent.id }, environment_id: env.id, files: [{ file_id: "file_none" }] });
    expect((await fake.confirm(missingFile)).status).toBe(404);
    const args = { agent: { id: agent.id }, environment_id: env.id };
    const toolUseId = fake.propose("create_session", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.archiveAgent(agent.id);
    const result = await fake.run("create_session", args, toolUseId);
    expect(result.text).toContain("Операция стала опаснее");
    expect(fake.calls.filter((call) => call.method === "POST" && call.path === "/v1/sessions")).toHaveLength(0);
  });

  it("puts the assistant agent and archived objects out of v1", async () => {
    const { fake, env } = setup();
    const assistantLike = fake.addAgent({ name: "Ещё ассистент", mcp_servers: [{ type: "url", name: "platform", url: PLATFORM_URL }] });
    const use = fake.propose("create_session", { agent: { id: assistantLike.id }, environment_id: env.id });
    expect((await fake.preview(use)).body).toMatchObject({ class: "out_of_v1" });
    expect((await fake.confirm(use)).body.error.type).toBe("class");
    const archivedEnv = fake.addEnvironment({ name: "Старое", archived_at: "2026-10-01T00:00:00.000Z" });
    const agent = fake.addAgent({ name: "Простой" });
    const archived = fake.propose("create_session", { agent: { id: agent.id }, environment_id: archivedEnv.id });
    expect((await fake.preview(archived)).body.class).toBe("out_of_v1");
  });

  it("the console preview of create_session carries the session block the card shows", async () => {
    const fake = createFakePlatform();
    fake.setupAssistant();
    const agent = fake.addAgent({
      name: "Сводка PR",
      tools: [{ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [{ name: "bash", enabled: true }, { name: "web_fetch", enabled: true }] }],
      mcp_servers: [{ type: "url", name: "github", url: "https://mcp.example/github?token=x" }],
      skills: [{ type: "custom", skill_id: "skill_pdf" }],
    });
    const env = fake.addEnvironment({ name: "Песок", config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["pypi.org"] } } });
    const file = fake.addFile("data.csv", new TextEncoder().encode("a,b"));
    const toolUseId = fake.propose("create_session", { agent: { id: agent.id }, environment_id: env.id, title: "Проверка", files: [{ file_id: file.id, mount_path: "/mnt/data.csv" }] });
    const preview = await fake.preview(toolUseId);
    expect(preview.body.session).toEqual({
      agent_id: agent.id,
      agent_name: "Сводка PR",
      agent_version: 1,
      environment_id: env.id,
      environment_name: "Песок",
      title: "Проверка",
      files: [{ file_id: file.id, filename: "data.csv", mount_path: "/mnt/data.csv" }],
      tools: ["bash", "web_fetch"],
      mcp_servers: ["github"],
      skills: ["skill_pdf"],
      network: "ограничена: pypi.org",
    });
    expect(preview.body.message).toBeNull();
  });

  it("the console preview of send_message carries the full text the agent gets", async () => {
    const { fake, agent, env } = setup();
    const sessionId = await createSession(fake, agent.id, env.id, { title: "Проверка" });
    const text = Array.from({ length: 60 }, (_, i) => `Строка ${i + 1}`).join("\n");
    const toolUseId = fake.propose("send_message", { session_id: sessionId, text });
    const preview = await fake.preview(toolUseId);
    expect(preview.body.message).toEqual({
      session_id: sessionId,
      session_title: "Проверка",
      text,
      agent_name: "Рабочий",
      environment_name: "Рабочее",
    });
    expect(preview.body.session).toBeNull();
  });

  it("refuses create_session when the environment changed after the last check", async () => {
    const { fake, agent, env } = setup();
    const args = { agent: { id: agent.id }, environment_id: env.id };
    const toolUseId = fake.propose("create_session", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.hooks.afterDigestCheck = () => {
      const stored = fake.environment(env.id);
      Object.assign(stored, { config: { type: "cloud", networking: { type: "unrestricted" } }, rev: stored.rev + 1, updated_at: "2026-10-16T12:00:00.000Z" });
    };
    const result = await fake.run("create_session", args, toolUseId);
    fake.hooks.afterDigestCheck = undefined;
    expect(result.text).toBe("Объект изменился после подтверждения. Покажи новую разницу и спроси снова");
    expect(fake.actionRows.at(-1)).toMatchObject({ tool: "create_session", result: "refused_stale" });
    expect(fake.calls.filter((call) => call.method === "POST" && call.path === "/v1/sessions")).toHaveLength(0);
  });

  it("send_message sends one user.message with If-Match into a session of this conversation", async () => {
    const { fake, agent, env } = setup();
    const sessionId = await createSession(fake, agent.id, env.id);
    const toolUseId = fake.propose("send_message", { session_id: sessionId, text: "Разбери PR 42" });
    const preview = await fake.preview(toolUseId);
    expect(preview.body).toMatchObject({ class: "update" });
    expect(preview.body.after_yaml).toContain("Разбери PR 42");
    expect(preview.body.operations[0].details.note).toBe("Агент начнёт работу сразу после отправки");
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    const result = await fake.run("send_message", { session_id: sessionId, text: "Разбери PR 42" }, toolUseId);
    expect(result.isError, result.text).toBe(false);
    const posts = fake.calls.filter((call) => call.method === "POST" && call.path === `/v1/sessions/${sessionId}/events`);
    expect(posts).toHaveLength(1);
    expect(posts[0].headers.get("if-match")).toBe('"1"');
    expect(posts[0].body).toEqual({ events: [{ type: "user.message", content: [{ type: "text", text: "Разбери PR 42" }] }] });
    expect(fake.events(sessionId).map((event) => event.type)).toEqual(["user.message"]);
    expect(fake.session(sessionId).status).toBe("running");
  });

  it("send_message is out of v1 for any other session", async () => {
    const { fake, agent, env } = setup();
    const outOfV1 = async (sessionId: string) => {
      const use = fake.propose("send_message", { session_id: sessionId, text: "Привет" });
      const preview = await fake.preview(use);
      expect(preview.body.class, sessionId).toBe("out_of_v1");
      expect(preview.body.reason).toBe("В первой версии ассистент отправляет только первое сообщение в сессию, которую создал сам");
    };
    await outOfV1(fake.addSession({ agentId: agent.id, environmentId: env.id, metadata: { oma_assistant_session: ASSISTANT_SESSION } }));
    const otherConversation = fake.addSession({ agentId: "agent_assistant", environmentId: "env_assistant", id: "sesn_other_assistant" });
    void otherConversation;
    const fromOther = fake.addSession({ agentId: agent.id, environmentId: env.id });
    fake.actionRows.push({ ...fake.actionRows[0] ?? {}, id: "row_x", workspaceId: "ws_1", userId: OWNER, sessionId: "sesn_other_assistant", agentId: null, agentVersion: null, model: null, tool: "create_session", class: "create", toolUseId: "t_x", opIndex: 0, inputDigest: "", inputRedacted: null, targetKind: "session", targetId: fromOther, targetRevision: null, result: "ok", errorMessage: null, confirmationId: null, previewDigest: null, maskedCount: 0, createdAt: "", finishedAt: null, durationMs: null });
    await outOfV1(fromOther);
    const written = await createSession(fake, agent.id, env.id);
    fake.pushEvent(written, { type: "user.message", content: [{ type: "text", text: "уже" }] });
    fake.session(written).status = "idle";
    await outOfV1(written);
    const running = await createSession(fake, agent.id, env.id);
    fake.session(running).status = "running";
    await outOfV1(running);
    const archived = await createSession(fake, agent.id, env.id);
    fake.session(archived).archived_at = "2026-10-16T00:00:00.000Z";
    await outOfV1(archived);
  });

  it("a third-party user.message between confirm and run gives refused_class without a write", async () => {
    const { fake, agent, env } = setup();
    const sessionId = await createSession(fake, agent.id, env.id);
    const args = { session_id: sessionId, text: "Начни" };
    const toolUseId = fake.propose("send_message", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.pushEvent(sessionId, { type: "user.message", content: [{ type: "text", text: "от участника" }] });
    const result = await fake.run("send_message", args, toolUseId);
    expect(result.text).toContain("Операция стала опаснее");
    expect(fake.calls.filter((call) => call.method === "POST" && call.path === `/v1/sessions/${sessionId}/events`)).toHaveLength(0);
    expect(fake.events(sessionId).filter((event) => event.type === "user.message")).toHaveLength(1);
  });

  it("only the owner confirms a send_message card", async () => {
    const { fake, agent, env } = setup();
    const sessionId = await createSession(fake, agent.id, env.id);
    const toolUseId = fake.propose("send_message", { session_id: sessionId, text: "Начни" });
    expect((await fake.confirm(toolUseId, { user: MEMBER })).status).toBe(403);
  });
});
