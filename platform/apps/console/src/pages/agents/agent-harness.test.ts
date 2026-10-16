import { describe, expect, it } from "vitest";

import type { HarnessEntry, ModelOption } from "../../lib/catalog-api";
import {
  applyHarness,
  compatibility,
  groupHarnessEntries,
  harnessDisabledReason,
  harnessIdOf,
  harnessTargetOf,
  isAcpHarness,
  modelDisabledReason,
  pickDefaultModel,
} from "./agent-harness";
import {
  ACP_EFFORT_NOTE,
  ACP_SYSTEM_NOTE,
  HARNESS_LABELS,
  acpMcpNote,
  acpToolsNote,
  harnessDescription,
  harnessLabel,
  protocolLabel,
  statusLabel,
} from "./harness-text";

const CLAUDE_BLOCK = {
  agent: {
    id: "claude-acp",
    command: "sh",
    args: ["-c", 'exec claude-agent-acp'],
    cwd: "/mnt/session/outputs",
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      OMA_CLAUDE_SETTINGS: '{"permissions":{"allow":["Read","Write","Edit"]}}',
    },
  },
  per_turn_timeout_ms: 600000,
};

function entry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
  return {
    id: "claude-acp",
    source: "builtin",
    label: "Claude Agent",
    status: "ready",
    reason: null,
    runtime_harness: "acp-sandbox",
    protocols: ["anthropic-messages"],
    supports: { effort: false, speed: false, platform_tools: false, mcp: false },
    acp: CLAUDE_BLOCK,
    install: { npm: ["@agentclientprotocol/claude-agent-acp@0.91.0"], pip: [] },
    install_hint: "npm install -g @agentclientprotocol/claude-agent-acp",
    allowed_env: null,
    card_id: null,
    ...overrides,
  };
}

const PI = entry({
  id: "pi",
  label: "Pi agent-core",
  runtime_harness: null,
  protocols: ["*"],
  supports: { effort: true, speed: true, platform_tools: true, mcp: true },
  acp: null,
  install: { npm: [], pip: [] },
  install_hint: null,
});

function model(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    handle: "verify-fake",
    label: "Claude Sonnet 4.6",
    source: "card",
    card_id: "mc_1",
    is_default: false,
    provider: "anthropic",
    wire_model: "claude-sonnet-4-6",
    api: "anthropic-messages",
    protocols: ["anthropic-messages"],
    context_window: 200000,
    max_output_tokens: 64000,
    effort_levels: ["low", "medium", "high"],
    speed_fast: true,
    harnesses: ["pi", "claude-acp"],
    ...overrides,
  };
}

