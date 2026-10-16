import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import {
  assistantToolName,
  createAssistantSession,
  fetchSettings,
  findBuilder,
  isReadTool,
  isWriteTool,
  fetchActions,
  normalizeOpClass,
  normalizePreview,
  postDecision,
  requestPreview,
  saveSettings,
  sendAssistantMessage,
} from "./api";

describe("assistantToolName", () => {
  it("убирает префикс MCP-сервера", () => {
    expect(assistantToolName("mcp__platform__create_agent")).toBe("create_agent");
    expect(assistantToolName("create_agent")).toBe("create_agent");
  });
});

describe("классы инструментов", () => {
  it("читающие и пишущие инструменты не пересекаются", () => {
    expect(isReadTool("list")).toBe(true);
    expect(isReadTool("get_session_events")).toBe(true);
    expect(isReadTool("create_agent")).toBe(false);
    expect(isWriteTool("create_agent")).toBe(true);
    expect(isWriteTool("apply_changes")).toBe(true);
    expect(isWriteTool("send_message")).toBe(true);
    expect(isWriteTool("preview_change")).toBe(false);
    expect(isWriteTool("list")).toBe(false);
  });
});

describe("normalizeOpClass", () => {
  it("понимает латиницу и русские названия", () => {
    expect(normalizeOpClass("create")).toBe("create");
    expect(normalizeOpClass("создание")).toBe("create");
    expect(normalizeOpClass("update")).toBe("edit");
    expect(normalizeOpClass("правка")).toBe("edit");
    expect(normalizeOpClass("out_of_v1")).toBe("out_of_v1");
    expect(normalizeOpClass("вне v1")).toBe("out_of_v1");
    expect(normalizeOpClass("что-то")).toBeNull();
  });
});

describe("normalizePreview", () => {
  it("заполняет умолчания для пустого ответа", () => {
    const p = normalizePreview({});
    expect(p.disabled).toBe(false);
    expect(p.schemaError).toBeNull();
    expect(p.operations).toEqual([]);
    expect(p.digest).toBeNull();
    expect(p.canConfirm).toBe(true);
    expect(p.secret).toBe(false);
  });

  it("читает операции, класс и предупреждения", () => {
    const p = normalizePreview({
      tool: "update_agent",
      preview_digest: "abc",
      can_confirm: false,
      owner_name: "Анна",
      operations: [
        {
          index: 0,
          tool: "update_agent",
          kind: "agent",
          target_id: "agent_1",
          name: "Сводка PR",
          class: "правка",
          before_yaml: "a: 1\n",
          after_yaml: "a: 2\n",
          warnings: ["модель не найдена"],
          version_from: 3,
          version_to: 4,
        },
      ],
    });
    expect(p.digest).toBe("abc");
    expect(p.canConfirm).toBe(false);
    expect(p.ownerName).toBe("Анна");
    expect(p.operations[0]).toMatchObject({
      kind: "agent",
      targetId: "agent_1",
      class: "edit",
      versionFrom: 3,
      versionTo: 4,
      warnings: ["модель не найдена"],
    });
  });

  it("старший класс пачки берёт из операций, если сервер его не прислал", () => {
    const p = normalizePreview({
      operations: [
        { index: 0, tool: "create_skill", kind: "skill", class: "create" },
        { index: 1, tool: "update_agent", kind: "agent", class: "edit" },
      ],
    });
    expect(p.class).toBe("edit");
    const out = normalizePreview({
      operations: [
        { index: 0, tool: "update_deployment", kind: "deployment", class: "out_of_v1" },
        { index: 1, tool: "update_agent", kind: "agent", class: "edit" },
      ],
    });
    expect(out.class).toBe("out_of_v1");
  });

  it("ошибку схемы и признак секрета держит отдельно", () => {
    const p = normalizePreview({ schema_error: "поле command не принимается", secret: true });
    expect(p.schemaError).toBe("поле command не принимается");
    expect(p.secret).toBe(true);
  });

  it("не принимает чужие типы вместо строк и массивов", () => {
    const p = normalizePreview({
      operations: [{ index: 0, tool: 5, kind: null, warnings: "x", before_yaml: 7 }],
    });
    expect(p.operations[0].tool).toBe("");
    expect(p.operations[0].warnings).toEqual([]);
    expect(p.operations[0].beforeYaml).toBeNull();
  });
});

