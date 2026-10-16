import { describe, expect, it } from "vitest";
import { isValidPackageName, parsePackageRequirement } from "../../src/environment/package-names.js";

describe("package requirement whitelist", () => {
  it.each([
    ["pip", "numpy"], ["pip", "numpy==2.0.2"], ["pip", "pandas[excel]>=2.2,<3"],
    ["pip", "python-pptx>=1.0"], ["pip", "Pillow!=10.*,>=9.0rc1"],
    ["pip", "a~=2.2"], ["pip", "a==1.0.post1.dev2"],
    ["npm", "cowsay"], ["npm", "@scope/pkg@1.2.3-beta.1"],
    ["apt", "python3-bs4"], ["apt", "libstdc++6"],
  ])("accepts %s %s", (manager, value) => {
    expect(isValidPackageName(manager, value)).toBe(true);
  });

  const rejected = ["-e .", "--index-url=https://x", "-r req.txt", "https://x/p.whl",
    "file:///x", "name @ https://x", "git+https://x", "github:user/repo", "./x", "/x",
    "../x", "~/x", "x/../y", "x;y", "x'", 'x"', "$(id)", "`id`", "x\\y", "x\ny",
    "x\ty", "раndas", "", "a".repeat(215), "x\n"];
  it.each(["pip", "npm", "apt"])("rejects unsafe %s strings", (manager) => {
    for (const value of rejected) expect(isValidPackageName(manager, value), value).toBe(false);
  });
  it.each([
    ["pip", "pkg===1.0"], ["pip", "pkg==1.0+local"], ["pip", "pkg>=1.*"],
    ["pip", "pkg~=1"], ["pip", "pkg[bad,]"], ["pip", "pkg==1.0rc1.*"],
    ["npm", "pkg@latest"], ["npm", "pkg@next"], ["npm", "pkg@^1.2"],
    ["npm", "pkg@01.2.3"], ["npm", "pkg@1.2.3-01"], ["npm", ".pkg"],
    ["apt", "pkg=1.0"], ["apt", "pkg:amd64"], ["apt", "a"],
    ["cargo", "serde"], ["gem", "rails"], ["go", "example.org/mod"],
  ])("rejects unsupported %s %s", (manager, value) => {
    expect(isValidPackageName(manager, value)).toBe(false);
  });
  it("extracts canonical identity without extras and constraints", () => {
    expect(parsePackageRequirement("pip", "My_Pkg[excel]>=2.2,<3")).toEqual({
      manager: "pip", name: "my-pkg", extras: ["excel"], constraints: ">=2.2,<3", requirement: "My_Pkg[excel]>=2.2,<3",
    });
    expect(parsePackageRequirement("npm", "@scope/pkg@1.2.3").name).toBe("@scope/pkg");
    expect(() => parsePackageRequirement("pip", "--help")).toThrow(/pip/);
  });
});
