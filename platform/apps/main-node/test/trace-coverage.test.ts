import { describe, expect, it } from "vitest";
import { expectedHarnessCoverage, expectedHarnessLevel } from "../src/lib/trace/harness-coverage";
import { checkHarnessConformance, loadTraceFixture, runProjectorInputs, spansOfKind } from "./_helpers/trace-harness-conformance";

describe("harness levels and trace coverage (plan 2.5)", () => {
  it("knows the expected level of each harness", () => {
    expect(expectedHarnessLevel("pi")).toBe(2);
    expect(expectedHarnessLevel("default")).toBe(2);
    expect(expectedHarnessLevel(null)).toBe(2);
    expect(expectedHarnessLevel("my-own-harness")).toBe(0);
  });

  it("expects Pi coverage from the legacy harness names, which run on Pi (D41)", () => {
    for (const harness of ["ai-sdk", "acp-sandbox", "acp-proxy"]) {
      expect(expectedHarnessLevel(harness), harness).toBe(2);
      expect(expectedHarnessCoverage(harness), harness).toEqual(expectedHarnessCoverage("pi"));
    }
  });

  it("pi-turn-frames.json passes the contract of level 2", () => {
    const fixture = loadTraceFixture("pi-turn-frames.json");
    expect(expectedHarnessLevel(fixture.harness)).toBe(2);
    const result = checkHarnessConformance(fixture, 2);
    expect(result.problems).toEqual([]);
    expect(result.coverage).toEqual(result.expected);
  });

  it("a turn without timing fields passes the contract of level 1 with coverage by events", () => {
    // Recorded under the old ai-sdk name: a Pi turn without timing fields.
    const fixture = loadTraceFixture("ai-sdk-turn-frames.json");
    const result = checkHarnessConformance(fixture, 1);
    expect(result.problems).toEqual([]);
    expect(result.coverage).toEqual({ model_calls: "by_events", tools: "by_events", sandbox: "attempts" });
  });

  it("silent-harness-frames.json passes the contract of level 0", () => {
    const fixture = loadTraceFixture("silent-harness-frames.json");
    expect(expectedHarnessLevel(fixture.harness)).toBe(0);
    const result = checkHarnessConformance(fixture, 0);
    expect(result.problems).toEqual([]);
    expect(result.coverage).toEqual(result.expected);
  });

  it("makes model_call spans for any harness name, an ACP one too", () => {
    const fixture = loadTraceFixture("ai-sdk-turn-frames.json");
    for (const harness of ["claude-acp", "acp-sandbox"]) {
      const trace = runProjectorInputs(fixture.inputs, { sessionId: fixture.scope.sessionId, harness });
      expect(spansOfKind(trace, "acp_prompt"), harness).toHaveLength(0);
      expect(spansOfKind(trace, "model_call"), harness).toHaveLength(3);
      expect([...trace.turns.values()][0]!.coverage.model_calls, harness).toBe("by_events");
    }
  });

  it("the silent harness still gets a turn, a sandbox attempt and the end of the turn", () => {
    const fixture = loadTraceFixture("silent-harness-frames.json");
    const trace = runProjectorInputs(fixture.inputs, { sessionId: fixture.scope.sessionId, harness: fixture.harness });
    expect(spansOfKind(trace, "turn")[0]).toMatchObject({ status: "ok", end_ms: 1792200102410 });
    expect(spansOfKind(trace, "sandbox")).toHaveLength(1);
  });
});
