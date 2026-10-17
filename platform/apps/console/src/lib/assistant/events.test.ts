import { describe, expect, it } from "vitest";

import type { Event } from "../events";
import {
  appliedLines,
  buildThread,
  mergeEvent,
  parseToolInput,
  readRowLabel,
  type ThreadItem,
} from "./events";

const user = (id: string, text: string): Event => ({
  type: "user.message",
  id,
  content: [{ type: "text", text }],
});
const agentMsg = (id: string, text: string): Event => ({
  type: "agent.message",
  id,
  content: [{ type: "text", text }],
});
const use = (id: string, name: string, input: Record<string, unknown>): Event => ({
  type: "agent.mcp_tool_use",
  id,
  name,
  mcp_server_name: "platform",
  input,
  evaluated_permission: "ask",
});
const result = (useId: string, text: string, isError = false): Event => ({
  type: "agent.mcp_tool_result",
  id: `res_${useId}`,
  mcp_tool_use_id: useId,
  is_error: isError,
  content: [{ type: "text", text }],
});

describe("mergeEvent", () => {
  it("добавляет новое и заменяет событие с тем же id", () => {
    let list: Event[] = [];
    list = mergeEvent(list, user("e1", "a"));
    list = mergeEvent(list, agentMsg("e2", "b"));
    list = mergeEvent(list, agentMsg("e2", "b2"));
    expect(list).toHaveLength(2);
    expect((list[1].content as Array<{ text: string }>)[0].text).toBe("b2");
  });
});

describe("buildThread: реплики", () => {
  it("реплики пользователя и ассистента по порядку, контекст страницы скрыт", () => {
    const items = buildThread([
      user("e1", 'Привет\n\n<page_context>{"kind":"other"}</page_context>'),
      agentMsg("e2", "Здравствуйте"),
    ]);
    expect(items).toEqual([
      { kind: "user", id: "e1", text: "Привет" },
      { kind: "assistant", id: "e2", text: "Здравствуйте" },
    ]);
  });

  it("пустые реплики не показывает", () => {
    expect(buildThread([agentMsg("e2", "   ")])).toEqual([]);
  });

  it("ошибку сессии показывает строкой", () => {
    const items = buildThread([{ type: "session.error", id: "e9", error: "модель недоступна" }]);
    expect(items[0]).toMatchObject({ kind: "error", text: "модель недоступна" });
  });
});

describe("buildThread: чтение", () => {
  it("чтение это свёрнутая строка с готовым названием", () => {
    const items = buildThread([
      use("tu1", "list", { kind: "sessions", limit: 12 }),
      result("tu1", JSON.stringify({ items: new Array(12).fill({}), truncated: false })),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "read", status: "done", label: "Прочитал список: сессии (12)" });
  });

  it("префикс mcp__platform__ в имени не мешает", () => {
    const items = buildThread([use("tu1", "mcp__platform__get", { kind: "agent", id: "agent_1" })]);
    expect(items[0]).toMatchObject({ kind: "read", status: "running", label: "Читаю: агент agent_1" });
  });

  it("ошибка чтения помечается", () => {
    const items = buildThread([use("tu1", "get", { kind: "agent", id: "a" }), result("tu1", "нет доступа", true)]);
    expect(items[0]).toMatchObject({ kind: "read", status: "error" });
  });

  it("request_secret даёт ссылку только на путь консоли", () => {
    const ok = buildThread([
      use("tu1", "request_secret", { kind: "static_bearer", name: "TOKEN" }),
      result("tu1", JSON.stringify({ url: "/vaults/vlt_1?name=TOKEN" })),
    ]);
    expect(ok[0]).toMatchObject({ kind: "read", link: "/vaults/vlt_1?name=TOKEN" });
    const bad = buildThread([
      use("tu2", "request_secret", { kind: "static_bearer", name: "TOKEN" }),
      result("tu2", JSON.stringify({ url: "https://evil.example/steal" })),
    ]);
    expect((bad[0] as Extract<ThreadItem, { kind: "read" }>).link).toBeUndefined();
    for (const [i, url] of ["//evil.example/x", "/\\evil.example/x", "javascript:alert(1)", "/ok path"].entries()) {
      const items = buildThread([
        use(`tx${i}`, "request_secret", { kind: "static_bearer", name: "T" }),
        result(`tx${i}`, JSON.stringify({ url })),
      ]);
      expect((items[0] as Extract<ThreadItem, { kind: "read" }>).link).toBeUndefined();
    }
  });

  it("подпись чтения для разных инструментов", () => {
    expect(readRowLabel("search_docs", { query: "навык" }, null, "done")).toBe("Поиск по документации: «навык»");
    expect(readRowLabel("search_config", { query: "PR" }, null, "done")).toBe("Поиск по конфигурации: «PR»");
    expect(readRowLabel("get_session_events", { session_id: "sesn_1" }, null, "done")).toBe("Прочитал события сессии sesn_1");
    expect(readRowLabel("help", { topic: "agent" }, null, "done")).toBe("Прочитал справку: agent");
  });
});

