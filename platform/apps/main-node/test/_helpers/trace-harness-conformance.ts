// Harness contract check for the agent trace (docs/plans/agent-trace.md, 2.5).
// A harness adds a fixture of one turn and its expected level; the check runs
// the projector and verifies the nodes and the coverage it builds.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTraceProjector, type TraceProjectorOptions } from "../../src/lib/trace/projector";
import { expectedHarnessCoverage, type HarnessLevel } from "../../src/lib/trace/harness-coverage";
import type {
  TraceCoverage,
  TraceOp,
  TraceProjectorInput,
  TraceSpanWrite,
  TraceTurnWrite,
} from "../../src/lib/trace/types";

export interface TraceTurnFixture {
  scope: { workspaceId: string; sessionId: string };
  harness: string | null;
  agentName?: string;
  execution?: Record<string, unknown> & { id: string };
  history?: Array<{ id: string; type: string; processed_at: number; thread_id: string | null; document: Record<string, unknown> }>;
  inputs: TraceProjectorInput[];
  interrupt?: { id: string; type: string; processed_at: number; document: Record<string, unknown> };
}

export interface TraceMultiTurnFixture {
  scope: { workspaceId: string; sessionId: string };
  harness: string | null;
  agentName?: string;
  threads?: Record<string, string>;
  turns: Array<{ executionId: string; inputs: TraceProjectorInput[] }>;
}

export function loadTraceFixture<T = TraceTurnFixture>(name: string): T {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "_fixtures", "trace", name);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** In-memory view of what the store would hold after the ops: enough for projector tests. */
export interface ProjectedTrace {
  ops: TraceOp[];
  spans: Map<string, TraceSpanWrite>;
  turns: Map<string, TraceTurnWrite>;
}

export function emptyProjectedTrace(): ProjectedTrace {
  return { ops: [], spans: new Map(), turns: new Map() };
}

export function applyOpsInMemory(target: ProjectedTrace, ops: readonly TraceOp[]): ProjectedTrace {
  for (const op of ops) {
    target.ops.push(op);
    if (op.op === "claim" || op.op === "turn") {
      target.turns.set(op.turn.turn_id, op.turn);
      continue;
    }
    if (op.op === "upsert") {
      const span = { ...op.span, attrs: { ...op.span.attrs } };
      if (op.inherit_from !== undefined) {
        const parent = target.spans.get(op.inherit_from);
        if (parent === undefined) continue;
        span.turn_id = parent.turn_id;
        span.thread_id = parent.thread_id;
      }
      if (op.continued_thread !== undefined && span.attrs.continued_from === undefined) {
        const previous = [...target.spans.values()]
          .filter((candidate) => candidate.kind === "subagent" && candidate.thread_id === op.continued_thread && candidate.turn_id !== span.turn_id)
          .sort((a, b) => b.start_ms - a.start_ms)[0];
        if (previous !== undefined) span.attrs.continued_from = previous.span_id;
      }
      target.spans.set(span.span_id, span);
      continue;
    }
    const current = target.spans.get(op.span_id);
    if (current === undefined || !op.expect.includes(current.status)) continue;
    target.spans.set(op.span_id, { ...current, ...op.set });
  }
  return target;
}

export function runProjectorInputs(
  inputs: readonly TraceProjectorInput[],
  options: TraceProjectorOptions,
  target: ProjectedTrace = emptyProjectedTrace(),
): ProjectedTrace {
  const projector = createTraceProjector(options);
  for (const input of inputs) applyOpsInMemory(target, projector.push(input));
  return target;
}

export function projectorOptionsFor(fixture: { scope: { sessionId: string }; harness: string | null }): TraceProjectorOptions {
  return { sessionId: fixture.scope.sessionId, harness: fixture.harness, mode: "live" };
}

export function spansOfKind(trace: ProjectedTrace, kind: TraceSpanWrite["kind"]): TraceSpanWrite[] {
  return [...trace.spans.values()].filter((span) => span.kind === kind).sort((a, b) => a.start_ms - b.start_ms || a.span_id.localeCompare(b.span_id));
}

export interface ConformanceResult {
  coverage: TraceCoverage;
  expected: TraceCoverage;
  problems: string[];
}

/** Runs one turn of a harness fixture and checks the nodes its level promises. */
export function checkHarnessConformance(fixture: TraceTurnFixture, level: HarnessLevel): ConformanceResult {
  const trace = runProjectorInputs(fixture.inputs, projectorOptionsFor(fixture));
  const problems: string[] = [];
  const turns = [...trace.turns.values()];
  if (turns.length !== 1) problems.push(`expected one turn, got ${turns.length}`);
  const turn = turns[0];
  const expected = expectedHarnessCoverage(fixture.harness);
  const coverage = turn?.coverage ?? { model_calls: "absent", tools: "absent", sandbox: "attempts" };
  const turnSpan = spansOfKind(trace, "turn").find((span) => span.parent_span_id === null);
  if (turnSpan === undefined) problems.push("no top-level turn span");
  else if (turnSpan.status === "running") problems.push("turn is still running");
  if (spansOfKind(trace, "sandbox").length === 0) problems.push("no sandbox attempt");
  for (const span of trace.spans.values()) {
    if (span.parent_span_id !== null && !trace.spans.has(span.parent_span_id)) problems.push(`orphan ${span.kind} ${span.span_id}`);
    if (span.end_ms === null && span.status !== "waiting") problems.push(`open ${span.kind} ${span.span_id}`);
  }
  if (level >= 1) {
    if (spansOfKind(trace, "model_call").length === 0) problems.push("level 1 needs model calls");
    if (coverage.model_calls === "absent") problems.push("level 1 needs model_calls coverage");
  }
  if (level >= 2) {
    if (coverage.model_calls !== "measured") problems.push(`level 2 needs measured model calls, got ${coverage.model_calls}`);
    if (spansOfKind(trace, "tool_call").length > 0 && coverage.tools !== "measured") problems.push(`level 2 needs measured tools, got ${coverage.tools}`);
  }
  if (level === 0 && coverage.model_calls !== "absent") problems.push(`level 0 has no model calls, got ${coverage.model_calls}`);
  return { coverage, expected, problems };
}
