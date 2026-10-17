import type { HarnessDisposeReason, HarnessInterface } from "./interface";

type HarnessFactory = () => HarnessInterface;

const registry = new Map<string, HarnessFactory>();

/** Harness names of removed loops (AI SDK loop and the ACP harnesses).
 * Agents stored with one of them keep running on the default Pi harness. */
const LEGACY_HARNESS_NAMES: ReadonlySet<string> = new Set([
  "ai-sdk",
  "acp-sandbox",
  "acp-proxy",
]);

const warnedLegacyNames = new Set<string>();

/** True when the name runs the Pi loop: unset, `default`, `pi` or a legacy
 * name that resolveHarness maps to Pi. Code that picks Pi-only behaviour
 * (skill mounting) checks this, so an old agent gets what a Pi agent gets. */
export function isPiHarnessName(name?: string | null): boolean {
  return !name || name === "default" || name === "pi" || LEGACY_HARNESS_NAMES.has(name);
}

export function registerHarness(name: string, factory: HarnessFactory) {
  registry.set(name, factory);
}

export function resolveHarness(name?: string): HarnessInterface {
  let key = name || "default";
  if (!registry.has(key) && LEGACY_HARNESS_NAMES.has(key)) {
    if (!warnedLegacyNames.has(key)) {
      warnedLegacyNames.add(key);
      console.warn(
        `[harness] "${key}" was removed; the agent runs on the default Pi harness`,
      );
    }
    key = "default";
  }
  const factory = registry.get(key);
  if (!factory) {
    throw new Error(`Unknown harness: "${key}". Registered: ${[...registry.keys()].join(", ")}`);
  }
  return factory();
}

/** Session-scoped harness owner. A harness instance is kept across turns of
 * one agent version; an agent version or harness change disposes the old
 * instance before activating the replacement. */
export class HarnessLease {
  #active: { key: string; harness: HarnessInterface } | null = null;

  async resolve(key: string, name?: string): Promise<HarnessInterface> {
    if (this.#active?.key === key) return this.#active.harness;
    await this.dispose("replace");
    const harness = resolveHarness(name);
    this.#active = { key, harness };
    return harness;
  }

  async dispose(reason: HarnessDisposeReason = "destroy"): Promise<void> {
    const active = this.#active;
    this.#active = null;
    await active?.harness.dispose?.(reason);
  }
}