describe("applyHarness", () => {
  it("смена с pi на claude-acp пишет acp-sandbox и блок из каталога, убирает усилие и хранит остальной _oma", () => {
    const config = {
      name: "Юрист",
      model: { id: "verify-fake", effort: "high", speed: "fast", max_tokens: 4096 },
      _oma: { aux_model: { id: "haiku" }, appendable_prompts: ["p1"] },
    };

    const next = applyHarness(config, harnessTargetOf(entry()), { forUpdate: false });

    expect(next._oma).toEqual({
      aux_model: { id: "haiku" },
      appendable_prompts: ["p1"],
      harness: "acp-sandbox",
      acp: CLAUDE_BLOCK,
    });
    expect(next.model).toEqual({ id: "verify-fake", max_tokens: 4096 });
    // Блок скопирован: правка конфигурации не трогает каталог.
    expect((next._oma as { acp: unknown }).acp).not.toBe(CLAUDE_BLOCK);
    // Исходная конфигурация не меняется.
    expect(config.model).toEqual({
      id: "verify-fake",
      effort: "high",
      speed: "fast",
      max_tokens: 4096,
    });
  });

  it("создаёт _oma, когда у агента его не было, и не трогает модель-строку", () => {
    const next = applyHarness({ name: "A", model: "verify-fake" }, harnessTargetOf(entry()), {
      forUpdate: false,
    });

    expect(next.model).toBe("verify-fake");
    expect(next._oma).toEqual({ harness: "acp-sandbox", acp: CLAUDE_BLOCK });
  });

  it("возврат на встроенный цикл при создании убирает harness и acp, остальной _oma цел", () => {
    const config = {
      model: "verify-fake",
      _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK, aux_model: { id: "haiku" } },
    };

    const next = applyHarness(config, harnessTargetOf(PI), { forUpdate: false });

    expect(next._oma).toEqual({ aux_model: { id: "haiku" } });
  });

  it("убирает пустой _oma целиком при создании", () => {
    const next = applyHarness(
      { model: "m", _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } },
      harnessTargetOf(PI),
      { forUpdate: false },
    );

    expect(next).not.toHaveProperty("_oma");
  });

  it("при изменении агента возврат на встроенный цикл шлёт null вместо harness и acp", () => {
    const next = applyHarness(
      { model: "m", _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK, aux_model: { id: "h" } } },
      harnessTargetOf(PI),
      { forUpdate: true },
    );

    expect(next._oma).toEqual({ harness: null, acp: null, aux_model: { id: "h" } });
  });

  it("устаревший ai-sdk при выборе встроенного цикла тоже очищается", () => {
    const next = applyHarness({ model: "m", _oma: { harness: "ai-sdk" } }, harnessTargetOf(PI), {
      forUpdate: true,
    });

    expect(next._oma).toEqual({ harness: null, acp: null });
  });

  it("встроенный цикл, заданный явно как pi, остаётся как есть", () => {
    const config = { model: "m", _oma: { harness: "pi" } };

    expect(applyHarness(config, harnessTargetOf(PI), { forUpdate: true })).toEqual(config);
  });

  it("смена одного ACP-агента на другой заменяет блок целиком", () => {
    const codex = entry({
      id: "codex-acp",
      status: "unverified",
      protocols: ["openai-responses"],
      acp: { agent: { id: "codex-acp", command: "codex-acp", cwd: "/mnt/session/outputs" } },
    });

    const next = applyHarness(
      { model: "m", _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } },
      harnessTargetOf(codex),
      { forUpdate: true },
    );

    expect(next._oma).toEqual({
      harness: "acp-sandbox",
      acp: { agent: { id: "codex-acp", command: "codex-acp", cwd: "/mnt/session/outputs" } },
    });
  });
});

describe("harnessIdOf", () => {
  it("даёт pi для пустого значения, default и pi", () => {
    expect(harnessIdOf({})).toBe("pi");
    expect(harnessIdOf({ _oma: {} })).toBe("pi");
    expect(harnessIdOf({ _oma: { harness: null } })).toBe("pi");
    expect(harnessIdOf({ _oma: { harness: "" } })).toBe("pi");
    expect(harnessIdOf({ _oma: { harness: "default" } })).toBe("pi");
    expect(harnessIdOf({ _oma: { harness: "pi" } })).toBe("pi");
    expect(harnessIdOf(null)).toBe("pi");
  });

  it("для acp-sandbox берёт id ACP-агента, без него остаётся acp-sandbox", () => {
    expect(harnessIdOf({ _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } })).toBe("claude-acp");
    expect(harnessIdOf({ _oma: { harness: "acp-sandbox", acp: { agent: { command: "x" } } } })).toBe(
      "acp-sandbox",
    );
    expect(harnessIdOf({ _oma: { harness: "acp-sandbox" } })).toBe("acp-sandbox");
  });

  it("остальные значения возвращает как есть", () => {
    expect(harnessIdOf({ _oma: { harness: "ai-sdk" } })).toBe("ai-sdk");
    expect(harnessIdOf({ _oma: { harness: "acp-proxy" } })).toBe("acp-proxy");
  });
});

describe("isAcpHarness", () => {
  it("считает ACP конфигурацию с acp-sandbox или записью каталога с runtime_harness", () => {
    expect(isAcpHarness({ _oma: { harness: "acp-sandbox", acp: CLAUDE_BLOCK } })).toBe(true);
    expect(isAcpHarness({ _oma: { harness: "ai-sdk" } })).toBe(false);
    expect(isAcpHarness({})).toBe(false);
    expect(isAcpHarness(entry())).toBe(true);
    expect(isAcpHarness(PI)).toBe(false);
  });
});

