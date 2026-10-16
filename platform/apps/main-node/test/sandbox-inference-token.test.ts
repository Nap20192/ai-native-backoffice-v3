// The sandbox inference token: a sealed, short-lived bearer that an ACP agent
// in the session VM presents to the hosted inference proxy of its session.

import { describe, expect, it, vi } from "vitest";

import { createNodeSecrets } from "../src/secrets";
import {
  SANDBOX_INFERENCE_CIPHER_PURPOSE,
  SANDBOX_INFERENCE_TOKEN_PREFIX,
  issueSandboxInferenceToken,
  resolveSandboxInferenceBearer,
  sandboxInferenceCipher,
  sandboxInferenceTokenTtlMs,
} from "../src/lib/sandbox-inference-token";

const secrets = createNodeSecrets(Buffer.alloc(32, 7).toString("base64"));
const cipher = secrets.cipherFor(SANDBOX_INFERENCE_CIPHER_PURPOSE);
const NOW = Date.parse("2026-10-16T10:00:00.000Z");

async function issue(overrides: Partial<Parameters<typeof issueSandboxInferenceToken>[0]> = {}) {
  return issueSandboxInferenceToken({
    cipher,
    workspaceId: "tn_1",
    sessionId: "ses_1",
    ttlMs: 20 * 60_000,
    now: NOW,
    ...overrides,
  });
}

