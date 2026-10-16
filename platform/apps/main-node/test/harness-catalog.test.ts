import { describe, expect, it } from "vitest";
import { OMA_OVERLAY_AGENTS } from "@open-managed-agents/acp-runtime/known-agents";
import {
  BUILTIN_HARNESSES,
  HARNESS_RU_LABELS,
  cardToHarnessEntry,
  compatibility,
  harnessDisplayLabel,
  harnessKeyOf,
  listHarnesses,
  type CatalogHarnessCard,
  type HarnessReadiness,
} from "../src/lib/harness-catalog.js";

const READY: HarnessReadiness = {
  rootSecret: "root-secret",
  gatewayBaseUrl: "http://host.boxlite.internal:8795",
  sandboxProvider: "litebox",
};

const CLAUDE_ACP_BLOCK = {
  agent: {
    id: "claude-acp",
    command: "sh",
    args: ["-c", "mkdir -p \"$CLAUDE_CONFIG_DIR\" && printf '%s' \"$OMA_CLAUDE_SETTINGS\" > \"$CLAUDE_CONFIG_DIR/settings.json\" && exec claude-agent-acp"],
    cwd: "/mnt/session/outputs",
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      OMA_CLAUDE_SETTINGS: "{\"permissions\":{\"allow\":[\"Read\",\"Write\",\"Edit\"]}}",
    },
  },
  per_turn_timeout_ms: 600000,
};

