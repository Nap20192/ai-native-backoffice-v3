import { describe, expect, it } from "vitest";

import type { Event } from "../../../lib/events";
import {
  changedKeys,
  describeReducer,
  displayText,
  extractAgentDrafts,
  initialDescribeState,
  validateDraft,
  type AgentDraft,
} from "./describe-state";

const use = (id: string, name: string, input: Record<string, unknown>): Event => ({
  type: "agent.mcp_tool_use",
  id,
  name,
  mcp_server_name: "platform",
  input,
});
const result = (useId: string, body: unknown, isError = false): Event => ({
  type: "agent.mcp_tool_result",
  id: `res_${useId}`,
  mcp_tool_use_id: useId,
  is_error: isError,
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
});

const YAML_A = "name: Сводка заявок\nmodel: qwen3.6-35b\nsystem: Пиши сводку\n";
const YAML_B = "name: Сводка заявок\nmodel: qwen3.6-35b\nsystem: Пиши короткую сводку\ntools:\n  - type: agent_toolset_20260401\n";

const preview = (afterYaml: string, extra: Record<string, unknown> = {}) => ({
  tool: "preview_change",
  preview_digest: "d",
  operations: [{ index: 0, tool: "create_agent", kind: "agent", class: "create", after_yaml: afterYaml, warnings: ["Нет описания"] }],
  ...extra,
});

describe("extractAgentDrafts", () => {
  it("берёт after_yaml операции kind agent из результата preview_change", () => {
    const drafts = extractAgentDrafts([
      use("t1", "mcp__platform__preview_change", { kind: "agent", config: "name: x" }),
      result("t1", preview(YAML_A)),
    ]);
    expect(drafts).toEqual([{ toolUseId: "t1", yaml: YAML_A, warnings: ["Нет описания"], name: "Сводка заявок" }]);
  });

  it("принимает имя инструмента без префикса и поле after_yaml на верхнем уровне", () => {
    const drafts = extractAgentDrafts([
      use("t1", "preview_change", { kind: "agent" }),
      result("t1", { after_yaml: YAML_A }),
    ]);
    expect(drafts.map((d) => d.yaml)).toEqual([YAML_A]);
  });

  it("пропускает другие виды, вызовы без результата, ошибки и мусор", () => {
    const drafts = extractAgentDrafts([
      use("t1", "preview_change", { kind: "skill" }),
      result("t1", preview("name: s\n")),
      use("t2", "preview_change", { kind: "agent" }),
      use("t3", "preview_change", { kind: "agent" }),
      result("t3", "не json", false),
      use("t4", "preview_change", { kind: "agent" }),
      result("t4", preview(YAML_A), true),
      use("t5", "get", { kind: "agents", id: "a" }),
      result("t5", preview(YAML_A)),
    ]);
    expect(drafts).toEqual([]);
  });

  it("порядок черновиков равен порядку вызовов", () => {
    const drafts = extractAgentDrafts([
      use("t1", "preview_change", { kind: "agent" }),
      use("t2", "preview_change", { kind: "agent" }),
      result("t2", preview(YAML_B)),
      result("t1", preview(YAML_A)),
    ]);
    expect(drafts.map((d) => d.toolUseId)).toEqual(["t1", "t2"]);
  });

  it("ошибка схемы в ответе preview не даёт черновика", () => {
    const drafts = extractAgentDrafts([
      use("t1", "preview_change", { kind: "agent" }),
      result("t1", { schema_error: "model: обязательное поле", operations: [] }),
    ]);
    expect(drafts).toEqual([]);
  });
});

describe("changedKeys", () => {
  it("называет верхние ключи, которые поменялись, добавились или исчезли", () => {
    expect(changedKeys(YAML_A, YAML_B)).toEqual(["system", "tools"]);
    expect(changedKeys(YAML_B, YAML_A)).toEqual(["system", "tools"]);
  });
  it("порядок ключей и пробелы не считаются", () => {
    expect(changedKeys("a: 1\nb: [1, 2]\n", "b:\n  - 1\n  - 2\na: 1\n")).toEqual([]);
  });
  it("пусто, если YAML не читается", () => {
    expect(changedKeys("a: [", "a: 1")).toEqual([]);
  });
});

const draft = (id: string, yaml: string): AgentDraft => ({ toolUseId: id, yaml, warnings: [], name: null });

