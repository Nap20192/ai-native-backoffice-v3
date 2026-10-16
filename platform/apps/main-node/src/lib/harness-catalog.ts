// Harness catalog for GET /v1/oma/harnesses (docs/plans/models-harness.md, 3).
// Built-in entries plus the workspace harness cards. The card store is a port:
// this file declares the structural card type and never imports the HC store.
import { OMA_OVERLAY_AGENTS, type KnownAgentEntry } from "@open-managed-agents/acp-runtime/known-agents";
import type { InferenceWireProtocol } from "@open-managed-agents/inference-proxy";
import { INFERENCE_PROTOCOLS } from "./acp-env-policy.js";

export type HarnessStatus = "ready" | "unverified" | "unavailable";
export type HarnessProtocol = InferenceWireProtocol | "*";

export interface HarnessAcpBlock {
  agent: {
    id: string;
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  per_turn_timeout_ms?: number;
}

export interface HarnessEntry {
  id: string;
  source: "builtin" | "card";
  label: string;
  status: HarnessStatus;
  reason: string | null;
  runtime_harness: "acp-sandbox" | null;
  protocols: HarnessProtocol[];
  supports: { effort: boolean; speed: boolean; platform_tools: boolean; mcp: boolean };
  acp: HarnessAcpBlock | null;
  install: { npm: string[]; pip: string[] };
  install_hint: string | null;
  allowed_env: string[] | null;
  card_id: string | null;
}

/** The fields of a harness card the catalog reads (HC owns the full type). */
export interface CatalogHarnessCard {
  id: string;
  harness_id: string;
  name: string;
  command: string;
  args: readonly string[];
  cwd: string | null;
  install: { npm: readonly string[]; pip: readonly string[] };
  protocols: readonly string[];
  allowed_env: readonly string[];
  status?: string;
  created_at: string | number;
  archived_at?: string | number | null;
}

export interface HarnessReadiness {
  /** PLATFORM_ROOT_SECRET of the server. */
  rootSecret: string | null | undefined;
  /** SANDBOX_GATEWAY_BASE_URL, or PUBLIC_BASE_URL when the first is empty. */
  gatewayBaseUrl: string | null | undefined;
  /** Resolved sandbox provider id, for example litebox or daytona. */
  sandboxProvider: string | null | undefined;
}

export interface HarnessCatalogDeps {
  /** Active cards of the workspace. Missing on MySQL: the catalog has no cards. */
  listHarnessCards?(workspaceId: string): Promise<readonly CatalogHarnessCard[]>;
  readiness: HarnessReadiness;
}

export type HarnessCompatibility =
  | { compatible: true; protocol: InferenceWireProtocol | null }
  | { compatible: false; reason: string };

export const ACP_SESSION_CWD = "/mnt/session/outputs";

/** Pinned package of the Claude Code adapter verified by W4. */
export const CLAUDE_AGENT_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp@0.91.0";

/** Русские подписи встроенных записей, копия строк C/pages/agents/harness-text.ts. */
export const HARNESS_RU_LABELS: Readonly<Record<string, string>> = {
  pi: "Встроенный цикл",
  "claude-acp": "Claude Code в песочнице",
  "codex-acp": "Codex в песочнице",
  gemini: "Gemini CLI в песочнице",
  opencode: "OpenCode в песочнице",
  "kimi-code": "Kimi Code в песочнице",
  "pi-acp": "Pi через ACP в песочнице",
  "ai-sdk": "AI SDK (устарел)",
};

/** Sandbox providers whose adapters implement spawnDuplexProcess. */
const ACP_SANDBOX_PROVIDERS: ReadonlySet<string> = new Set([
  "litebox",
  "boxlite",
  "e2b",
  "sprites",
  // NODE_ENV=test only (OPENMA_TEST_SANDBOX_PROVIDER=local-subprocess).
  "test-local-subprocess",
]);

const UNAVAILABLE_REASONS = {
  rootSecret: "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
  sandbox: "Песочница этого сервера не запускает ACP-агентов",
  gateway: "VM не знает адрес сервера: задайте SANDBOX_GATEWAY_BASE_URL",
} as const;

// Model protocols of the ACP agents with a model adapter. They repeat
// `supportedProtocols` in P/harness-inference-adapters/src/adapters/*.ts;
// main-node does not depend on that package.
const BUILTIN_ACP_PROTOCOLS: ReadonlyArray<readonly [string, InferenceWireProtocol[]]> = [
  ["claude-acp", ["anthropic-messages"]], // adapters/claude.ts
  ["codex-acp", ["openai-responses"]], // adapters/codex.ts
  ["gemini", ["gemini"]], // adapters/gemini.ts
  ["opencode", ["openai-chat"]], // adapters/opencode.ts
  ["kimi-code", ["openai-chat"]], // adapters/kimi.ts
  ["pi-acp", ["openai-chat"]], // adapters/pi.ts
];

/** Verified entries. Every other built-in ACP entry is unverified. */
const VERIFIED_BUILTIN_IDS: ReadonlySet<string> = new Set(["pi", "claude-acp"]);

const NO_PLATFORM_SUPPORT = { effort: false, speed: false, platform_tools: false, mcp: false };

// Permissions wrapper from the W4 recipe (docs/runbook-claude-code-sandbox.md, 3).
// acp-sandbox does not answer ACP permission requests, so Claude Code needs
// permissions.allow in settings.json to write files.
const CLAUDE_ACP_BLOCK: HarnessAcpBlock = {
  agent: {
    id: "claude-acp",
    command: "sh",
    args: [
      "-c",
      "mkdir -p \"$CLAUDE_CONFIG_DIR\" && printf '%s' \"$OMA_CLAUDE_SETTINGS\" > \"$CLAUDE_CONFIG_DIR/settings.json\" && exec claude-agent-acp",
    ],
    cwd: ACP_SESSION_CWD,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      OMA_CLAUDE_SETTINGS: "{\"permissions\":{\"allow\":[\"Read\",\"Write\",\"Edit\"]}}",
    },
  },
  per_turn_timeout_ms: 600_000,
};

