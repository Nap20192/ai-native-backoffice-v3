import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/lib/platform-mcp/canonical-json.js";

describe("canonicalJson", () => {
  it("sorts nested keys and preserves arrays, strings and scalar types", () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }, null, true, "a\nb"], a: -0 }))
      .toBe('{"a":0,"z":[{"a":1,"b":2},null,true,"a\\nb"]}');
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } }))
      .toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ "10": 10, "2": 2 })).toBe('{"10":10,"2":2}');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it.each([undefined, NaN, Infinity, 1n, () => 1, Symbol(), { a: undefined }, new Date(), Array(1)])(
    "rejects values outside JSON: %s", (value) => expect(() => canonicalJson(value)).toThrow(),
  );
  it("rejects cycles but accepts shared objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
    const shared = { a: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });
});
