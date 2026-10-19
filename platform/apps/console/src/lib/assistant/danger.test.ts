import { describe, expect, it } from "vitest";

import { isWriteTool, maxOpClass, normalizeOpClass, normalizePreview } from "./api";
import { appliedLines, buildThread, parseApplied } from "./events";
import { listPathsFor } from "./invalidate";
import type { Event } from "../events";

// Опасные операции помощника (docs/plans/crud.md, 3.1 и 3.4).

describe("класс «опасное»", () => {
  it("сервер шлёт danger, консоль его понимает и ставит между правкой и «вне v1»", () => {
    expect(normalizeOpClass("danger")).toBe("danger");
    expect(normalizeOpClass("опасное")).toBe("danger");
    expect(maxOpClass(["edit", "danger"])).toBe("danger");
    expect(maxOpClass(["danger", "out_of_v1"])).toBe("out_of_v1");
  });

  it("новые инструменты записи ждут кнопки, get_dependencies нет", () => {
    for (const tool of [
      "archive_object",
      "unarchive_object",
      "delete_object",
      "update_session",
      "pause_deployment",
      "unpause_deployment",
      "run_deployment",
      "add_session_resource",
      "update_session_resource",
    ]) {
      expect(isWriteTool(`mcp__platform__${tool}`), tool).toBe(true);
    }
    expect(isWriteTool("get_dependencies")).toBe(false);
  });

  it("preview несёт операцию, зависимости и необратимость", () => {
    const p = normalizePreview({
      tool: "delete_object",
      class: "danger",
      preview_digest: "d1",
      operations: [
        {
          op_index: 0,
          tool: "delete_object",
          target_kind: "file",
          target_id: "file_1",
          class: "danger",
          irreversible: true,
          details: { card: { operation: "delete", kind: "file", id: "file_1" }, note: "Это нельзя отменить" },
          dependencies: {
            blocking: [],
            affected: [{ kind: "session", id: "sesn_1", name: "Старая", status: "terminated", note: "файл пропадёт из сессии" }],
            truncated: false,
          },
        },
      ],
    });
    const op = p.operations[0];
    expect(p.class).toBe("danger");
    expect(op.class).toBe("danger");
    expect(op.operation).toBe("delete");
    expect(op.irreversible).toBe(true);
    expect(op.dependencies?.affected).toEqual([
      { kind: "session", id: "sesn_1", name: "Старая", status: "terminated", note: "файл пропадёт из сессии" },
    ]);
    expect(op.dependencies?.blocking).toEqual([]);
  });

  it("без зависимостей у операции dependencies равно null, operation по имени инструмента", () => {
    const p = normalizePreview({
      operations: [{ op_index: 0, tool: "archive_object", target_kind: "session", class: "danger" }],
    });
    expect(p.operations[0].dependencies).toBeNull();
    expect(p.operations[0].operation).toBe("archive");
    expect(p.operations[0].irreversible).toBe(false);
  });
});

describe("итог опасной записи", () => {
  it("архив, возврат и удаление дают свои строки, у удалённого объекта нет ссылки", () => {
    const archived = parseApplied("archive_object", { kind: "session", id: "sesn_1" }, "В архиве: сессия sesn_1");
    expect(appliedLines(archived)).toEqual([{ text: "Отправлено в архив: сессия sesn_1", href: "/sessions/sesn_1" }]);
    const restored = parseApplied("unarchive_object", { kind: "agent", id: "agent_1" }, "Возвращено");
    expect(appliedLines(restored)).toEqual([{ text: "Возвращено из архива: агент agent_1", href: "/agents/agent_1" }]);
    const deleted = parseApplied("delete_object", { kind: "file", id: "file_1" }, "Удалено: файл file_1");
    expect(appliedLines(deleted)).toEqual([{ text: "Удалено: файл file_1", href: null }]);
  });

  it("после архива и удаления консоль обновляет списки этих сущностей", () => {
    const events = [
      { id: "tu_a", type: "agent.mcp_tool_use", name: "mcp__platform__archive_object", input: { kind: "session", id: "sesn_1" } },
      { id: "r_a", type: "agent.mcp_tool_result", mcp_tool_use_id: "tu_a", content: [{ type: "text", text: "ok" }] },
      { id: "tu_d", type: "agent.mcp_tool_use", name: "mcp__platform__delete_object", input: { kind: "file", id: "file_1" } },
      { id: "r_d", type: "agent.mcp_tool_result", mcp_tool_use_id: "tu_d", content: [{ type: "text", text: "ok" }] },
    ] as unknown as Event[];
    const thread = buildThread(events);
    expect(thread.map((i) => (i.kind === "proposal" ? `${i.tool}:${i.phase}` : i.kind))).toEqual([
      "archive_object:applied",
      "delete_object:applied",
    ]);
    expect(listPathsFor(thread)).toEqual(["/v1/sessions", "/v1/files"]);
  });
});

describe("отказ пользователя", () => {
  it("после «Отклонить» сервер пишет результат is_error, карточка остаётся «Отклонено», а не «Не применено»", () => {
    const events = [
      { id: "tu_d", type: "agent.mcp_tool_use", name: "mcp__platform__delete_object", input: { kind: "file", id: "file_1" } },
      { id: "c_d", type: "user.tool_confirmation", tool_use_id: "tu_d", result: "deny", deny_message: "не надо" },
      { id: "r_d", type: "agent.mcp_tool_result", mcp_tool_use_id: "tu_d", is_error: true, content: [{ type: "text", text: "Denied: Tool execution was denied by the user." }] },
    ] as unknown as Event[];
    const [item] = buildThread(events);
    expect(item).toMatchObject({ kind: "proposal", tool: "delete_object", phase: "denied", denyMessage: "не надо" });
  });
});