describe("describeReducer", () => {
  it("первый черновик ставит YAML без прошлого и без подсветки", () => {
    const s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    expect(s.yaml).toBe(YAML_A);
    expect(s.previous).toBeNull();
    expect(s.changed).toEqual([]);
    expect(s.edited).toBe(false);
  });

  it("новый черновик помнит прошлый и считает изменённые ключи", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    s = describeReducer(s, { type: "draft", draft: draft("t2", YAML_B) });
    expect(s.previous).toBe(YAML_A);
    expect(s.yaml).toBe(YAML_B);
    expect(s.changed).toEqual(["system", "tools"]);
  });

  it("тот же черновик второй раз не затирает ручную правку", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    s = describeReducer(s, { type: "edit", text: "name: Моя правка\n" });
    s = describeReducer(s, { type: "draft", draft: draft("t1", YAML_A) });
    expect(s.yaml).toBe("name: Моя правка\n");
    expect(s.edited).toBe(true);
  });

  it("ручная правка YAML ставит edited, а новый черновик модели снимает", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    s = describeReducer(s, { type: "edit", text: YAML_A + "description: Мой\n" });
    expect(s.edited).toBe(true);
    s = describeReducer(s, { type: "draft", draft: draft("t2", YAML_B) });
    expect(s.edited).toBe(false);
    expect(s.previous).toContain("description: Мой");
  });

  it("формат JSON показывает тот же конфиг, правка JSON возвращается в YAML", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    s = describeReducer(s, { type: "format", format: "json" });
    expect(JSON.parse(displayText(s))).toEqual({ name: "Сводка заявок", model: "qwen3.6-35b", system: "Пиши сводку" });
    s = describeReducer(s, { type: "edit", text: JSON.stringify({ name: "Новое", model: "m" }) });
    expect(s.jsonDraft).toBeNull();
    expect(s.yaml).toContain("name: Новое");
    s = describeReducer(s, { type: "format", format: "yaml" });
    expect(displayText(s)).toContain("name: Новое");
  });

  it("битый JSON остаётся текстом правки и не трогает YAML", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    s = describeReducer(s, { type: "format", format: "json" });
    s = describeReducer(s, { type: "edit", text: "{ name:" });
    expect(s.yaml).toBe(YAML_A);
    expect(displayText(s)).toBe("{ name:");
    expect(validateDraft(s)).toMatchObject({ ok: false });
  });

  it("в JSON нельзя переключиться, пока YAML не читается", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    s = describeReducer(s, { type: "edit", text: "name: [" });
    s = describeReducer(s, { type: "format", format: "json" });
    expect(s.format).toBe("yaml");
  });

  it("поле формы меняет один ключ и сохраняет остальные", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_B) });
    s = describeReducer(s, { type: "field", key: "name", value: "Другое имя" });
    expect(s.yaml).toContain("name: Другое имя");
    expect(s.yaml).toContain("agent_toolset_20260401");
    expect(s.edited).toBe(true);
    s = describeReducer(s, { type: "field", key: "description", value: "Коротко" });
    expect(s.yaml).toContain("description: Коротко");
    s = describeReducer(s, { type: "field", key: "description", value: "" });
    expect(s.yaml).not.toContain("description");
  });

  it("сброс возвращает пустое состояние", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    s = describeReducer(s, { type: "reset" });
    expect(s).toEqual(initialDescribeState);
  });
});

describe("validateDraft", () => {
  it("без черновика нельзя создавать", () => {
    expect(validateDraft(initialDescribeState)).toEqual({ ok: false, error: "Черновика пока нет" });
  });
  it("читаемый YAML с именем даёт тело запроса, tools по умолчанию", () => {
    const s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    const v = validateDraft(s);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload).toMatchObject({ name: "Сводка заявок", model: "qwen3.6-35b" });
      expect(v.payload.tools).toEqual([{ type: "agent_toolset_20260401" }]);
    }
  });
  it("битый YAML и YAML без имени дают причину", () => {
    let s = describeReducer(initialDescribeState, { type: "draft", draft: draft("t1", YAML_A) });
    s = describeReducer(s, { type: "edit", text: "name: [" });
    const bad = validateDraft(s);
    expect(bad.ok).toBe(false);
    s = describeReducer(s, { type: "edit", text: "model: m\n" });
    expect(validateDraft(s)).toEqual({ ok: false, error: "Укажите название агента" });
  });
});
