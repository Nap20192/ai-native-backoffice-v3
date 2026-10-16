import { describe, expect, it } from "vitest";
import { parseSkillRequirements } from "../src/lib/skill-requirements.js";

describe("skill requirements metadata", () => {
  it("reads quoted metadata and multiline descriptions", () => {
    expect(parseSkillRequirements(`---
name: office
description: >
  Create documents.
  Check the result.
metadata:
  oma.requires.pip: "python-pptx>=1.0 pandas[excel]>=2.2,<3"
  oma.requires.apt: 'libreoffice-impress-nogui'
  oma.requires.npm: "@scope/pkg@1.2.3"
---
# Body
`)).toEqual({ pip: ["python-pptx>=1.0", "pandas[excel]>=2.2,<3"], apt: ["libreoffice-impress-nogui"], npm: ["@scope/pkg@1.2.3"] });
  });
  it("returns empty lists without metadata or frontmatter", () => {
    expect(parseSkillRequirements("---\nname: simple\n---\nBody")).toEqual({ apt: [], pip: [], npm: [] });
    expect(parseSkillRequirements("# Skill\nmetadata:\n  oma.requires.pip: evil")).toEqual({ apt: [], pip: [], npm: [] });
  });
  it.each(["--index-url=https://x", "pkg===1.0", "pkg==1.0+local", "https://x/p.whl", "раndas", "-e ."])("rejects %s with the key in the error", (value) => {
    expect(() => parseSkillRequirements(`---\nmetadata:\n  oma.requires.pip: '${value}'\n---`)).toThrow(/oma.requires.pip/);
  });
  it.each(["[numpy]", "12", "null"])("rejects non-string metadata %s", (value) => {
    expect(() => parseSkillRequirements(`---\nmetadata:\n  oma.requires.pip: ${value}\n---`)).toThrow(/oma.requires.pip/);
  });
  it("rejects unsupported managers, duplicate keys and broken frontmatter", () => {
    expect(() => parseSkillRequirements("---\nmetadata:\n  oma.requires.cargo: serde\n---")).toThrow(/oma.requires.cargo/);
    expect(() => parseSkillRequirements("---\nmetadata:\n  oma.requires.pip: a\n  oma.requires.pip: b\n---")).toThrow();
    expect(() => parseSkillRequirements("---\nmetadata: [\n---")).toThrow();
    expect(() => parseSkillRequirements("---\nname: missing-end")).toThrow();
  });
});