describe("ответ preview сервера (apps/main-node/src/lib/platform-mcp/preview.ts)", () => {
  // Форма, которую отдаёт previewJson: op_index, target_kind, reason, details.
  const server = {
    tool: "apply_changes",
    class: "update",
    reason: null,
    schema_error: null,
    not_found: null,
    invalid: null,
    args_stale: false,
    secret: false,
    preview_digest: "d1",
    can_confirm: true,
    operations: [
      {
        op_index: 0,
        tool: "create_deployment",
        target_kind: "deployment",
        target_id: null,
        name: "Ночной отчёт",
        class: "create",
        reason: null,
        before_yaml: null,
        after_yaml: "name: Ночной отчёт\n",
        warnings: [],
        details: { upcoming_runs: ["2026-10-17T00:00:00.000Z", "2026-10-18T00:00:00.000Z"] },
      },
      {
        op_index: 1,
        tool: "update_agent",
        target_kind: "agent",
        target_id: "agent_1",
        name: "Сводка PR",
        class: "update",
        reason: null,
        version_from: 3,
        version_to: 4,
        warnings: [],
      },
      { op_index: 2, tool: "update_deployment", target_kind: "deployment", target_id: "dep_1", class: "out_of_v1", reason: "Деплоймент работает" },
    ],
  };

  it("читает вид, индекс, ближайшие запуски, версии и причину вне первой версии", () => {
    const p = normalizePreview(server);
    expect(p.operations.map((o) => [o.index, o.kind])).toEqual([[0, "deployment"], [1, "agent"], [2, "deployment"]]);
    expect(p.operations[0]).toMatchObject({ name: "Ночной отчёт", nextRuns: ["2026-10-17T00:00:00.000Z", "2026-10-18T00:00:00.000Z"] });
    expect(p.operations[1]).toMatchObject({ class: "edit", versionFrom: 3, versionTo: 4, targetId: "agent_1" });
    expect(p.operations[2].outOfV1Reason).toBe("Деплоймент работает");
  });

  it("not_found и invalid сервера приходят строками", () => {
    expect(normalizePreview({ ...server, not_found: "Агент не найден" }).notFound).toBe(true);
    expect(normalizePreview({ ...server, not_found: null }).notFound).toBe(false);
    expect(normalizePreview({ ...server, invalid: "Навык не прошёл проверку" }).schemaError).toBe("Навык не прошёл проверку");
  });
});

describe("fetchActions", () => {
  it("читает строки журнала из поля actions ответа сервера", async () => {
    const api = vi.fn(async () => ({
      actions: [{ id: "a1", tool: "list", class: "read", result: "ok", op_index: 0, created_at: "2026-10-16T10:00:00Z" }],
      confirmations: [],
      next_cursor: null,
    }));
    const page = await fetchActions(api, { sessionId: "sesn_1" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ id: "a1", tool: "list", result: "ok" });
  });
});

describe("requestPreview", () => {
  it("шлёт session_id и tool_use_id и только их", async () => {
    const api = vi.fn(async () => ({ operations: [] }));
    await requestPreview(api, { sessionId: "sesn_1", toolUseId: "tu_1" });
    expect(api).toHaveBeenCalledTimes(1);
    const [path, init] = api.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/oma/platform-mcp/preview");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ session_id: "sesn_1", tool_use_id: "tu_1" });
  });
});

describe("postDecision", () => {
  const input = {
    sessionId: "sesn_1",
    toolUseId: "tu_1",
    result: "allow" as const,
    digest: "dg1",
  };

  it("шлёт решение с отпечатком карточки", async () => {
    const api = vi.fn(async () => ({}));
    const out = await postDecision(api, input);
    expect(out).toEqual({ ok: true });
    const [path, init] = api.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/oma/platform-mcp/confirm");
    expect(JSON.parse(init.body as string)).toEqual({
      session_id: "sesn_1",
      tool_use_id: "tu_1",
      result: "allow",
      preview_digest: "dg1",
    });
  });

  it("передаёт причину отказа", async () => {
    const api = vi.fn(async () => ({}));
    await postDecision(api, { ...input, result: "deny", denyMessage: "stale" });
    const init = (api.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string).deny_message).toBe("stale");
  });

  const failing = (status: number, code: string) =>
    vi.fn(async () => {
      throw new ApiError({ status, code, message: "x" });
    });

  it.each([
    [409, "stale", "stale"],
    [409, "class", "class"],
    [409, "secret", "secret"],
    [409, "disabled", "disabled"],
    [409, "not_pending", "not_pending"],
    [404, "not_found_error", "not_found"],
    [403, "permission_error", "forbidden"],
    [409, "что-то новое", "other"],
    [500, "api_error", "other"],
  ])("ошибка %i %s даёт причину %s", async (status, code, reason) => {
    const out = await postDecision(failing(status, code), input);
    expect(out).toMatchObject({ ok: false, reason, status });
  });

  it("сетевой сбой тоже не бросает наружу", async () => {
    const out = await postDecision(
      vi.fn(async () => {
        throw new Error("offline");
      }),
      input,
    );
    expect(out).toMatchObject({ ok: false, reason: "other" });
  });
});

