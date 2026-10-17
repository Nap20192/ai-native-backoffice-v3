// Archive, restore, delete and the other new writes of the assistant
// (docs/plans/crud.md, 3.1 to 3.4).

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { REASON_DEPENDENCIES, REASON_OWN } from "../src/lib/platform-mcp/classify";
import { ASSISTANT_SESSION, createFakePlatform, OWNER, WS } from "./helpers/platform-mcp-fake";

const STALE = "Объект изменился после подтверждения. Покажи новую разницу и спроси снова";
const ARCHIVED_AT = "2026-10-01T00:00:00.000Z";

function setup() {
  const fake = createFakePlatform();
  fake.setupAssistant();
  return fake;
}

type Fake = ReturnType<typeof setup>;

async function previewOf(fake: Fake, tool: string, args: Record<string, unknown>) {
  return (await fake.preview(fake.propose(tool, args))).body;
}

/** A nested request with its own route token, as a bug in a tool would send it. */
async function rawRequest(fake: Fake, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const bytes = body === undefined ? "" : JSON.stringify(body);
  const token = fake.deps.tokens.issueRoute({
    workspaceId: WS,
    userId: OWNER,
    sessionId: ASSISTANT_SESSION,
    method,
    path,
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
    issuer: "handler",
  });
  return fake.deps.innerFetch(
    new Request(`http://platform-mcp.internal${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: bytes }),
    }),
  );
}

describe("assistant danger class", () => {
  it("classes every new tool by the state of its object", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка" });
    const archived = fake.addAgent({ name: "Старый", archived_at: ARCHIVED_AT });
    const env = fake.addEnvironment({ name: "Песочница" });
    const sessionId = fake.addSession({ agentId: agent.id, environmentId: env.id, title: "Разбор" });
    const archivedSession = fake.addSession({ agentId: agent.id, environmentId: env.id });
    fake.session(archivedSession).archived_at = ARCHIVED_AT;
    const paused = fake.addDeployment({ status: "paused" });
    const active = fake.addDeployment({ status: "active" });
    const gone = fake.addDeployment({ status: "paused", archived_at: ARCHIVED_AT });
    const file = fake.addFile("a.txt", new TextEncoder().encode("a"));
    const store = fake.addStore({ name: "Память" });
    const memory = fake.addMemory(store.id, "/a.md", "текст");
    const skill = fake.addSkill("Навык", { "SKILL.md": "x" });
    fake.addModelCard({ id: "mc_1" });

    const cases: [string, Record<string, unknown>, string][] = [
      ["archive_object", { kind: "agent", id: agent.id }, "danger"],
      ["archive_object", { kind: "agent", id: archived.id }, "out_of_v1"],
      ["unarchive_object", { kind: "agent", id: archived.id }, "update"],
      ["delete_object", { kind: "agent", id: agent.id }, "danger"],
      ["delete_object", { kind: "agent", id: archived.id }, "danger"],
      ["archive_object", { kind: "environment", id: env.id }, "danger"],
      ["delete_object", { kind: "environment", id: env.id }, "danger"],
      ["archive_object", { kind: "session", id: sessionId }, "danger"],
      ["unarchive_object", { kind: "session", id: archivedSession }, "update"],
      ["delete_object", { kind: "session", id: sessionId }, "danger"],
      ["archive_object", { kind: "deployment", id: active.id }, "danger"],
      ["unarchive_object", { kind: "deployment", id: gone.id }, "update"],
      ["delete_object", { kind: "file", id: file.id }, "danger"],
      ["delete_object", { kind: "skill", id: skill.id }, "danger"],
      ["delete_object", { kind: "skill_version", id: skill.id, version: "1" }, "danger"],
      ["archive_object", { kind: "memory_store", id: store.id }, "danger"],
      ["delete_object", { kind: "memory_store", id: store.id }, "danger"],
      ["delete_object", { kind: "memory", id: memory.id, parent_id: store.id }, "danger"],
      ["archive_object", { kind: "model_card", id: "mc_1" }, "danger"],
      ["delete_object", { kind: "model_card", id: "mc_1" }, "danger"],
      ["update_session", { session_id: sessionId, title: "Новое" }, "update"],
      ["update_session", { session_id: archivedSession, title: "Новое" }, "out_of_v1"],
      ["add_session_resource", { session_id: sessionId, file_id: file.id }, "create"],
      ["pause_deployment", { deployment_id: active.id }, "update"],
      ["unpause_deployment", { deployment_id: paused.id }, "update"],
      ["run_deployment", { deployment_id: paused.id }, "update"],
      ["run_deployment", { deployment_id: gone.id }, "out_of_v1"],
      ["pause_deployment", { deployment_id: gone.id }, "out_of_v1"],
    ];
    for (const [tool, args, cls] of cases) {
      const body = await previewOf(fake, tool, args);
      expect(body.class, `${tool} ${JSON.stringify(args)}: ${JSON.stringify(body.reason ?? body.not_found)}`).toBe(cls);
    }
  });

  it("puts the assistant's own agent, environment and conversation out of v1", async () => {
    const fake = setup();
    for (const [tool, args] of [
      ["archive_object", { kind: "agent", id: "agent_assistant" }],
      ["delete_object", { kind: "agent", id: "agent_assistant" }],
      ["archive_object", { kind: "environment", id: "env_assistant" }],
      ["archive_object", { kind: "session", id: ASSISTANT_SESSION }],
      ["update_session", { session_id: ASSISTANT_SESSION, title: "Другое" }],
    ] as const) {
      const body = await previewOf(fake, tool, args);
      expect(body, `${tool} ${JSON.stringify(args)}`).toMatchObject({ class: "out_of_v1", reason: REASON_OWN });
    }
    const toolUseId = fake.propose("archive_object", { kind: "agent", id: "agent_assistant" });
    const refused = await fake.confirm(toolUseId);
    expect([refused.status, refused.body.error.type]).toEqual([409, "class"]);
    const run = await fake.run("archive_object", { kind: "agent", id: "agent_assistant" }, toolUseId);
    expect(run.isError).toBe(true);
    expect(fake.calls.filter((call) => call.path.endsWith("/archive"))).toHaveLength(0);
  });

  it("blocking dependencies make the operation out of v1 with the list", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка" });
    fake.setDependencies("agent", agent.id, "delete", {
      blocking: [{ kind: "session", id: "sesn_9", name: "Разбор", status: "running", note: "живая сессия" }],
    });
    const toolUseId = fake.propose("delete_object", { kind: "agent", id: agent.id });
    const body = (await fake.preview(toolUseId)).body;
    expect(body.class).toBe("out_of_v1");
    expect(body.reason).toBe(`${REASON_DEPENDENCIES}: сессия «Разбор» (sesn_9)`);
    expect(body.operations[0]).toMatchObject({
      irreversible: true,
      dependencies: { blocking: [{ kind: "session", id: "sesn_9", status: "running" }], affected: [], truncated: false },
    });
    const refused = await fake.confirm(toolUseId);
    expect([refused.status, refused.body.error.type]).toEqual([409, "class"]);
    expect(fake.deletes()).toHaveLength(0);
  });

  it("the card carries the dependencies; archive and delete send the confirmed revision in If-Match", async () => {
    const fake = setup();
    const env = fake.addEnvironment({ name: "Песочница" });
    fake.setDependencies("environment", env.id, "archive", {
      affected: [{ kind: "deployment", id: "depl_7", name: "Отчёт", status: "paused", note: "деплоймент не снимется с паузы" }],
    });
    const archiveUse = fake.propose("archive_object", { kind: "environment", id: env.id });
    const card = (await fake.preview(archiveUse)).body;
    expect(card).toMatchObject({ class: "danger", irreversible: false, dependencies: { affected: [{ id: "depl_7" }] } });
    expect(card.operations[0]).toMatchObject({ class: "danger", irreversible: false, name: "Песочница", details: { card: { operation: "archive", kind: "environment" } } });
    expect((await fake.confirm(archiveUse)).status).toBe(200);
    const archived = await fake.run("archive_object", { kind: "environment", id: env.id }, archiveUse);
    expect(archived.isError, archived.text).toBe(false);
    const archiveCall = fake.calls.find((call) => call.path === `/v1/environments/${env.id}/archive`)!;
    expect(archiveCall.headers.get("if-match")).toBe('"1"');
    expect(fake.environment(env.id).archived_at).not.toBeNull();
    expect(fake.actionRows.at(-1)).toMatchObject({ tool: "archive_object", class: "danger", result: "ok", targetKind: "environment", targetId: env.id });

    const agent = fake.addAgent({ name: "Сводка" });
    fake.editAgent(agent.id, { system: "Вторая" });
    const deleteUse = fake.propose("delete_object", { kind: "agent", id: agent.id });
    expect((await fake.preview(deleteUse)).body.operations[0]).toMatchObject({ irreversible: true, revision: "2" });
    expect((await fake.confirm(deleteUse)).status).toBe(200);
    const deleted = await fake.run("delete_object", { kind: "agent", id: agent.id }, deleteUse);
    expect(deleted.isError, deleted.text).toBe(false);
    expect(fake.deletes().map((call) => [call.path, call.headers.get("if-match")])).toEqual([[`/v1/agents/${agent.id}`, "2"]]);
    expect(fake.hasAgent(agent.id)).toBe(false);
  });

  it("a new dependency after the card gives 409 stale at confirm", async () => {
    const fake = setup();
    const env = fake.addEnvironment({ name: "Песочница" });
    const toolUseId = fake.propose("delete_object", { kind: "environment", id: env.id });
    const digest = (await fake.preview(toolUseId)).body.preview_digest;
    fake.setDependencies("environment", env.id, "delete", {
      affected: [{ kind: "session", id: "sesn_8", name: null, status: "terminated", note: "сессия в архиве" }],
    });
    const refused = await fake.confirm(toolUseId, { digest });
    expect([refused.status, refused.body.error.type]).toEqual([409, "stale"]);
    expect(refused.body.preview.operations[0].dependencies.affected).toHaveLength(1);
    expect(fake.confirmationRows).toHaveLength(0);
  });

  it("a new dependency after the confirmation gives refused_stale and no write", async () => {
    const fake = setup();
    const env = fake.addEnvironment({ name: "Песочница" });
    const args = { kind: "environment", id: env.id };
    const toolUseId = fake.propose("delete_object", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.setDependencies("environment", env.id, "delete", {
      affected: [{ kind: "session", id: "sesn_8", name: null, status: "terminated", note: null }],
    });
    const result = await fake.run("delete_object", args, toolUseId);
    expect(result.text).toBe(STALE);
    expect(fake.actionRows.at(-1)).toMatchObject({ tool: "delete_object", result: "refused_stale" });
    expect(fake.deletes()).toHaveLength(0);
  });

  it("a dependency after the last check: the route answers 409 and the call gets refused_stale", async () => {
    const fake = setup();
    const store = fake.addStore({ name: "Память" });
    const args = { kind: "memory_store", id: store.id };
    const toolUseId = fake.propose("delete_object", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.hooks.afterDigestCheck = () =>
      fake.setDependencies("memory_store", store.id, "delete", {
        blocking: [{ kind: "deployment", id: "depl_1", name: "Отчёт", status: "active", note: null }],
      });
    const result = await fake.run("delete_object", args, toolUseId);
    fake.hooks.afterDigestCheck = undefined;
    expect(result.text).toBe(STALE);
    expect(fake.actionRows.at(-1)).toMatchObject({ result: "refused_stale" });
    expect(fake.store(store.id)).toBeDefined();
  });

  it("refuses a batch with a danger operation", async () => {
    const fake = setup();
    const file = fake.addFile("a.txt", new TextEncoder().encode("a"));
    for (const tool of ["archive_object", "delete_object"]) {
      const result = await fake.call("apply_changes", {
        operations: [
          { tool: "create_memory_store", args: { name: "Заметки" } },
          { tool, args: { kind: "file", id: file.id } },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(`Операция 2: опасная операция ${tool} идёт отдельной карточкой`);
    }
    expect(fake.deletes()).toHaveLength(0);
    expect(fake.hasFile(file.id)).toBe(true);
  });

  it("the token refuses vault routes, a body-less archive and a session update with tools", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка" });
    const env = fake.addEnvironment({ name: "Песочница" });
    const sessionId = fake.addSession({ agentId: agent.id, environmentId: env.id });
    for (const [method, path] of [
      ["DELETE", "/v1/vaults/vlt_1"],
      ["POST", "/v1/vaults/vlt_1/archive"],
      ["POST", "/v1/vaults/vlt_1/unarchive"],
      ["DELETE", "/v1/vaults/vlt_1/credentials/cred_1"],
      ["GET", "/v1/oma/dependencies/vault/vlt_1?operation=delete"],
    ]) {
      expect((await rawRequest(fake, method, path, method === "POST" ? {} : undefined)).status, `${method} ${path}`).toBe(403);
    }
    const withTools = await rawRequest(fake, "POST", `/v1/sessions/${sessionId}`, { agent: { tools: [{ type: "agent_toolset_20260401" }] } });
    expect(withTools.status).toBe(403);
    expect(fake.rejected.at(-1)?.reason).toContain("title and metadata");
    const label = await rawRequest(fake, "POST", `/v1/sessions/${sessionId}`, { metadata: { oma_created_via: "x" } });
    expect(label.status).toBe(403);
    const noIfMatch = await rawRequest(fake, "DELETE", `/v1/agents/${agent.id}`);
    expect(noIfMatch.status).toBe(403);
    expect(fake.rejected.at(-1)?.reason).toBe("If-Match is required");
    expect(fake.hasAgent(agent.id)).toBe(true);
  });

  it("update_session changes the title and metadata and refuses oma_* keys", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка" });
    const env = fake.addEnvironment({ name: "Песочница" });
    const sessionId = fake.addSession({ agentId: agent.id, environmentId: env.id, title: "Старое", metadata: { team: "a" } });
    const bad = await previewOf(fake, "update_session", { session_id: sessionId, metadata: { oma_created_via: "assistant" } });
    expect(bad.invalid).toBe("Ключи oma_* в метаданных меняет только платформа");
    const run = await fake.confirmAndRun("update_session", { session_id: sessionId, title: "Новое", metadata: { team: "b" } });
    expect(run.isError, run.text).toBe(false);
    const write = fake.writes().find((call) => call.path === `/v1/sessions/${sessionId}`)!;
    expect(write.body).toEqual({ title: "Новое", metadata: { team: "b" } });
    expect(write.headers.get("if-match")).toBe('"1"');
    expect(fake.session(sessionId)).toMatchObject({ title: "Новое", metadata: { team: "b" } });
  });

  it("adds a file to a session and deletes a session resource", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка" });
    const env = fake.addEnvironment({ name: "Песочница" });
    const sessionId = fake.addSession({ agentId: agent.id, environmentId: env.id });
    const file = fake.addFile("a.txt", new TextEncoder().encode("a"));
    const added = await fake.confirmAndRun("add_session_resource", { session_id: sessionId, file_id: file.id, mount_path: "/mnt/a.txt" });
    expect(added.isError, added.text).toBe(false);
    const resource = fake.session(sessionId).resources[0];
    expect(resource).toMatchObject({ type: "file", file_id: file.id, mount_path: "/mnt/a.txt" });
    const listed = await fake.call("list", { kind: "session_resources", filter: { session_id: sessionId } });
    expect(JSON.parse(listed.text).data).toEqual([expect.objectContaining({ id: resource.id, file_id: file.id })]);
    const deleteArgs = { kind: "session_resource", id: resource.id, parent_id: sessionId };
    expect((await previewOf(fake, "delete_object", deleteArgs)).class).toBe("danger");
    const deleted = await fake.confirmAndRun("delete_object", deleteArgs);
    expect(deleted.isError, deleted.text).toBe(false);
    expect(fake.session(sessionId).resources).toEqual([]);
  });

  it("pauses, unpauses and runs a deployment; restore brings it back paused", async () => {
    const fake = setup();
    const deployment = fake.addDeployment({ status: "active" });
    const paused = await fake.confirmAndRun("pause_deployment", { deployment_id: deployment.id });
    expect(paused.isError, paused.text).toBe(false);
    expect(fake.calls.find((call) => call.path.endsWith("/pause"))!.headers.get("if-match")).toBe('"1"');
    expect(fake.deployment(deployment.id).status).toBe("paused");
    expect((await fake.confirmAndRun("unpause_deployment", { deployment_id: deployment.id })).isError).toBe(false);
    expect(fake.deployment(deployment.id).status).toBe("active");
    const ran = await fake.confirmAndRun("run_deployment", { deployment_id: deployment.id });
    expect(ran.isError, ran.text).toBe(false);
    expect(ran.text).toContain(fake.runs()[0].session_id);

    const edit = await previewOf(fake, "update_deployment", { deployment_id: deployment.id, changes: { name: "Новое" } });
    expect(edit).toMatchObject({ class: "update", warnings: ["Следующий запуск возьмёт новую конфигурацию"] });

    expect((await fake.confirmAndRun("archive_object", { kind: "deployment", id: deployment.id })).isError).toBe(false);
    const restored = await fake.confirmAndRun("unarchive_object", { kind: "deployment", id: deployment.id });
    expect(restored.isError, restored.text).toBe(false);
    expect(restored.text).toContain("на паузе");
    expect(fake.deployment(deployment.id)).toMatchObject({ archived_at: null, status: "paused" });
  });

  it("deletes a memory by its content hash and a skill version by its number", async () => {
    const fake = setup();
    const store = fake.addStore({ name: "Память" });
    const memory = fake.addMemory(store.id, "/a.md", "текст");
    const deleted = await fake.confirmAndRun("delete_object", { kind: "memory", id: memory.id, parent_id: store.id });
    expect(deleted.isError, deleted.text).toBe(false);
    expect(fake.deletes().at(-1)!.path).toBe(`/v1/memory_stores/${store.id}/memories/${memory.id}?expected_content_sha256=${memory.content_sha256}`);

    const skill = fake.addSkill("Навык", { "SKILL.md": "x" });
    fake.skill(skill.id).versions.set("2", {});
    fake.setDependencies("skill_version", `${skill.id}@1`, "delete", {
      affected: [{ kind: "agent", id: "agent_9", name: "Сводка", status: null, note: "агент перейдёт на предыдущую версию" }],
    });
    const card = await previewOf(fake, "delete_object", { kind: "skill_version", id: skill.id, version: "1" });
    expect(card.operations[0].dependencies.affected[0].id).toBe("agent_9");
    const version = await fake.confirmAndRun("delete_object", { kind: "skill_version", id: skill.id, version: "1" });
    expect(version.isError, version.text).toBe(false);
    expect(fake.deletes().at(-1)!.path).toBe(`/v1/skills/${skill.id}/versions/1`);
    expect(fake.deletes().at(-1)!.headers.get("if-match")).toBe('"1"');
  });

  it("get_dependencies reads the report without a confirmation", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка" });
    fake.setDependencies("agent", agent.id, "archive", {
      blocking: [{ kind: "deployment", id: "depl_1", name: "Отчёт", status: "active", note: "активный деплоймент" }],
    });
    const result = await fake.call("get_dependencies", { kind: "agent", id: agent.id, operation: "archive" });
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ kind: "agent", id: agent.id, operation: "archive", blocking: [{ id: "depl_1" }], affected: [], truncated: false });
    expect(fake.actionRows.at(-1)).toMatchObject({ tool: "get_dependencies", class: "read", result: "ok" });
    const memory = await fake.call("get_dependencies", { kind: "memory", id: "mem_1", parent_id: "memstore_1", operation: "delete" });
    expect(JSON.parse(memory.text)).toMatchObject({ blocking: [], affected: [] });
  });
});
