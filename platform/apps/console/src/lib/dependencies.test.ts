import { describe, expect, it } from "vitest";

import { dependenciesFromErrorBody, parseDependencyReport } from "./dependencies";
import { dependencyPath } from "./useDependencyReport";

describe("dependencies", () => {
  it("parses a report and drops malformed rows", () => {
    const report = parseDependencyReport({
      blocking: [{ kind: "session", id: "sesn_1", name: "Чат", status: "idle", note: null }, { id: 1 }],
      affected: [],
      truncated: true,
    });
    expect(report).toEqual({
      blocking: [{ kind: "session", id: "sesn_1", name: "Чат", status: "idle", note: null }],
      affected: [],
      truncated: true,
    });
    expect(parseDependencyReport("nope")).toBeNull();
  });

  it("reads the list out of a 409 body", () => {
    const body = {
      type: "error",
      error: {
        type: "dependency_conflict_error",
        message: "x",
        dependencies: { blocking: [], affected: [], truncated: false },
      },
    };
    expect(dependenciesFromErrorBody(body)).toEqual({ blocking: [], affected: [], truncated: false });
    expect(dependenciesFromErrorBody({ error: "text" })).toBeNull();
  });

  it("builds the request path with the operation and the skill version", () => {
    expect(dependencyPath({ kind: "skill_version", id: "skill_1", version: "2" }, "delete")).toBe(
      "/v1/oma/dependencies/skill_version/skill_1?operation=delete&version=2",
    );
    expect(dependencyPath({ kind: "agent", id: "a/b" }, "archive")).toBe(
      "/v1/oma/dependencies/agent/a%2Fb?operation=archive",
    );
  });
});
