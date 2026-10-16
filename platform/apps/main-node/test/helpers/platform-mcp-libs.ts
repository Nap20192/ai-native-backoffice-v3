// Test doubles of the BX2 helpers (canonical JSON, scanner, URL redaction,
// YAML diff, skill spec, docs search). BS3 wires the real ones.

import type { PlatformMcpLibs } from "../../src/lib/platform-mcp/ports";

const MASK = "[скрыто]";
const KEY_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /xox[abprs]-[A-Za-z0-9-]{8,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN[^-]*-----/g,
];

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function variants(value: string): string[] {
  const encoded = encodeURIComponent(value);
  return [...new Set([value, JSON.stringify(value).slice(1, -1), encoded,encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), encoded.replace(/%20/g, "+")])];
}

function maskBase64(text: string, known: readonly string[]): { text: string; count: number } {
  let count = 0;
  const out = text.replace(/[A-Za-z0-9+/_-]{4,}={0,2}/g, (run) => {
    for (let shift = 0; shift < 4; shift++) {
      const decoded = Buffer.from(run.slice(shift).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
      if (known.some((value) => value.length > 0 && decoded.includes(Buffer.from(value).toString("latin1")))) {
        count++;
        return MASK;
      }
    }
    return run;
  });
  return { text: out, count };
}

export const testLibs: PlatformMcpLibs = {
  canonicalJson,
  scan(text, known) {
    let count = 0;
    let out = text;
    const values = [...known].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
    for (const value of values) {
      for (const variant of variants(value)) {
        const parts = out.split(variant);
        if (parts.length > 1) {
          count += parts.length - 1;
          out = parts.join(MASK);
        }
      }
    }
    if (values.length > 0) {
      const b64 = maskBase64(out, values.filter((value) => value.length >= 3));
      out = b64.text;
      count += b64.count;
    }
    for (const pattern of KEY_PATTERNS) {
      out = out.replace(pattern, () => {
        count++;
        return MASK;
      });
    }
    return { text: out, count };
  },
  hasKeyPattern(text) {
    return KEY_PATTERNS.some((pattern) => new RegExp(pattern.source).test(text));
  },
  redactUrl(url) {
    try {
      const parsed = new URL(url);
      const secrets: string[] = [];
      if (parsed.username) secrets.push(decodeURIComponent(parsed.username));
      if (parsed.password) secrets.push(decodeURIComponent(parsed.password));
      for (const [, value] of parsed.searchParams) if (value) secrets.push(value);
      if (parsed.hash.length > 1) secrets.push(parsed.hash.slice(1));
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return { url: parsed.toString(), secrets };
    } catch {
      return { url: MASK, secrets: [url] };
    }
  },
  yamlDiff(before, after) {
    const a = before.split("\n");
    const b = after.split("\n");
    const lines: string[] = [];
    for (const line of a) if (!b.includes(line)) lines.push(`- ${line}`);
    for (const line of b) if (!a.includes(line)) lines.push(`+ ${line}`);
    return lines.join("\n");
  },
  checkSkill(files) {
    const skill = files.find((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"));
    if (!skill) return { ok: false, errors: ["нет файла SKILL.md"] };
    if (!/^---\n[\s\S]*name:\s*\S+[\s\S]*\n---/.test(skill.content)) return { ok: false, errors: ["нет поля name во frontmatter"] };
    return { ok: true, errors: [] };
  },
  searchDocs(query, limit) {
    const docs = [
      { document: "platform-reference.md", heading: "Окружение", text: "Окружение задаёт сеть и пакеты песочницы." },
      { document: "writing-skills.md", heading: "Навык", text: "Файл SKILL.md начинается с frontmatter." },
    ];
    const q = query.toLowerCase();
    return docs.filter((doc) => `${doc.heading} ${doc.text}`.toLowerCase().includes(q)).slice(0, limit);
  },
};
