import { encodeCursor } from "./cursor.js";
import type { TraceExecutionsReader } from "./executions-reader.js";
import type { TraceRepair } from "./repair.js";
import type { TraceStore } from "./store.js";
import type { TraceScope, TraceSpanKind } from "./types.js";

/**
 * Search over all turns of a session (plan section 3.2): name, tool, model,
 * span id, event ids and error text. Turns without a stored trace are built
 * first, newest first, within a time budget; the answer says how many remain.
 */
export interface TraceSearchMatch {
  span_id: string;
  turn_id: string | null;
  kind: TraceSpanKind;
  name: string;
}

export interface TraceSearchResult {
  matches: TraceSearchMatch[];
  next: string | null;
  remaining_turns: number;
}

export interface TraceSearchDependencies {
  store: TraceStore;
  repair: TraceRepair;
  executions: TraceExecutionsReader;
}

export async function searchTrace(
  dependencies: TraceSearchDependencies,
  scope: TraceScope,
  input: { query: string; after: { m: number; s: string } | null; limit: number; budgetMs: number },
): Promise<TraceSearchResult> {
  const started = performance.now();
  const rows = new Map((await dependencies.store.readTurns(scope)).map((row) => [row.turn_id, row]));
  const pending = (await dependencies.executions.list(scope))
    .filter((execution) => dependencies.repair.needsRepair(rows.get(execution.id) ?? null, execution))
    .reverse();
  let remaining = pending.length;
  for (const execution of pending) {
    if (performance.now() - started >= input.budgetMs) break;
    await dependencies.repair.repairTurn(scope, execution);
    remaining -= 1;
  }
  const found = await dependencies.store.search(scope, input.query, input.after, input.limit + 1);
  const page = found.slice(0, input.limit);
  const last = page.at(-1);
  return {
    matches: page.map((span) => ({ span_id: span.span_id, turn_id: span.turn_id, kind: span.kind, name: span.name })),
    next: found.length > input.limit && last !== undefined ? encodeCursor({ m: last.start_ms, s: last.span_id }) : null,
    remaining_turns: remaining,
  };
}
