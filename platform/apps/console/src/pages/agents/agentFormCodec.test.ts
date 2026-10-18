import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import type { ModelOption } from "../../lib/catalog-api";
import type { AgentRecord } from "../../types/agent";
import {
  INITIAL_FORM,
  agentToForm,
  applyModelChoice,
  agentToPreservedConfig,
  buildModelValue,
  configToForm,
  mergeFormIntoConfig,
  mergeMcpServers,
  mergeToolsField,
  materializeAgentUpdate,
  newMcpEntry,
  parseAgentConfigText,
  prepareCodePayload,
  writesMultiagent20261001,
  type FormState,
} from "./agentFormCodec";

function sampleAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent_1",
    type: "agent",
    name: "Coder",
    model: {
      id: "claude-sonnet-4-6",
      effort: { type: "high" },
      inference_geo: "us",
      speed: "fast",
      provider_options: { anthropic: { beta: ["context-1m"] } },
    },
    system: "Be helpful",
    version: 3,
    description: "desc",
    created_at: "2026-01-01T00:00:00.000Z",
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        configs: [{ name: "bash", enabled: true, permission_policy: { type: "always_ask" } }],
      },
      {
        type: "custom",
        name: "deploy",
        description: "Deploy app",
        input_schema: { type: "object", properties: {} },
      },
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: { permission_policy: { type: "always_ask" } },
      },
      { type: "future_toolset_2099", keep: true },
    ],
    mcp_servers: [
      {
        name: "github",
        type: "url",
        url: "https://mcp.example.test/github",
      },
    ],
    metadata: { team: "platform", owner: "alice" },
    ...overrides,
  } as AgentRecord;
}

