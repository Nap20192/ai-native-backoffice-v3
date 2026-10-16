import { describe, expect, it } from "vitest";
import { expectedHarnessCoverage, expectedHarnessLevel, isAcpHarness } from "../src/lib/trace/harness-coverage";
import { checkHarnessConformance, loadTraceFixture, runProjectorInputs, spansOfKind } from "./_helpers/trace-harness-conformance";

describe("harness levels and trace coverage (plan 2.5)", () => {
  it("knows the expected level of each harness", () => {
    expect(expectedHarnessLevel("pi")).toBe(2);
    expect(expectedHarnessLevel(null)).toBe(2);
    expect(expectedHarnessLevel("ai-sdk")).toBe(1);
    expect(expectedHarnessLevel("acp-sandbox")).toBe(1);
    expect(expectedHarnessCoverage("claude-acp").model_calls).toBe("turn_only");
    expect(isAcpHarness("codex-acp")).toBe(true);
    expect(expectedHarnessLevel("my-own-harness")).toBe(0);
  });

  it.each([
    ["pi-turn-frames.json", 2],
    ["ai-sdk-turn-frames.json", 1],
    ["silent-harness-frames.json", 0],
  ] as const)("%s passes the contract of level %i", (name, level) => {
    const fixture = loadTraceFixture(name);
    expect(expectedHarnessLevel(fixture.harness)).toBe(level);
    const result = checkHarnessConformance(fixture, level);
    expect(result.problems).toEqual([]);
    expect(result.coverage).toEqual(result.expected);
  });

  it("an ACP harness puts the model request pair into acp_prompt", () => {
    const fixture = loadTraceFixture("ai-sdk-turn-frames.json");
    const trace = runProjectorInputs(fixture.inputs, { sessionId: fixture.scope.sessionId, harness: "claude-acp" });
    expect(spansOfKind(trace, "model_call")).toHaveLength(0);
    expect(spansOfKind(trace, "acp_prompt")).toHaveLength(3);
    expect([...trace.turns.values()][0]!.coverage.model_calls).toBe("turn_only");
  });

  it("the silent harness still gets a turn, a sandbox attempt and the end of the turn", () => {
    const fixture = loadTraceFixture("silent-harness-frames.json");
    const trace = runProjectorInputs(fixture.inputs, { sessionId: fixture.scope.sessionId, harness: fixture.harness });
    expect(spansOfKind(trace, "turn")[0]).toMatchObject({ status: "ok", end_ms: 1792200102410 });
    expect(spansOfKind(trace, "sandbox")).toHaveLength(1);
  });
});
