import { describe, expect, it } from "vitest";

import type { ModelOption } from "../../lib/catalog-api";
import { findModel, pickDefaultModel } from "./agent-model";

function model(overrides: Partial<ModelOption> = {}): ModelOption {
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
    effort_levels: ["low", "medium", "high"],
    speed_fast: true,
    ...overrides,
  };
}

describe("pickDefaultModel", () => {
  const defaultCard = model({ handle: "default-card", is_default: true });
  const otherCard = model({ handle: "other-card" });
  const builtin = model({ handle: "claude-sonnet-4-6", source: "builtin", card_id: null });

  it("берёт карточку по умолчанию", () => {
    expect(pickDefaultModel([otherCard, defaultCard, builtin])?.handle).toBe("default-card");
  });

  it("иначе первую карточку", () => {
    expect(pickDefaultModel([builtin, otherCard])?.handle).toBe("other-card");
  });

  it("иначе первую встроенную модель", () => {
    expect(pickDefaultModel([builtin])?.handle).toBe("claude-sonnet-4-6");
  });

  it("берёт модель любого протокола, даже без протоколов", () => {
    expect(pickDefaultModel([model({ handle: "x", protocols: [] })])?.handle).toBe("x");
  });

  it("без моделей даёт null", () => {
    expect(pickDefaultModel([])).toBeNull();
  });
});

describe("findModel", () => {
  it("находит модель по handle", () => {
    const options = [model({ handle: "a" }), model({ handle: "b" })];
    expect(findModel(options, "b")?.handle).toBe("b");
  });

  it("без каталога или без совпадения даёт undefined", () => {
    expect(findModel(undefined, "a")).toBeUndefined();
    expect(findModel([model({ handle: "a" })], "z")).toBeUndefined();
  });
});
