import { describe, expect, it } from "vitest";

import { sanitizeModelCardDraft } from "./drafts";

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