describe("agentFormCodec lossless update", () => {
  it("rejects malformed or non-object YAML/JSON before an editor mode switch", () => {
    expect(() => parseAgentConfigText("name: [", "yaml")).toThrow(/некорректный yaml/i);
    expect(() => parseAgentConfigText("- name: coder", "yaml")).toThrow(/объектом/i);
    expect(() => parseAgentConfigText('"coder"', "json")).toThrow(/объектом/i);
    expect(parseAgentConfigText('{"name":"Coder"}', "json")).toEqual({ name: "Coder" });
  });

  it("preserves model.speed on a name-only edit", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    expect(form.model).toBe("claude-sonnet-4-6");
    expect(form.modelSpeed).toBe("fast");
    expect(form.modelEffort).toBe("high");
    expect(buildModelValue(form)).toEqual({
      id: "claude-sonnet-4-6",
      effort: "high",
      speed: "fast",
    });

    form.name = "Renamed";
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });
    expect(payload.name).toBe("Renamed");
    expect(payload.model).toEqual({
      id: "claude-sonnet-4-6",
      effort: { type: "high" },
      inference_geo: "us",
      speed: "fast",
      provider_options: { anthropic: { beta: ["context-1m"] } },
    });
  });

  it("merges tools without dropping custom / unknown / mcp policies", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.name = "Still Coder";

    const tools = mergeToolsField(agent.tools, form);
    expect(tools.some((t) => (t as { type?: string }).type === "custom")).toBe(true);
    expect(tools.some((t) => (t as { type?: string }).type === "future_toolset_2099")).toBe(
      true,
    );
    const mcp = tools.find(
      (t) =>
        (t as { type?: string }).type === "mcp_toolset" &&
        (t as { mcp_server_name?: string }).mcp_server_name === "github",
    ) as { default_config?: { permission_policy?: { type?: string } } };
    expect(mcp?.default_config?.permission_policy?.type).toBe("always_ask");

    const builtin = tools.find(
      (t) => (t as { type?: string }).type === "agent_toolset_20260401",
    ) as { configs?: Array<{ name: string }> };
    expect(builtin?.configs?.some((c) => c.name === "bash")).toBe(true);
  });

  it("keeps the original tool array order during an unrelated Form edit", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);

    expect(mergeToolsField(agent.tools, form)).toEqual(agent.tools);
  });

  it("preserves advanced built-in tool configuration on a name-only edit", () => {
    const agent = sampleAgent({
      mcp_servers: [],
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
          configs: [
            {
              type: "web_fetch",
              name: "web_fetch",
              enabled: true,
              permission_policy: { type: "always_ask" },
              allowed_domains: ["docs.example.test"],
              blocked_domains: ["private.example.test"],
              max_content_tokens: 4096,
            },
          ],
        },
      ],
    });
    const form = agentToForm(agent);
    form.name = "Renamed";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.tools).toEqual(agent.tools);
  });

  it("resets only form-owned tool policy while retaining advanced settings", () => {
    const agent = sampleAgent({
      mcp_servers: [],
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
          configs: [
            {
              type: "web_fetch",
              name: "web_fetch",
              enabled: true,
              permission_policy: { type: "always_ask" },
              allowed_domains: ["docs.example.test"],
              max_content_tokens: 4096,
            },
          ],
        },
      ],
    });
    const form = agentToForm(agent);
    form.toolOverrides.web_fetch = "default";

    const tools = mergeToolsField(agent.tools, form);

    expect(tools).toEqual([
      {
        type: "agent_toolset_20260401",
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        configs: [
          {
            type: "web_fetch",
            name: "web_fetch",
            allowed_domains: ["docs.example.test"],
            max_content_tokens: 4096,
          },
        ],
      },
    ]);
  });

  it("preserves a Managed URL MCP server", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    const merged = mergeMcpServers(agent.mcp_servers as unknown[], form.mcpServers);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      name: "github",
      type: "url",
      url: "https://mcp.example.test/github",
    });
  });

  it("round-trips the standard MCP stdio shape without HTTP adapter fields", () => {
    const agent = sampleAgent({
      mcp_servers: [{
        name: "workspace",
        type: "stdio",
        command: "/usr/local/bin/workspace-mcp",
        args: ["--root", "/workspace"],
        env: { LOG_LEVEL: "info" },
      }],
    } as Partial<AgentRecord>);

    const form = agentToForm(agent);
    expect(form.mcpServers).toEqual([{
      name: "workspace",
      originalName: "workspace",
      type: "stdio",
      url: "",
      command: "/usr/local/bin/workspace-mcp",
      argsJson: '["--root","/workspace"]',
      envJson: '{"LOG_LEVEL":"info"}',
      permission: "always_ask",
      toolExceptions: [],
    }]);
    expect(mergeMcpServers(agent.mcp_servers as unknown[], form.mcpServers)).toEqual([
      {
        name: "workspace",
        type: "stdio",
        command: "/usr/local/bin/workspace-mcp",
        args: ["--root", "/workspace"],
        env: { LOG_LEVEL: "info" },
      },
    ]);
  });

  it("preserves MCP config and tool policy when an existing server is renamed", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.mcpServers[0].name = "renamed-github";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.mcp_servers).toEqual([
      {
        name: "renamed-github",
        type: "url",
        url: "https://mcp.example.test/github",
      },
    ]);
    expect(payload.tools).toContainEqual({
      type: "mcp_toolset",
      mcp_server_name: "renamed-github",
      default_config: { permission_policy: { type: "always_ask" } },
    });
  });

  it("новому серверу MCP форма пишет «Всегда спрашивать», старому оставляет его политику", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.mcpServers.push(newMcpEntry("iiko", "https://mcp.example.test/iiko"));

    const tools = mergeToolsField(agent.tools, form);

    expect(tools).toContainEqual({
      type: "mcp_toolset",
      mcp_server_name: "iiko",
      default_config: { permission_policy: { type: "always_ask" } },
    });
    expect(tools).toContainEqual({
      type: "mcp_toolset",
      mcp_server_name: "github",
      default_config: { permission_policy: { type: "always_ask" } },
    });
  });

  it("round-trips official top-level fields through form update merge", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.description = "tweaked";
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });
    // Omission is the official update meaning for "preserve unchanged".
    expect(payload.metadata).toBeUndefined();
    expect(payload.description).toBe("tweaked");
    expect(payload.id).toBeUndefined();
    expect(payload.version).toBeUndefined();
  });

  it("edits metadata with update-patch deletion semantics", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    expect(JSON.parse(form.metadataJson)).toEqual({
      team: "platform",
      owner: "alice",
    });
    form.metadataJson = JSON.stringify({ owner: "bob", purpose: "review" });

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.metadata).toEqual({
      team: null,
      owner: "bob",
      purpose: "review",
    });
  });

  it("emits create metadata as a full object and rejects invalid form JSON", () => {
    const form = {
      ...INITIAL_FORM,
      name: "Coder",
      model: "deepseek-chat",
      metadataJson: '{"team":"platform"}',
    };
    expect(
      mergeFormIntoConfig(form, null, { forUpdate: false }).metadata,
    ).toEqual({ team: "platform" });

    form.metadataJson = "{";
    expect(() => mergeFormIntoConfig(form, null, { forUpdate: false })).toThrow(
      /json метаданных/i,
    );
  });

  it("keeps unsupported fields when Form state is re-merged after a mode switch baseline", () => {
    const agent = sampleAgent();
    const base = agentToPreservedConfig(agent);
    const form = agentToForm(agent);
    form.name = "After YAML peek";
    const afterForm = mergeFormIntoConfig(form, base, { forUpdate: true });
    const payload = mergeFormIntoConfig(
      { ...agentToForm(agent), name: "Final" },
      afterForm,
      { forUpdate: true },
    );
    expect(payload.name).toBe("Final");
    expect(payload.model).toEqual({
      id: "claude-sonnet-4-6",
      effort: { type: "high" },
      inference_geo: "us",
      speed: "fast",
      provider_options: { anthropic: { beta: ["context-1m"] } },
    });
    expect(
      (payload.tools as unknown[]).some((t) => (t as { type?: string }).type === "custom"),
    ).toBe(true);
    expect((payload.mcp_servers as Array<{ url?: unknown }>)[0]?.url).toBe(
      "https://mcp.example.test/github",
    );
    expect(payload.metadata).toEqual({ team: "platform", owner: "alice" });
  });

  it("materializes an update patch before switching back to Form mode", () => {
    const current = agentToPreservedConfig(
      sampleAgent({
        _oma: {
          aux_model: { id: "deepseek-chat" },
          harness: "pi",
        },
      }),
    );

    const materialized = materializeAgentUpdate(current, {
      metadata: { owner: "bob" },
      tools: null,
      _oma: { aux_model: null },
    });

    expect(materialized.metadata).toEqual({ team: "platform", owner: "bob" });
    expect(materialized.tools).toEqual([]);
    expect(materialized._oma).toEqual({ harness: "pi" });
  });

  it("does not carry provider-specific options onto a different model", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.model = "deepseek-chat";
    form.modelSpeed = "";
    form.modelEffort = "";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.model).toBe("deepseek-chat");
  });

  it("does not carry provider-specific options onto a different auxiliary model", () => {
    const agent = sampleAgent({
      _oma: {
        aux_model: {
          id: "claude-haiku-4-5",
          speed: "fast",
          provider_options: { anthropic: { beta: ["context-1m"] } },
        },
      },
    });
    const form = agentToForm(agent);
    form.auxiliaryModel = "deepseek-chat";
    form.auxiliaryModelSpeed = "";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload._oma).toEqual({ aux_model: { id: "deepseek-chat" } });
  });

  it("preserves advisor roster members that the Form does not edit", () => {
    const agent = sampleAgent({
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "agent", id: "agent_reviewer", version: 3 },
          { type: "advisor", model: "claude-haiku-4-5" },
        ],
      },
    });
    const form = agentToForm(agent);
    form.name = "Renamed";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload.multiagent).toEqual(agent.multiagent);
  });

  it("does not silently pin an unversioned callable agent to version 1", () => {
    const config = agentToPreservedConfig(sampleAgent());
    config.multiagent = {
      type: "coordinator",
      agents: [{ type: "agent", id: "agent_reviewer" }],
    };
    const form = configToForm(config);

    expect(form.callableAgents).toEqual([
      { type: "agent", id: "agent_reviewer" },
    ]);
    expect(
      mergeFormIntoConfig(form, config, { forUpdate: true })
        .multiagent,
    ).toEqual({
      type: "coordinator",
      agents: [{ type: "agent", id: "agent_reviewer" }],
    });
  });
});

