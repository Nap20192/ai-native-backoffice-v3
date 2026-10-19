import { describe, expect, it } from "vitest";
import { shortenId } from "./format";

describe("shortenId", () => {
  it("returns en-dash when id is missing", () => {
    expect(shortenId(undefined)).toBe("–");
  });
  it("passes through short ids unchanged", () => {
    expect(shortenId("abc")).toBe("abc");
  });
  it("truncates long ids with prefix + ellipsis + suffix", () => {
    expect(shortenId("agt_01ABCDEFGHIJKLMXYZ")).toBe("agt_01AB…XYZ");
  });
});