const PI_ENTRY: HarnessEntry = {
  id: "pi",
  source: "builtin",
  label: "Pi agent-core",
  status: "ready",
  reason: null,
  runtime_harness: null,
  protocols: ["*"],
  supports: { effort: true, speed: true, platform_tools: true, mcp: true },
  acp: null,
  install: { npm: [], pip: [] },
  install_hint: null,
  allowed_env: null,
  card_id: null,
};

function knownAgent(id: string): KnownAgentEntry {
  const agent = OMA_OVERLAY_AGENTS.find((candidate) => candidate.id === id);
  if (agent === undefined) throw new Error(`known-agents has no ACP agent ${id}`);
  return agent;
}

function builtinAcpEntry(id: string, protocols: InferenceWireProtocol[]): HarnessEntry {
  const known = knownAgent(id);
  const npm = id === "claude-acp"
    ? [CLAUDE_AGENT_ACP_PACKAGE]
    : known.install?.kind === "npm" ? [known.install.package] : [];
  return {
    id,
    source: "builtin",
    label: known.label,
    status: VERIFIED_BUILTIN_IDS.has(id) ? "ready" : "unverified",
    reason: null,
    runtime_harness: "acp-sandbox",
    protocols: [...protocols],
    supports: { ...NO_PLATFORM_SUPPORT },
    acp: id === "claude-acp"
      ? structuredClone(CLAUDE_ACP_BLOCK)
      : {
          agent: {
            id,
            command: known.spec.command,
            args: [...(known.spec.args ?? [])],
            cwd: ACP_SESSION_CWD,
          },
        },
    install: { npm, pip: [] },
    install_hint: known.installHint ?? null,
    allowed_env: null,
    card_id: null,
  };
}

export const BUILTIN_HARNESSES: readonly HarnessEntry[] = Object.freeze([
  PI_ENTRY,
  ...BUILTIN_ACP_PROTOCOLS.map(([id, protocols]) => builtinAcpEntry(id, protocols)),
]);

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_HARNESSES.map((entry) => entry.id));

export function cardToHarnessEntry(card: CatalogHarnessCard): HarnessEntry {
  const protocols = INFERENCE_PROTOCOLS.filter((protocol) => card.protocols.includes(protocol));
  return {
    id: card.harness_id,
    source: "card",
    label: card.name,
    status: "unverified",
    reason: null,
    runtime_harness: "acp-sandbox",
    protocols,
    supports: { ...NO_PLATFORM_SUPPORT },
    acp: {
      agent: {
        id: card.harness_id,
        command: card.command,
        args: [...card.args],
        ...(card.cwd ? { cwd: card.cwd } : {}),
      },
    },
    install: { npm: [...card.install.npm], pip: [...card.install.pip] },
    install_hint: null,
    allowed_env: [...card.allowed_env],
    card_id: card.id,
  };
}