describe("agent endpoint boundary", () => {
  it("preserves update omissions and explicit clears in code mode", () => {
    expect(
      prepareCodePayload({ model: "deepseek-chat" }, { forUpdate: true }),
    ).toEqual({ model: "deepseek-chat" });
    expect(
      prepareCodePayload({ tools: null }, { forUpdate: true }),
    ).toEqual({ tools: null });
  });

  it("requires a create name and only defaults omitted create tools", () => {
    expect(() =>
      prepareCodePayload({ model: "deepseek-chat" }, { forUpdate: false }),
    ).toThrow(/укажите название/i);
    expect(
      prepareCodePayload(
        { name: "Coder", model: "deepseek-chat" },
        { forUpdate: false },
      ),
    ).toEqual({
      name: "Coder",
      model: "deepseek-chat",
      tools: [{ type: "agent_toolset_20260401" }],
    });
    expect(
      prepareCodePayload(
        { name: "Coder", model: "deepseek-chat", tools: [] },
        { forUpdate: false },
      ),
    ).toEqual({ name: "Coder", model: "deepseek-chat", tools: [] });
  });

  it("emits only Managed Agent fields when editing a standard agent", () => {
    const agent = sampleAgent({
      mcp_servers: [],
    });
    const form = agentToForm(agent);
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload).not.toHaveProperty("_oma");
    expect(payload).not.toHaveProperty("runtime_binding");
    expect(payload).not.toHaveProperty("enable_general_subagent");
    expect(payload).not.toHaveProperty("type");
    expect(payload).not.toHaveProperty("created_at");
    expect(payload).not.toHaveProperty("updated_at");
  });

  it("round-trips typed OpenMA fields and emits explicit clears", () => {
    const agent = sampleAgent({
      _oma: {
        aux_model: { id: "deepseek-chat", speed: "fast" },
        appendable_prompts: ["prompt_review", "prompt_security"],
        harness: "pi",
      },
    });
    const form = agentToForm(agent);

    expect(form.auxiliaryModel).toBe("deepseek-chat");
    expect(form.auxiliaryModelSpeed).toBe("fast");
    expect(form.appendablePrompts).toEqual([
      "prompt_review",
      "prompt_security",
    ]);

    form.auxiliaryModel = "";
    form.auxiliaryModelSpeed = "";
    form.appendablePrompts = [];
    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload._oma).toEqual({
      aux_model: null,
      appendable_prompts: [],
      harness: "pi",
    });
  });
});

