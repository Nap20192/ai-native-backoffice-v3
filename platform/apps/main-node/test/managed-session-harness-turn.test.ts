// main-node resolves a fresh harness for every turn. A harness with
// `dispose` is disposed with "shutdown" after the turn, so the next turn
// starts clean.

import { describe, expect, it } from "vitest";

import type { HarnessContext, HarnessInterface } from "@open-managed-agents/agent/harness/interface";

import { runHarnessForTurn } from "../src/lib/node-managed-harness-turn";

const ctx = {} as HarnessContext;

function fakeHarness(run: () => Promise<void>, dispose?: (reason?: string) => Promise<void>) {
  const calls: string[] = [];
  const harness = {
    run: async () => {
      calls.push("run");
      await run();
    },
    ...(dispose && {
      dispose: async (reason?: string) => {
        calls.push(`dispose:${reason}`);
        await dispose(reason);
      },
    }),
  } as unknown as HarnessInterface;
  return { harness, calls };
}

describe("runHarnessForTurn", () => {
  it("disposes the harness with reason shutdown after the turn", async () => {
    const { harness, calls } = fakeHarness(async () => {}, async () => {});
    await runHarnessForTurn(harness, ctx);
    expect(calls).toEqual(["run", "dispose:shutdown"]);
  });

  it("disposes after a failed turn and rethrows the turn error", async () => {
    const { harness, calls } = fakeHarness(
      async () => { throw new Error("turn failed"); },
      async () => { throw new Error("dispose failed"); },
    );
    const reported: unknown[] = [];
    await expect(runHarnessForTurn(harness, ctx, (error) => reported.push(error))).rejects.toThrow("turn failed");
    expect(calls).toEqual(["run", "dispose:shutdown"]);
    expect((reported[0] as Error).message).toBe("dispose failed");
  });

  it("reports a dispose failure without failing a completed turn", async () => {
    const reported: unknown[] = [];
    const { harness } = fakeHarness(async () => {}, async () => { throw new Error("dispose failed"); });
    await runHarnessForTurn(harness, ctx, (error) => reported.push(error));
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe("dispose failed");
  });

  it("runs a harness without dispose", async () => {
    const { harness, calls } = fakeHarness(async () => {});
    await runHarnessForTurn(harness, ctx);
    expect(calls).toEqual(["run"]);
  });
});
