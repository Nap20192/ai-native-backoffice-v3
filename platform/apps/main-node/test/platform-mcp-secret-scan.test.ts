import { describe, expect, it } from "vitest";
import { scanSecrets, scanSecretValues } from "../src/lib/platform-mcp/secret-scan.js";
import { AGENT_TEMPLATES } from "../../console/src/data/templates.js";

describe("scanSecrets", () => {
  it.each([
    "sk-1234567890abcdefghijkl", "ghp_1234567890abcdefghijkl", "github_pat_1234567890abcdefghijkl",
    "xoxb-1234567890-abcdefghijkl", "AKIAIOSFODNN7EXAMPLE",
    "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
    Buffer.from("Some long opaque credential that must be hidden in full.").toString("base64"),
  ])("masks key patterns: %s", (secret) => {
    expect(scanSecrets(`(${secret})`)).toEqual({ text: "([скрыто])", masked_count: 1 });
  });
  it("does not flag template prompts with an empty set", () => {
    for (const template of AGENT_TEMPLATES) {
      expect(scanSecrets(template.system, [])).toEqual({ text: template.system, masked_count: 0 });
    }
  });
  it("recognizes JWT headers with legal JSON whitespace", () => {
    const header = Buffer.from('{\n  "alg": "HS256"\n}').toString("base64url");
    const jwt = `${header}.eyJzdWIiOiIxIn0.c2lnbmF0dXJl`;
    expect(scanSecrets(`(${jwt})`).text).toBe("([скрыто])");
    expect(scanSecrets("version.one.two").masked_count).toBe(0);
  });
  it("finds every nonempty known value as a substring, including one character", () => {
    expect(scanSecrets("abc abc", ["", "b"])).toEqual({ text: "a[скрыто]c a[скрыто]c", masked_count: 2 });
    expect(scanSecrets("prefix short suffix", ["short"]).text).toBe("prefix [скрыто] suffix");
    expect(scanSecrets("abcdef", ["abc", "abcdef", "def"]).masked_count).toBe(1);
  });
  it("handles URL encoding, hex case and form spaces", () => {
    for (const value of ["a b/+?", 'quote"\\slash', "секрет"]) {
      const encoded = encodeURIComponent(value);
      for (const form of [encoded, encoded.toLowerCase(), encoded.replaceAll("%20", "+")]) {
        expect(scanSecrets(`(${form})`, [value]).text).toBe("([скрыто])");
      }
    }
  });
  it("decodes base64 and base64url at every byte and character alignment", () => {
    for (const secret of ["!", "p@ss", "секрет", 'a"\\b']) {
      for (let bytes = 0; bytes < 3; bytes++) {
        for (let chars = 0; chars < 4; chars++) {
          for (const encoding of ["base64", "base64url"] as const) {
            const encoded = "A".repeat(chars) + Buffer.from("x".repeat(bytes) + secret + "end").toString(encoding);
            expect(scanSecrets(`(${encoded})`, [secret]).text).toBe("([скрыто])");
          }
        }
      }
    }
  });
  it("masks nested string values before JSON escaping and then the final text", () => {
    const secret = 'short"\\value';
    const input = { system: secret, metadata: ["prefix " + secret], n: 1 };
    const result = scanSecretValues(input, [secret]);
    expect(result).toEqual({ value: { system: "[скрыто]", metadata: ["prefix [скрыто]"], n: 1 }, masked_count: 2 });
    expect(input.system).toBe(secret);
    expect(scanSecrets(JSON.stringify(result.value), [secret]).text).not.toContain("short");
  });
  it("masks a known value inside already serialized JSON, where quotes and backslashes are escaped", () => {
    for (const secret of ['pa"ss\\word1', "tab\there\nline", 'only"quote']) {
      const text = JSON.stringify({ config: { password: secret }, list: [`prefix ${secret}`] });
      const result = scanSecrets(text, [secret]);
      expect(result.masked_count, secret).toBe(2);
      expect(JSON.parse(result.text)).toEqual({ config: { password: "[скрыто]" }, list: ["prefix [скрыто]"] });
    }
  });
});