describe("buildThread: предложения", () => {
  it("запись без решения ждёт кнопки", () => {
    const items = buildThread([use("tu1", "create_skill", { display_title: "Навык", files: [] })]);
    expect(items[0]).toMatchObject({ kind: "proposal", id: "tu1", tool: "create_skill", phase: "pending" });
  });

  it("allow без результата это «отправлено»", () => {
    const items = buildThread([
      use("tu1", "create_skill", {}),
      { type: "user.tool_confirmation", id: "c1", tool_use_id: "tu1", result: "allow" },
    ]);
    expect(items[0]).toMatchObject({ phase: "sent" });
  });

  it("deny это «отклонено»", () => {
    const items = buildThread([
      use("tu1", "create_skill", {}),
      { type: "user.tool_confirmation", id: "c1", tool_use_id: "tu1", result: "deny", deny_message: "не надо" },
    ]);
    expect(items[0]).toMatchObject({ phase: "denied", denyMessage: "не надо" });
  });

  it("успешный результат это «применено» с разобранным итогом", () => {
    const items = buildThread([
      use("tu1", "create_skill", { display_title: "Навык PR", files: [] }),
      { type: "user.tool_confirmation", id: "c1", tool_use_id: "tu1", result: "allow" },
      result("tu1", JSON.stringify({ ok: true, results: [{ tool: "create_skill", kind: "skill", id: "skl_1", name: "Навык PR", version: 1, action: "create" }] })),
    ]);
    const p = items[0] as Extract<ThreadItem, { kind: "proposal" }>;
    expect(p.phase).toBe("applied");
    expect(p.applied).toEqual([
      { tool: "create_skill", kind: "skill", id: "skl_1", name: "Навык PR", version: 1, action: "create" },
    ]);
  });

  it("ошибка результата это «не вышло» с текстом", () => {
    const items = buildThread([
      use("tu1", "update_agent", {}),
      { type: "user.tool_confirmation", id: "c1", tool_use_id: "tu1", result: "allow" },
      result("tu1", "Объект изменился после подтверждения", true),
    ]);
    expect(items[0]).toMatchObject({ phase: "failed", resultText: "Объект изменился после подтверждения" });
  });

  it("результат, который не JSON, берёт из входа название и вид", () => {
    const items = buildThread([
      use("tu1", "create_agent", { config: { name: "Сводка PR", model: "m" } }),
      { type: "user.tool_confirmation", id: "c1", tool_use_id: "tu1", result: "allow" },
      result("tu1", "Готово"),
    ]);
    const p = items[0] as Extract<ThreadItem, { kind: "proposal" }>;
    expect(p.applied).toEqual([
      { tool: "create_agent", kind: "agent", id: null, name: "Сводка PR", version: null, action: "create" },
    ]);
  });

  it("send_message тоже предложение", () => {
    const items = buildThread([use("tu1", "send_message", { session_id: "s1", text: "Начни" })]);
    expect(items[0]).toMatchObject({ kind: "proposal", tool: "send_message", phase: "pending" });
  });
});

