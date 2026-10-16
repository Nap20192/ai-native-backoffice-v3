import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { BUILTIN_HARNESSES } from "../src/lib/harness-catalog.js";
import {
  listModelOptions,
  type ModelOptionCard,
  type ModelOptionsDeps,
} from "../src/lib/model-options.js";

const AGENT_EFFORT = ["low", "medium", "high", "xhigh", "max"];

function piModel(provider: string, id: string): Model<Api> {
  const model = builtinProviders().find((candidate) => candidate.id === provider)!
    .getModels().find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Pi catalog has no ${provider}/${id}`);
  return model;
}

function piEffort(model: Model<Api>): string[] {
  if (model.reasoning !== true) return [];
  const levels = new Set<string>(getSupportedThinkingLevels(model));
  return AGENT_EFFORT.filter((level) => levels.has(level));
}

let seq = 0;
function card(overrides: Partial<ModelOptionCard> = {}): ModelOptionCard {
  seq += 1;
  return {
    id: `mc_${String(seq).padStart(3, "0")}`,
    model_id: `card-${seq}`,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    base_url: null,
    pi_config: null,
    is_default: false,
    created_at: `2026-10-${String(seq).padStart(2, "0")}T00:00:00.000Z`,
    archived_at: null,
    ...overrides,
  };
}

function deps(cards: ModelOptionCard[], available = false): ModelOptionsDeps {
  return {
    listCards: async (workspaceId) => {
      expect(workspaceId).toBe("ws_1");
      return cards;
    },
    serverKey: { available, baseUrl: null },
  };
}

const harnesses = [...BUILTIN_HARNESSES];

describe("listModelOptions", () => {
  it("is empty without cards and without a server key", async () => {
    expect(await listModelOptions(deps([]), "ws_1", harnesses)).toEqual({
      builtin_available: false,
      data: [],
    });
  });

  it("lists the Pi anthropic catalog when the server has a key", async () => {
    const result = await listModelOptions(deps([], true), "ws_1", harnesses);
    const anthropic = builtinProviders().find((provider) => provider.id === "anthropic")!.getModels();
    expect(result.builtin_available).toBe(true);
    expect(result.data.map((option) => option.handle)).toEqual(anthropic.map((model) => model.id));
    const sonnet = result.data.find((option) => option.handle === "claude-sonnet-4-6")!;
    const pi = piModel("anthropic", "claude-sonnet-4-6");
    expect(sonnet).toEqual({
      handle: "claude-sonnet-4-6",
      label: pi.name,
      source: "builtin",
      card_id: null,
      is_default: false,
      provider: "anthropic",
      wire_model: "claude-sonnet-4-6",
      api: "anthropic-messages",
      protocols: ["anthropic-messages"],
      context_window: pi.contextWindow,
      max_output_tokens: pi.maxTokens,
      effort_levels: piEffort(pi),
      speed_fast: true,
      harnesses: ["pi", "claude-acp"],
    });
    expect(sonnet.effort_levels).toEqual(["low", "medium", "high", "max"]);
  });

  it("hides a built-in model behind an active card with the same handle", async () => {
    const result = await listModelOptions(deps([
      card({ id: "mc_same", model_id: "claude-sonnet-4-6", model: "claude-sonnet-4-6" }),
    ], true), "ws_1", harnesses);
    const matches = result.data.filter((option) => option.handle === "claude-sonnet-4-6");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ source: "card", card_id: "mc_same" });
  });

  it("skips archived cards, which then do not hide the built-in model", async () => {
    const result = await listModelOptions(deps([
      card({ model_id: "claude-sonnet-4-6", archived_at: "2026-10-15T00:00:00.000Z" }),
      card({ model_id: "gone", archived_at: "2026-10-15T00:00:00.000Z" }),
    ], true), "ws_1", harnesses);
    expect(result.data.some((option) => option.handle === "gone")).toBe(false);
    expect(result.data.find((option) => option.handle === "claude-sonnet-4-6")!.source).toBe("builtin");
  });

  it("orders the default card, other cards newest first, then built-ins", async () => {
    const result = await listModelOptions(deps([
      card({ model_id: "older", created_at: "2026-10-01T00:00:00.000Z" }),
      card({ model_id: "default", is_default: true, created_at: "2026-09-01T00:00:00.000Z" }),
      card({ model_id: "newer", created_at: "2026-10-05T00:00:00.000Z" }),
      card({ id: "mc_z", model_id: "same-time-z", created_at: "2026-10-03T00:00:00.000Z" }),
      card({ id: "mc_a", model_id: "same-time-a", created_at: "2026-10-03T00:00:00.000Z" }),
    ], true), "ws_1", harnesses);
    expect(result.data.slice(0, 5).map((option) => option.handle)).toEqual([
      "default", "newer", "same-time-z", "same-time-a", "older",
    ]);
    expect(result.data[0]!.is_default).toBe(true);
    expect(result.data.slice(5).every((option) => option.source === "builtin")).toBe(true);
  });

  it("matches effort and speed of the Pi catalog for Anthropic, OpenAI and a custom card", async () => {
    const custom = card({
      model_id: "my-vllm",
      model: "qwen-local",
      provider: "my-vllm",
      base_url: "http://vllm.local/v1",
      pi_config: { api: "openai-completions", reasoning: true, contextWindow: 64000, maxTokens: 8000, name: "Qwen local" },
    });
    const result = await listModelOptions(deps([
      card({ model_id: "ant", model: "claude-opus-4-7", provider: "ant" }),
      card({ model_id: "oai", model: "gpt-5", provider: "openai" }),
      card({ model_id: "oai-plain", model: "gpt-4o", provider: "oai" }),
      custom,
    ]), "ws_1", harnesses);
    const byHandle = new Map(result.data.map((option) => [option.handle, option]));

    const opus = piModel("anthropic", "claude-opus-4-7");
    expect(byHandle.get("ant")).toMatchObject({
      label: opus.name,
      provider: "anthropic",
      wire_model: "claude-opus-4-7",
      api: "anthropic-messages",
      effort_levels: piEffort(opus),
      speed_fast: true,
      context_window: opus.contextWindow,
      max_output_tokens: opus.maxTokens,
    });
    expect(byHandle.get("ant")!.effort_levels).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const gpt5 = piModel("openai", "gpt-5");
    expect(byHandle.get("oai")).toMatchObject({
      provider: "openai",
      api: "openai-responses",
      effort_levels: piEffort(gpt5),
      speed_fast: true,
    });
    expect(byHandle.get("oai")!.effort_levels).toEqual(["low", "medium", "high"]);
    expect(byHandle.get("oai-plain")).toMatchObject({ provider: "openai", effort_levels: [], speed_fast: true });

    const customOption = byHandle.get("my-vllm")!;
    expect(customOption).toMatchObject({
      label: "Qwen local",
      provider: "my-vllm",
      wire_model: "qwen-local",
      api: "openai-completions",
      speed_fast: true,
      context_window: 64000,
      max_output_tokens: 8000,
    });
    const customPi = {
      id: "qwen-local", name: "Qwen local", provider: "my-vllm", api: "openai-completions",
      baseUrl: "http://vllm.local/v1", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8000,
    } as Model<Api>;
    expect(customOption.effort_levels).toEqual(piEffort(customPi));
    expect(customOption.effort_levels.length).toBeGreaterThan(0);
  });

  it("turns speed off for an API without fast mode", async () => {
    const result = await listModelOptions(deps([
      card({ model_id: "gem", model: "my-gemini", provider: "custom-gemini", pi_config: { api: "google-generative-ai" } }),
    ]), "ws_1", harnesses);
    expect(result.data[0]).toMatchObject({ api: "google-generative-ai", speed_fast: false, effort_levels: [] });
  });

  it("derives proxy protocols and compatible harnesses from the provider", async () => {
    const result = await listModelOptions(deps([
      card({ model_id: "anthropic-card", provider: "anthropic" }),
      card({ model_id: "deepseek-card", model: "deepseek-v4-pro", provider: "deepseek" }),
      card({ model_id: "router-card", model: "anthropic/claude-sonnet-4.5", provider: "openrouter" }),
      card({ model_id: "openai-card", model: "gpt-5", provider: "openai" }),
      card({ model_id: "google-card", model: "gemini-2.5-pro", provider: "google" }),
    ]), "ws_1", harnesses);
    const byHandle = new Map(result.data.map((option) => [option.handle, option]));
    expect(byHandle.get("anthropic-card")).toMatchObject({
      protocols: ["anthropic-messages"],
      harnesses: ["pi", "claude-acp"],
    });
    expect(byHandle.get("deepseek-card")!.protocols).toEqual(["openai-chat", "anthropic-messages"]);
    expect(byHandle.get("deepseek-card")!.harnesses).toEqual(
      expect.arrayContaining(["pi", "claude-acp", "opencode"]),
    );
    expect(byHandle.get("router-card")).toMatchObject({ protocols: [], harnesses: ["pi"] });
    expect(byHandle.get("openai-card")).toMatchObject({
      protocols: ["openai-chat", "openai-responses"],
      harnesses: ["pi", "codex-acp", "opencode", "kimi-code", "pi-acp"],
    });
    expect(byHandle.get("google-card")).toMatchObject({ protocols: ["gemini"], harnesses: ["pi", "gemini"] });
  });

  it("lists compatible harnesses whatever their status", async () => {
    const unavailable = harnesses.map((entry) =>
      entry.runtime_harness ? { ...entry, status: "unavailable" as const, reason: "x" } : entry);
    const result = await listModelOptions(deps([card({ model_id: "a" })]), "ws_1", unavailable);
    expect(result.data[0]!.harnesses).toEqual(["pi", "claude-acp"]);
  });

  it("falls back to the handle and nulls for a model unknown to Pi", async () => {
    const result = await listModelOptions(deps([
      card({ model_id: "mystery", model: "no-such-model-xyz", provider: "custom-llm" }),
    ]), "ws_1", harnesses);
    expect(result.data[0]).toEqual({
      handle: "mystery",
      label: "mystery",
      source: "card",
      card_id: expect.any(String),
      is_default: false,
      provider: "custom-llm",
      wire_model: "no-such-model-xyz",
      api: null,
      protocols: [],
      context_window: null,
      max_output_tokens: null,
      effort_levels: [],
      speed_fast: false,
      harnesses: ["pi"],
    });
  });

  it("takes the API the turn would use for an unknown model of a catalog provider", async () => {
    // A turn infers the API from the provider catalog (A/harness/pi-provider.ts).
    const result = await listModelOptions(deps([
      card({ model_id: "new-claude", model: "claude-not-in-pi-yet", provider: "anthropic" }),
      card({ model_id: "compat", model: "my-model", provider: "ant-compatible", base_url: "https://llm.local/v1" }),
      card({ model_id: "oai-compat", model: "my-model", provider: "oai-compatible", base_url: "https://llm.local/v1" }),
    ]), "ws_1", harnesses);
    const byHandle = new Map(result.data.map((option) => [option.handle, option]));
    expect(byHandle.get("new-claude")).toMatchObject({
      label: "new-claude",
      provider: "anthropic",
      api: "anthropic-messages",
      protocols: ["anthropic-messages"],
      context_window: null,
      effort_levels: [],
      speed_fast: true,
    });
    expect(byHandle.get("compat")).toMatchObject({
      provider: "anthropic-compatible",
      api: "anthropic-messages",
      protocols: ["anthropic-messages"],
      harnesses: ["pi", "claude-acp"],
    });
    expect(byHandle.get("oai-compat")).toMatchObject({
      provider: "openai-compatible",
      api: "openai-completions",
      protocols: ["openai-chat", "openai-responses"],
      speed_fast: true,
    });
  });

  it("looks a card model up in its own provider catalog first", async () => {
    // findPiCatalogModel("gpt-5") alone finds the azure entry with another API.
    const result = await listModelOptions(deps([
      card({ model_id: "oai", model: "gpt-5", provider: "openai" }),
    ]), "ws_1", harnesses);
    expect(result.data[0]).toMatchObject({ api: "openai-responses", speed_fast: true });
  });

  it("survives a malformed pi_config", async () => {
    const result = await listModelOptions(deps([
      card({ model_id: "broken", model: "custom-x", provider: "custom", pi_config: { api: "openai-completions", thinkingLevelMap: 42 } as Record<string, unknown> }),
    ]), "ws_1", harnesses);
    expect(result.data[0]!.handle).toBe("broken");
  });

  it("never returns key material", async () => {
    const withKey = { ...card({ model_id: "k" }), api_key_preview: "abcd", api_key: "sk-secret" } as ModelOptionCard;
    const result = await listModelOptions(deps([withKey]), "ws_1", harnesses);
    expect(JSON.stringify(result)).not.toContain("abcd");
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });
});
