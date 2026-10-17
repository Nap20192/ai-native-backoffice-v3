import { describe, expect, it } from "vitest";

import { dropLegacyHarness, withoutLegacyHarness } from "./legacy-harness";

describe("dropLegacyHarness", () => {
  it("при изменении меняет старый harness на pi и убирает acp и runtime_binding", () => {
    for (const harness of ["acp-sandbox", "acp-proxy", "ai-sdk"]) {
      const openma: Record<string, unknown> = {
        harness,
        acp: { agent: { command: "sh" } },
        runtime_binding: { runtime_id: "rt_1" },
        aux_model: { id: "haiku" },
      };
      dropLegacyHarness(openma, true);
      expect(openma).toEqual({ harness: "pi", aux_model: { id: "haiku" } });
    }
  });

  it("при создании старый harness убирает целиком", () => {
    const openma: Record<string, unknown> = { harness: "acp-sandbox", acp: {} };
    dropLegacyHarness(openma, false);
    expect(openma).toEqual({});
  });

  it("pi, default и отсутствие harness не трогает", () => {
    for (const openma of [{ harness: "pi" }, { harness: "default" }, { aux_model: { id: "m" } }]) {
      const copy: Record<string, unknown> = structuredClone(openma);
      dropLegacyHarness(copy, true);
      expect(copy).toEqual(openma);
    }
  });

  it("пустое значение и null не отправляет", () => {
    for (const harness of ["", null]) {
      const openma: Record<string, unknown> = { harness };
      dropLegacyHarness(openma, true);
      expect(openma).toEqual({});
    }
  });
});

describe("withoutLegacyHarness", () => {
  it("возвращает копию и не меняет исходный блок", () => {
    const source = { harness: "acp-sandbox", acp: { agent: { command: "sh" } } };
    expect(withoutLegacyHarness(source)).toEqual({ harness: "pi" });
    expect(source.harness).toBe("acp-sandbox");
  });

  it("не объект возвращает как есть", () => {
    expect(withoutLegacyHarness(null)).toBeNull();
    expect(withoutLegacyHarness("x")).toBe("x");
  });
});
