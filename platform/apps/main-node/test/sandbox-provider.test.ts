import { describe, expect, it } from "vitest";

import {
  SANDBOX_PROVIDER_PATHS,
  resolveSandboxProviderForEnvironment,
  resolveSandboxProviderModule,
} from "../src/sandbox-provider";

describe("main-node sandbox provider selection", () => {
  it("resolves supported isolated providers", () => {
    expect(resolveSandboxProviderModule(" LiteBox ")).toEqual({
      provider: "litebox",
      modulePath: "@open-managed-agents/sandbox-adapter-litebox",
    });
    expect(resolveSandboxProviderModule("boxlite")).toEqual({
      provider: "boxlite",
      modulePath: "@open-managed-agents/sandbox-adapter-litebox",
    });
  });

  // The upstream adapters were removed (docs/plans/cleanup.md, 4.4): a stale
  // SANDBOX_PROVIDER must fail at startup instead of loading a missing module.
  it.each(["e2b", "daytona", "boxrun", "sprites"])(
    "rejects the removed provider %s",
    (provider) => {
      expect(SANDBOX_PROVIDER_PATHS).not.toHaveProperty(provider);
      expect(() => resolveSandboxProviderModule(provider)).toThrow(
        new RegExp(`SANDBOX_PROVIDER=${provider} not recognized`),
      );
    },
  );

  it.each([undefined, "", "   "])(
    "requires an explicit provider (%s)",
    (provider) => {
      expect(() => resolveSandboxProviderModule(provider)).toThrow(
        /SANDBOX_PROVIDER is required/,
      );
    },
  );

  it.each(["subprocess", " SubProcess "])(
    "rejects the non-isolated subprocess adapter (%s)",
    (provider) => {
      expect(() => resolveSandboxProviderModule(provider)).toThrow(
        /subprocess.*test-only/i,
      );
    },
  );

  it("does not expose subprocess as a production provider", () => {
    expect(SANDBOX_PROVIDER_PATHS).not.toHaveProperty("subprocess");
  });

  it("allows the deterministic local adapter only through the test-only selector", () => {
    expect(resolveSandboxProviderForEnvironment({
      NODE_ENV: "test",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    })).toEqual({
      provider: "test-local-subprocess",
      modulePath: "@open-managed-agents/sandbox/adapters/local-subprocess",
    });
    expect(() => resolveSandboxProviderForEnvironment({
      NODE_ENV: "production",
      OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
      SANDBOX_PROVIDER: "litebox",
    })).toThrow(/test-only/i);
  });

  it("lists the isolated providers when selection is invalid", () => {
    expect(() => resolveSandboxProviderModule("unknown")).toThrow(
      /valid: litebox, boxlite$/,
    );
  });
});
