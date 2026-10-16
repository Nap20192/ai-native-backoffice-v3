import { describe, expect, it } from "vitest";
import { diffInstalledPackages, parseInstalledPackages } from "../../src/environment/installed-packages.js";

const inventory = (pip: unknown[] = [], apt: unknown[] = [], npm: unknown[] = [], localNpm: unknown[] = []) =>
  JSON.stringify({ pip, apt, npm, localNpm });

describe("sandbox package inventory", () => {
  it("rejects oversized output before parsing and marks its source", () => {
    const result = parseInstalledPackages("x".repeat(256 * 1024 + 1));
    expect(result).toMatchObject({ source: "sandbox", truncated: true, packages: [] });
    expect(parseInstalledPackages("я".repeat(140000)).truncated).toBe(true);
    expect(() => parseInstalledPackages("bad json")).toThrow(/inventory/i);
  });
  it("validates names and versions from the untrusted VM", () => {
    const result = parseInstalledPackages(inventory(
      [{ name: "My_Pkg", version: "1.2" }, { name: "--index-url=x", version: "1.0" }],
      [{ name: "python3-bs4", version: "1:4.12-1+deb12u1" }],
      [{ name: "a b", version: "1.2.3" }, { name: "cowsay", version: "1.6.0" }],
      [{ name: "@scope/local", version: "2.0.0" }],
    ));
    expect(result).toMatchObject({ source: "sandbox", truncated: false, rejected: 2 });
    expect(result.packages).toEqual([
      { manager: "pip", name: "my-pkg", version: "1.2", scope: "global", requirement: "my-pkg==1.2" },
      { manager: "apt", name: "python3-bs4", version: "1:4.12-1+deb12u1", scope: "global", requirement: "python3-bs4" },
      { manager: "npm", name: "cowsay", version: "1.6.0", scope: "global", requirement: "cowsay@1.6.0" },
      { manager: "npm", name: "@scope/local", version: "2.0.0", scope: "local", requirement: null },
    ]);
  });
  it("reports added, updated and removed packages against the baseline", () => {
    const before = parseInstalledPackages(inventory([
      { name: "numpy", version: "1.26.4" }, { name: "old", version: "1.0" },
    ]));
    const after = parseInstalledPackages(inventory([
      { name: "numpy", version: "2.0.2" }, { name: "rich", version: "13.0" },
    ]));
    const diff = diffInstalledPackages(before, after);
    expect(diff.updated).toEqual([{ ...after.packages[0], previousVersion: "1.26.4" }]);
    expect(diff.added).toEqual([after.packages[1]]);
    expect(diff.removed).toEqual([before.packages[1]]);
    expect(diffInstalledPackages(before, { ...after, truncated: true })).toMatchObject({
      added: [], updated: [], removed: [], truncated: true,
    });
  });
  it("does not let duplicate identities or malformed collections produce removals", () => {
    expect(() => parseInstalledPackages('{"pip":{}}')).toThrow(/inventory/i);
    expect(() => parseInstalledPackages(inventory([
      { name: "My_Pkg", version: "1.0" }, { name: "my-pkg", version: "2.0" },
    ]))).toThrow(/duplicate/i);
  });
});
