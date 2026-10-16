import { Buffer } from "node:buffer";
import { canonicalJson } from "./canonical-json.js";

const MASK = "[скрыто]";
const KEY_PATTERNS = [
  /\b(?:sk-|ghp_|github_pat_|xox[a-z]?-)[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g,
  /-----BEGIN[^\r\n]*/g,
  /[A-Za-z0-9+/_-]{64,}={0,2}/g,
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Call on each string value before serialization, then on the serialized text.
 * Always mask before truncating. masked_count counts merged matching spans. */
export function scanSecrets(text: string, knownSecrets: Iterable<string> = []): { text: string; masked_count: number } {
  const secrets = [...new Set(knownSecrets)].filter(Boolean);
  const spans: { start: number; end: number }[] = [];
  const add = (start: number, length: number) => spans.push({ start, end: start + length });
  for (const pattern of KEY_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) add(match.index!, match[0].length);
  }
  // JSON whitespace changes the encoded header prefix, so inspect the header.
  for (const match of text.matchAll(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
    try {
      const header = JSON.parse(Buffer.from(match[0].split(".")[0]!, "base64url").toString("utf8"));
      if (header && typeof header.alg === "string") add(match.index!, match[0].length);
    } catch {
      // Dotted prose is not a JWT.
    }
  }
  for (const secret of secrets) {
    // Serialized JSON escapes quotes, backslashes and control characters, so
    // the value is also looked for in its escaped form.
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      let position = text.indexOf(form);
      while (position !== -1) {
        add(position, form.length);
        position = text.indexOf(form, position + 1);
      }
    }
    // URI encoding can fail on lone UTF-16 surrogates; literal matching still applies.
    let encoded: string;
    try { encoded = encodeURIComponent(secret); } catch { continue; }
    for (const form of new Set([encoded, encoded.replaceAll("%20", "+")])) {
      const pattern = escapeRegex(form).replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
        "%" + [...hex].map((digit) => /[A-F]/.test(digit) ? `[${digit}${digit.toLowerCase()}]` : digit).join(""));
      for (const match of text.matchAll(new RegExp(pattern, "g"))) add(match.index!, match[0].length);
    }
  }
  const bytes = secrets.map((secret) => Buffer.from(secret, "utf8"));
  if (bytes.length) {
    for (const match of text.matchAll(/[A-Za-z0-9+/_-]{4,}={0,2}/g)) {
      for (let offset = 0; offset < 4; offset++) {
        const decoded = Buffer.from(match[0].slice(offset), "base64");
        if (bytes.some((secret) => decoded.includes(secret))) {
          add(match.index!, match[0].length);
          break;
        }
      }
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof spans = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  let cursor = 0;
  const parts: string[] = [];
  for (const span of merged) {
    parts.push(text.slice(cursor, span.start), MASK);
    cursor = span.end;
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), masked_count: merged.length };
}

/** Returns a new JSON tree, so quote/backslash escaping cannot hide a value. */
export function scanSecretValues(value: unknown, knownSecrets: Iterable<string> = []): { value: unknown; masked_count: number } {
  const secrets = [...knownSecrets];
  let masked_count = 0;
  function visit(item: unknown): unknown {
    if (typeof item === "string") {
      const scanned = scanSecrets(item, secrets);
      masked_count += scanned.masked_count;
      return scanned.text;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item !== null && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, visit(nested)]));
    return item;
  }
  return { value: visit(JSON.parse(canonicalJson(value))), masked_count };
}
