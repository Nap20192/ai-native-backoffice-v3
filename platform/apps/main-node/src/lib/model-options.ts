// Model choices for GET /v1/oma/model_options (docs/plans/models-harness.md, 2).
// Workspace model cards plus the Pi anthropic catalog when the server has its
// own ANTHROPIC_API_KEY. No key material and no prices leave this module.
import {
  getSupportedThinkingLevels,
  type Api,
  type Model as PiModel,
  type Provider as PiProvider,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  findPiCatalogModel,
  PI_UNKNOWN_MODEL_CONTEXT_WINDOW,
  PI_UNKNOWN_MODEL_MAX_TOKENS,
  resolvePiCatalogModelId,
} from "@open-managed-agents/managed-agents-application/agents/pi-model-catalog";
import {
  resolveProtocolEndpointsFromModelCard,
  type InferenceWireProtocol,
} from "@open-managed-agents/inference-proxy";
import { compatibility, type HarnessEntry } from "./harness-catalog.js";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Agent API effort levels in order. Pi `minimal` and `off` are not agent levels. */
export const AGENT_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

/** Pi APIs that take Managed Agents `speed: fast` (A/harness/pi-provider.ts). */
const FAST_SPEED_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
]);

export interface ModelOption {
  handle: string;
  label: string;
  source: "card" | "builtin";
  card_id: string | null;
  is_default: boolean;
  provider: string;
  wire_model: string;
  api: string | null;
  protocols: InferenceWireProtocol[];
  context_window: number | null;
  max_output_tokens: number | null;
  effort_levels: EffortLevel[];
  speed_fast: boolean;
  harnesses: string[];
}

export interface ModelOptionsResult {
  builtin_available: boolean;
  data: ModelOption[];
}

/** The fields of a model card row this module reads (ModelCardRow has more). */
export interface ModelOptionCard {
  id: string;
  model_id: string;
  model: string;
  provider: string;
  base_url: string | null;
  pi_config: Record<string, unknown> | null;
  is_default: boolean;
  created_at: string;
  archived_at: string | null;
}

export interface ModelOptionsDeps {
  /** Cards of the workspace, shaped like ModelCardService.list. */
  listCards(workspaceId: string): Promise<readonly ModelOptionCard[]>;
  /** Server ANTHROPIC_API_KEY: available when it is set and not blank. */
  serverKey: { available: boolean; baseUrl: string | null | undefined };
}

export async function listModelOptions(
  deps: ModelOptionsDeps,
  workspaceId: string,
  harnesses: readonly HarnessEntry[],
): Promise<ModelOptionsResult> {
  const cards = (await deps.listCards(workspaceId))
    .filter((card) => card.archived_at === null || card.archived_at === undefined)
    .slice()
    .sort(cardOrder);
  const options = cards.map((card) => cardOption(card, harnesses));
  if (deps.serverKey.available) {
    const cardHandles = new Set(cards.map((card) => card.model_id));
    for (const model of anthropicCatalog()) {
      if (!cardHandles.has(model.id)) {
        options.push(builtinOption(model, deps.serverKey.baseUrl ?? null, harnesses));
      }
    }
  }
  return { builtin_available: deps.serverKey.available, data: options };
}

/** Default card first, then newest first; ties by id, larger id first. */
function cardOrder(left: ModelOptionCard, right: ModelOptionCard): number {
  if (left.is_default !== right.is_default) return left.is_default ? -1 : 1;
  const byTime = Date.parse(right.created_at) - Date.parse(left.created_at);
  if (Number.isFinite(byTime) && byTime !== 0) return byTime;
  return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
}

let piProviders: PiProvider[] | null = null;

/** Pi builds its providers on every builtinProviders() call; the catalog is static. */
function piProvider(id: string): PiProvider | undefined {
  piProviders ??= builtinProviders();
  return piProviders.find((provider) => provider.id === id);
}

function anthropicCatalog(): readonly PiModel<Api>[] {
  return piProvider("anthropic")?.getModels() ?? [];
}

function cardOption(card: ModelOptionCard, harnesses: readonly HarnessEntry[]): ModelOption {
  const resolved = resolveCardModel(card);
  const protocols = proxyProtocols(card.provider, card.base_url);
  return withHarnesses({
    handle: card.model_id,
    label: resolved.label ?? card.model_id,
    source: "card",
    card_id: card.id,
    is_default: card.is_default,
    provider: resolved.providerId,
    wire_model: card.model,
    api: resolved.api,
    protocols,
    context_window: resolved.model?.contextWindow ?? null,
    max_output_tokens: resolved.model?.maxTokens ?? null,
    effort_levels: resolved.model ? effortLevels(resolved.model) : [],
    speed_fast: resolved.api !== null && FAST_SPEED_APIS.has(resolved.api),
    harnesses: [],
  }, harnesses);
}

