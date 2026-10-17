import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@open-managed-agents/api-types";
import { PiHarness } from "../src/harness/pi-loop";
import { registerCoreHarnesses } from "../src/harness/builtins";
import { agentUsesAssemblySkillMount } from "../src/harness/assembly/skill-config";
import {
  HarnessLease,
  isPiHarnessName,
  registerHarness,
  resolveHarness,
} from "../src/harness/registry";

describe("production harness composition", () => {
  it("uses Pi as the default harness", () => {
    registerCoreHarnesses();
    expect(resolveHarness()).toBeInstanceOf(PiHarness);
    expect(resolveHarness("default")).toBeInstanceOf(PiHarness);
    expect(resolveHarness("pi")).toBeInstanceOf(PiHarness);
  });

  it("runs agents stored with a removed harness on Pi and warns once per name", () => {
    registerCoreHarnesses();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const name of ["ai-sdk", "acp-sandbox", "acp-proxy", "ai-sdk"]) {
        expect(resolveHarness(name)).toBeInstanceOf(PiHarness);
      }
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
    }
  });

  it("still refuses an unknown harness name", () => {
    registerCoreHarnesses();
    expect(() => resolveHarness("no-such-harness")).toThrow(/Unknown harness/);
  });

  it("mounts skills the Pi way for an agent stored with a removed harness", () => {
    for (const harness of [undefined, "", "default", "pi", "ai-sdk", "acp-sandbox", "acp-proxy"]) {
      expect(isPiHarnessName(harness), String(harness)).toBe(true);
      expect(agentUsesAssemblySkillMount({ harness } as AgentConfig), String(harness)).toBe(true);
    }
    expect(isPiHarnessName("no-such-harness")).toBe(false);
    expect(agentUsesAssemblySkillMount({ harness: "no-such-harness" } as AgentConfig)).toBe(false);
  });

  it("reuses a session harness and disposes it when the binding changes", async () => {
    const disposed: string[] = [];
    let instance = 0;
    registerHarness("lease-test", () => {
      const id = ++instance;
      return {
        run: async () => {},
        dispose: async (reason) => { disposed.push(`${id}:${reason}`); },
      };
    });
    const lease = new HarnessLease();

    const first = await lease.resolve("agent:v1", "lease-test");
    const second = await lease.resolve("agent:v1", "lease-test");
    const replacement = await lease.resolve("agent:v2", "lease-test");

    expect(second).toBe(first);
    expect(replacement).not.toBe(first);
    expect(disposed).toEqual(["1:replace"]);

    await lease.dispose("shutdown");
    expect(disposed).toEqual(["1:replace", "2:shutdown"]);
  });
});
