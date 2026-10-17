// Wiring of models and harness into main-node (docs/plans/models-harness.md,
// unit WIRE). node-http.ts and node-managed.ts call these functions; the
// logic stays here so the shared modules change only by a few lines.
//
// - createModelsHarnessWiring: harness card store (none on MySQL), catalog of
//   models and harnesses, readiness of ACP entries (3.2).
// - buildHarnessCardRoutesFor: /v1/oma/harness_cards, or 501 on MySQL.
// - agentForGuard: the stored agent in the shape agentConfigGuard reads.
// - prepareAcpTurnInference: section 5.8, what an acp-sandbox turn needs to
//   reach its model through the inference proxy.
// - acpTurnAgent: the agent config of that turn, without model keys in env.
// - acpTurnEnv: the inference of that turn for HarnessContext.env.
import { Hono } from "hono";
import { resolveOverlayAgent } from "@open-managed-agents/acp-runtime/known-agents";
import {
  resolveProtocolEndpointsFromModelCard,
  type InferenceWireProtocol,
} from "@open-managed-agents/inference-proxy";
import type { SqlClient } from "@open-managed-agents/sql-client";

import type { NodeConfig } from "../config.js";
import { resolveSandboxProviderForEnvironment } from "../sandbox-provider.js";
import { createWorkspaceCatalog, type WorkspaceCatalog } from "./catalog-routes.js";
import {
  acpUnavailableReason,
  BUILTIN_HARNESSES,
  cardToHarnessEntry,
  harnessDisplayLabel,
  type HarnessEntry,
  type HarnessReadiness,
} from "./harness-catalog.js";
import { MODEL_KEY_ENV_NAMES } from "./acp-env-policy.js";
import {
  buildHarnessCardRoutes,
  createHarnessCardStore,
  type HarnessCardDependencyCheck,
  type HarnessCardStore,
} from "./harness-cards/index.js";
import type { ModelOptionCard } from "./model-options.js";
import {
  buildSandboxHostedInference,
  cardInferenceEnv,
  resolveSandboxGatewayBaseUrl,
  selectTurnProtocol,
  type SandboxHostedInference,
} from "./sandbox-hosted-inference.js";
import {
  issueSandboxInferenceToken,
  sandboxInferenceCipher,
  sandboxInferenceTokenTtlMs,
  type SandboxInferenceCipher,
} from "./sandbox-inference-token.js";

export interface ModelsHarnessWiringDeps {
  config: Pick<NodeConfig, "platformRootSecret" | "http" | "model" | "sandbox">;
  sql: SqlClient;
  /** Database dialect: harness cards need SQLite or Postgres. */
  dialect: string;
  modelCards: { list(input: { tenantId: string }): Promise<readonly ModelOptionCard[]> };
}

export interface ModelsHarnessWiring {
  /** null on MySQL: no harness cards there. */
  cardStore: HarnessCardStore | null;
  catalog: WorkspaceCatalog;
  readiness: HarnessReadiness;
  /** Origin the session VM calls, or null when the server has none. */
  gatewayBaseUrl: string | null;
}

export function createModelsHarnessWiring(deps: ModelsHarnessWiringDeps): ModelsHarnessWiring {
  const cardStore = deps.dialect === "mysql" ? null : createHarnessCardStore(deps.sql);
  const gatewayBaseUrl = resolveSandboxGatewayBaseUrl({
    sandboxGatewayBaseUrl: deps.config.http.sandboxGatewayBaseUrl ?? null,
    publicBaseUrl: deps.config.http.publicBaseUrl ?? null,
  });
  const readiness: HarnessReadiness = {
    rootSecret: deps.config.platformRootSecret ?? null,
    gatewayBaseUrl,
    sandboxProvider: sandboxProviderId(deps.config.sandbox.environment),
  };
  const catalog = createWorkspaceCatalog({
    models: {
      listCards: (workspaceId) => deps.modelCards.list({ tenantId: workspaceId }),
      serverKey: {
        available: Boolean(deps.config.model.apiKey?.trim()),
        baseUrl: deps.config.model.baseUrl ?? null,
      },
    },
    harnesses: {
      ...(cardStore === null ? {} : { listHarnessCards: (workspaceId: string) => cardStore.listActive(workspaceId) }),
      readiness,
    },
  });
  return { cardStore, catalog, readiness, gatewayBaseUrl };
}