function builtinOption(
  model: PiModel<Api>,
  baseUrl: string | null,
  harnesses: readonly HarnessEntry[],
): ModelOption {
  return withHarnesses({
    handle: model.id,
    label: model.name,
    source: "builtin",
    card_id: null,
    is_default: false,
    provider: "anthropic",
    wire_model: model.id,
    api: model.api,
    protocols: proxyProtocols("anthropic", baseUrl),
    context_window: model.contextWindow ?? null,
    max_output_tokens: model.maxTokens ?? null,
    effort_levels: effortLevels(model),
    speed_fast: FAST_SPEED_APIS.has(model.api),
    harnesses: [],
  }, harnesses);
}

function withHarnesses(option: ModelOption, harnesses: readonly HarnessEntry[]): ModelOption {
  option.harnesses = harnesses
    .filter((entry) => compatibility(entry, option).compatible)
    .map((entry) => entry.id);
  return option;
}

/** Protocols the inference proxy serves for this provider, without repeats. */
function proxyProtocols(providerId: string, baseUrl: string | null): InferenceWireProtocol[] {
  const endpoints = resolveProtocolEndpointsFromModelCard({ providerId, baseUrl });
  return [...new Set(endpoints.map((endpoint) => endpoint.protocol))];
}

function effortLevels(model: PiModel<Api>): EffortLevel[] {
  if (model.reasoning !== true) return [];
  try {
    const supported = new Set<string>(getSupportedThinkingLevels(model));
    return AGENT_EFFORT_LEVELS.filter((level) => supported.has(level));
  } catch {
    return [];
  }
}

interface ResolvedCardModel {
  providerId: string;
  api: string | null;
  label: string | null;
  model: PiModel<Api> | null;
}

/**
 * Pi metadata of a card, resolved the way a turn resolves it
 * (createPiModelRuntime in A/harness/pi-provider.ts): the provider catalog
 * first, then the whole Pi catalog, then a custom `pi_config` with `api`.
 * The provider catalog goes first because findPiCatalogModel alone returns
 * the first provider with that id, for example azure for `gpt-5`.
 */
function resolveCardModel(card: ModelOptionCard): ResolvedCardModel {
  const plan = providerPlan(card.provider);
  try {
    const config = (card.pi_config ?? null) as Partial<PiModel<Api>> | null;
    const catalogModel = plan.catalog?.getModels()
      .find((model) => model.id === resolvePiCatalogModelId(card.model))
      ?? findPiCatalogModel(card.model);
    const api = stringOrNull(config?.api)
      ?? plan.api
      ?? catalogModel?.api
      ?? singleApi(plan.catalog);
    if (catalogModel === undefined && !config?.api) {
      return { providerId: plan.id, api, label: null, model: null };
    }
    const base: PiModel<Api> = catalogModel ?? {
      id: card.model,
      name: card.model,
      provider: plan.id,
      api: api as Api,
      baseUrl: card.base_url ?? plan.catalog?.baseUrl ?? "",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: PI_UNKNOWN_MODEL_CONTEXT_WINDOW,
      maxTokens: PI_UNKNOWN_MODEL_MAX_TOKENS,
    };
    const model = {
      ...base,
      ...config,
      id: card.model,
      provider: plan.id,
      api: api as Api,
    } as PiModel<Api>;
    return {
      providerId: plan.id,
      api,
      label: typeof model.name === "string" && model.name.length > 0 ? model.name : card.model,
      model,
    };
  } catch {
    // One malformed custom card must not break the whole list.
    return { providerId: plan.id, api: plan.api, label: null, model: null };
  }
}

interface ProviderPlan {
  id: string;
  api: string | null;
  catalog: PiProvider | undefined;
}

/** Provider tags as a turn reads them, legacy ant/oai tags included. */
function providerPlan(provider: string): ProviderPlan {
  const requested = (provider || "ant").trim().toLowerCase();
  switch (requested) {
    case "ant-compatible":
    case "anthropic-compatible":
      return { id: "anthropic-compatible", api: "anthropic-messages", catalog: piProvider("anthropic") };
    case "oai-compatible":
    case "openai-compatible":
      return { id: "openai-compatible", api: "openai-completions", catalog: piProvider("openai") };
  }
  const id = requested === "ant" ? "anthropic" : requested === "oai" ? "openai" : requested;
  return { id, api: null, catalog: piProvider(id) };
}

function singleApi(catalog: PiProvider | undefined): string | null {
  const apis = new Set((catalog?.getModels() ?? []).map((model) => model.api));
  return apis.size === 1 ? [...apis][0]! : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
