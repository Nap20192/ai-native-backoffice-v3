// Write preconditions on the v1 edit routes (docs/plans/builder-agent.md,
// 2.5 step 8). A read or a write answers with `ETag: "<revision>"`. A write
// that carries `If-Match` with that value goes through only while the stored
// revision is the same. The header is optional, so clients that never send
// it keep the old behaviour.
import type { Context } from "hono";

export type RevisionPrecondition =
  | { type: "absent" }
  | { type: "revision"; revision: number }
  | { type: "invalid"; message: string };

/** `"<revision>"`, the strong entity tag of a stored revision. */
export function revisionETag(revision: number): string {
  return `"${revision}"`;
}

/** Sets `ETag` when the application returned a revision. */
export function setRevisionETag(c: Context, revision: number | undefined): void {
  if (revision !== undefined) c.header("ETag", revisionETag(revision));
}

/**
 * Reads `If-Match` as one stored revision. `*` and a missing header mean no
 * precondition. A weak tag, a list of tags or anything that is not a positive
 * integer is invalid: the route answers 400 and calls nothing.
 */
export function readRevisionIfMatch(header: string | undefined): RevisionPrecondition {
  if (header === undefined) return { type: "absent" };
  const value = header.trim();
  if (value === "*") return { type: "absent" };
  const match = /^(?:"([0-9]+)"|([0-9]+))$/u.exec(value);
  const digits = match?.[1] ?? match?.[2];
  const revision = digits === undefined ? Number.NaN : Number(digits);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return {
      type: "invalid",
      message: 'If-Match must be one revision from ETag, for example "3"',
    };
  }
  return { type: "revision", revision };
}

/** `{expectedRevision}` for a command, empty without a precondition. */
export function expectedRevisionOf(
  precondition: RevisionPrecondition,
): { expectedRevision?: number } {
  return precondition.type === "revision"
    ? { expectedRevision: precondition.revision }
    : {};
}
