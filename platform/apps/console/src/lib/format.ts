/**
 * Truncate a long ID like `agt_01ABCDEF...XYZ` to a few-char prefix +
 * ellipsis + suffix, used as a fallback label when the resource's
 * display name hasn't loaded yet. Better than rendering 30 chars of
 * opaque hex in a badge.
 */
export function shortenId(id: string | undefined): string {
  if (!id) return "–";
  if (id.length <= 12) return id;
  return id.slice(0, 8) + "…" + id.slice(-3);
}
