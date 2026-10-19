// The platform cipher moved from @open-managed-agents/integrations-adapters-node
// into main-node (docs/plans/cleanup.md, 5.1). Values sealed before the move
// must still open: the ciphertexts below were produced by the old package
// with the same secret and labels.

import { describe, expect, it } from "vitest";
import { WebCryptoAesGcm } from "../src/lib/web-crypto-aes-gcm";

const SECRET = "fixture-root-secret-0123456789abcdef"; // gitleaks:allow (fixed fake test secret)
const SEALED_BY_OLD_PACKAGE = {
  purpose: "7dEd1Oxk1OKELRxEylBe4Gskh4oCl6b-J5kEkgFIsQ6ziUHMjVjbe9tnMt6a5I2fNVc",
  defaultLabel: "npfWDjSwr5KWuT2tHpCvH531a3n4umDOYq_rOlwXXY_BrZGGT9-Mds4",
};

describe("WebCryptoAesGcm", () => {
  it("opens values sealed by the old integrations package", async () => {
    const purpose = new WebCryptoAesGcm(SECRET, "managed.vault.credentials");
    expect(await purpose.decrypt(SEALED_BY_OLD_PACKAGE.purpose)).toBe("sealed before the move");
    const byDefault = new WebCryptoAesGcm(SECRET);
    expect(await byDefault.decrypt(SEALED_BY_OLD_PACKAGE.defaultLabel)).toBe("default label");
  });

  it("round-trips with a fresh IV and keeps labels apart", async () => {
    const a = new WebCryptoAesGcm(SECRET, "a");
    const first = await a.encrypt("hello");
    const second = await a.encrypt("hello");
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await a.decrypt(first)).toBe("hello");
    await expect(new WebCryptoAesGcm(SECRET, "b").decrypt(first)).rejects.toThrow();
  });

  it("rejects an empty secret and a too short ciphertext", async () => {
    expect(() => new WebCryptoAesGcm("")).toThrow(/secret must be non-empty/);
    await expect(new WebCryptoAesGcm(SECRET).decrypt("AAAA")).rejects.toThrow(/too short/);
  });
});