/** Provider id of SANDBOX_PROVIDER (or the test provider), null when unset or invalid. */
export function sandboxProviderId(environment: Readonly<Record<string, string | undefined>>): string | null {
  try {
    return resolveSandboxProviderForEnvironment(environment).provider;
  } catch {
    return null;
  }
}

/** `dependencies` blocks archive and delete of a card that agents use (crud.md, 2.8). */
export function buildHarnessCardRoutesFor(
  wiring: Pick<ModelsHarnessWiring, "cardStore">,
  dependencies?: HarnessCardDependencyCheck,
): Hono {
  if (wiring.cardStore !== null) {
    return buildHarnessCardRoutes({
      store: wiring.cardStore,
      ...(dependencies === undefined ? {} : { dependencies }),
    }) as unknown as Hono;
  }
  const unsupported = new Hono();
  unsupported.all("*", (c) => c.json({ error: "Свои harness на MySQL не поддерживаются", field: null }, 501));
  return unsupported;
}

/** Domain agent fields the guard needs. */
export interface StoredAgentForGuard {
  model: { id: string; effort?: string; speed?: string };
  openma?: {
    harness?: string;
    acp?: { agent: { id?: string; command: string; env?: Record<string, string | undefined> } };
  };
}

/** A stored agent in the shape of AgentConfigGuardDeps.loadAgent. */
export function agentForGuard(agent: StoredAgentForGuard) {
  const acpAgent = agent.openma?.acp?.agent;
  const env = acpAgent?.env === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(acpAgent.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
  return {
    model: {
      id: agent.model.id,
      ...(agent.model.effort === undefined ? {} : { effort: agent.model.effort }),
      ...(agent.model.speed === undefined ? {} : { speed: agent.model.speed }),
    },
    _oma: {
      harness: agent.openma?.harness ?? null,
      acp: acpAgent === undefined
        ? null
        : {
            agent: {
              ...(acpAgent.id === undefined ? {} : { id: acpAgent.id }),
              command: acpAgent.command,
              ...(env === undefined ? {} : { env }),
            },
          },
    },
  };
}

/** Harness part of a turn's agent config (legacy shape of the harness). */
export interface AcpTurnAgent {
  model: string | { id: string };
  harness?: string;
  acp?: {
    agent: { id?: string; command: string; env?: Record<string, string | undefined> } & Record<string, unknown>;
    per_turn_timeout_ms?: number;
  } & Record<string, unknown>;
}

export type AcpTurnInference =
  | { kind: "builtin"; hostedInference: SandboxHostedInference }
  | { kind: "card"; env: Record<string, string> };

/**
 * Section 5.8 for an acp-sandbox turn: readiness, the catalog entry (a
 * built-in entry with a model adapter or a workspace card, archived too), the
 * turn protocol, a token for this turn, then the hosted inference of a
 * built-in entry or the variables of a card. Throws an Error with text for a
 * person; the turn fails, the session stays.
 */
export async function prepareAcpTurnInference(input: {
  wiring: Pick<ModelsHarnessWiring, "cardStore" | "readiness" | "gatewayBaseUrl">;
  secrets: { cipherFor(purpose: string): SandboxInferenceCipher } | null;
  workspaceId: string;
  sessionId: string;
  agent: AcpTurnAgent;
  /** Upstream of the agent model as resolveNodeModelCreds returns it. */
  upstream: { provider?: string | null; baseURL?: string | null };
  now?: number;
}): Promise<AcpTurnInference> {
  const reason = acpUnavailableReason(input.wiring.readiness)
    ?? (input.secrets === null ? "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET" : null);
  const gatewayBaseUrl = input.wiring.gatewayBaseUrl;
  if (reason !== null || gatewayBaseUrl === null || input.secrets === null) {
    throw new Error(`ACP-агенту нужен прокси модели: ${reason ?? "VM не знает адрес сервера: задайте SANDBOX_GATEWAY_BASE_URL"}`);
  }

  const harnessId = input.agent.acp?.agent.id ?? "";
  const entry = builtinAcpEntry(harnessId) ?? await cardEntry(input.wiring.cardStore, input.workspaceId, harnessId);
  if (entry === null) {
    throw new Error(`Harness «${harnessId}» не поддерживается: для него нет адаптера модели и нет карточки`);
  }

  const modelHandle = typeof input.agent.model === "string" ? input.agent.model : input.agent.model.id;
  const modelProtocols: InferenceWireProtocol[] = [
    ...new Set(resolveProtocolEndpointsFromModelCard({
      providerId: input.upstream.provider ?? "anthropic",
      baseUrl: input.upstream.baseURL ?? null,
    }).map((endpoint) => endpoint.protocol)),
  ];
  const protocol = selectTurnProtocol(entry.protocols, modelProtocols);
  if (protocol === null) {
    throw new Error(`Модель «${modelHandle}» не подходит для harness «${harnessDisplayLabel(entry)}»`);
  }

  const token = await issueSandboxInferenceToken({
    cipher: sandboxInferenceCipher(input.secrets),
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    ttlMs: sandboxInferenceTokenTtlMs(input.agent.acp?.per_turn_timeout_ms),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (entry.source === "builtin") {
    return {
      kind: "builtin",
      hostedInference: buildSandboxHostedInference({ gatewayBaseUrl, token, upstream: input.upstream }),
    };
  }
  return {
    kind: "card",
    env: cardInferenceEnv({ gatewayBaseUrl, sessionId: input.sessionId, token, protocol, modelHandle }),
  };
}

/**
 * The agent config an acp-sandbox turn runs with (5.7). Model keys leave the
 * ACP env: the guard checks only new saves, and a snapshot saved before it
 * can still hold CLAUDE_CODE_OAUTH_TOKEN or a provider key, which the
 * built-in adapters do not all drop and a card would pass on as is. Without
 * a key the same object comes back. The inference of the turn goes through
 * acpTurnEnv, not this config: the config makes the ACP checkpoint key, and
 * the token changes every turn.
 */
export function acpTurnAgent<T extends AcpTurnAgent>(agent: T): T {
  const env = agent.acp?.agent.env;
  if (agent.acp === undefined || env === undefined || !Object.keys(env).some((name) => MODEL_KEY_ENV_NAMES.has(name))) {
    return agent;
  }
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !MODEL_KEY_ENV_NAMES.has(name)));
  return { ...agent, acp: { ...agent.acp, agent: { ...agent.acp.agent, env: kept } } };
}

/** The part of HarnessContext.env that carries the inference of an
 * acp-sandbox turn: hostedInference of a built-in entry, or the card
 * variables the harness lays over the env of the ACP process. */
export function acpTurnEnv(inference: AcpTurnInference):
  | { hostedInference: SandboxHostedInference }
  | { acpLaunchEnv: Record<string, string> } {
  return inference.kind === "builtin"
    ? { hostedInference: inference.hostedInference }
    : { acpLaunchEnv: inference.env };
}

function builtinAcpEntry(id: string): HarnessEntry | null {
  const canonical = BUILTIN_HARNESSES.some((entry) => entry.id === id) ? id : resolveOverlayAgent(id)?.id;
  return BUILTIN_HARNESSES.find(
    (entry) => entry.id === canonical && entry.runtime_harness === "acp-sandbox",
  ) ?? null;
}

async function cardEntry(
  store: HarnessCardStore | null,
  workspaceId: string,
  harnessId: string,
): Promise<HarnessEntry | null> {
  if (store === null || harnessId === "") return null;
  const card = await store.findByHarnessId(workspaceId, harnessId);
  return card === null ? null : cardToHarnessEntry(card);
}
