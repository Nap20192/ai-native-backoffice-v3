import type { HarnessContext, HarnessInterface } from "@open-managed-agents/agent/harness/interface";

/**
 * One turn on a harness resolved for that turn. main-node has no session-
 * scoped harness owner (upstream's HarnessLease lives in the Durable Object
 * runtime), so a stateful harness is disposed after its turn: acp-sandbox
 * otherwise keeps its ACP agent process alive in the sandbox and every turn
 * starts one more. "shutdown" keeps the native ACP session and its checkpoint
 * in the sandbox, so the next turn resumes it (session/resume or load).
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
