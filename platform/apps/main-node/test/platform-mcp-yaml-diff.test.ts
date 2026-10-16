import { describe, expect, it } from "vitest";
import { yamlDiff } from "../src/lib/platform-mcp/yaml-diff.js";

describe("yamlDiff", () => {
  it("ignores object key order at every depth", () => {
    const before = { z: [{ b: 2, a: 1 }], a: true };
    const after = { a: true, z: [{ a: 1, b: 2 }] };
    const result = yamlDiff(before, after);
    expect(result.before_yaml).toBe(result.after_yaml);
    expect(result.diff).toBe("");
  });
  it("shows additions, deletions and replacements with stable YAML", () => {
    const result = yamlDiff({ b: 2, a: 1 }, { c: 3, a: 1 });
    expect(result.before_yaml).toBe("a: 1\nb: 2\n");
    expect(result.after_yaml).toBe("a: 1\nc: 3\n");
    expect(result.diff).toContain("-b: 2");
    expect(result.diff).toContain("+c: 3");
    expect(yamlDiff({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual(result);
  });
  it("preserves array order and multiline strings", () => {
    expect(yamlDiff([1, 2], [2, 1]).diff).not.toBe("");
    expect(yamlDiff(null, { system: "Read\nWrite\n" }).after_yaml).toContain("  Read\n  Write");
  });
  it("rejects non-JSON input", () => expect(() => yamlDiff({}, { x: undefined })).toThrow());
});
