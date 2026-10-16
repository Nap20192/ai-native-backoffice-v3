/** Opaque trace cursors: base64url of JSON with the sort key (plan section 3.2). */

export class TraceCursorError extends Error {
  constructor(message = "Invalid trace cursor") {
    super(message);
    this.name = "TraceCursorError";
  }
}

export type TraceCursorValue = string | number | string[];

export function encodeCursor(value: Record<string, TraceCursorValue>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Decodes any cursor. Callers read the fields they need through the typed readers below. */
export function decodeCursor(text: string): Record<string, unknown> {
  if (text.length === 0 || text.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(text)) throw new TraceCursorError();
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TraceCursorError();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof TraceCursorError) throw error;
    throw new TraceCursorError();
  }
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) throw new TraceCursorError();
  return field;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new TraceCursorError();
  return field;
}

/** Change feed position: spans by (updated_at, span_id), turn summaries by (updated_at, turn_id). */
export interface ChangesCursor {
  u: number;
  s: string;
  tu: number;
  tt: string;
}

export function readChangesCursor(text: string): ChangesCursor {
  const value = decodeCursor(text);
  return { u: numberField(value, "u"), s: stringField(value, "s"), tu: numberField(value, "tu"), tt: stringField(value, "tt") };
}

/** Span page position by (start_ms, span_id) inside a fixed set of turns. */
export interface SpansCursor {
  turns: string[];
  m: number;
  s: string;
}

export function readSpansCursor(text: string): SpansCursor {
  const value = decodeCursor(text);
  const turns = value.turns;
  if (!Array.isArray(turns) || turns.length === 0 || turns.length > 50 || !turns.every((turn) => typeof turn === "string")) {
    throw new TraceCursorError();
  }
  return { turns: turns as string[], m: numberField(value, "m"), s: stringField(value, "s") };
}

/** Older turn summaries: everything before (start_ms, turn_id). */
export interface TurnsCursor {
  m: number;
  t: string;
}

export function readTurnsCursor(text: string): TurnsCursor {
  const value = decodeCursor(text);
  return { m: numberField(value, "m"), t: stringField(value, "t") };
}

/** Search position by (start_ms, span_id). */
export function readSearchCursor(text: string): { m: number; s: string } {
  const value = decodeCursor(text);
  return { m: numberField(value, "m"), s: stringField(value, "s") };
}
