import { describe, expect, it } from "vitest";
import { createFakePlatform } from "./helpers/platform-mcp-fake";

function setup() {
  const fake = createFakePlatform();
  fake.setupAssistant();
  return fake;
}

describe("platform MCP batch", () => {
  it("replaces $ref with the id created earlier and logs one row per operation", async () => {
    const fake = setup();
    const args = {
      title: "Агент для PR",
      operations: [
        { ref: "env", tool: "create_environment", args: { config: { name: "PR", config: { type: "cloud" } } } },
        { ref: "agent", tool: "create_agent", args: { config: "name: Сводка PR\nmodel: qwen3.6-35b\nsystem: Пиши кратко\n" } },
        { tool: "create_session", args: { agent: { id: { $ref: "agent" } }, environment_id: { $ref: "env" }, title: "Первая" } },
      ],
    };
    const toolUseId = fake.propose("apply_changes", args);
    const preview = await fake.preview(toolUseId);
    expect(preview.body.class).toBe("create");
    expect(preview.body.operations.map((op: { tool: string; class: string }) => [op.tool, op.class])).toEqual([
      ["create_environment", "create"],
      ["create_agent", "create"],
      ["create_session", "create"],
    ]);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    const result = await fake.run("apply_changes", args, toolUseId);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain("Пачка выполнена");
    const rows = fake.actionRows.filter((row) => row.toolUseId === toolUseId);
    expect(rows.map((row) => [row.opIndex, row.tool, row.result])).toEqual([
      [0, "create_environment", "ok"],
      [1, "create_agent", "ok"],
      [2, "create_session", "ok"],
    ]);
    const session = fake.calls.find((call) => call.method === "POST" && call.path === "/v1/sessions")!.body as any;
    expect(session.agent).toEqual({ type: "agent", id: rows[1].targetId, version: 1 });
    expect(session.environment_id).toBe(rows[0].targetId);
  });

  it("stops on the first error and keeps what it created", async () => {
    const fake = setup();
    const agent = fake.addAgent({ name: "Рабочий" });
    const env = fake.addEnvironment({ name: "Рабочее" });
    const args = {
      operations: [
        { tool: "create_memory_store", args: { name: "Память" } },
        {
          tool: "create_deployment",
          args: {
            name: "Утро",
            agent: { id: agent.id },
            environment_id: env.id,
            initial_events: [{ type: "user.message", content: [{ type: "text", text: "Сводка" }] }],
          },
        },
        { tool: "create_environment", args: { config: { name: "Не дойдёт" } } },
      ],
    };
    const toolUseId = fake.propose("apply_changes", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.environment(env.id).archived_at = "2026-10-16T00:00:00.000Z";
    const result = await fake.run("apply_changes", args, toolUseId);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Пачка остановилась на ошибке");
    expect(result.text).toContain("3. create_environment: не выполнялась");
    expect(fake.actionRows.filter((row) => row.toolUseId === toolUseId).map((row) => row.result)).toEqual(["ok", "error"]);
    expect(fake.writes().map((call) => call.path)).toEqual(["/v1/sessions/sesn_assistant/events", "/v1/memory_stores", "/v1/deployments"]);
    expect(fake.deployments()).toHaveLength(0);
  });

  it("re-checks every operation: a change during the batch stops it", async () => {
    const fake = setup();
    const store = fake.addStore({ name: "Память" });
    const env = fake.addEnvironment({ name: "Окружение" });
    const args = {
      operations: [
        { tool: "create_memory_store", args: { name: "Новая" } },
        { tool: "update_memory_store", args: { memory_store_id: store.id, name: "Иначе" } },
        { tool: "update_environment", args: { environment_id: env.id, changes: { description: "Ассистент" } } },
        { tool: "create_environment", args: { config: { name: "Четвёртая" } } },
      ],
    };
    const toolUseId = fake.propose("apply_changes", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    let writes = 0;
    fake.hooks.afterDigestCheck = () => {
      writes++;
      if (writes === 2) Object.assign(fake.environment(env.id), { description: "Третье лицо", rev: 2 });
    };
    const result = await fake.run("apply_changes", args, toolUseId);
    fake.hooks.afterDigestCheck = undefined;
    expect(fake.actionRows.filter((row) => row.toolUseId === toolUseId).map((row) => row.result)).toEqual(["ok", "ok", "refused_stale"]);
    expect(result.text).toContain("4. create_environment: не выполнялась");
    expect(fake.environment(env.id).description).toBe("Третье лицо");

    const store2 = fake.addStore({ name: "Ещё" });
    const deployment = fake.addDeployment({ status: "paused" });
    const second = {
      operations: [
        { tool: "update_memory_store", args: { memory_store_id: store2.id, name: "А" } },
        { tool: "update_deployment", args: { deployment_id: deployment.id, changes: { name: "Б" } } },
      ],
    };
    const secondUse = fake.propose("apply_changes", second);
    expect((await fake.confirm(secondUse)).status).toBe(200);
    fake.hooks.afterDigestCheck = (info) => {
      if (info.tool === "update_memory_store") fake.deployment(deployment.id).archived_at = "2026-10-16T11:00:00.000Z";
    };
    await fake.run("apply_changes", second, secondUse);
    fake.hooks.afterDigestCheck = undefined;
    expect(fake.actionRows.filter((row) => row.toolUseId === secondUse).map((row) => row.result)).toEqual(["ok", "refused_class"]);
  });

  it("stops the batch when the assistant goes off in the middle", async () => {
    const fake = setup();
    const args = { operations: [{ tool: "create_memory_store", args: { name: "А" } }, { tool: "create_memory_store", args: { name: "Б" } }] };
    const toolUseId = fake.propose("apply_changes", args);
    expect((await fake.confirm(toolUseId)).status).toBe(200);
    fake.hooks.afterDigestCheck = () => fake.setEnabled(false);
    await fake.run("apply_changes", args, toolUseId);
    fake.hooks.afterDigestCheck = undefined;
    expect(fake.actionRows.filter((row) => row.toolUseId === toolUseId).map((row) => row.result)).toEqual(["ok", "refused_disabled"]);
  });

  it("takes the highest class and refuses bad batches by schema", async () => {
    const fake = setup();
    const store = fake.addStore({ name: "Память" });
    const mixed = fake.propose("apply_changes", {
      operations: [
        { tool: "create_memory_store", args: { name: "А" } },
        { tool: "update_memory_store", args: { memory_store_id: store.id, name: "Б" } },
      ],
    });
    expect((await fake.preview(mixed)).body.class).toBe("update");

    const bad = [
      { operations: [{ tool: "update_memory_store", args: { memory_store_id: store.id, name: "А" } }, { tool: "update_memory_store", args: { memory_store_id: store.id, name: "Б" } }] },
      { operations: [{ tool: "send_message", args: { session_id: "sesn_1", text: "x" } }] },
      { operations: [{ ref: "s", tool: "create_memory_store", args: { name: "А" } }, { tool: "update_memory_store", args: { memory_store_id: { $ref: "s" }, name: "Б" } }] },
      { operations: [{ tool: "create_session", args: { agent: { id: { $ref: "nope" } }, environment_id: "env_1" } }] },
      { operations: [{ tool: "list", args: { kind: "agents" } }] },
    ];
    for (const args of bad) {
      const result = await fake.call("apply_changes", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text).toMatch(/Операция \d/);
    }
    expect(fake.writes().filter((call) => !call.path.endsWith("/events"))).toHaveLength(0);
  });
});
