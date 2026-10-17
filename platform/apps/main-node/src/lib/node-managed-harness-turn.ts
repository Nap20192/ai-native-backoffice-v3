import type { HarnessContext, HarnessInterface } from "@open-managed-agents/agent/harness/interface";

/**
 * One turn on a harness resolved for that turn. main-node has no session-
 * scoped harness owner (upstream's HarnessLease lives in the Durable Object
 * runtime), so a harness with `dispose` is disposed with "shutdown" after its
 * turn and the next turn starts clean.
 *
 * A dispose failure is reported, not thrown: it must neither fail a completed
 * turn nor replace the turn's own error.
 */
export async function runHarnessForTurn(
  harness: HarnessInterface,
  ctx: HarnessContext,
  onDisposeError: (error: unknown) => void = () => {},
): Promise<void> {
  let turnError: unknown;
  let failed = false;
  try {
    await harness.run(ctx);
  } catch (error) {
    failed = true;
    turnError = error;
  }
  try {
    await harness.dispose?.("shutdown");
  } catch (error) {
    onDisposeError(error);
  }
  if (failed) throw turnError;
}
