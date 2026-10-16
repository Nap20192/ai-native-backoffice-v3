import { describe, expect, it } from "vitest";
import { createFakePlatform, type FakePlatform } from "./helpers/platform-mcp-fake";

const SKILL_MD = "---\nname: pr-review\ndescription: Проверяет PR\n---\nТело навыка";

function setup() {
  const fake = createFakePlatform();
  fake.setupAssistant();
  const env = fake.addEnvironment({ name: "Песочница" });
  return { fake, env };
}

describe("platform MCP gate", () => {
  it("refuses a write without a confirmation and writes nothing", async () => {
    const { fake } = setup();
    const result = await fake.call("create_memory_store", { name: "Заметки" });
    expect(result.isError).toBe(true);
    expect(result.text).toBe("Нужно подтверждение пользователя. Закончи ход и дождись ответа");
    expect(fake.writes()).toHaveLength(0);
    expect(fake.actionRows.at(-1)).toMatchObject({ tool: "create_memory_store", result: "refused_confirmation" });
    const noId = await fake.call("create_memory_store", { name: "Заметки" }, { skipEvent: true });
    expect(noId.isError).toBe(true);
  });

  it("runs a confirmed call once, uses the confirmation and replays a repeat", async () => {
    const { fake } = setup();
    const args = { name: "Заметки", description: "Для команды" };
    const run = await fake.confirmAndRun("create_memory_store", args);
    expect(run.isError).toBe(false);
    expect(run.text).toContain("Создано хранилище памяти");
    const writes = fake.writes().filter((call) => call.path === "/v1/memory_stores");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ name: "Заметки", metadata: { oma_created_via: "assistant", oma_assistant_session: "sesn_assistant" } });
    expect(fake.confirmationRows[0].usedAt).not.toBeNull();
    const again = await fake.run("create_memory_store", args, run.toolUseId);
    expect(again.text).toContain("уже обработан");
    expect(fake.writes().filter((call) => call.path === "/v1/memory_stores")).toHaveLength(1);
  });

  it("refuses when the arguments differ from the logged call", async () => {
    const { fake } = setup();
    const toolUseId = fake.propose("create_memory_store", { name: "Заметки" });
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    const result = await fake.run("create_memory_store", { name: "Другое" }, toolUseId);
    expect(result.text).toContain("Нужно подтверждение");
    expect(fake.writes().filter((call) => call.path === "/v1/memory_stores")).toHaveLength(0);
  });

  it("deny writes the event, stores no row and the call runs nothing", async () => {
    const { fake } = setup();
    const toolUseId = fake.propose("create_memory_store", { name: "Заметки" });
    const denied = await fake.confirm(toolUseId, { result: "deny", denyMessage: "Не нужно" });
    expect(denied.status).toBe(200);
    expect(fake.confirmationRows).toHaveLength(0);
    expect(fake.events("sesn_assistant").at(-1)).toMatchObject({ type: "user.tool_confirmation", result: "deny", deny_message: "Не нужно" });
    const result = await fake.run("create_memory_store", { name: "Заметки" }, toolUseId);
    expect(result.isError).toBe(true);
    expect(fake.writes().filter((call) => call.path === "/v1/memory_stores")).toHaveLength(0);
  });

  it("refuses with refused_stale when the object changed after the confirmation", async () => {
    const { fake, env } = setup();
    const args = { environment_id: env.id, changes: { description: "Новое" } };
    const toolUseId = fake.propose("update_environment", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.environment(env.id).description = "Правка третьего лица";
    fake.environment(env.id).rev++;
    const result = await fake.run("update_environment", args, toolUseId);
    expect(result.text).toBe("Объект изменился после подтверждения. Покажи новую разницу и спроси снова");
    expect(fake.writes().filter((call) => call.path === `/v1/environments/${env.id}`)).toHaveLength(0);
    expect(fake.actionRows.at(-1)).toMatchObject({ result: "refused_stale" });
  });

  it("refuses with refused_class when the class grew after the confirmation", async () => {
    const { fake } = setup();
    const deployment = fake.addDeployment({ status: "paused" });
    const args = { deployment_id: deployment.id, changes: { name: "Утренняя сводка" } };
    const toolUseId = fake.propose("update_deployment", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.deployment(deployment.id).status = "active";
    const result = await fake.run("update_deployment", args, toolUseId);
    expect(result.text).toBe("Операция стала опаснее, чем на карточке. В первой версии её делает человек в консоли");
    expect(fake.writes().filter((call) => call.path.startsWith("/v1/deployments"))).toHaveLength(0);
    expect(fake.actionRows.at(-1)).toMatchObject({ result: "refused_class" });

    const store = fake.addStore({ name: "Память" });
    const memoryArgs = { memory_store_id: store.id, path: "/notes/a.md", content: "текст" };
    const memoryUse = fake.propose("write_memory", memoryArgs);
    expect((await fake.confirm(memoryUse)).status).toBe(200);
    fake.addMemory(store.id, "/notes/a.md", "занято");
    const memory = await fake.run("write_memory", memoryArgs, memoryUse);
    expect(memory.text).toContain("Операция стала опаснее");
    expect(fake.memories().filter((m) => m.path === "/notes/a.md").map((m) => m.content)).toEqual(["занято"]);
  });

  it("refuses with refused_disabled when the assistant goes off after the confirmation", async () => {
    const { fake } = setup();
    const toolUseId = fake.propose("create_memory_store", { name: "Заметки" });
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.setEnabled(false);
    const result = await fake.run("create_memory_store", { name: "Заметки" }, toolUseId);
    expect(result.text).toContain("Ассистент выключен");
    expect(fake.actionRows.at(-1)).toMatchObject({ result: "refused_disabled" });
    expect(fake.writes().filter((call) => call.path === "/v1/memory_stores")).toHaveLength(0);
    fake.setEnabled(true);
    const repeat = await fake.run("create_memory_store", { name: "Заметки" }, toolUseId);
    expect(repeat.text).toContain("уже обработан");
    expect(fake.writes().filter((call) => call.path === "/v1/memory_stores")).toHaveLength(0);
  });

  it("refuses a used confirmation", async () => {
    const { fake } = setup();
    const toolUseId = fake.propose("create_memory_store", { name: "Заметки" });
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.confirmationRows[0].usedAt = "2026-10-16T00:00:00.000Z";
    const result = await fake.run("create_memory_store", { name: "Заметки" }, toolUseId);
    expect(result.text).toContain("Нужно подтверждение");
  });
});