describe("issueSandboxInferenceToken", () => {
  it("seals workspace, session and expiry behind the oma_sbx_ prefix", async () => {
    const token = await issue();

    expect(SANDBOX_INFERENCE_TOKEN_PREFIX).toBe("oma_sbx_");
    expect(token.startsWith("oma_sbx_")).toBe(true);
    expect(token.slice("oma_sbx_".length)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("tn_1");
    expect(token).not.toContain("ses_1");
    const sealed = Buffer.from(token.slice("oma_sbx_".length), "base64url").toString("utf8");
    expect(JSON.parse(await cipher.decrypt(sealed))).toEqual({
      v: 1,
      ws: "tn_1",
      ses: "ses_1",
      exp: NOW + 20 * 60_000,
    });
  });

  it("uses the managed.sandbox-inference cipher purpose", () => {
    expect(SANDBOX_INFERENCE_CIPHER_PURPOSE).toBe("managed.sandbox-inference");
    const purposes: string[] = [];
    sandboxInferenceCipher({
      cipherFor: (purpose) => {
        purposes.push(purpose);
        return cipher;
      },
    });
    expect(purposes).toEqual(["managed.sandbox-inference"]);
  });

  it.each([
    ["an empty workspace", { workspaceId: "" }],
    ["an empty session", { sessionId: "" }],
    ["a zero lifetime", { ttlMs: 0 }],
    ["a lifetime over six hours", { ttlMs: 6 * 60 * 60_000 + 1 }],
    ["a fractional lifetime", { ttlMs: 1.5 }],
  ])("refuses %s", async (_case, overrides) => {
    await expect(issue(overrides)).rejects.toThrow();
  });
});

describe("resolveSandboxInferenceBearer", () => {
  it("resolves the token of a session to its workspace and session", async () => {
    const token = await issue();

    await expect(resolveSandboxInferenceBearer({ cipher, token, now: NOW + 60_000 }))
      .resolves.toEqual({
        tenantId: "tn_1",
        credential: {
          type: "sandbox_inference",
          sessionId: "ses_1",
          expiresAt: "2026-10-16T10:20:00.000Z",
        },
      });
  });

  it("refuses an expired token", async () => {
    const token = await issue();

    await expect(resolveSandboxInferenceBearer({ cipher, token, now: NOW + 20 * 60_000 }))
      .resolves.toBeNull();
  });

  it("refuses a token sealed by another cipher", async () => {
    const token = await issue({ cipher: secrets.cipherFor("managed.environment-work.session-token") });
    const otherRoot = createNodeSecrets(Buffer.alloc(32, 9).toString("base64"))
      .cipherFor(SANDBOX_INFERENCE_CIPHER_PURPOSE);
    const fromOtherRoot = await issue({ cipher: otherRoot });

    await expect(resolveSandboxInferenceBearer({ cipher, token, now: NOW })).resolves.toBeNull();
    await expect(resolveSandboxInferenceBearer({ cipher, token: fromOtherRoot, now: NOW }))
      .resolves.toBeNull();
  });

  it("refuses a damaged token", async () => {
    const token = await issue();
    const body = token.slice("oma_sbx_".length);
    const flipped = `${body.slice(0, 20)}${body[20] === "A" ? "B" : "A"}${body.slice(21)}`;

    for (const damaged of [
      `oma_sbx_${flipped}`,
      `${token}x`,
      "oma_sbx_",
      "oma_sbx_not base64!",
      `oma_sbx_${Buffer.from("garbage").toString("base64url")}`,
    ]) {
      await expect(resolveSandboxInferenceBearer({ cipher, token: damaged, now: NOW }))
        .resolves.toBeNull();
    }
  });

  it("refuses sealed claims of the wrong shape", async () => {
    const seal = async (claims: unknown) =>
      `oma_sbx_${Buffer.from(await cipher.encrypt(JSON.stringify(claims))).toString("base64url")}`;

    for (const claims of [
      { v: 2, ws: "tn_1", ses: "ses_1", exp: NOW + 60_000 },
      { v: 1, ws: "", ses: "ses_1", exp: NOW + 60_000 },
      { v: 1, ws: "tn_1", ses: 1, exp: NOW + 60_000 },
      { v: 1, ws: "tn_1", ses: "ses_1", exp: "later" },
      ["tn_1", "ses_1"],
    ]) {
      await expect(resolveSandboxInferenceBearer({ cipher, token: await seal(claims), now: NOW }))
        .resolves.toBeNull();
    }
  });

  it("leaves a token without the prefix to the next resolver without decrypting", async () => {
    const decrypt = vi.fn(async (value: string) => value);

    for (const token of ["sk-ant-req-v1.abc", "workspace-key", "OMA_SBX_abc"]) {
      await expect(resolveSandboxInferenceBearer({
        cipher: { encrypt: async (value) => value, decrypt },
        token,
        now: NOW,
      })).resolves.toBeNull();
    }
    expect(decrypt).not.toHaveBeenCalled();
  });
});

describe("sandboxInferenceTokenTtlMs", () => {
  it("is the turn timeout plus fifteen minutes", () => {
    expect(sandboxInferenceTokenTtlMs(600_000)).toBe(600_000 + 15 * 60_000);
  });

  it("takes the default turn timeout of five minutes without one", () => {
    expect(sandboxInferenceTokenTtlMs(undefined)).toBe(300_000 + 15 * 60_000);
    expect(sandboxInferenceTokenTtlMs(null)).toBe(300_000 + 15 * 60_000);
    expect(sandboxInferenceTokenTtlMs(0)).toBe(300_000 + 15 * 60_000);
    expect(sandboxInferenceTokenTtlMs(-5)).toBe(300_000 + 15 * 60_000);
    expect(sandboxInferenceTokenTtlMs(Number.NaN)).toBe(300_000 + 15 * 60_000);
  });

  it("is never longer than six hours", () => {
    expect(sandboxInferenceTokenTtlMs(24 * 60 * 60_000)).toBe(6 * 60 * 60_000);
    expect(sandboxInferenceTokenTtlMs(Number.POSITIVE_INFINITY)).toBe(6 * 60 * 60_000);
  });

  it("gives a lifetime the issuer accepts", async () => {
    const token = await issue({ ttlMs: sandboxInferenceTokenTtlMs(24 * 60 * 60_000) });
    expect(token.startsWith("oma_sbx_")).toBe(true);
  });
});
