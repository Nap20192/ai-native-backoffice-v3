// Writes synthetic trace spans for pagination and load checks (plan section 6,
// trace.pagination and trace.perf). Refuses to run with NODE_ENV=production.
//
//   tsx scripts/seed-trace-spans.ts --db <sqlite file | postgres url> \
//     --workspace <id> --session <id> [--turns 1] [--spans 12000] [--updated-at <ms>]
//
// Every span of a run gets the same updated_at unless --updated-at is omitted,
// then it is the current time. Turns are written complete, one turn span and
// children of kind model_call, tool_call and tool_exec.
import { pathToFileURL } from "node:url";
import {
  createBetterSqlite3SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { spanIdFor, turnSpanIdFor } from "../src/lib/trace/ids.js";
import { ensureTraceSchema } from "../src/lib/trace/store.js";

export interface SeedTraceSpansInput {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  workspaceId: string;
  sessionId: string;
  turns: number;
  spansPerTurn: number;
  updatedAt?: number;
  startMs?: number;
}

export interface SeedTraceSpansResult {
  turnIds: string[];
  spans: number;
}

const COLUMNS = [
  "workspace_id", "session_id", "span_id", "parent_span_id", "turn_id", "attempt_id", "thread_id", "kind", "name",
  "source", "precision", "start_ms", "end_ms", "status", "harness", "model", "tool_name", "tool_call_id",
  "primary_event_id", "event_ids", "attrs", "version", "deleted", "updated_at",
];
const ROWS_PER_INSERT = 200;
const KINDS = ["model_call", "tool_call", "tool_exec"] as const;

export async function seedTraceSpans(input: SeedTraceSpansInput): Promise<SeedTraceSpansResult> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("seed-trace-spans refuses to write into a production database (NODE_ENV=production)");
  }
  await ensureTraceSchema(input.sql);
  const updatedAt = input.updatedAt ?? Date.now();
  const base = input.startMs ?? updatedAt - input.turns * input.spansPerTurn * 10 - 60_000;
  const turnIds: string[] = [];
  let spans = 0;
  for (let turn = 0; turn < input.turns; turn += 1) {
    const turnId = `sevt_seed_${String(turn).padStart(5, "0")}`;
    turnIds.push(turnId);
    const turnSpan = turnSpanIdFor(input.sessionId, turnId);
    const turnStart = base + turn * input.spansPerTurn * 10;
    const turnEnd = turnStart + input.spansPerTurn * 10;
    const rows: unknown[][] = [[
      input.workspaceId, input.sessionId, turnSpan, null, turnId, "attempt_seed", "sthr_primary", "turn", "agent",
      "events", "measured", turnStart, turnEnd, "ok", "pi", null, null, null, turnId, JSON.stringify([turnId]), "{}", 1, 0, updatedAt,
    ]];
    for (let index = 1; index < input.spansPerTurn; index += 1) {
      const kind = KINDS[index % KINDS.length]!;
      const key = `${turnId}:${index}`;
      const start = turnStart + index * 10;
      rows.push([
        input.workspaceId, input.sessionId, spanIdFor(input.sessionId, "events", kind, key), turnSpan, turnId, "attempt_seed",
        "sthr_primary", kind, kind === "model_call" ? "seed-model" : `seed_tool_${index % 7}`, "events", "measured",
        start, start + 8, "ok", "pi", kind === "model_call" ? "seed-model" : null,
        kind === "model_call" ? null : `seed_tool_${index % 7}`, kind === "model_call" ? null : `toolu_seed_${key}`,
        `sevt_seed_${key}`, JSON.stringify([`sevt_seed_${key}`]), "{}", 1, 0, updatedAt,
      ]);
    }
    for (let offset = 0; offset < rows.length; offset += ROWS_PER_INSERT) {
      const chunk = rows.slice(offset, offset + ROWS_PER_INSERT);
      const placeholders = chunk.map(() => `(${COLUMNS.map(() => "?").join(", ")})`).join(", ");
      await input.sql.prepare(
        `INSERT INTO trace_spans (${COLUMNS.join(", ")}) VALUES ${placeholders}
         ON CONFLICT (workspace_id, session_id, span_id) DO NOTHING`,
      ).bind(...chunk.flat()).run();
    }
    spans += rows.length;
    await input.sql.prepare(
      `INSERT INTO trace_turns (workspace_id, session_id, turn_id, thread_id, attempt_id, attempt_generation, state,
         frames_lost, lost, history_cursor, start_ms, end_ms, span_count, error_count, waiting_count, coverage, version, updated_at)
       VALUES (?, ?, ?, 'sthr_primary', 'attempt_seed', 1, 'complete', 0, '[]', NULL, ?, ?, ?, 0, 0, ?, 1, ?)
       ON CONFLICT (workspace_id, session_id, turn_id) DO NOTHING`,
    ).bind(
      input.workspaceId, input.sessionId, turnId, turnStart, turnEnd, rows.length,
      JSON.stringify({ model_calls: "measured", tools: "measured", sandbox: "attempts" }), updatedAt,
    ).run();
  }
  return { turnIds, spans };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const db = argument("db");
  const workspaceId = argument("workspace");
  const sessionId = argument("session");
  if (db === undefined || workspaceId === undefined || sessionId === undefined) {
    console.error("usage: seed-trace-spans --db <sqlite file | postgres url> --workspace <id> --session <id> [--turns 1] [--spans 12000] [--updated-at <ms>]");
    process.exit(2);
  }
  const postgres = db.startsWith("postgres://") || db.startsWith("postgresql://");
  const sql = postgres ? await createPostgresSqlClient(db) : await createBetterSqlite3SqlClient(db);
  const result = await seedTraceSpans({
    sql,
    dialect: postgres ? "postgres" : "sqlite",
    workspaceId,
    sessionId,
    turns: Number(argument("turns") ?? 1),
    spansPerTurn: Number(argument("spans") ?? 12_000),
    ...(argument("updated-at") !== undefined && { updatedAt: Number(argument("updated-at")) }),
  });
  console.log(JSON.stringify(result));
  if (postgres) await (sql as unknown as { sql: { end(options?: { timeout?: number }): Promise<void> } }).sql.end({ timeout: 5 });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
