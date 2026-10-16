import { describe, expect, it } from "vitest";
import { buildDocsIndex, searchDocs } from "../src/lib/platform-mcp/docs-search.js";

describe("docs search", () => {
  const index = buildDocsIndex([
    { name: "skills.md", content: "# Навыки\nОбщее описание.\n## Создание\nПроверяйте frontmatter.\n```md\n## Not a heading\n```\n### Файлы\nСкрипты рядом.\n" },
    { name: "sessions.md", content: "Introduction\n# Сессии\nОтправьте сообщение.\n" },
  ]);
  it("finds a heading without case sensitivity", () => {
    expect(searchDocs(index, "НАВЫКИ")[0]).toMatchObject({ document: "skills.md", heading: "Навыки" });
  });
  it("finds text and returns its section", () => {
    expect(searchDocs(index, "frontmatter")[0]).toMatchObject({ document: "skills.md", heading: "Создание" });
    expect(searchDocs(index, "frontmatter")[0].content).not.toContain("Скрипты рядом");
    expect(index.some((section) => section.heading === "Not a heading")).toBe(false);
  });
  it("handles preambles, no headings, setext headings and fenced blocks", () => {
    const sections = buildDocsIndex([{ name: "a.md", content: "Preamble\n\nTitle\n=====\nBody\n~~~\n## Code\n~~~\n" }]);
    expect(searchDocs(sections, "Preamble")[0].document).toBe("a.md");
    expect(searchDocs(sections, "Body")[0].heading).toBe("Title");
    expect(sections.some((s) => s.heading === "Code")).toBe(false);
    expect(searchDocs(buildDocsIndex([{ name: "b.md", content: "Plain document" }]), "plain")).toHaveLength(1);
  });
  it("uses a default limit of five and stable results", () => {
    const many = buildDocsIndex(Array.from({ length: 8 }, (_, n) => ({ name: `${n}.md`, content: "# Match\nText" })));
    expect(searchDocs(many, "match")).toHaveLength(5);
    expect(searchDocs(many, "match", 2)).toHaveLength(2);
    expect(searchDocs(many, "match", 0)).toEqual([]);
    expect(searchDocs(index, "  ")).toEqual([]);
    expect(searchDocs(index, "absent")).toEqual([]);
  });
});
