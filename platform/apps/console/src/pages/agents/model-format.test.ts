import { describe, expect, it } from "vitest";

import type { ModelOption } from "../../lib/catalog-api";
import {
  EFFORT_ORDER,
  contextLabel,
  effortLabel,
  effortOf,
  modelMetaLine,
  providerLabel,
  sourceLabel,
} from "./model-format";

function option(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    handle: "verify-fake",
    label: "Claude Sonnet 4.6",
    source: "card",
    card_id: "mc_1",
    is_default: false,
    provider: "anthropic",
    wire_model: "claude-sonnet-4-6",
    api: "anthropic-messages",
    protocols: ["anthropic-messages"],
    context_window: 200000,
    max_output_tokens: 64000,
    effort_levels: ["low", "medium", "high", "max"],
    speed_fast: true,
    harnesses: ["pi", "claude-acp"],
    ...overrides,
  };
}

describe("подписи усилия", () => {
  it("называет пять уровней по-русски и держит их порядок", () => {
    expect(EFFORT_ORDER).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(EFFORT_ORDER.map((level) => effortLabel(level))).toEqual([
      "Низкое",
      "Среднее",
      "Высокое",
      "Очень высокое",
      "Максимальное",
    ]);
    expect(effortLabel("high", { lower: true })).toBe("высокое");
  });

  it("читает усилие из модели агента строкой и объектом, лишнее отбрасывает", () => {
    expect(effortOf({ id: "m", effort: "high" })).toBe("high");
    expect(effortOf({ id: "m", effort: { type: "xhigh" } })).toBe("xhigh");
    expect(effortOf({ id: "m", effort: { type: "turbo" } })).toBe("");
    expect(effortOf({ id: "m" })).toBe("");
    expect(effortOf("claude-sonnet-4-6")).toBe("");
    expect(effortOf(null)).toBe("");
  });
});

describe("контекст, провайдер и источник", () => {
  it("пишет окно контекста в тысячах и миллионах токенов", () => {
    expect(contextLabel(200000)).toBe("200 тыс. токенов");
    expect(contextLabel(128000)).toBe("128 тыс. токенов");
    expect(contextLabel(1000000)).toBe("1 млн токенов");
    expect(contextLabel(1500000)).toBe("1,5 млн токенов");
    expect(contextLabel(512)).toBe("512 токенов");
    expect(contextLabel(null)).toBeNull();
    expect(contextLabel(0)).toBeNull();
  });

  it("называет известных провайдеров, остальных оставляет как есть", () => {
    expect(providerLabel("anthropic")).toBe("Anthropic");
    expect(providerLabel("openai")).toBe("OpenAI");
    expect(providerLabel("my-vllm")).toBe("my-vllm");
  });

  it("называет источник модели", () => {
    expect(sourceLabel("card")).toBe("Карточка");
    expect(sourceLabel("builtin")).toBe("Ключ сервера");
  });

  it("собирает серую строку под моделью без цен", () => {
    expect(modelMetaLine(option())).toBe("Карточка · Anthropic · 200 тыс. токенов");
    expect(modelMetaLine(option({ source: "builtin", context_window: null }))).toBe(
      "Ключ сервера · Anthropic",
    );
  });
});
