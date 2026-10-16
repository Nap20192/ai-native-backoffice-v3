import { dump, JSON_SCHEMA } from "js-yaml";
import { canonicalJson } from "./canonical-json.js";

/** Both inputs must already have passed the response whitelist and secret scan. */
export function yamlDiff(before: unknown, after: unknown): { before_yaml: string; after_yaml: string; diff: string } {
  const yaml = (value: unknown) => dump(JSON.parse(canonicalJson(value)), {
    schema: JSON_SCHEMA, sortKeys: true, noRefs: true, lineWidth: -1,
  });
  const before_yaml = yaml(before);
  const after_yaml = yaml(after);
  if (before_yaml === after_yaml) return { before_yaml, after_yaml, diff: "" };
  const oldLines = before_yaml.trimEnd().split("\n");
  const newLines = after_yaml.trimEnd().split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let end = 0;
  while (end < oldLines.length - start && end < newLines.length - start && oldLines[oldLines.length - 1 - end] === newLines[newLines.length - 1 - end]) end++;
  const lines = [
    "--- before", "+++ after", `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.slice(0, start).map((line) => ` ${line}`),
    ...oldLines.slice(start, oldLines.length - end).map((line) => `-${line}`),
    ...newLines.slice(start, newLines.length - end).map((line) => `+${line}`),
    ...oldLines.slice(oldLines.length - end).map((line) => ` ${line}`),
  ];
  return { before_yaml, after_yaml, diff: lines.join("\n") + "\n" };
}