describe("совместимость модели и harness", () => {
  it("встроенный цикл берёт любую модель, даже без протоколов", () => {
    expect(compatibility(PI, model({ protocols: [] }))).toEqual({ ok: true });
  });

  it("ACP берёт модель, если протоколы пересекаются", () => {
    expect(compatibility(entry(), model())).toEqual({ ok: true });
  });

  it("называет причину по образцу из контракта", () => {
    const result = compatibility(
      entry(),
      model({ handle: "verify-oai", protocols: ["openai-chat"] }),
    );

    expect(result).toEqual({
      ok: false,
      reason:
        "Claude Code в песочнице работает только с моделями с протоколом anthropic-messages, у модели verify-oai: openai-chat",
    });
  });

  it("у модели без протоколов причина говорит про прокси", () => {
    const result = compatibility(entry(), model({ handle: "or-x", protocols: [] }));

    expect(result).toEqual({
      ok: false,
      reason:
        "Claude Code в песочнице работает только с моделями с протоколом anthropic-messages, у модели or-x нет протокола, который понимает прокси",
    });
  });

  it("для карточки с несколькими протоколами и своим названием перечисляет протоколы", () => {
    const card = entry({
      id: "aider-local",
      source: "card",
      label: "Aider через ACP",
      protocols: ["openai-chat", "openai-responses"],
      card_id: "hcard_1",
    });

    expect(compatibility(card, model({ handle: "m1", protocols: ["gemini"] }))).toEqual({
      ok: false,
      reason:
        "Aider через ACP работает только с моделями с протоколом openai-chat или openai-responses, у модели m1: gemini",
    });
  });

  it("modelDisabledReason молчит без harness и для совместимой модели", () => {
    expect(modelDisabledReason(model(), undefined)).toBeNull();
    expect(modelDisabledReason(model(), entry())).toBeNull();
    expect(modelDisabledReason(model({ protocols: ["openai-chat"] }), entry())).toMatch(
      /работает только с моделями/,
    );
  });
});

describe("harnessDisabledReason", () => {
  it("недоступная запись выключена с причиной сервера", () => {
    const unavailable = entry({
      status: "unavailable",
      reason: "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
    });

    expect(harnessDisabledReason(unavailable, [model()])).toBe(
      "Сервер не выпустит токен песочницы: задайте PLATFORM_ROOT_SECRET",
    );
  });

  it("запись без совместимых моделей выключена с подсказкой, какая модель нужна", () => {
    expect(harnessDisabledReason(entry(), [model({ protocols: ["openai-chat"] })])).toBe(
      "Нет подходящих моделей: нужна модель с протоколом anthropic-messages",
    );
    expect(harnessDisabledReason(entry(), [])).toBe(
      "Нет подходящих моделей: нужна модель с протоколом anthropic-messages",
    );
  });

  it("пока модели не загружены, совместимость не проверяется", () => {
    expect(harnessDisabledReason(entry(), undefined)).toBeNull();
  });

  it("встроенный цикл доступен всегда", () => {
    expect(harnessDisabledReason(PI, [])).toBeNull();
  });
});

describe("pickDefaultModel", () => {
  const defaultCard = model({ handle: "default-card", is_default: true });
  const otherCard = model({ handle: "other-card" });
  const builtin = model({ handle: "claude-sonnet-4-6", source: "builtin", card_id: null });

  it("берёт карточку по умолчанию, если она совместима", () => {
    expect(pickDefaultModel([otherCard, defaultCard, builtin], entry())?.handle).toBe("default-card");
  });

  it("иначе первую совместимую карточку", () => {
    const incompatibleDefault = model({
      handle: "oai",
      is_default: true,
      protocols: ["openai-chat"],
    });

    expect(pickDefaultModel([incompatibleDefault, otherCard, builtin], entry())?.handle).toBe(
      "other-card",
    );
  });

  it("иначе первую совместимую встроенную модель", () => {
    expect(pickDefaultModel([builtin], entry())?.handle).toBe("claude-sonnet-4-6");
  });

  it("без совместимых моделей даёт null", () => {
    expect(pickDefaultModel([model({ protocols: ["openai-chat"] })], entry())).toBeNull();
    expect(pickDefaultModel([], PI)).toBeNull();
  });

  it("для встроенного цикла совместима любая модель", () => {
    expect(pickDefaultModel([model({ handle: "x", protocols: [] })], PI)?.handle).toBe("x");
  });
});

