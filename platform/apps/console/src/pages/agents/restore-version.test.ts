import { describe, expect, it } from "vitest";

import { restoreVersionBody } from "./restore-version";

describe("restoreVersionBody", () => {
  it("takes the stored fields of the old version and the current version number", () => {
    const body = restoreVersionBody(
      {
        id: "agent_1",
        version: 2,
        name: "Юрист",
        description: null,
        model: "claude-sonnet-4-6",
        system: "Старый промпт",
        tools: [{ type: "agent_toolset_20260401" }],
        created_at: "2026-10-01T00:00:00.000Z",
        archived_at: null,
        _oma: { harness: "pi" },
      },
      5,
    );

    expect(body).toEqual({
      version: 5,
      name: "Юрист",
      description: null,
      model: "claude-sonnet-4-6",
      system: "Старый промпт",
      tools: [{ type: "agent_toolset_20260401" }],
      _oma: { harness: "pi" },
    });
  });

  it("leaves out fields the version does not have", () => {
    expect(restoreVersionBody({ name: "A" }, 1)).toEqual({ version: 1, name: "A" });
  });
});
