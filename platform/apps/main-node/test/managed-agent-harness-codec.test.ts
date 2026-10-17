import { describe, expect, it } from "vitest";
import { getToolPermission } from "@open-managed-agents/agent/harness/tools";
import type { Session } from "@open-managed-agents/managed-agents-application";
import * as managedAgentCodec from "../src/lib/node-managed-agent-codec.js";
import {
  allowAllLegacyHarnessTools,
  toLegacyHarnessAgentConfig,
} from "../src/lib/node-managed-agent-codec.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_coordinator",
    description: null,
    mcpServers: [
      { type: "url", name: "docs", url: "https://mcp.example.test" },
    ],
    model: {
      id: "claude-opus-5",
      effort: "high",
      inferenceGeo: "us",
      providerOptions: {
        pi: { reasoning: "high", sampling: { temperature: 0 } },
      },
      speed: "fast",
    },
    multiagent: {
      type: "coordinator",
      agents: [
        {
          type: "agent",
          id: "agent_reviewer",
          description: null,
          mcpServers: [],
          model: { id: "claude-sonnet-4-6" },
          name: "Reviewer",
          skills: [],
          system: null,
          tools: [],
          version: 7,
        },
        { type: "advisor", model: "claude-haiku-4-5" },
      ],
    },
    name: "Coordinator",
    openma: {
      auxiliaryModel: {
        id: "deepseek-chat",
        providerOptions: { pi: { reasoning: "off" } },
        speed: "fast",
      },
      appendablePrompts: ["prompt_review"],
      harness: "pi",
      enableGeneralSubagent: true,
    },
    skills: [{ type: "custom", skillId: "skill_review", version: "3" }],
    system: "Coordinate carefully",
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [
          {
            type: "web_search",
            name: "web_search",
            enabled: true,
            permissionPolicy: { type: "always_ask" },
            allowedDomains: ["docs.example.com"],
            blockedDomains: ["private.example.com"],
            userLocation: {
              type: "approximate",
              city: "Shanghai",
              timezone: "Asia/Shanghai",
            },
          },
        ],
        defaultConfig: {
          enabled: false,
          permissionPolicy: { type: "always_allow" },
        },
      },
      {
        type: "mcp_toolset",
        mcpServerName: "docs",
        configs: [
          {
            name: "search",
            enabled: true,
            permissionPolicy: { type: "always_ask" },
          },
        ],
        defaultConfig: {
          enabled: true,
          permissionPolicy: { type: "always_allow" },
        },
      },
      {
        type: "custom",
        name: "release",
        description: "Release the service",
        inputSchema: {
          type: "object",
          properties: { tag: { type: "string" } },
          required: ["tag"],
        },
      },
    ],
    version: 4,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:01.000Z",
  usage: {},
  vaultIds: [],
};

