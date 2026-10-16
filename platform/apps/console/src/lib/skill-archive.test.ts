import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { readSkillArchiveFiles } from "./skill-archive";

// Uint8Array.from: TextEncoder under jsdom returns an array from another realm,
// and fflate would read it as a folder.
const text = (value: string) => Uint8Array.from(new TextEncoder().encode(value));

describe("readSkillArchiveFiles", () => {
  it("drops the archive folder, puts SKILL.md first and marks binary files", () => {
    const zip = zipSync({
      "docx/scripts/run.py": text("print('ok')\n"),
      "docx/SKILL.md": text("---\nname: docx\n---\nТело навыка\n"),
      "docx/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]),
    });
    expect(readSkillArchiveFiles(zip)).toEqual([
      { filename: "SKILL.md", content: "---\nname: docx\n---\nТело навыка\n", encoding: "utf8" },
      { filename: "logo.png", content: "", encoding: "base64" },
      { filename: "scripts/run.py", content: "print('ok')\n", encoding: "utf8" },
    ]);
  });

  it("reads a Response body the way the skill card does", async () => {
    const zip = zipSync({ "pdf/SKILL.md": text("x") });
    const response = new Response(zip as Uint8Array<ArrayBuffer>);
    const files = readSkillArchiveFiles(new Uint8Array(await response.arrayBuffer()));
    expect(files.map((file) => file.filename)).toEqual(["SKILL.md"]);
  });
});
