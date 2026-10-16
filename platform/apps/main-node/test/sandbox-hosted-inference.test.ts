// What a turn of an ACP agent in the VM gets to reach the model through the
// hosted inference proxy: the gateway address, `hostedInference` for built-in
// entries with a model adapter, and plain variables for a harness card.

import { describe, expect, it } from "vitest";

import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import { parseHostedInferenceSubPath } from "@open-managed-agents/inference-proxy";

import {
  buildSandboxHostedInference,
  cardInferenceEnv,
  normalizeSandboxGatewayBaseUrl,
  resolveSandboxGatewayBaseUrl,
  selectTurnProtocol,
} from "../src/lib/sandbox-hosted-inference";

const GATEWAY = "http://host.boxlite.internal:8795";

describe("buildSandboxHostedInference", () => {
  it("gives a model card the proxy endpoints of its provider", () => {
    const hosted = buildSandboxHostedInference({
      gatewayBaseUrl: GATEWAY,
      token: "oma_sbx_turn",
      upstream: { provider: "anthropic", baseURL: "https://fake.test" },
    });

    expect(hosted).toEqual({
      gatewayBaseUrl: GATEWAY,
      sessionsToken: "oma_sbx_turn",
      model: {
        providerId: "anthropic",
        baseUrl: "https://fake.test",
        protocolEndpoints: [{
          protocol: "anthropic-messages",
          proxyPathSegment: "anthropic",
          upstreamBaseUrl: "https://fake.test",
        }],
      },
    });
  });

  it("treats the server key as Anthropic with the server base URL or none", () => {
    const withoutBase = buildSandboxHostedInference({
      gatewayBaseUrl: GATEWAY,
      token: "oma_sbx_turn",
      upstream: {},
    });
    const withBase = buildSandboxHostedInference({
      gatewayBaseUrl: GATEWAY,
      token: "oma_sbx_turn",
      upstream: { baseURL: "https://gateway.example/v1" },
    });

    expect(withoutBase.model).toEqual({
      providerId: "anthropic",
      baseUrl: null,
      protocolEndpoints: [{
        protocol: "anthropic-messages",
        proxyPathSegment: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
      }],
    });
    expect(withBase.model.baseUrl).toBe("https://gateway.example/v1");
    expect(withBase.model.protocolEndpoints[0].upstreamBaseUrl).toBe("https://gateway.example");
  });

  it("gives a DeepSeek card both of its protocols", () => {
    const hosted = buildSandboxHostedInference({
      gatewayBaseUrl: GATEWAY,
      token: "oma_sbx_turn",
      upstream: { provider: "deepseek" },
    });

    expect(hosted.model.protocolEndpoints.map((endpoint) => endpoint.protocol))
      .toEqual(["openai-chat", "anthropic-messages"]);
  });

  it("fits the hostedInference slot of the harness context", () => {
    const hosted: NonNullable<HarnessContext["env"]["hostedInference"]> = buildSandboxHostedInference({
      gatewayBaseUrl: GATEWAY,
      token: "oma_sbx_turn",
      upstream: { provider: "anthropic", baseURL: null },
    });
    expect(hosted.model?.providerId).toBe("anthropic");
  });

  it("carries no provider key", () => {
    const hosted = buildSandboxHostedInference({
      gatewayBaseUrl: GATEWAY,
      token: "oma_sbx_turn",
      upstream: { provider: "anthropic", baseURL: "https://fake.test", apiKey: "sk-card" } as never,
    });
    expect(JSON.stringify(hosted)).not.toContain("sk-card");
  });
});

describe("selectTurnProtocol", () => {
  it("takes the first harness protocol the model has", () => {
    expect(selectTurnProtocol(["anthropic-messages"], ["openai-chat", "anthropic-messages"]))
      .toBe("anthropic-messages");
    expect(selectTurnProtocol(["openai-responses", "openai-chat"], ["openai-chat", "openai-responses"]))
      .toBe("openai-responses");
  });

  it("gives null without a shared protocol", () => {
    expect(selectTurnProtocol(["anthropic-messages"], ["openai-chat"])).toBeNull();
    expect(selectTurnProtocol(["openai-chat"], [])).toBeNull();
    expect(selectTurnProtocol([], ["openai-chat"])).toBeNull();
  });

  it("lets the any-protocol entry take the first protocol of the model", () => {
    expect(selectTurnProtocol(["*"], ["openai-chat", "openai-responses"])).toBe("openai-chat");
    expect(selectTurnProtocol(["*"], [])).toBeNull();
  });

  it("ignores names that are not proxy protocols", () => {
    expect(selectTurnProtocol(["openai-completions", "openai-chat"], ["openai-completions", "openai-chat"]))
      .toBe("openai-chat");
    expect(selectTurnProtocol(["*"], ["google-generative-ai", "gemini"])).toBe("gemini");
  });
});