function modelOption(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    handle: "claude-sonnet-4-6",
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
    effort_levels: ["low", "medium", "high", "max"],
    speed_fast: true,
    ...overrides,
  };
}

describe("усилие модели в форме", () => {
  it("читает усилие объектом и строкой, у старых агентов без него поле пустое", () => {
    expect(agentToForm(sampleAgent()).modelEffort).toBe("high");
    expect(configToForm({ name: "A", model: { id: "m", effort: "xhigh" } }).modelEffort).toBe(
      "xhigh",
    );
    expect(configToForm({ name: "A", model: "m" }).modelEffort).toBe("");
    expect(INITIAL_FORM.modelEffort).toBe("");
  });

  it("пишет выбранное усилие строкой и убирает его, когда выбрано «По умолчанию»", () => {
    const form = { ...INITIAL_FORM, name: "A", model: "claude-sonnet-4-6", modelEffort: "high" as const };
    expect(buildModelValue(form)).toEqual({ id: "claude-sonnet-4-6", effort: "high" });

    expect(buildModelValue({ ...form, modelEffort: "" })).toBe("claude-sonnet-4-6");
    expect(
      buildModelValue(
        { ...form, modelEffort: "", modelSpeed: "fast" },
        { id: "claude-sonnet-4-6", effort: { type: "high" }, speed: "fast" },
      ),
    ).toEqual({ id: "claude-sonnet-4-6", speed: "fast" });
  });

  it("не трогает усилие, которое пользователь не менял, даже если API вернул его объектом", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.name = "Renamed";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), { forUpdate: true });

    expect((payload.model as { effort: unknown }).effort).toEqual({ type: "high" });
  });

  it("заменяет усилие на выбранное, остальные поля модели хранит", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.modelEffort = "low";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), { forUpdate: true });

    expect(payload.model).toEqual({
      id: "claude-sonnet-4-6",
      effort: "low",
      inference_geo: "us",
      speed: "fast",
      provider_options: { anthropic: { beta: ["context-1m"] } },
    });
  });

  it("YAML туда и обратно не теряет effort, speed и max_tokens", () => {
    const agent = sampleAgent({
      model: {
        id: "claude-sonnet-4-6",
        effort: { type: "high" },
        speed: "fast",
        max_tokens: 4096,
      },
    } as Partial<AgentRecord>);
    const form = agentToForm(agent);
    const config = mergeFormIntoConfig(form, agentToPreservedConfig(agent), { forUpdate: true });

    const text = yaml.dump(config, { lineWidth: -1 });
    const back = parseAgentConfigText(text, "yaml");
    const backForm = configToForm(back);
    const again = mergeFormIntoConfig(backForm, back, { forUpdate: true });

    expect(backForm.modelEffort).toBe("high");
    expect(backForm.modelSpeed).toBe("fast");
    expect(again.model).toEqual({
      id: "claude-sonnet-4-6",
      effort: { type: "high" },
      speed: "fast",
      max_tokens: 4096,
    });
  });
});

