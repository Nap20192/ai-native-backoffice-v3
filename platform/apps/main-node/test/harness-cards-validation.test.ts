import { describe, expect, it } from "vitest";
import { validateHarnessCardInput } from "../src/lib/harness-cards/validation";

const validInput = {
  harness_id: "aider-local", name: "Aider через ACP", command: "aider-acp",
  args: [], protocols: ["openai-chat"],
};

describe("harness card validation", () => {
  it("rejects a builtin ID with a field error", () => {
    expect(() => validateHarnessCardInput({ ...validInput, harness_id: "claude-acp" }, { mode: "create" }))
      .toThrow(expect.objectContaining({ field: "harness_id", message: "ID «claude-acp» занят встроенным harness" }));
  });
  it.each(["pi", "default", "ai-sdk", "acp", "acp-sandbox", "acp-proxy", "claude-code", "codex", "codex-cli", "codex-acp-bridge", "gemini-cli", "kimi-code-acp", "dsh-acp", "deepseek-harness-acp", "claude-agent-acp", "hermes"])("reserves %s", (harness_id) => {
    expect(() => validateHarnessCardInput({ ...validInput, harness_id }, { mode: "create" })).toThrow(expect.objectContaining({ field: "harness_id" }));
  });
  it.each([
    ["harness_id", "Aider"], ["harness_id", "x"], ["harness_id", "a b"], ["harness_id", "a".repeat(41)],
    ["name", "  "], ["name", "x".repeat(81)], ["command", "sh -c"], ["command", "../bin/acp"],
    ["command", "/bin/acp;id"], ["command", "$(id)"], ["command", "x".repeat(201)],
    ["args", "--acp"], ["args", [1]], ["args", ["a\0b"]], ["args", Array(33).fill("x")], ["args", ["x".repeat(2001)]],
    ["cwd", "relative"], ["cwd", "/x\0y"],
    ["protocols", []], ["protocols", ["gemini"]], ["protocols", ["openai-chat", "openai-chat"]],
    ["allowed_env", ["OPENAI_API_KEY"]], ["allowed_env", ["MY_TOKEN"]], ["allowed_env", ["ANTHROPIC_BASE_URL"]],
    ["allowed_env", ["X=x"]], ["allowed_env", ["X", "X"]], ["allowed_env", { X: "secret" }], ["allowed_env", Array.from({ length: 33 }, (_, i) => `X${i}`)],
    ["env", { SAFE: "sk-secret-test" }], ["status", "ready"], ["created_by", "someone"],
    ["install", { npm: ["--index-url=x"] }], ["install", { pip: ["git+https://x"] }],
    ["install", { npm: ["https://x"] }], ["install", { npm: ["a b"] }], ["install", { pip: ["-r"] }],
    ["install", { npm: Array(21).fill("pkg") }], ["install", { other: [] }], ["install", null],
  ])("rejects invalid %s", (field, value) => {
    expect(() => validateHarnessCardInput({ ...validInput, [field as string]: value }, { mode: "create" })).toThrow(expect.objectContaining({ field }));
  });
  it.each([null, [], "text", 42])("rejects a non-object body", (body) => {
    expect(() => validateHarnessCardInput(body, { mode: "create" })).toThrow();
  });
  it.each(["name", "harness_id", "command", "protocols"])("requires %s", (field) => {
    const body: Record<string, unknown> = { ...validInput };
    delete body[field];
    expect(() => validateHarnessCardInput(body, { mode: "create" })).toThrow(expect.objectContaining({ field }));
  });
  it("defaults optional fields and trims the name", () => {
    expect(validateHarnessCardInput({ ...validInput, name: "  Мой агент  " }, { mode: "create" })).toEqual({
      ...validInput, name: "Мой агент", cwd: "/mnt/session/outputs", install: { npm: [], pip: [] }, allowed_env: [],
    });
  });
  it("accepts absolute commands, literal arguments, packages and safe environment names", () => {
    const body = { ...validInput, command: "/opt/bin/agent", args: ["argument with spaces", "$(literal)"], cwd: null,
      install: { npm: ["@scope/agent@1.2.3", "agent@latest"], pip: ["aider-chat==0.86.1", "agent[acp]>=1.2,<2"] }, allowed_env: ["AIDER_AUTO_COMMITS"] };
    expect(validateHarnessCardInput(body, { mode: "create" })).toEqual(body);
  });
  it("keeps a partial update partial", () => {
    expect(validateHarnessCardInput({ name: " Новое имя " }, { mode: "update" })).toEqual({ name: "Новое имя" });
    expect(validateHarnessCardInput({}, { mode: "update" })).toEqual({});
  });
  it("rejects even the same harness ID in an update", () => {
    expect(() => validateHarnessCardInput({ harness_id: validInput.harness_id }, { mode: "update" })).toThrow(expect.objectContaining({ field: "harness_id" }));
  });
});
