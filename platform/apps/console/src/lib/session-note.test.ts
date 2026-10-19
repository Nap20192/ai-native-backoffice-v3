import { describe, expect, it } from "vitest";
import { explainSessionNote } from "./session-note";

describe("explainSessionNote", () => {
  it("explains an MCP server that denied access and says what to do", () => {
    // 2026-10-19: an agent with the Amplitude MCP server ran in a session
    // without a vault. The turn showed only the raw English line below.
    const raw = 'MCP setup failed for "amplitude" (https://mcp.amplitude.com/mcp): Version negotiation failed: the server denied access (HTTP 403)';
    const note = explainSessionNote(raw);
    expect(note.text).toContain("«amplitude»");
    expect(note.text).toContain("403");
    expect(note.text).toContain("https://mcp.amplitude.com/mcp");
    expect(note.text).toMatch(/хранилищ/);
    expect(note.detail).toBe(raw);
  });

  it("treats 401 the same way", () => {
    const note = explainSessionNote('MCP setup failed for "crm" (https://crm.test/mcp): unauthorized (HTTP 401)');
    expect(note.text).toContain("«crm»");
    expect(note.detail).toBeDefined();
  });

  it("leaves other notes as they are", () => {
    expect(explainSessionNote("MCP setup failed for \"crm\" (https://crm.test/mcp): fetch failed")).toEqual({
      text: "MCP setup failed for \"crm\" (https://crm.test/mcp): fetch failed",
    });
    expect(explainSessionNote("Something else")).toEqual({ text: "Something else" });
  });
});
