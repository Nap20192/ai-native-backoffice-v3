import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { DefaultNodeManagedSessionRunnerDependencies } from "../src/lib/node-managed-session-runner.js";
import { createNodeTraceWiring, withTracePhases } from "../src/lib/trace/node-wiring.js";

// Wave 1 wiring of the agent trace in main-node (docs/plans/agent-trace.md, TW1, 3.4).

const runnerDependencies = {
  buildSandbox: async () => { throw new Error("not started in this test"); },
} as unknown as DefaultNodeManagedSessionRunnerDependencies;

describe("node trace wiring", () => {
  it("leaves the runner dependencies as they are without a trace", () => {
    expect(withTracePhases(null, runnerDependencies)).toBe(runnerDependencies);
  });

  it("wraps the runner on SQLite so sandbox phases reach the observer", async () => {
    const wiring = createNodeTraceWiring({ sql: await createBetterSqlite3SqlClient(":memory:"), dialect: "sqlite" })!;
    expect(wiring).not.toBeNull();
    const decorated = withTracePhases(wiring, runnerDependencies);
    expect(decorated).not.toBe(runnerDependencies);
    expect(decorated.buildSandbox).not.toBe(runnerDependencies.buildSandbox);
    await wiring.deleteSession({ workspaceId: "workspace_01", sessionId: "session_01" });
    expect(await wiring.store.readTurns({ workspaceId: "workspace_01", sessionId: "session_01" })).toEqual([]);
  });
});
