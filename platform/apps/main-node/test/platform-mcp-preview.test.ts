import { describe, expect, it } from "vitest";
import { createFakePlatform } from "./helpers/platform-mcp-fake";

function setup() {
  const fake = createFakePlatform();
  fake.setupAssistant();
  return fake;
}

const digestOf = async (fake: ReturnType<typeof setup>, toolUseId: string) => (await fake.preview(toolUseId)).body.preview_digest as string;

describe("platform MCP preview digest", () => {
  it("shows the diff of update_agent and changes the digest when the version moves", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка", system: "Старый промпт" });
    const toolUseId = fake.propose("update_agent", { agent_id: agent.id, expected_version: 1, changes: { system: "Новый промпт" } });
    const first = await fake.preview(toolUseId);
    expect(first.body.diff).toContain("- system: Старый промпт");
    expect(first.body.diff).toContain("+ system: Новый промпт");
    fake.editAgent(agent.id, { description: "чужая правка" });
    const second = await fake.preview(toolUseId);
    expect(second.body.preview_digest).not.toBe(first.body.preview_digest);
    expect(second.body.args_stale).toBe(true);
  });

  it("names each operation and gives the versions of an agent edit for the card title", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Сводка", system: "Старый промпт" });
    const edit = await fake.preview(fake.propose("update_agent", { agent_id: agent.id, expected_version: 1, changes: { system: "Новый" } }));
    expect(edit.body.operations[0]).toMatchObject({ target_kind: "agent", name: "Сводка", version_from: 1, version_to: 2 });
    const env = await fake.preview(fake.propose("create_environment", { config: { name: "Новое окружение", config: { type: "cloud", networking: { type: "unrestricted" } } } }));
    expect(env.body.operations[0]).toMatchObject({ target_kind: "environment", name: "Новое окружение", version_from: null, version_to: null });
    const store = fake.addStore({ name: "Память" });
    const memory = await fake.preview(fake.propose("write_memory", { memory_store_id: store.id, path: "/notes/a.md", content: "x" }));
    expect(memory.body.operations[0]).toMatchObject({ target_kind: "memory", name: "/notes/a.md" });
  });

  it("changes the digest with every field of 2.5, step 4", async () => {
    const fake = setup();
    const env = fake.addEnvironment({ name: "Окружение" });
    const args = { environment_id: env.id, changes: { description: "Новое" } };
    const use = fake.propose("update_environment", args);
    const base = await digestOf(fake, use);
    expect(await digestOf(fake, use)).toBe(base);

    const otherArgs = fake.propose("update_environment", { environment_id: env.id, changes: { description: "Другое" } });
    expect(await digestOf(fake, otherArgs)).not.toBe(base);

    fake.environment(env.id).rev++;
    const revision = await digestOf(fake, use);
    expect(revision).not.toBe(base);

    fake.environment(env.id).name = "Переименовано";
    const before = await digestOf(fake, use);
    expect(before).not.toBe(revision);

    fake.known.push("Переименовано-секрет");
    fake.environment(env.id).description = "Переименовано-секрет";
    expect(await digestOf(fake, use)).not.toBe(before);

    fake.environment(env.id).archived_at = "2026-10-16T00:00:00.000Z";
    const archived = await fake.preview(use);
    expect(archived.body.class).toBe("out_of_v1");

    const store = fake.addStore({ name: "Память" });
    const memoryUse = fake.propose("write_memory", { memory_store_id: store.id, path: "/a.md", content: "x" });
    const free = await fake.preview(memoryUse);
    fake.addMemory(store.id, "/a.md", "занято");
    const taken = await fake.preview(memoryUse);
    expect(free.body.class).toBe("create");
    expect(taken.body.class).toBe("update");
    expect(taken.body.preview_digest).not.toBe(free.body.preview_digest);

    const deployment = fake.addDeployment({ status: "paused" });
    const deploymentUse = fake.propose("update_deployment", { deployment_id: deployment.id, changes: { name: "x" } });
    const paused = await digestOf(fake, deploymentUse);
    fake.deployment(deployment.id).paused_reason = { type: "error", error: { type: "unknown_error" } };
    fake.deployment(deployment.id).status = "active";
    expect(await digestOf(fake, deploymentUse)).not.toBe(paused);
  });

  it("puts the agent version of create_session into the digest", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Рабочий" });
    const env = fake.addEnvironment({ name: "Рабочее" });
    const file = fake.addFile("data.csv", new TextEncoder().encode("a,b"));
    const use = fake.propose("create_session", { agent: { id: agent.id }, environment_id: env.id, title: "Проверка", files: [{ file_id: file.id }] });
    const first = await fake.preview(use);
    expect(first.body).toMatchObject({ class: "create" });
    expect(first.body.after_yaml).toContain("version: 1");
    expect(first.body.operations[0].details.note).toBe("Сессия создаётся пустой. Агент начнёт работу после первого сообщения");
    fake.editAgent(agent.id, { system: "новое" });
    const second = await fake.preview(use);
    expect(second.body.after_yaml).toContain("version: 2");
    expect(second.body.preview_digest).not.toBe(first.body.preview_digest);
  });

  it("refuses an input with a key pattern at once", async () => {
    const fake = setup();
    const result = await fake.call("create_agent", { config: { name: "x", model: "qwen", system: "ключ sk-abcdefghijklmnopqrst" } });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("request_secret");
    const draft = await fake.call("preview_change", { kind: "model_card", body: { model: "qwen", pi_config: { token: "ghp_abcdefghijklmnop" } } });
    expect(draft.isError).toBe(true);
    const env = await fake.call("preview_change", { kind: "agent", body: { name: "x", model: "q", mcp_servers: [{ type: "stdio", name: "s", command: "/bin/s", env: { X: "AKIAABCDEFGHIJKLMNOP" } }] } });
    expect(env.isError).toBe(true);
    expect(fake.writes()).toHaveLength(0);
  });
});
