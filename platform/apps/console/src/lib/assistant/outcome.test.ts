import { describe, expect, it } from "vitest";

import type { Event } from "../events";
import { extractOutcomeDraft, outcomeRequestText } from "./outcome";

const use = (id: string, input: Record<string, unknown>): Event => ({
  id,
  type: "agent.mcp_tool_use",
  mcp_server_name: "platform",
  name: "mcp__platform__preview_change",
  input,
});
const result = (useId: string, body: unknown, isError = false): Event => ({
  id: `res_${useId}`,
  type: "agent.mcp_tool_result",
  mcp_tool_use_id: useId,
  is_error: isError,
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
});

const draft = {
  kind: "outcome",
  class: "draft",
  after_yaml: "description: План миграции биллинга\nrubric:\n  type: text\n  content: |\n    У каждой фазы есть откат\n    Нет простоя\nmax_iterations: 4\n",
};

describe("extractOutcomeDraft", () => {
  it("читает описание, критерии и число итераций из черновика", () => {
    const events = [use("t1", { kind: "outcome", body: {} }), result("t1", draft)];
    expect(extractOutcomeDraft(events)).toEqual({
      description: "План миграции биллинга",
      rubric: "У каждой фазы есть откат\nНет простоя",
      maxIterations: 4,
    });
  });

  it("берёт последний черновик", () => {
    const second = { ...draft, after_yaml: "description: Новый\nrubric:\n  type: text\n  content: Критерий\n" };
    const events = [
      use("t1", { kind: "outcome" }),
      result("t1", draft),
      use("t2", { kind: "outcome" }),
      result("t2", second),
    ];
    expect(extractOutcomeDraft(events)).toEqual({ description: "Новый", rubric: "Критерий", maxIterations: null });
  });

  it("пропускает чужие виды, ошибки и рубрику-файл", () => {
    const events = [
      use("a", { kind: "agent" }),
      result("a", { kind: "agent", after_yaml: "name: x\n" }),
      use("b", { kind: "outcome" }),
      result("b", "description: Ошибка схемы", true),
      use("c", { kind: "outcome" }),
      result("c", { kind: "outcome", after_yaml: "description: Д\nrubric:\n  type: file\n  file_id: file_1\n" }),
    ];
    expect(extractOutcomeDraft(events)).toBeNull();
  });

  it("не падает на мусоре", () => {
    const events = [use("t1", { kind: "outcome" }), result("t1", "не json")];
    expect(extractOutcomeDraft(events)).toBeNull();
  });
});

describe("outcomeRequestText", () => {
  it("просит черновик результата для сессии и запрещает писать", () => {
    const text = outcomeRequestText("sesn_1");
    expect(text).toContain("sesn_1");
    expect(text).toContain("preview_change");
    expect(text).toContain("outcome");
  });
});
