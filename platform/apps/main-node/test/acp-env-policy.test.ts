import { describe, expect, it } from "vitest";
import { MODEL_PROVIDER_SECRET_ENV_KEYS } from "@open-managed-agents/inference-proxy";
import {
  CARD_PROTOCOLS,
  INFERENCE_PROTOCOLS,
  MODEL_KEY_ENV_NAMES,
  SERVER_INFERENCE_ENV_NAMES,
  checkAcpEnv,
  isSecretLikeEnvName,
  isSecretLikeEnvValue,
} from "../src/lib/acp-env-policy.js";

describe("checkAcpEnv", () => {
  it("reports a server-owned model key as server_name and a token as secret_name", () => {
    expect(checkAcpEnv({ ANTHROPIC_API_KEY: "x" }, null)).toEqual([
      { name: "ANTHROPIC_API_KEY", kind: "server_name" },
    ]);
    expect(checkAcpEnv({ GITHUB_TOKEN: "x" }, null)).toEqual([
      { name: "GITHUB_TOKEN", kind: "secret_name" },
    ]);
  });

  it("passes the W4 Claude Code recipe variables", () => {
    expect(checkAcpEnv({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      OMA_CLAUDE_SETTINGS: "{\"permissions\":{\"allow\":[\"Read\",\"Write\",\"Edit\"]}}",
    }, null)).toEqual([]);
  });

  it("accepts an empty or missing env", () => {
    expect(checkAcpEnv(undefined, null)).toEqual([]);
    expect(checkAcpEnv({}, ["A"])).toEqual([]);
  });

  it("rejects names outside latin letters, digits and underscore", () => {
    expect(checkAcpEnv({ "MY-VAR": "1", "1ABC": "1", "ПЕРЕМЕННАЯ": "1" }, null)).toEqual([
      { name: "MY-VAR", kind: "bad_name" },
      { name: "1ABC", kind: "bad_name" },
      { name: "ПЕРЕМЕННАЯ", kind: "bad_name" },
    ]);
  });

  it("checks the name in order bad_name, server_name, secret_name, not_allowed", () => {
    // ANTHROPIC_AUTH_TOKEN is both a server name and secret-like: server wins.
    expect(checkAcpEnv({ ANTHROPIC_AUTH_TOKEN: "x" }, ["ANTHROPIC_AUTH_TOKEN"])).toEqual([
      { name: "ANTHROPIC_AUTH_TOKEN", kind: "server_name" },
    ]);
    // A secret-like name stays secret even when a card allows it.
    expect(checkAcpEnv({ MY_TOKEN: "x" }, ["MY_TOKEN"])).toEqual([
      { name: "MY_TOKEN", kind: "secret_name" },
    ]);
    expect(checkAcpEnv({ AIDER_AUTO_COMMITS: "1", OTHER: "1" }, ["AIDER_AUTO_COMMITS"])).toEqual([
      { name: "OTHER", kind: "not_allowed" },
    ]);
  });

  it("checks the value after the name and skips the value check for null", () => {
    expect(checkAcpEnv({ HELPER: "sk-ant-abc123" }, null)).toEqual([
      { name: "HELPER", kind: "secret_value" },
    ]);
    expect(checkAcpEnv({ HELPER: null }, null)).toEqual([]);
    expect(checkAcpEnv({ ANTHROPIC_BASE_URL: null }, null)).toEqual([
      { name: "ANTHROPIC_BASE_URL", kind: "server_name" },
    ]);
    // One problem per variable: a bad name does not also report its value.
    expect(checkAcpEnv({ "BAD-NAME": "sk-abc" }, null)).toEqual([
      { name: "BAD-NAME", kind: "bad_name" },
    ]);
  });

  it("treats every server inference name as server_name", () => {
    for (const name of SERVER_INFERENCE_ENV_NAMES) {
      expect(checkAcpEnv({ [name]: "x" }, null)).toEqual([{ name, kind: "server_name" }]);
    }
  });

  it("never lets a model provider key through", () => {
    for (const name of MODEL_KEY_ENV_NAMES) {
      const problems = checkAcpEnv({ [name]: "x" }, [name]);
      expect(problems).toHaveLength(1);
      expect(["server_name", "secret_name"]).toContain(problems[0]!.kind);
    }
  });
});

describe("env name and value heuristics", () => {
  it("flags secret-like names", () => {
    for (const name of [
      "GITHUB_TOKEN", "MY_API_KEY", "db_password", "SSH_PASSWD", "CLIENT_SECRET",
      "GOOGLE_CREDENTIALS", "PRIVATE_PEM", "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      expect(isSecretLikeEnvName(name), name).toBe(true);
    }
    for (const name of ["PATH", "AIDER_AUTO_COMMITS", "OMA_CLAUDE_SETTINGS", "NODE_ENV"]) {
      expect(isSecretLikeEnvName(name), name).toBe(false);
    }
  });

  it("flags provider key prefixes and JWTs", () => {
    for (const value of [
      "sk-proj-abc", "sk-ant-api03-x", "AIzaSyD", "ghp_abc", "gho_abc", "github_pat_11",
      "glpat-xyz", "xoxb-1", "xoxp-1", "xoxa-1", "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    ]) {
      expect(isSecretLikeEnvValue(value), value).toBe(true);
    }
    for (const value of ["1", "true", "/mnt/session/outputs", "{\"permissions\":{}}", "eyJ-not-a-jwt"]) {
      expect(isSecretLikeEnvValue(value), value).toBe(false);
    }
  });
});

describe("protocol and name lists", () => {
  it("lists the wire protocols shared by models, harness and proxy", () => {
    expect(INFERENCE_PROTOCOLS).toEqual(["anthropic-messages", "openai-chat", "openai-responses", "gemini"]);
    expect(CARD_PROTOCOLS).toEqual(["anthropic-messages", "openai-chat", "openai-responses"]);
  });

  it("includes every provider secret plus Claude tokens in MODEL_KEY_ENV_NAMES", () => {
    for (const name of MODEL_PROVIDER_SECRET_ENV_KEYS) expect(MODEL_KEY_ENV_NAMES.has(name)).toBe(true);
    expect(MODEL_KEY_ENV_NAMES.has("ANTHROPIC_AUTH_TOKEN")).toBe(true);
    expect(MODEL_KEY_ENV_NAMES.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
  });

  it("keeps the contract list of server inference names", () => {
    expect([...SERVER_INFERENCE_ENV_NAMES].sort()).toEqual([
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
      "GEMINI_API_KEY", "GEMINI_CLI_CUSTOM_HEADERS", "GEMINI_MODEL", "GOOGLE_GEMINI_BASE_URL",
      "HOSTED_INFERENCE_TOKEN", "HOSTED_INFERENCE_URL",
      "OMA_INFERENCE_BASE_URL", "OMA_INFERENCE_PROTOCOL", "OMA_INFERENCE_TOKEN", "OMA_MODEL",
      "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    ]);
  });
});
