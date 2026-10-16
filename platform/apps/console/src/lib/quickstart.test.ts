import { describe, expect, it } from "vitest";

import type { ThreadItem } from "./assistant/events";
import { agentHandoffPrompt, collectResources, exportSnippet, wizardSteps } from "./quickstart";

const applied = (
  tool: string,
  info: { kind: string; id: string | null; name: string | null; action?: "create" | "update" },
  phase: "applied" | "pending" = "applied",
): ThreadItem => ({
  kind: "proposal",
  id: `tu_${tool}`,
  tool,
  input: {},
  phase,
  applied: [{ tool, version: null, action: "create", ...info }],
});

describe("collectResources", () => {
  it("находит окружение и сессию, созданные ассистентом", () => {
    const thread: ThreadItem[] = [
      { kind: "assistant", id: "a", text: "Привет" },
      applied("create_environment", { kind: "environment", id: "env_1", name: "Основное" }),
      applied("create_session", { kind: "session", id: "sesn_1", name: "Проверка" }),
    ];
    expect(collectResources(thread)).toEqual({
      environment: { id: "env_1", name: "Основное" },
      session: { id: "sesn_1", name: "Проверка" },
      messageSent: false,
    });
  });

  it("берёт пачку и отмечает первое сообщение", () => {
    const thread: ThreadItem[] = [
      {
        kind: "proposal",
        id: "b",
        tool: "apply_changes",
        input: {},
        phase: "applied",
        applied: [
          { tool: "create_environment", kind: "environment", id: "env_2", name: "Песок", version: null, action: "create" },
          { tool: "send_message", kind: "message", id: "sesn_1", name: null, version: null, action: "create" },
        ],
      },
    ];
    const res = collectResources(thread);
    expect(res.environment).toEqual({ id: "env_2", name: "Песок" });
    expect(res.messageSent).toBe(true);
  });

  it("не считает предложения, которые ещё не применены, и правки", () => {
    const thread: ThreadItem[] = [
      applied("create_environment", { kind: "environment", id: "env_1", name: "Х" }, "pending"),
      applied("update_environment", { kind: "environment", id: "env_9", name: "Правка", action: "update" }),
    ];
    expect(collectResources(thread).environment).toBeNull();
  });

  it("без id объект не считается созданным", () => {
    const thread: ThreadItem[] = [applied("create_session", { kind: "session", id: null, name: "Без id" })];
    expect(collectResources(thread).session).toBeNull();
  });
});

describe("wizardSteps", () => {
  const ids = ["agent", "environment", "session", "connect"];

  it("показывает четыре шага по порядку", () => {
    const steps = wizardSteps({ agent: null, environment: null, session: null, messageSent: false });
    expect(steps.map((s) => s.id)).toEqual(ids);
    expect(steps.map((s) => s.title)).toEqual(["Создать агента", "Настроить окружение", "Начать сессию", "Подключить"]);
    expect(steps.map((s) => s.status)).toEqual(["current", "todo", "todo", "todo"]);
  });

  it("после агента текущий шаг окружение, после окружения сессия", () => {
    const agent = { id: "agent_1", name: "А", version: 1 };
    expect(wizardSteps({ agent, environment: null, session: null, messageSent: false }).map((s) => s.status)).toEqual([
      "done", "current", "todo", "todo",
    ]);
    expect(
      wizardSteps({ agent, environment: { id: "e", name: "Е" }, session: null, messageSent: false }).map((s) => s.status),
    ).toEqual(["done", "done", "current", "todo"]);
  });

  it("сессия с первым сообщением закрывает шаг, и текущим становится подключение", () => {
    const steps = wizardSteps({
      agent: { id: "agent_1", name: "А", version: 1 },
      environment: { id: "e", name: "Е" },
      session: { id: "s", name: "С" },
      messageSent: true,
    });
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "done", "current"]);
  });

  it("сессия без сообщения остаётся текущим шагом", () => {
    const steps = wizardSteps({
      agent: { id: "agent_1", name: "А", version: 1 },
      environment: { id: "e", name: "Е" },
      session: { id: "s", name: "С" },
      messageSent: false,
    });
    expect(steps.map((s) => s.status)).toEqual(["done", "done", "current", "todo"]);
  });
});

describe("exportSnippet", () => {
  it("даёт команды curl для сессии с агентом и окружением", () => {
    const text = exportSnippet({ agentId: "agent_1", agentVersion: 2, environmentId: "env_1" });
    expect(text).toContain("/v1/sessions");
    expect(text).toContain('"id": "agent_1"');
    expect(text).toContain('"version": 2');
    expect(text).toContain('"environment_id": "env_1"');
    expect(text).toContain("$OMA_API_KEY");
    expect(text).not.toMatch(/sk-|Bearer [A-Za-z0-9]{8,}/);
  });

  it("без окружения оставляет подсказку, а не пустое значение", () => {
    expect(exportSnippet({ agentId: "agent_1", agentVersion: 1, environmentId: null })).toContain("<id окружения>");
  });
});

describe("agentHandoffPrompt", () => {
  it("называет агента и просит предложить окружение карточкой", () => {
    const text = agentHandoffPrompt({ id: "agent_1", name: "Сводка PR", version: 1 });
    expect(text).toContain("Сводка PR");
    expect(text).toContain("agent_1");
    expect(text).toMatch(/окружени/);
  });
});