describe("buildThread: черновики карточек", () => {
  it("preview_change с model_card даёт карточку черновика, тело может быть YAML", () => {
    const items = buildThread([
      use("tu1", "preview_change", { kind: "model_card", body: { name: "Qwen", wire_model: "qwen" } }),
      result("tu1", "ok"),
      use("tu2", "preview_change", { kind: "model_card", body: "provider: openai\nmodel_id: m\n" }),
      result("tu2", "ok"),
    ]);
    expect(items[0]).toMatchObject({ kind: "draft", draftKind: "model_card", body: { name: "Qwen", wire_model: "qwen" } });
    expect(items[1]).toMatchObject({ kind: "draft", draftKind: "model_card", body: { provider: "openai", model_id: "m" } });
  });

  it("старый черновик harness_card из истории это строка чтения", () => {
    const items = buildThread([
      use("tu1", "preview_change", { kind: "harness_card", body: { name: "H" } }),
      result("tu1", "ok"),
    ]);
    expect(items[0]).toMatchObject({ kind: "read", status: "done" });
  });

  it("preview_change для остальных видов это строка чтения", () => {
    const items = buildThread([use("tu1", "preview_change", { kind: "agent", body: {} }), result("tu1", "ok")]);
    expect(items[0]).toMatchObject({ kind: "read", label: "Собрал черновик: агент" });
  });

  it("черновик с ошибкой не показывает карточку", () => {
    const items = buildThread([
      use("tu1", "preview_change", { kind: "model_card", body: {} }),
      result("tu1", "ошибка схемы", true),
    ]);
    expect(items[0]).toMatchObject({ kind: "read", status: "error" });
  });
});

describe("parseToolInput", () => {
  it("принимает объект и строку YAML или JSON", () => {
    expect(parseToolInput({ a: 1 })).toEqual({ a: 1 });
    expect(parseToolInput("name: x\nlist:\n  - 1\n")).toEqual({ name: "x", list: [1] });
    expect(parseToolInput('{"a":2}')).toEqual({ a: 2 });
  });
  it("мусор даёт пустой объект", () => {
    expect(parseToolInput("- - -: [")).toEqual({});
    expect(parseToolInput(5)).toEqual({});
    expect(parseToolInput(null)).toEqual({});
  });
});

describe("appliedLines", () => {
  it("создание: род и вид по-русски, версия", () => {
    expect(appliedLines([{ tool: "create_skill", kind: "skill", id: "skl_1", name: "Навык PR", version: 1, action: "create" }]))
      .toEqual([{ text: "Создан навык «Навык PR», версия 1", href: "/skills" }]);
    expect(appliedLines([{ tool: "create_environment", kind: "environment", id: "env_1", name: "Песок", version: null, action: "create" }]))
      .toEqual([{ text: "Создано окружение «Песок»", href: "/environments/env_1" }]);
    expect(appliedLines([{ tool: "create_session", kind: "session", id: "sesn_1", name: "Проверка", version: null, action: "create" }]))
      .toEqual([{ text: "Создана сессия «Проверка»", href: "/sessions/sesn_1" }]);
  });
  it("правка и сообщение", () => {
    expect(appliedLines([{ tool: "update_agent", kind: "agent", id: "agent_1", name: "Сводка", version: 4, action: "update" }]))
      .toEqual([{ text: "Изменён агент «Сводка», версия 4", href: "/agents/agent_1" }]);
    expect(appliedLines([{ tool: "send_message", kind: "message", id: "sesn_1", name: "Проверка", version: null, action: "create" }]))
      .toEqual([{ text: "Отправлено первое сообщение в сессию «Проверка»", href: "/sessions/sesn_1" }]);
  });
  it("id в ссылке кодируется", () => {
    const [line] = appliedLines([{ tool: "create_agent", kind: "agent", id: "a/../b?x", name: "А", version: null, action: "create" }]);
    expect(line.href).toBe("/agents/a%2F..%2Fb%3Fx");
  });
  it("без имени подпись короче", () => {
    expect(appliedLines([{ tool: "create_agent", kind: "agent", id: null, name: null, version: null, action: "create" }]))
      .toEqual([{ text: "Создан агент", href: null }]);
  });
});
