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
const UNKNOWN: HarnessExpectation = {
  level: 0,
  coverage: { model_calls: "absent", tools: "absent", sandbox: "attempts" },
};

/**
 * Harness names an agent can carry. Only Pi runs turns (D41): the legacy
 * names ai-sdk, acp-sandbox and acp-proxy resolve to Pi in the harness
 * registry, so their new turns report like Pi.
 */
const PI_NAMES: ReadonlySet<string> = new Set(["default", "pi", "ai-sdk", "acp-sandbox", "acp-proxy"]);

function expectation(harness: string | null | undefined): HarnessExpectation {
  if (harness === null || harness === undefined || harness === "") return PI;
  return PI_NAMES.has(harness) ? PI : UNKNOWN;
}

export function expectedHarnessLevel(harness: string | null | undefined): HarnessLevel {
  return expectation(harness).level;
}

export function expectedHarnessCoverage(harness: string | null | undefined): TraceCoverage {
  return { ...expectation(harness).coverage };
}