describe("managed Agent to legacy Node harness codec", () => {
  it("resolves the pinned auxiliary model for tool execution", async () => {
    const resolveAuxiliary = (managedAgentCodec as Record<string, unknown>)
      .resolveNodeManagedAuxiliaryToolModel as undefined | ((
        session: Session,
        buildModel: (model: Session["agent"]["model"]) => Promise<unknown>,
      ) => Promise<unknown>);
    expect(resolveAuxiliary).toBeTypeOf("function");
    if (resolveAuxiliary === undefined) return;
    const selectedModels: Session["agent"]["model"][] = [];
    const model = { provider: "test-model" };

    await expect(resolveAuxiliary(session, async (selected) => {
      selectedModels.push(selected);
      return model;
    })).resolves.toEqual({
      model,
      modelInfo: { model_id: "deepseek-chat" },
      providerOptions: { pi: { reasoning: "off" } },
    });
    expect(selectedModels).toEqual([{
      id: "deepseek-chat",
      providerOptions: { pi: { reasoning: "off" } },
      speed: "fast",
    }]);
  });

  it("projects Environment networking policy for the shared harness tools", () => {
    const encodeEnvironment = (managedAgentCodec as Record<string, unknown>)
      .toLegacyHarnessEnvironmentConfig as undefined | ((environment: unknown) => unknown);
    expect(encodeEnvironment).toBeTypeOf("function");
    if (encodeEnvironment === undefined) return;

    expect(encodeEnvironment({
      id: "env_limited",
      archivedAt: null,
      config: {
        type: "cloud",
        networking: {
          type: "limited",
          allowMcpServers: false,
          allowPackageManagers: true,
          allowedHosts: ["api.example.test"],
        },
        packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
      },
      createdAt: "2026-09-09T00:00:00.000Z",
      description: null,
      metadata: {},
      name: "Limited",
      updatedAt: "2026-09-09T00:00:00.000Z",
    })).toEqual({
      networking: {
        type: "limited",
        allow_mcp_servers: false,
        allow_package_managers: true,
        allowed_hosts: ["api.example.test"],
      },
    });
  });

  it("encodes application-native resolved definitions at the final adapter", () => {
    expect(toLegacyHarnessAgentConfig(session)).toEqual({
      id: "agent_coordinator",
      name: "Coordinator",
      model: {
        id: "claude-opus-5",
        effort: "high",
        inference_geo: "us",
        provider_options: {
          pi: { reasoning: "high", sampling: { temperature: 0 } },
        },
        speed: "fast",
      },
      system: "Coordinate carefully",
      tools: [
        {
          type: "agent_toolset_20260401",
          configs: [
            {
              type: "web_search",
              name: "web_search",
              enabled: true,
              permission_policy: { type: "always_ask" },
              allowed_domains: ["docs.example.com"],
              blocked_domains: ["private.example.com"],
              user_location: {
                type: "approximate",
                city: "Shanghai",
                timezone: "Asia/Shanghai",
              },
            },
          ],
          default_config: {
            enabled: false,
            permission_policy: { type: "always_allow" },
          },
        },
        {
          type: "mcp_toolset",
          mcp_server_name: "docs",
          configs: [
            {
              name: "search",
              enabled: true,
              permission_policy: { type: "always_ask" },
            },
          ],
          default_config: {
            enabled: true,
            permission_policy: { type: "always_allow" },
          },
        },
        {
          type: "custom",
          name: "release",
          description: "Release the service",
          input_schema: {
            type: "object",
            properties: { tag: { type: "string" } },
            required: ["tag"],
          },
        },
      ],
      mcp_servers: [
        { type: "url", name: "docs", url: "https://mcp.example.test" },
      ],
      skills: [{ type: "custom", skill_id: "skill_review", version: "3" }],
      callable_agents: [
        { type: "agent", id: "agent_reviewer", version: 7 },
      ],
      multiagent: {
        type: "coordinator",
        agents: [
          { type: "agent", id: "agent_reviewer", version: 7 },
          { type: "advisor", model: "claude-haiku-4-5" },
        ],
      },
      aux_model: {
        id: "deepseek-chat",
        provider_options: { pi: { reasoning: "off" } },
        speed: "fast",
      },
      appendable_prompts: ["prompt_review"],
      harness: "pi",
      enable_general_subagent: true,
      version: 4,
      created_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:01.000Z",
    });
  });

  it("passes a legacy harness name to the registry and drops stored ACP fields (D41)", () => {
    const legacy = {
      ...session,
      agent: {
        ...session.agent,
        openma: {
          harness: "acp-sandbox",
          // Fields of an agent saved before D41; the domain no longer has them.
          acp: { agent: { id: "claude-acp", command: "claude-agent-acp" } },
          runtimeBinding: { runtimeId: "runtime_local", acpAgentId: "claude-acp" },
        },
      },
    } as unknown as Session;
    const encoded = toLegacyHarnessAgentConfig(legacy) as unknown as Record<string, unknown>;
    expect(encoded.harness).toBe("acp-sandbox");
    expect(encoded).not.toHaveProperty("acp");
    expect(encoded).not.toHaveProperty("runtime_binding");
  });

  it("creates a non-mutating executable copy for confirmed tool execution", () => {
    const encoded = toLegacyHarnessAgentConfig(session);
    const executable = allowAllLegacyHarnessTools(encoded);

    expect(executable.tools.slice(0, 2)).toMatchObject([
      {
        default_config: { permission_policy: { type: "always_allow" } },
        configs: [
          { name: "web_search", permission_policy: { type: "always_allow" } },
        ],
      },
      {
        default_config: { permission_policy: { type: "always_allow" } },
        configs: [
          { name: "search", permission_policy: { type: "always_allow" } },
        ],
      },
    ]);
    expect(encoded.tools.slice(0, 2)).toMatchObject([
      {
        default_config: { permission_policy: { type: "always_allow" } },
        configs: [
          { name: "web_search", permission_policy: { type: "always_ask" } },
        ],
      },
      {
        default_config: { permission_policy: { type: "always_allow" } },
        configs: [
          { name: "search", permission_policy: { type: "always_ask" } },
        ],
      },
    ]);
  });

  it("gives an allowing toolset to an MCP server that has none, so a confirmed call can run", () => {
    const withBareServer: Session = {
      ...session,
      agent: {
        ...session.agent,
        mcpServers: [
          ...session.agent.mcpServers,
          { type: "url", name: "iiko", url: "https://iiko.example.test/mcp" },
        ],
      },
    };
    const encoded = toLegacyHarnessAgentConfig(withBareServer);
    const executable = allowAllLegacyHarnessTools(encoded);
    const asHarness = (agent: typeof encoded) =>
      agent as unknown as Parameters<typeof getToolPermission>[0];

    expect(getToolPermission(asHarness(encoded), "mcp__iiko__write_act")).toBe("always_ask");
    expect(getToolPermission(asHarness(executable), "mcp__iiko__write_act")).toBe("always_allow");
    // The new entry goes last: the first non-custom entry still picks the builtins.
    expect(executable.tools.map((tool) => tool.type)).toEqual([
      "agent_toolset_20260401",
      "mcp_toolset",
      "custom",
      "mcp_toolset",
    ]);
    expect(executable.tools[3]).toEqual({
      type: "mcp_toolset",
      mcp_server_name: "iiko",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      configs: [],
    });
    expect(encoded.tools).toHaveLength(3);
  });
});
