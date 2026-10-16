import type { TraceCoverage } from "./types.js";

/**
 * What each harness reports (plan section 2.5).
 * 0: nothing but the final message, 1: model and tool events,
 * 2: events with harness timing, 3: OTel spans.
 */
export type HarnessLevel = 0 | 1 | 2 | 3;

interface HarnessExpectation {
  level: HarnessLevel;
  coverage: TraceCoverage;
}

const PI: HarnessExpectation = {
  level: 2,
  coverage: { model_calls: "measured", tools: "measured", sandbox: "attempts" },
};
const AI_SDK: HarnessExpectation = {
  level: 1,
  coverage: { model_calls: "by_events", tools: "by_events", sandbox: "attempts" },
};
const ACP: HarnessExpectation = {
  level: 1,
  coverage: { model_calls: "turn_only", tools: "by_events", sandbox: "attempts" },
};
const UNKNOWN: HarnessExpectation = {
  level: 0,
  coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" },
};

/** Harness registry names (apps/agent/src/harness/builtins.ts) and ACP agent ids. */
const EXPECTATIONS: Record<string, HarnessExpectation> = {
  default: PI,
  pi: PI,
  "ai-sdk": AI_SDK,
  "acp-sandbox": ACP,
  "acp-proxy": ACP,
  "claude-acp": ACP,
  "codex-acp": ACP,
  "gemini-acp": ACP,
  "opencode-acp": ACP,
  "pi-acp": ACP,
};

function expectation(harness: string | null | undefined): HarnessExpectation {
  if (harness === null || harness === undefined || harness === "") return PI;
  return EXPECTATIONS[harness] ?? (harness.endsWith("-acp") ? ACP : UNKNOWN);
}

export function expectedHarnessLevel(harness: string | null | undefined): HarnessLevel {
  return expectation(harness).level;
}

export function expectedHarnessCoverage(harness: string | null | undefined): TraceCoverage {
  return { ...expectation(harness).coverage };
}

/** ACP harnesses send one span.model_request_* pair per turn: it becomes acp_prompt. */
export function isAcpHarness(harness: string | null | undefined): boolean {
  return expectation(harness) === ACP;
}