describe("смена модели", () => {
  it("сохраняет усилие и скорость, если новая модель их поддерживает", () => {
    const form = { ...INITIAL_FORM, model: "a", modelEffort: "high" as const, modelSpeed: "fast" as const };

    const result = applyModelChoice(
      form,
      modelOption({ handle: "b", effort_levels: ["medium", "high"], speed_fast: true }),
    );

    expect(result.form.model).toBe("b");
    expect(result.form.modelEffort).toBe("high");
    expect(result.form.modelSpeed).toBe("fast");
    expect(result.effortReset).toBe(false);
    expect(result.speedReset).toBe(false);
  });

  it("сбрасывает усилие на модели без такого уровня и пишет об этом", () => {
    const form = { ...INITIAL_FORM, model: "a", modelEffort: "max" as const };

    const result = applyModelChoice(form, modelOption({ handle: "b", effort_levels: ["low", "medium"] }));

    expect(result.form.modelEffort).toBe("");
    expect(result.effortReset).toBe(true);
  });

  it("сбрасывает усилие на модели без уровней вовсе", () => {
    const form = { ...INITIAL_FORM, model: "a", modelEffort: "low" as const };

    const result = applyModelChoice(form, modelOption({ handle: "plain", effort_levels: [] }));

    expect(result.form.modelEffort).toBe("");
    expect(result.effortReset).toBe(true);
  });

  it("сбрасывает быструю скорость, если модель её не поддерживает", () => {
    const form = { ...INITIAL_FORM, model: "a", modelSpeed: "fast" as const };

    const result = applyModelChoice(form, modelOption({ handle: "b", speed_fast: false }));

    expect(result.form.modelSpeed).toBe("");
    expect(result.speedReset).toBe(true);
  });

  it("не сообщает о сбросе, когда усилия и скорости не было", () => {
    const result = applyModelChoice({ ...INITIAL_FORM, model: "a" }, modelOption({ handle: "b", effort_levels: [], speed_fast: false }));

    expect(result.effortReset).toBe(false);
    expect(result.speedReset).toBe(false);
  });

  it("запоминает карточку выбранной модели", () => {
    expect(applyModelChoice(INITIAL_FORM, modelOption({ card_id: "mc_9" })).form.modelCardId).toBe(
      "mc_9",
    );
    expect(
      applyModelChoice(INITIAL_FORM, modelOption({ source: "builtin", card_id: null })).form
        .modelCardId,
    ).toBe("");
  });
});

const ACP_BLOCK = {
  agent: { id: "claude-acp", command: "sh", args: ["-c", "exec claude-agent-acp"] },
  per_turn_timeout_ms: 600000,
};

/** Агент из старой базы: в `_oma` ещё лежат поля, которых в контракте больше нет. */
function legacyAgent(openma: Record<string, unknown>, overrides: Record<string, unknown> = {}): AgentRecord {
  return sampleAgent({ _oma: openma, ...overrides } as unknown as Partial<AgentRecord>);
}

describe("старый harness агента", () => {
  it("в состоянии формы нет выбора harness", () => {
    expect(INITIAL_FORM).not.toHaveProperty("harness");
    expect(INITIAL_FORM).not.toHaveProperty("harnessAcp");
    expect(agentToForm(legacyAgent({ harness: "acp-sandbox", acp: ACP_BLOCK }))).not.toHaveProperty("harness");
  });

  it("изменение ACP-агента переводит его на pi, блок acp не уходит, остальной _oma цел", () => {
    const agent = legacyAgent(
      {
        harness: "acp-sandbox",
        acp: ACP_BLOCK,
        aux_model: { id: "haiku" },
        appendable_prompts: ["p1"],
      },
      { model: { id: "claude-sonnet-4-6" } },
    );
    const form = agentToForm(agent);
    form.name = "Renamed";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), { forUpdate: true });

    expect(payload._oma).toEqual({
      harness: "pi",
      aux_model: { id: "haiku" },
      appendable_prompts: ["p1"],
    });
  });

  it("устаревший ai-sdk и acp-proxy при изменении тоже становятся pi", () => {
    for (const harness of ["ai-sdk", "acp-proxy"]) {
      const agent = legacyAgent({ harness });
      const payload = mergeFormIntoConfig(agentToForm(agent), agentToPreservedConfig(agent), {
        forUpdate: true,
      });
      expect(payload._oma).toEqual({ harness: "pi" });
    }
  });

  it("явные pi и default остаются как есть", () => {
    for (const harness of ["pi", "default"]) {
      const agent = legacyAgent({ harness });
      const payload = mergeFormIntoConfig(agentToForm(agent), agentToPreservedConfig(agent), {
        forUpdate: true,
      });
      expect(payload._oma).toEqual({ harness });
    }
  });

  it("runtime_binding в _oma форма не отправляет", () => {
    const agent = legacyAgent({
      runtime_binding: { runtime_id: "rt_1", acp_agent_id: "codex-acp" },
      appendable_prompts: ["p1"],
    });

    const payload = mergeFormIntoConfig(agentToForm(agent), agentToPreservedConfig(agent), {
      forUpdate: true,
    });

    expect(payload._oma).toEqual({ appendable_prompts: ["p1"] });
  });

  it("при создании из YAML со старым harness убирает harness и acp вместе с пустым _oma", () => {
    const base = parseAgentConfigText(
      "name: Coder\nmodel: claude-sonnet-4-6\n_oma:\n  harness: acp-sandbox\n  acp:\n    agent:\n      command: sh\n",
      "yaml",
    );

    const payload = mergeFormIntoConfig(configToForm(base), base, { forUpdate: false });

    expect(payload).not.toHaveProperty("_oma");
  });

  it("усилие, скорость, инструменты и MCP старого ACP-агента сохраняются", () => {
    const agent = legacyAgent({ harness: "acp-sandbox", acp: ACP_BLOCK });
    const form = agentToForm(agent);

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), { forUpdate: true });

    expect(payload.model).toMatchObject({ id: "claude-sonnet-4-6", effort: { type: "high" }, speed: "fast" });
    expect(
      (payload.tools as unknown[]).some((t) => (t as { type?: string }).type === "custom"),
    ).toBe(true);
    expect((payload.mcp_servers as Array<{ name: string }>)[0]?.name).toBe("github");
  });
});