interface LateCase {
  name: string;
  prepare(fake: FakePlatform): Promise<{ tool: string; args: Record<string, unknown>; path: string; thirdParty(): void; untouched(): void }>;
}

const LATE: LateCase[] = [
  {
    name: "agent",
    async prepare(fake) {
      const agent = fake.addAgent({ name: "Сводка", system: "Старый" });
      return {
        tool: "update_agent",
        args: { agent_id: agent.id, expected_version: 1, changes: { system: "Ассистент" } },
        path: `/v1/agents/${agent.id}`,
        thirdParty: () => fake.editAgent(agent.id, { system: "Третье лицо" }),
        untouched: () => expect(fake.agentVersions(agent.id).map((v) => v.system)).toEqual(["Старый", "Третье лицо"]),
      };
    },
  },
  {
    name: "environment",
    async prepare(fake) {
      const env = fake.addEnvironment({ name: "Окружение" });
      return {
        tool: "update_environment",
        args: { environment_id: env.id, changes: { description: "Ассистент" } },
        path: `/v1/environments/${env.id}`,
        thirdParty: () => Object.assign(fake.environment(env.id), { description: "Третье лицо", rev: 2 }),
        untouched: () => expect(fake.environment(env.id).description).toBe("Третье лицо"),
      };
    },
  },
  {
    name: "paused deployment",
    async prepare(fake) {
      const deployment = fake.addDeployment({ status: "paused" });
      return {
        tool: "update_deployment",
        args: { deployment_id: deployment.id, changes: { name: "Ассистент" } },
        path: `/v1/deployments/${deployment.id}`,
        thirdParty: () => Object.assign(fake.deployment(deployment.id), { name: "Третье лицо", rev: 2 }),
        untouched: () => expect(fake.deployment(deployment.id).name).toBe("Третье лицо"),
      };
    },
  },
  {
    name: "skill version",
    async prepare(fake) {
      const skill = fake.addSkill("Навык", { "SKILL.md": SKILL_MD });
      return {
        tool: "create_skill_version",
        args: { skill_id: skill.id, files: [{ path: "SKILL.md", content: `${SKILL_MD}\nНовое` }] },
        path: `/v1/skills/${skill.id}/versions`,
        thirdParty: () => {
          const current = fake.skill(skill.id);
          current.versions.set("2", { "SKILL.md": new TextEncoder().encode("третье лицо") });
          Object.assign(current, { latest_version: "2", rev: 2 });
        },
        untouched: () => expect(fake.skill(skill.id).latest_version).toBe("2"),
      };
    },
  },
  {
    name: "memory store",
    async prepare(fake) {
      const store = fake.addStore({ name: "Память" });
      return {
        tool: "update_memory_store",
        args: { memory_store_id: store.id, name: "Ассистент" },
        path: `/v1/memory_stores/${store.id}`,
        thirdParty: () => Object.assign(fake.store(store.id), { name: "Третье лицо", rev: 2 }),
        untouched: () => expect(fake.store(store.id).name).toBe("Третье лицо"),
      };
    },
  },
  {
    name: "model card",
    async prepare(fake) {
      const card = fake.addModelCard({ id: "mc_1", model: "qwen" });
      return {
        tool: "update_model_card",
        args: { model_card_id: card.id, changes: { model: "qwen-ассистент" } },
        path: `/v1/oma/model_cards/${card.id}`,
        thirdParty: () => Object.assign(fake.modelCard(card.id), { model: "третье лицо", updated_at: "2026-10-16T12:00:00.000Z" }),
        untouched: () => expect(fake.modelCard(card.id).model).toBe("третье лицо"),
      };
    },
  },
  {
    name: "harness card",
    async prepare(fake) {
      const card = fake.addHarnessCard({ id: "hc_1" });
      return {
        tool: "update_harness_card",
        args: { harness_card_id: card.id, changes: { name: "Ассистент" } },
        path: `/v1/oma/harness_cards/${card.id}`,
        thirdParty: () => Object.assign(fake.harnessCard(card.id), { name: "Третье лицо", updated_at: "2026-10-16T12:00:00.000Z" }),
        untouched: () => expect(fake.harnessCard(card.id).name).toBe("Третье лицо"),
      };
    },
  },
  {
    name: "memory",
    async prepare(fake) {
      const store = fake.addStore({ name: "Память" });
      const memory = fake.addMemory(store.id, "/a.md", "было");
      return {
        tool: "write_memory",
        args: { memory_store_id: store.id, path: "/a.md", content: "ассистент" },
        path: `/v1/memory_stores/${store.id}/memories/${memory.id}`,
        thirdParty: () => Object.assign(fake.memory(memory.id), { content: "третье лицо", content_sha256: "f".repeat(64) }),
        untouched: () => expect(fake.memory(memory.id).content).toBe("третье лицо"),
      };
    },
  },
  {
    name: "session",
    async prepare(fake) {
      const agent = fake.addAgent({ name: "Рабочий" });
      const env = fake.addEnvironment({ name: "Рабочее" });
      const created = await fake.confirmAndRun("create_session", { agent: { id: agent.id }, environment_id: env.id });
      expect(created.isError).toBe(false);
      const sessionId = fake.actionRows.find((row) => row.tool === "create_session" && row.result === "ok")!.targetId!;
      return {
        tool: "send_message",
        args: { session_id: sessionId, text: "Начни работу" },
        path: `/v1/sessions/${sessionId}/events`,
        thirdParty: () => fake.pushEvent(sessionId, { type: "user.message", content: [{ type: "text", text: "Третье лицо" }] }),
        untouched: () =>
          expect(fake.events(sessionId).filter((e) => e.type === "user.message").map((e) => e.content[0].text)).toEqual(["Третье лицо"]),
      };
    },
  },
];

