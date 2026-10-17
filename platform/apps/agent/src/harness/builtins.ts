import { PiHarness } from "./pi-loop";
import { registerHarness } from "./registry";

/**
 * Register the only harness the platform runs: the Pi agent-core loop.
 * `default` and `pi` are two names for it. Legacy names stored on old
 * agents are mapped to `default` by resolveHarness (registry.ts).
 */
export function registerCoreHarnesses(): void {
  registerHarness("default", () => new PiHarness());
  registerHarness("pi", () => new PiHarness());
}