describe("cardInferenceEnv", () => {
  it("points an OpenAI Chat card at the openai/v1 segment of its session proxy", () => {
    const env = cardInferenceEnv({
      gatewayBaseUrl: GATEWAY,
      sessionId: "ses_1",
      token: "oma_sbx_turn",
      protocol: "openai-chat",
      modelHandle: "verify-oai",
    });

    expect(env).toEqual({
      OMA_INFERENCE_PROTOCOL: "openai-chat",
      OMA_INFERENCE_BASE_URL: `${GATEWAY}/v1/oma/inference-proxy/ses_1/openai/v1`,
      OMA_INFERENCE_TOKEN: "oma_sbx_turn",
      OMA_MODEL: "verify-oai",
      OPENAI_BASE_URL: `${GATEWAY}/v1/oma/inference-proxy/ses_1/openai/v1`,
      OPENAI_API_KEY: "oma_sbx_turn",
      OPENAI_MODEL: "verify-oai",
    });
    expect(env.OPENAI_BASE_URL.endsWith("/inference-proxy/ses_1/openai/v1")).toBe(true);
  });

  it("uses the same OpenAI variables for OpenAI Responses", () => {
    const env = cardInferenceEnv({
      gatewayBaseUrl: GATEWAY,
      sessionId: "ses_1",
      token: "oma_sbx_turn",
      protocol: "openai-responses",
      modelHandle: "verify-oai",
    });

    expect(env.OMA_INFERENCE_PROTOCOL).toBe("openai-responses");
    expect(env.OPENAI_BASE_URL).toBe(`${GATEWAY}/v1/oma/inference-proxy/ses_1/openai/v1`);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("gives an Anthropic Messages card the Anthropic variables", () => {
    const env = cardInferenceEnv({
      gatewayBaseUrl: `${GATEWAY}/`,
      sessionId: "ses_1",
      token: "oma_sbx_turn",
      protocol: "anthropic-messages",
      modelHandle: "verify-fake",
    });

    expect(env).toEqual({
      OMA_INFERENCE_PROTOCOL: "anthropic-messages",
      OMA_INFERENCE_BASE_URL: `${GATEWAY}/v1/oma/inference-proxy/ses_1/anthropic`,
      OMA_INFERENCE_TOKEN: "oma_sbx_turn",
      OMA_MODEL: "verify-fake",
      ANTHROPIC_BASE_URL: `${GATEWAY}/v1/oma/inference-proxy/ses_1/anthropic`,
      ANTHROPIC_AUTH_TOKEN: "oma_sbx_turn",
      ANTHROPIC_MODEL: "verify-fake",
    });
  });

  it("encodes the session id in the path", () => {
    const env = cardInferenceEnv({
      gatewayBaseUrl: GATEWAY,
      sessionId: "ses/1",
      token: "oma_sbx_turn",
      protocol: "anthropic-messages",
      modelHandle: "verify-fake",
    });

    expect(env.OMA_INFERENCE_BASE_URL).toBe(`${GATEWAY}/v1/oma/inference-proxy/ses%2F1/anthropic`);
  });

  it.each([
    ["anthropic-messages", "anthropic-messages"],
    ["openai-chat", "openai-chat"],
    ["openai-responses", "openai-chat"],
  ] as const)("routes %s to a segment the proxy parses as %s", (protocol, parsed) => {
    const env = cardInferenceEnv({
      gatewayBaseUrl: GATEWAY,
      sessionId: "ses_1",
      token: "oma_sbx_turn",
      protocol,
      modelHandle: "m",
    });
    const subPath = env.OMA_INFERENCE_BASE_URL.split("/inference-proxy/ses_1/")[1];
    expect(parseHostedInferenceSubPath(`${subPath}/messages`).protocol).toBe(parsed);
  });
});

describe("sandbox gateway address", () => {
  it("normalizes SANDBOX_GATEWAY_BASE_URL to an http or https origin", () => {
    expect(normalizeSandboxGatewayBaseUrl("http://host.boxlite.internal:8795")).toBe(
      "http://host.boxlite.internal:8795",
    );
    expect(normalizeSandboxGatewayBaseUrl("https://oma.example.com/")).toBe(
      "https://oma.example.com",
    );
    expect(normalizeSandboxGatewayBaseUrl(undefined)).toBeNull();
    expect(normalizeSandboxGatewayBaseUrl("  ")).toBeNull();
  });

  it.each([
    "host.boxlite.internal:8795",
    "ftp://oma.example.com",
    "https://oma.example.com/api",
    "https://oma.example.com/?x=1",
    "https://user:pass@oma.example.com",
    "not a url",
  ])("rejects %s", (value) => {
    expect(() => normalizeSandboxGatewayBaseUrl(value)).toThrow(/SANDBOX_GATEWAY_BASE_URL/);
  });

  it("prefers SANDBOX_GATEWAY_BASE_URL and falls back to PUBLIC_BASE_URL", () => {
    expect(resolveSandboxGatewayBaseUrl({
      sandboxGatewayBaseUrl: "http://host.boxlite.internal:8795",
      publicBaseUrl: "https://oma.example.com",
    })).toBe("http://host.boxlite.internal:8795");
    expect(resolveSandboxGatewayBaseUrl({
      sandboxGatewayBaseUrl: undefined,
      publicBaseUrl: "https://oma.example.com/console",
    })).toBe("https://oma.example.com");
    expect(resolveSandboxGatewayBaseUrl({ sandboxGatewayBaseUrl: "", publicBaseUrl: "" })).toBeNull();
    expect(resolveSandboxGatewayBaseUrl({})).toBeNull();
    expect(resolveSandboxGatewayBaseUrl({ publicBaseUrl: "not a url" })).toBeNull();
  });
});
