import { describe, expect, it } from "vitest";
import { validateSkillSpec } from "../src/lib/platform-mcp/skill-spec.js";

const skill = (yaml: string, body = "Read the input.") => `---\n${yaml}\n---\n${body}`;
const valid = "name: test-skill\ndescription: Read documents when asked.";

describe("validateSkillSpec", () => {
  it.each([
    ["minimal", skill(valid), true],
    ["optional fields", skill(`${valid}\nlicense: MIT\ncompatibility: Needs Python\nallowed-tools: Read Bash\nmetadata:\n  author: team`), true],
    ["missing frontmatter", "# Skill", false],
    ["malformed YAML", skill("name: ["), false],
    ["missing name", skill("description: Read documents"), false],
    ["empty name", skill('name: ""\ndescription: Read'), false],
    ["long name", skill(`name: ${"a".repeat(65)}\ndescription: Read`), false],
    ["uppercase name", skill("name: Test\ndescription: Read"), false],
    ["leading hyphen", skill("name: -test\ndescription: Read"), false],
    ["trailing hyphen", skill("name: test-\ndescription: Read"), false],
    ["consecutive hyphens", skill("name: test--skill\ndescription: Read"), false],
    ["missing description", skill("name: test-skill"), false],
    ["blank description", skill('name: test-skill\ndescription: "   "'), false],
    ["long description", skill(`name: test-skill\ndescription: ${"a".repeat(1025)}`), false],
    ["description type", skill("name: test-skill\ndescription: 123"), false],
    ["compatibility type", skill(`${valid}\ncompatibility: []`), false],
    ["empty compatibility", skill(`${valid}\ncompatibility: ""`), false],
    ["long compatibility", skill(`${valid}\ncompatibility: ${"a".repeat(501)}`), false],
    ["metadata values", skill(`${valid}\nmetadata:\n  version: 1`), false],
    ["metadata array", skill(`${valid}\nmetadata: []`), false],
    ["license type", skill(`${valid}\nlicense: false`), false],
    ["tools type", skill(`${valid}\nallowed-tools: []`), false],
    ["duplicate keys", skill(`${valid}\nname: other`), false],
    ["frontmatter array", skill("- name\n- description"), false],
    ["boundary lengths", skill(`name: ${"a".repeat(64)}\ndescription: ${"d".repeat(1024)}\ncompatibility: ${"c".repeat(500)}`), true],
    ["CRLF", skill(valid).replaceAll("\n", "\r\n"), true],
    ["multiline description", skill("name: test-skill\ndescription: |\n  Read documents.\n  Use when asked."), true],
  ])("%s", (_name, content, accepted) => {
    const result = validateSkillSpec(content);
    expect(result.valid).toBe(accepted);
    expect(result.errors.length === 0).toBe(accepted);
  });
  it("checks the directory name when supplied", () => {
    expect(validateSkillSpec(skill(valid), "other").valid).toBe(false);
    expect(validateSkillSpec(skill(valid), "test-skill").valid).toBe(true);
  });
  it("warns about long instructions without rejecting them", () => {
    const result = validateSkillSpec(skill(valid, "instruction\n".repeat(500)));
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
  it("does not repeat malformed input in errors", () => {
    expect(JSON.stringify(validateSkillSpec(skill("private-value: [")))).not.toContain("private-value");
  });
});