describe("разрешение MCP-сервера в форме (план cma-wave-1, 3.1, срез 6)", () => {
  function iikoAgent(toolset?: Record<string, unknown>): AgentRecord {
    return sampleAgent({
      mcp_servers: [{ name: "iiko", type: "url", url: "https://mcp.example.test/iiko" }],
      tools: [{ type: "agent_toolset_20260401" }, ...(toolset ? [toolset] : [])],
    } as unknown as Partial<AgentRecord>);
  }

  it("читает разрешение сервера и исключения, чужие строки configs исключениями не считает", () => {
    const form = agentToForm(iikoAgent({
      type: "mcp_toolset",
      mcp_server_name: "iiko",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      configs: [
        { name: "read_report", permission_policy: { type: "always_allow" } },
        { name: "write_act", enabled: true, permission_policy: { type: "always_ask" } },
        { name: "drop_all", enabled: false },
      ],
    }));

    expect(form.mcpServers[0]).toMatchObject({
      permission: "always_allow",
      toolExceptions: [
        { name: "read_report", permission: "always_allow" },
        { name: "write_act", permission: "always_ask" },
      ],
    });
  });

  it("набор без политики и сервер без набора форма читает как «Всегда спрашивать»", () => {
    const noPolicy = agentToForm(iikoAgent({ type: "mcp_toolset", mcp_server_name: "iiko" }));
    const noToolset = agentToForm(iikoAgent());

    expect(noPolicy.mcpServers[0]).toMatchObject({ permission: "always_ask", toolExceptions: [] });
    expect(noToolset.mcpServers[0]).toMatchObject({ permission: "always_ask", toolExceptions: [] });
  });

  it("правка разрешения и исключений сохраняет чужие строки configs и поля набора", () => {
    const agent = iikoAgent({
      type: "mcp_toolset",
      mcp_server_name: "iiko",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      configs: [
        { name: "read_report", permission_policy: { type: "always_allow" } },
        { name: "write_act", enabled: true, permission_policy: { type: "always_allow" } },
        { name: "drop_all", enabled: false },
      ],
    });
    const form = agentToForm(agent);
    form.mcpServers[0].permission = "always_ask";
    form.mcpServers[0].toolExceptions = [
      { name: "write_act", permission: "always_ask" },
      { name: "list_acts", permission: "always_allow" },
    ];

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), { forUpdate: true });

    expect(payload.tools).toContainEqual({
      type: "mcp_toolset",
      mcp_server_name: "iiko",
      default_config: { enabled: true, permission_policy: { type: "always_ask" } },
      configs: [
        { name: "write_act", enabled: true, permission_policy: { type: "always_ask" } },
        { name: "drop_all", enabled: false },
        { name: "list_acts", permission_policy: { type: "always_allow" } },
      ],
    });
  });

  it("правка имени агента отправляет набор без политики как есть", () => {
    const toolset = { type: "mcp_toolset", mcp_server_name: "iiko", configs: [] };
    const agent = iikoAgent(toolset);
    const form = agentToForm(agent);
    form.name = "Другое имя";

    expect(mergeToolsField(agent.tools, form)).toContainEqual(toolset);
  });

  it("новый сервер с исключением получает строку configs, пустое имя исключения не уходит", () => {
    const agent = sampleAgent();
    const form = agentToForm(agent);
    form.mcpServers.push({
      name: "iiko",
      type: "url",
      url: "https://mcp.example.test/iiko",
      command: "",
      argsJson: "[]",
      envJson: "{}",
      permission: "always_ask",
      toolExceptions: [
        { name: "read_report", permission: "always_allow" },
        { name: "  ", permission: "always_allow" },
      ],
    });

    expect(mergeToolsField(agent.tools, form)).toContainEqual({
      type: "mcp_toolset",
      mcp_server_name: "iiko",
      default_config: { permission_policy: { type: "always_ask" } },
      configs: [{ name: "read_report", permission_policy: { type: "always_allow" } }],
    });
  });
});