describe("groupHarnessEntries", () => {
  it("делит записи на готовые, непроверенные, недоступные и свои", () => {
    const groups = groupHarnessEntries([
      PI,
      entry(),
      entry({ id: "codex-acp", status: "unverified" }),
      entry({ id: "gemini", status: "unavailable", reason: "нет" }),
      entry({ id: "aider-local", source: "card", status: "unverified", card_id: "h1" }),
    ]);

    expect(groups.map((group) => [group.key, group.entries.map((e) => e.id)])).toEqual([
      ["ready", ["pi", "claude-acp"]],
      ["unverified", ["codex-acp"]],
      ["unavailable", ["gemini"]],
      ["own", ["aider-local"]],
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Готово",
      "Не проверено",
      "Недоступно",
      "Свои",
    ]);
  });

  it("пропускает пустые группы", () => {
    expect(groupHarnessEntries([PI]).map((group) => group.key)).toEqual(["ready"]);
  });
});

describe("тексты harness", () => {
  it("называет встроенные записи по-русски, а карточку её названием", () => {
    expect(harnessLabel(PI)).toBe("Встроенный цикл");
    expect(harnessLabel(entry())).toBe("Claude Code в песочнице");
    expect(harnessLabel(entry({ id: "gemini" }))).toBe("Gemini CLI в песочнице");
    expect(
      harnessLabel(entry({ id: "aider-local", source: "card", label: "Aider через ACP" })),
    ).toBe("Aider через ACP");
    expect(HARNESS_LABELS["ai-sdk"]).toBe("AI SDK (устарел)");
  });

  it("описывает выбранный вариант", () => {
    expect(harnessDescription(PI)).toMatch(/Платформа сама ведёт ход/);
    expect(harnessDescription(entry())).toMatch(/ключа в VM нет/);
    expect(harnessDescription(entry({ id: "codex-acp", status: "unverified" }))).toBe(
      "Агент запускается так же, как Claude Code, но на нашем сервере этот путь не проверялся.",
    );
    expect(
      harnessDescription(
        entry({
          id: "aider-local",
          source: "card",
          status: "unverified",
          label: "Aider через ACP",
          acp: { agent: { id: "aider-local", command: "aider-acp" } },
        }),
      ),
    ).toBe("Свой ACP-агент из карточки. Запускается в VM окружения командой aider-acp. Не проверено.");
  });

  it("называет протоколы и статусы по-русски", () => {
    expect(protocolLabel("anthropic-messages")).toBe("Anthropic Messages");
    expect(protocolLabel("openai-chat")).toBe("OpenAI Chat Completions");
    expect(protocolLabel("openai-responses")).toBe("OpenAI Responses");
    expect(protocolLabel("gemini")).toBe("Gemini API");
    expect(protocolLabel("*")).toBe("Любой");
    expect(statusLabel("ready")).toBe("Готово");
    expect(statusLabel("unverified")).toBe("Не проверено");
    expect(statusLabel("unavailable")).toBe("Недоступно");
  });

  it("поясняет вкладки ACP: для Claude Code своё, для остальных по подписи", () => {
    expect(acpToolsNote(entry())).toBe(
      "Claude Code работает своими инструментами: Read, Write, Edit, Bash и другими. Разрешения задаёт список permissions.allow в переменной OMA_CLAUDE_SETTINGS, править её можно в режиме YAML. Настройки этой вкладки сохраняются, но в ходе не применяются.",
    );
    expect(acpToolsNote(entry({ id: "codex-acp" }))).toBe(
      "Codex в песочнице работает своими инструментами. Настройки этой вкладки сохраняются, но в ходе не применяются.",
    );
    expect(acpMcpNote(entry())).toBe(
      "MCP-серверы агента до Claude Code в песочнице не доходят: на этом сервере у ACP-агентов нет шлюза MCP. Настройки сохраняются, но в ходе не применяются.",
    );
    expect(ACP_EFFORT_NOTE).toBe("Усилие и скорость ACP-агенту не передаются");
    expect(ACP_SYSTEM_NOTE).toBe("ACP-агент пока не получает системный промпт");
  });
});
