// The agent config an acp-sandbox turn runs with (docs/plans/models-harness.md,
// 5.7 and 5.8). An agent snapshot saved before the guard can still carry a
// model key in its ACP env; the turn must not hand it to the VM.

import { describe, expect, it } from "vitest";

import {
  acpTurnAgent,
  type AcpTurnAgent,
  type AcpTurnInference,
} from "../src/lib/models-harness-wiring";

const builtin: AcpTurnInference = {
  kind: "builtin",
  hostedInference: {
    gatewayBaseUrl: "http://host.boxlite.internal:8795",
    sessionsToken: "oma_sbx_turn",
    model: { providerId: "anthropic", baseUrl: null, protocolEndpoints: [] },
  },
};

const CARD_ENV = {
  OMA_INFERENCE_PROTOCOL: "openai-chat",
  OMA_INFERENCE_BASE_URL: "http://gw/v1/oma/inference-proxy/ses_1/openai/v1",
  OMA_INFERENCE_TOKEN: "oma_sbx_turn",
  OMA_MODEL: "verify-oai",
  OPENAI_BASE_URL: "http://gw/v1/oma/inference-proxy/ses_1/openai/v1",
  OPENAI_API_KEY: "oma_sbx_turn",
  OPENAI_MODEL: "verify-oai",
};

const card: AcpTurnInference = { kind: "card", env: CARD_ENV };

function agentWithEnv(env?: Record<string, string>, id = "claude-acp"): AcpTurnAgent {
  return {
    model: "verify-fake",
    harness: "acp-sandbox",
    acp: {
      agent: { id, command: "sh", args: ["-c", "exec claude-agent-acp"], ...(env === undefined ? {} : { env }) },
      per_turn_timeout_ms: 600_000,
    },
  };
}

const OLD_KEYS = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-old",
  ANTHROPIC_API_KEY: "sk-ant-api03-old",
  ANTHROPIC_AUTH_TOKEN: "old-auth-token",
  OPENAI_API_KEY: "sk-old-openai",
  GEMINI_API_KEY: "AIza-old",
};

describe("acpTurnAgent", () => {
  it("drops model keys of an old snapshot before a built-in entry turn", () => {
    const agent = agentWithEnv({ ...OLD_KEYS, OMA_CLAUDE_SETTINGS: "{}", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    const before = structuredClone(agent);

    const turn = acpTurnAgent(agent, builtin);

    expect(turn.acp?.agent.env).toEqual({ OMA_CLAUDE_SETTINGS: "{}", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    expect(turn.acp?.agent).toMatchObject({ id: "claude-acp", command: "sh", args: ["-c", "exec claude-agent-acp"] });
    expect(turn.acp?.per_turn_timeout_ms).toBe(600_000);
    expect(agent).toEqual(before);
  });

  it("lays the card variables over an env without the old keys", () => {
    const agent = agentWithEnv({ ...OLD_KEYS, AIDER_AUTO_COMMITS: "false" }, "aider-local");

    const turn = acpTurnAgent(agent, card);

    expect(turn.acp?.agent.env).toEqual({ AIDER_AUTO_COMMITS: "false", ...CARD_ENV });
    expect(JSON.stringify(turn)).not.toMatch(/sk-ant-oat01-old|sk-ant-api03-old|old-auth-token|sk-old-openai|AIza-old/);
  });

  it("returns the same config when there is nothing to drop, so the ACP checkpoint still matches", () => {
    const clean = agentWithEnv({ OMA_CLAUDE_SETTINGS: "{}" });
    const bare = agentWithEnv();
    expect(acpTurnAgent(clean, builtin)).toBe(clean);
    expect(acpTurnAgent(bare, builtin)).toBe(bare);
  });
});
