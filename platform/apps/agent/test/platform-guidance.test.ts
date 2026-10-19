import { describe, expect, it } from "vitest";

import { composeSystemPrompt, platformGuidance } from "../src/harness/platform-guidance";

const READ_BACK = "After you write a file for the user, read it back and check it against the task.";
const WIDESCREEN = "Make new slide decks 16:9 unless the user asks for another size.";

describe("platform guidance", () => {
  it("asks every agent to read a written file back and to make decks 16:9", () => {
    for (const prompt of [composeSystemPrompt(null), composeSystemPrompt("You are a helper.")]) {
      expect(prompt).toContain(READ_BACK);
      expect(prompt).toContain(WIDESCREEN);
    }
  });

  it("keeps each new line to one short sentence", () => {
    for (const line of [READ_BACK, WIDESCREEN]) {
      expect(platformGuidance.split("\n\n")).toContain(line);
      expect(line.split(/[.!?](\s|$)/u).filter((part) => part.trim()).length).toBe(1);
    }
  });
});