describe("мультиагент: оба типа блока (план multiagent, 3.2, срез 4)", () => {
  const WORKFLOWS = {
    type: "enabled",
    inline_agents: { type: "enabled" },
    predefined_agents: [{ type: "agent", id: "agent_batch", version: 1 }],
  };

  /** Агент `agent_1` с блоком нового типа: себя сервер отдаёт своим id и версией. */
  function newTypeAgent(): AgentRecord {
    return sampleAgent({
      multiagent: {
        type: "multiagent_20261001",
        subagents: {
          type: "enabled",
          inline_agents: { type: "disabled" },
          predefined_agents: [
            { type: "agent", id: "agent_reviewer", version: 3 },
            { type: "agent", id: "agent_1", version: 2 },
          ],
        },
        workflows: structuredClone(WORKFLOWS),
        advisor: { type: "enabled", model: "verify-oai" },
      } as unknown as AgentRecord["multiagent"],
    });
  }

  function coordinatorAgent(): AgentRecord {
    return sampleAgent({
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "agent", id: "agent_reviewer", version: 3 },
          { type: "advisor", model: "verify-oai" },
          { type: "agent", id: "agent_1", version: 2 },
        ],
      },
      _oma: { enable_general_subagent: true },
    });
  }

  function multiagentOf(form: FormState, agent: AgentRecord): unknown {
    return mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
      ownId: agent.id,
    }).multiagent;
  }

  it("читает coordinator: агентов с версией, себя по своему id и советника", () => {
    const form = agentToForm(coordinatorAgent());

    expect(form.callableAgents).toEqual([{ type: "agent", id: "agent_reviewer", version: 3 }]);
    expect(form.selfCallable).toBe(true);
    expect(form.advisorModel).toBe("verify-oai");
    expect(form.inlineAgents).toBe(false);
  });

  it("читает multiagent_20261001: список субагентов, себя, inline и советника", () => {
    const form = agentToForm(newTypeAgent());

    expect(form.callableAgents).toEqual([{ type: "agent", id: "agent_reviewer", version: 3 }]);
    expect(form.selfCallable).toBe(true);
    expect(form.inlineAgents).toBe(false);
    expect(form.advisorModel).toBe("verify-oai");
  });

  it("YAML нового типа: строка с id и self читаются, пропущенные настройки берут умолчания CMA", () => {
    const form = configToForm({
      name: "Из YAML",
      multiagent: {
        type: "multiagent_20261001",
        subagents: { type: "enabled", predefined_agents: ["agent_reviewer", { type: "self" }] },
      },
    });

    expect(form.callableAgents).toEqual([{ type: "agent", id: "agent_reviewer" }]);
    expect(form.selfCallable).toBe(true);
    expect(form.inlineAgents).toBe(true);
    expect(form.advisorModel).toBe("");
    expect(configToForm({ multiagent: { type: "multiagent_20261001" } }).inlineAgents).toBe(true);
    expect(
      configToForm({ multiagent: { type: "multiagent_20261001", subagents: { type: "disabled" } } })
        .inlineAgents,
    ).toBe(false);
  });

  it("правка имени агента нового типа пишет тот же тип: workflows, закрепления и чужие поля целы, сам агент уходит как self", () => {
    const agent = newTypeAgent();
    const preserved = agentToPreservedConfig(agent);
    const block = preserved.multiagent as { subagents: Record<string, unknown> };
    block.subagents.note = "чужое поле";
    const form = configToForm(preserved, agent.id);
    form.name = "Renamed";

    const payload = mergeFormIntoConfig(form, preserved, { forUpdate: true, ownId: agent.id });

    expect(payload.multiagent).toEqual({
      type: "multiagent_20261001",
      subagents: {
        type: "enabled",
        note: "чужое поле",
        inline_agents: { type: "disabled" },
        predefined_agents: [
          { type: "agent", id: "agent_reviewer", version: 3 },
          { type: "self" },
        ],
      },
      workflows: WORKFLOWS,
      advisor: { type: "enabled", model: "verify-oai" },
    });
    expect(payload).not.toHaveProperty("_oma");
  });

  it("сам агент в списке workflows уходит как self: свой id сервер в списке не примет", () => {
    const agent = newTypeAgent();
    const block = agent.multiagent as unknown as { workflows: { predefined_agents: unknown[] } };
    block.workflows.predefined_agents.push({ type: "agent", id: "agent_1", version: 2 });
    const form = agentToForm(agent);
    form.name = "Renamed";

    expect(multiagentOf(form, agent)).toMatchObject({
      workflows: {
        type: "enabled",
        inline_agents: { type: "enabled" },
        predefined_agents: [{ type: "agent", id: "agent_batch", version: 1 }, { type: "self" }],
      },
    });
  });

  it("форма меняет inline и советника нового типа, пустой список без inline даёт subagents disabled", () => {
    const agent = newTypeAgent();
    const form = agentToForm(agent);
    form.inlineAgents = true;
    form.advisorModel = "";

    expect(multiagentOf(form, agent)).toMatchObject({
      subagents: { type: "enabled", inline_agents: { type: "enabled" } },
      workflows: WORKFLOWS,
      advisor: { type: "disabled" },
    });

    form.callableAgents = [];
    form.selfCallable = false;
    form.inlineAgents = false;
    expect(multiagentOf(form, agent)).toEqual({
      type: "multiagent_20261001",
      subagents: { type: "disabled" },
      workflows: WORKFLOWS,
      advisor: { type: "disabled" },
    });

    form.inlineAgents = true;
    expect(multiagentOf(form, agent)).toMatchObject({
      subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [] },
    });
  });

  it("новый агент из формы пишет coordinator с собой и советником (решение 5)", () => {
    const form: FormState = {
      ...INITIAL_FORM,
      name: "Координатор",
      model: "verify-fake",
      callableAgents: [{ type: "agent", id: "agent_reviewer" }],
      selfCallable: true,
      advisorModel: "verify-oai",
    };

    const payload = mergeFormIntoConfig(form, null, { forUpdate: false });

    expect(payload.multiagent).toEqual({
      type: "coordinator",
      agents: [
        { type: "agent", id: "agent_reviewer" },
        { type: "self" },
        { type: "advisor", model: "verify-oai" },
      ],
    });
    expect(payload).not.toHaveProperty("_oma");
  });

  it("правка coordinator: свой id становится self на своём месте, советник меняется на месте, _oma цел", () => {
    const agent = coordinatorAgent();
    const form = agentToForm(agent);
    form.advisorModel = "verify-fake";

    const payload = mergeFormIntoConfig(form, agentToPreservedConfig(agent), {
      forUpdate: true,
      ownId: agent.id,
    });

    expect(payload.multiagent).toEqual({
      type: "coordinator",
      agents: [
        { type: "agent", id: "agent_reviewer", version: 3 },
        { type: "advisor", model: "verify-fake" },
        { type: "self" },
      ],
    });
    expect(payload._oma).toEqual({ enable_general_subagent: true });
  });

  it("coordinator без агентов, себя и советника на правке снимает блок", () => {
    const agent = coordinatorAgent();
    const form = agentToForm(agent);
    form.callableAgents = [];
    form.selfCallable = false;
    form.advisorModel = "";

    expect(multiagentOf(form, agent)).toBeNull();
  });

  it("агент, выбранный в списке как он сам, уходит как self", () => {
    const agent = sampleAgent();
    const form: FormState = {
      ...agentToForm(agent),
      callableAgents: [{ type: "agent", id: agent.id, version: 3 }],
    };

    expect(multiagentOf(form, agent)).toEqual({ type: "coordinator", agents: [{ type: "self" }] });
  });

  it("форма пишет новый тип только агенту, у которого он уже есть", () => {
    expect(writesMultiagent20261001(agentToPreservedConfig(newTypeAgent()))).toBe(true);
    expect(writesMultiagent20261001(agentToPreservedConfig(coordinatorAgent()))).toBe(false);
    expect(writesMultiagent20261001(agentToPreservedConfig(sampleAgent()))).toBe(false);
    expect(writesMultiagent20261001(null)).toBe(false);
  });
});