describe("platform MCP write after the last check", () => {
  for (const testCase of LATE) {
    it(`sends the confirmed revision and gets refused_stale for ${testCase.name}`, async () => {
      const { fake } = setup();
      const prepared = await testCase.prepare(fake);
      const toolUseId = fake.propose(prepared.tool, prepared.args);
      const confirmed = await fake.confirm(toolUseId);
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      const revision = fake.confirmationRows.at(-1)!.targetRevisions[0];
      fake.hooks.afterDigestCheck = () => prepared.thirdParty();
      const result = await fake.run(prepared.tool, prepared.args, toolUseId);
      fake.hooks.afterDigestCheck = undefined;
      expect(result.text).toBe("Объект изменился после подтверждения. Покажи новую разницу и спроси снова");
      expect(fake.actionRows.at(-1)).toMatchObject({ tool: prepared.tool, result: "refused_stale" });
      const write = fake.calls.filter((call) => call.method === "POST" && call.path === prepared.path).at(-1)!;
      expect(write).toBeDefined();
      const sent =
        (write.body as any)?.version !== undefined
          ? String((write.body as any).version)
          : (write.body as any)?.precondition?.content_sha256 ?? write.headers.get("if-match");
      expect(sent).toBe(revision);
      prepared.untouched();
    });
  }
});