function card(overrides: Partial<CatalogHarnessCard> = {}): CatalogHarnessCard {
  return {
    id: "hcard_V1StGXR8Z5jdHi6B",
    harness_id: "aider-local",
    name: "Aider через ACP",
    command: "aider-acp",
    args: [],
    cwd: "/mnt/session/outputs",
    install: { npm: [], pip: ["aider-chat==0.86.1"] },
    protocols: ["openai-chat"],
    allowed_env: ["AIDER_AUTO_COMMITS"],
    status: "unverified",
    created_at: "2026-10-16T10:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

describe("BUILTIN_HARNESSES", () => {
  it("lists the built-in loop, Claude Code and ACP agents that have a model adapter", () => {
    expect(BUILTIN_HARNESSES.map((entry) => [entry.id, entry.status, entry.runtime_harness, entry.protocols]))
      .toEqual([
        ["pi", "ready", null, ["*"]],
        ["claude-acp", "ready", "acp-sandbox", ["anthropic-messages"]],
        ["codex-acp", "unverified", "acp-sandbox", ["openai-responses"]],
        ["gemini", "unverified", "acp-sandbox", ["gemini"]],
        ["opencode", "unverified", "acp-sandbox", ["openai-chat"]],
        ["kimi-code", "unverified", "acp-sandbox", ["openai-chat"]],
        ["pi-acp", "unverified", "acp-sandbox", ["openai-chat"]],
      ]);
    const ids = BUILTIN_HARNESSES.map((entry) => entry.id);
    for (const missing of ["aider", "mimo", "mcode", "hermes", "ai-sdk", "acp-proxy"]) {
      expect(ids).not.toContain(missing);
    }
  });

  it("describes the built-in loop", () => {
    expect(BUILTIN_HARNESSES[0]).toEqual({
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
    });
  });

  it("keeps the verified W4 recipe for Claude Code", () => {
    const claude = BUILTIN_HARNESSES.find((entry) => entry.id === "claude-acp");
    expect(claude).toEqual({
      id: "claude-acp",
      source: "builtin",
      label: "Claude Agent",
      status: "ready",
      reason: null,
      runtime_harness: "acp-sandbox",
      protocols: ["anthropic-messages"],
      supports: { effort: false, speed: false, platform_tools: false, mcp: false },
      acp: CLAUDE_ACP_BLOCK,
      install: { npm: ["@agentclientprotocol/claude-agent-acp@0.91.0"], pip: [] },
      install_hint: "npm install -g @agentclientprotocol/claude-agent-acp",
      allowed_env: null,
      card_id: null,
    });
  });

  it("takes commands, labels and install hints of other agents from known-agents", () => {
    for (const id of ["codex-acp", "gemini", "opencode", "kimi-code", "pi-acp"]) {
      const entry = BUILTIN_HARNESSES.find((candidate) => candidate.id === id)!;
      const known = OMA_OVERLAY_AGENTS.find((candidate) => candidate.id === id)!;
      expect(entry.label).toBe(known.label);
      expect(entry.install_hint).toBe(known.installHint ?? null);
      expect(entry.acp).toEqual({
        agent: {
          id,
          command: known.spec.command,
          args: known.spec.args ?? [],
          cwd: "/mnt/session/outputs",
        },
      });
      expect(entry.supports).toEqual({ effort: false, speed: false, platform_tools: false, mcp: false });
    }
    expect(BUILTIN_HARNESSES.find((entry) => entry.id === "gemini")!.acp!.agent)
      .toMatchObject({ command: "gemini", args: ["--acp"] });
    expect(BUILTIN_HARNESSES.find((entry) => entry.id === "pi-acp")!.install.npm).toEqual(["pi-acp"]);
    expect(BUILTIN_HARNESSES.find((entry) => entry.id === "codex-acp")!.install.npm).toEqual([]);
  });
});

describe("cardToHarnessEntry", () => {
  it("maps a workspace card to an unverified ACP entry", () => {
    expect(cardToHarnessEntry(card())).toEqual({
      id: "aider-local",
      source: "card",
      label: "Aider через ACP",
      status: "unverified",
      reason: null,
      runtime_harness: "acp-sandbox",
      protocols: ["openai-chat"],
      supports: { effort: false, speed: false, platform_tools: false, mcp: false },
      acp: { agent: { id: "aider-local", command: "aider-acp", args: [], cwd: "/mnt/session/outputs" } },
      install: { npm: [], pip: ["aider-chat==0.86.1"] },
      install_hint: null,
      allowed_env: ["AIDER_AUTO_COMMITS"],
      card_id: "hcard_V1StGXR8Z5jdHi6B",
    });
  });

  it("leaves cwd out of the block when the card has none", () => {
    expect(cardToHarnessEntry(card({ cwd: null })).acp).toEqual({
      agent: { id: "aider-local", command: "aider-acp", args: [] },
    });
  });
});

describe("listHarnesses", () => {
  it("returns built-ins first and then active cards, newest first", async () => {
    const entries = await listHarnesses({
      readiness: READY,
      listHarnessCards: async (workspaceId) => {
        expect(workspaceId).toBe("ws_1");
        return [
          card({ id: "hcard_old", harness_id: "old-agent", name: "Старый", created_at: "2026-10-01T00:00:00.000Z" }),
          card({ id: "hcard_new", harness_id: "new-agent", name: "Новый", created_at: "2026-10-10T00:00:00.000Z" }),
          card({ id: "hcard_gone", harness_id: "gone-agent", archived_at: "2026-10-12T00:00:00.000Z" }),
        ];
      },
    }, "ws_1");
    expect(entries.map((entry) => [entry.id, entry.status])).toEqual([
      ["pi", "ready"],
      ["claude-acp", "ready"],
      ["codex-acp", "unverified"],
      ["gemini", "unverified"],
      ["opencode", "unverified"],
      ["kimi-code", "unverified"],
      ["pi-acp", "unverified"],
      ["new-agent", "unverified"],
      ["old-agent", "unverified"],
    ]);
  });

  it("orders cards with the same created_at by id, newest id first", async () => {
    const entries = await listHarnesses({
      readiness: READY,
      listHarnessCards: async () => [
        card({ id: "hcard_a", harness_id: "agent-a" }),
        card({ id: "hcard_b", harness_id: "agent-b" }),
      ],
    }, "ws_1");
    expect(entries.slice(-2).map((entry) => entry.id)).toEqual(["agent-b", "agent-a"]);
  });

  it("returns only built-ins without a card store", async () => {
    const entries = await listHarnesses({ readiness: READY }, "ws_1");
    expect(entries.map((entry) => entry.id)).toEqual(BUILTIN_HARNESSES.map((entry) => entry.id));
  });

  it("ignores a card that reuses a built-in id", async () => {
    const entries = await listHarnesses({
      readiness: READY,
      listHarnessCards: async () => [card({ harness_id: "claude-acp" })],
    }, "ws_1");
    expect(entries.filter((entry) => entry.id === "claude-acp")).toHaveLength(1);
    expect(entries.find((entry) => entry.id === "claude-acp")!.source).toBe("builtin");
  });

  it.each([
    [
      { ...READY, rootSecret: undefined },
      "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
    ],
    [
      { ...READY, rootSecret: "  " },
      "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
    ],
    [
      { ...READY, sandboxProvider: "daytona" },
      "Песочница этого сервера не запускает ACP-агентов",
    ],
    [
      { ...READY, sandboxProvider: null },
      "Песочница этого сервера не запускает ACP-агентов",
    ],
    [
      { ...READY, gatewayBaseUrl: "" },
      "VM не знает адрес сервера: задайте SANDBOX_GATEWAY_BASE_URL",
    ],
    [
      { rootSecret: null, sandboxProvider: "daytona", gatewayBaseUrl: null },
      "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
    ],
    [
      { ...READY, sandboxProvider: "daytona", gatewayBaseUrl: null },
      "Песочница этого сервера не запускает ACP-агентов",
    ],
  ] as Array<[HarnessReadiness, string]>)("marks every ACP entry unavailable: %s", async (readiness, reason) => {
    const entries = await listHarnesses({
      readiness,
      listHarnessCards: async () => [card()],
    }, "ws_1");
    expect(entries[0]).toMatchObject({ id: "pi", status: "ready", reason: null });
    for (const entry of entries.slice(1)) {
      expect(entry).toMatchObject({ status: "unavailable", reason });
    }
  });

  it.each(["litebox", "boxlite", "e2b", "sprites", "LiteBox", "test-local-subprocess"])(
    "keeps ACP entries available with sandbox %s",
    async (sandboxProvider) => {
      const entries = await listHarnesses({ readiness: { ...READY, sandboxProvider } }, "ws_1");
      expect(entries.every((entry) => entry.status !== "unavailable")).toBe(true);
    },
  );

  it("does not mutate the built-in constant", async () => {
    await listHarnesses({ readiness: { ...READY, rootSecret: null } }, "ws_1");
    expect(BUILTIN_HARNESSES.find((entry) => entry.id === "claude-acp")!.status).toBe("ready");
  });
});

describe("harnessKeyOf", () => {
  it.each([
    [undefined, "pi"],
    [{}, "pi"],
    [{ harness: null }, "pi"],
    [{ harness: "" }, "pi"],
    [{ harness: "default" }, "pi"],
    [{ harness: "pi" }, "pi"],
    [{ harness: "ai-sdk" }, "ai-sdk"],
    [{ harness: "acp-proxy", acp: { agent: { id: "claude-acp" } } }, "acp-proxy"],
    [{ harness: "acp-sandbox", acp: { agent: { id: "claude-acp", command: "sh" } } }, "claude-acp"],
    [{ harness: "acp-sandbox", acp: { agent: { command: "x" } } }, "acp"],
    [{ harness: "acp-sandbox", acp: null }, "acp"],
    [{ harness: "custom" }, "custom"],
  ] as const)("maps %j to %s", (config, key) => {
    expect(harnessKeyOf(config)).toBe(key);
  });
});

describe("compatibility", () => {
  const builtin = (id: string) => BUILTIN_HARNESSES.find((entry) => entry.id === id)!;
  const anthropicModel = { handle: "verify-fake", protocols: ["anthropic-messages"] as const };
  const openaiModel = { handle: "verify-oai", protocols: ["openai-chat", "openai-responses"] as const };
  const deepseekModel = { handle: "ds", protocols: ["openai-chat", "anthropic-messages"] as const };
  const routerModel = { handle: "router", protocols: [] as const };

  it("lets the built-in loop take any model", () => {
    expect(compatibility(builtin("pi"), anthropicModel)).toEqual({ compatible: true, protocol: "anthropic-messages" });
    expect(compatibility(builtin("pi"), routerModel)).toEqual({ compatible: true, protocol: null });
  });

  it("matches an ACP entry by protocol and picks the first entry protocol the model has", () => {
    expect(compatibility(builtin("claude-acp"), anthropicModel)).toEqual({ compatible: true, protocol: "anthropic-messages" });
    expect(compatibility(builtin("claude-acp"), deepseekModel)).toEqual({ compatible: true, protocol: "anthropic-messages" });
    const twoProtocols = cardToHarnessEntry(card({ protocols: ["anthropic-messages", "openai-chat"] }));
    expect(compatibility(twoProtocols, deepseekModel)).toEqual({ compatible: true, protocol: "anthropic-messages" });
  });

  it("explains a protocol mismatch", () => {
    expect(compatibility(builtin("claude-acp"), openaiModel)).toEqual({
      compatible: false,
      reason: "Claude Code в песочнице работает только с моделями с протоколом anthropic-messages, у модели verify-oai: openai-chat, openai-responses",
    });
    expect(compatibility(builtin("claude-acp"), routerModel)).toEqual({
      compatible: false,
      reason: "Claude Code в песочнице работает только с моделями с протоколом anthropic-messages, у модели router нет протокола, который понимает прокси",
    });
    expect(compatibility(cardToHarnessEntry(card()), anthropicModel)).toEqual({
      compatible: false,
      reason: "Aider через ACP работает только с моделями с протоколом openai-chat, у модели verify-fake: anthropic-messages",
    });
  });

  it("ignores the entry status", () => {
    const unavailable = { ...builtin("claude-acp"), status: "unavailable" as const, reason: "x" };
    expect(compatibility(unavailable, anthropicModel).compatible).toBe(true);
  });
});

describe("harness labels", () => {
  it("uses Russian labels for built-ins and the card name for cards", () => {
    expect(HARNESS_RU_LABELS).toEqual({
      pi: "Встроенный цикл",
      "claude-acp": "Claude Code в песочнице",
      "codex-acp": "Codex в песочнице",
      gemini: "Gemini CLI в песочнице",
      opencode: "OpenCode в песочнице",
      "kimi-code": "Kimi Code в песочнице",
      "pi-acp": "Pi через ACP в песочнице",
      "ai-sdk": "AI SDK (устарел)",
    });
    expect(harnessDisplayLabel(BUILTIN_HARNESSES[1]!)).toBe("Claude Code в песочнице");
    expect(harnessDisplayLabel(cardToHarnessEntry(card()))).toBe("Aider через ACP");
  });
});