/** Why ACP entries cannot run on this server, or null when they can. */
export function acpUnavailableReason(readiness: HarnessReadiness): string | null {
  if (!readiness.rootSecret?.trim()) return UNAVAILABLE_REASONS.rootSecret;
  const provider = readiness.sandboxProvider?.trim().toLowerCase() ?? "";
  if (!ACP_SANDBOX_PROVIDERS.has(provider)) return UNAVAILABLE_REASONS.sandbox;
  if (!readiness.gatewayBaseUrl?.trim()) return UNAVAILABLE_REASONS.gateway;
  return null;
}

export async function listHarnesses(
  deps: HarnessCatalogDeps,
  workspaceId: string,
): Promise<HarnessEntry[]> {
  const cards = deps.listHarnessCards ? await deps.listHarnessCards(workspaceId) : [];
  const cardEntries = cards
    .filter((card) => card.archived_at === undefined || card.archived_at === null)
    .filter((card) => !BUILTIN_IDS.has(card.harness_id))
    .slice()
    .sort(newestCardFirst)
    .map(cardToHarnessEntry);
  const reason = acpUnavailableReason(deps.readiness);
  return [...BUILTIN_HARNESSES, ...cardEntries].map((entry) => {
    const copy = structuredClone(entry);
    if (copy.runtime_harness === "acp-sandbox" && reason !== null) {
      copy.status = "unavailable";
      copy.reason = reason;
    }
    return copy;
  });
}

function newestCardFirst(left: CatalogHarnessCard, right: CatalogHarnessCard): number {
  const byTime = timeOf(right.created_at) - timeOf(left.created_at);
  if (byTime !== 0) return byTime;
  return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
}

function timeOf(value: string | number): number {
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/** Harness part of an agent config: `_oma` of the API or `openma` of the domain. */
export interface AgentHarnessConfig {
  harness?: string | null;
  acp?: { agent?: { id?: string | null; command?: string } | null } | null;
}

/**
 * Harness key of an agent: `pi` for the built-in loop, `ai-sdk`, `acp-proxy`,
 * the ACP agent id for `acp-sandbox` (or `acp` without one), else the value.
 */
export function harnessKeyOf(config: AgentHarnessConfig | null | undefined): string {
  const harness = config?.harness;
  if (!harness || harness === "default" || harness === "pi") return "pi";
  if (harness === "acp-sandbox") return config?.acp?.agent?.id || "acp";
  return harness;
}

/** Russian label for a built-in entry, the card name for a card. */
export function harnessDisplayLabel(entry: Pick<HarnessEntry, "id" | "source" | "label">): string {
  if (entry.source === "card") return entry.label;
  return HARNESS_RU_LABELS[entry.id] ?? entry.label;
}

/** Model fields the protocol rule reads. */
export interface ProtocolModel {
  handle: string;
  protocols: readonly InferenceWireProtocol[];
}

/**
 * Section 3.3: `*` takes any model, an ACP entry takes a model whose protocols
 * intersect its own. The turn protocol is the first entry protocol the model
 * has. The entry status does not matter here.
 */
export function compatibility(
  entry: Pick<HarnessEntry, "id" | "source" | "label" | "protocols">,
  option: ProtocolModel,
): HarnessCompatibility {
  if (entry.protocols.includes("*")) {
    return { compatible: true, protocol: option.protocols[0] ?? null };
  }
  const protocol = entry.protocols.find(
    (candidate): candidate is InferenceWireProtocol =>
      candidate !== "*" && option.protocols.includes(candidate),
  );
  if (protocol !== undefined) return { compatible: true, protocol };
  const needed = entry.protocols.join(", ");
  const label = harnessDisplayLabel(entry);
  const tail = option.protocols.length > 0
    ? `у модели ${option.handle}: ${option.protocols.join(", ")}`
    : `у модели ${option.handle} нет протокола, который понимает прокси`;
  return {
    compatible: false,
    reason: `${label} работает только с моделями с протоколом ${needed}, ${tail}`,
  };
}