describe("настройки", () => {
  it("читает выключатель", async () => {
    const api = vi.fn(async () => ({ enabled: false, can_change: true, updated_by: "u1" }));
    const s = await fetchSettings(api);
    expect(s).toMatchObject({ enabled: false, canChange: true });
  });

  it("без записи считает ассистента включённым", async () => {
    const s = await fetchSettings(vi.fn(async () => ({})));
    expect(s).toMatchObject({ enabled: true, canChange: false });
  });

  it("пишет выключатель", async () => {
    const api = vi.fn(async () => ({ enabled: false, can_change: true }));
    await saveSettings(api, false);
    const [path, init] = api.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/oma/platform-mcp/settings");
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
  });
});

describe("findBuilder", () => {
  it("находит агента с меткой oma_role: builder и его окружение", async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith("/v1/agents")) {
        return {
          data: [
            { id: "agent_x", name: "Другой", version: 1, metadata: {} },
            { id: "agent_b", name: "Ассистент", version: 3, metadata: { oma_role: "builder" } },
          ],
        };
      }
      return {
        data: [
          { id: "env_x", name: "Песок", metadata: {} },
          { id: "env_b", name: "Ассистент", metadata: { oma_role: "builder" } },
        ],
      };
    });
    const b = await findBuilder(api);
    expect(b).toEqual({
      agent: { id: "agent_b", name: "Ассистент", version: 3 },
      environment: { id: "env_b", name: "Ассистент" },
    });
  });

  it("окружение без метки находит по имени «Ассистент»", async () => {
    const api = vi.fn(async (path: string) =>
      path.startsWith("/v1/agents")
        ? { data: [{ id: "agent_b", name: "А", version: 1, metadata: { oma_role: "builder" } }] }
        : { data: [{ id: "env_n", name: "Ассистент", metadata: {} }] },
    );
    const b = await findBuilder(api);
    expect(b?.environment.id).toBe("env_n");
  });

  it("возвращает null, если ассистента нет", async () => {
    const api = vi.fn(async () => ({ data: [] }));
    expect(await findBuilder(api)).toBeNull();
  });

  it("пропускает агента в архиве", async () => {
    const api = vi.fn(async (path: string) =>
      path.startsWith("/v1/agents")
        ? {
            data: [
              {
                id: "agent_old",
                name: "Старый",
                version: 1,
                archived_at: "2026-10-01T00:00:00Z",
                metadata: { oma_role: "builder" },
              },
            ],
          }
        : { data: [{ id: "env_b", name: "Ассистент", metadata: { oma_role: "builder" } }] },
    );
    expect(await findBuilder(api)).toBeNull();
  });
});

describe("сессия ассистента", () => {
  const builder = {
    agent: { id: "agent_b", name: "Ассистент", version: 3 },
    environment: { id: "env_b", name: "Ассистент" },
  };

  it("создаёт сессию с явной версией агента", async () => {
    const api = vi.fn(async () => ({ id: "sesn_new" }));
    const id = await createAssistantSession(api, { builder, userId: "u1" });
    expect(id).toBe("sesn_new");
    const [path, init] = api.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/sessions");
    const body = JSON.parse(init.body as string);
    expect(body.agent).toEqual({ type: "agent", id: "agent_b", version: 3 });
    expect(body.environment_id).toBe("env_b");
    expect(body.metadata).toMatchObject({ oma_assistant_chat: "1", oma_assistant_user: "u1" });
    expect(body.initial_events).toBeUndefined();
  });

  it("с выбранной моделью просит модель через agent_with_overrides", async () => {
    const api = vi.fn(async () => ({ id: "sesn_new" }));
    await createAssistantSession(api, { builder, userId: "u1", model: "qwen3.6-35b" });
    const body = JSON.parse(((api.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string);
    expect(body.agent).toEqual({
      type: "agent_with_overrides",
      id: "agent_b",
      version: 3,
      model: "qwen3.6-35b",
    });
  });

  it("в режиме «черновик» оставляет четыре инструмента и выключенный встроенный набор", async () => {
    const api = vi.fn(async () => ({ id: "sesn_new" }));
    await createAssistantSession(api, { builder, userId: "u1", mode: "draft" });
    const body = JSON.parse(((api.mock.calls[0] as unknown as [string, RequestInit])[1]).body as string);
    expect(body.agent.type).toBe("agent_with_overrides");
    expect(body.agent.tools).toEqual([
      { type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [] },
      {
        type: "mcp_toolset",
        mcp_server_name: "platform",
        default_config: { enabled: false, permission_policy: { type: "always_ask" } },
        configs: ["help", "list", "get", "preview_change"].map((name) => ({
          name,
          enabled: true,
          permission_policy: { type: "always_allow" },
        })),
      },
    ]);
  });

  it("отправляет сообщение одним событием user.message", async () => {
    const api = vi.fn(async () => ({}));
    await sendAssistantMessage(api, "sesn_1", "Привет");
    const [path, init] = api.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/sessions/sesn_1/events");
    expect(JSON.parse(init.body as string)).toEqual({
      events: [{ type: "user.message", content: [{ type: "text", text: "Привет" }] }],
    });
  });
});
