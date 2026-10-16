import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/lib/platform-mcp/url-redact.js";

describe("redactUrl", () => {
  it("returns the public URL and all removed secret components", () => {
    const result = redactUrl("https://alice:p%40ss@example.com:8443/mcp?k=a+b&k=%2f%3D&empty=#frag%20ment");
    expect(result.url).toBe("https://example.com:8443/mcp");
    expect(result.secrets).toEqual(expect.arrayContaining([
      "alice", "p@ss", "alice:p@ss", "k=a+b&k=%2f%3D&empty=", "a b", "/=", "frag ment",
    ]));
    expect(result.secrets).not.toContain("");
  });
  it("preserves a public address", () => {
    expect(redactUrl("https://example.com/mcp")).toEqual({ url: "https://example.com/mcp", secrets: [] });
  });
  it.each(["not a URL?token=private", "//user:pass@example.com", "javascript:secret", "data:text/plain,secret", "https://%zz:pass@example.com"]) (
    "fails closed for invalid or non-HTTP URLs", (url) => expect(redactUrl(url).url).toBe("[скрыто]"),
  );
  it("keeps encoded and decoded forms for scanning", () => {
    expect(redactUrl("https://a%20b:p%2Fq@example.com/?token=x%2Fy#z%2Bw").secrets)
      .toEqual(expect.arrayContaining(["a%20b", "a b", "p%2Fq", "p/q", "a%20b:p%2Fq", "a b:p/q", "x/y", "z+w"]));
  });
});
