// Vault credentials of type `environment_variable` reach the session sandbox
// as environment variables. An ACP agent in the sandbox (Claude Code through
// `acp-sandbox`) reads its model key or subscription token from there, so the
// key lives in a Vault instead of the agent configuration.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SandboxExecutor, SandboxFactory } from "@open-managed-agents/sandbox";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults, type NodeComponentOverrides } from "../src/components";
import {
  applyVaultEnvironment,
  resolveVaultEnvironmentVariables,
  vaultEnvironmentApplies,
} from "../src/lib/node-managed-vault-env";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function envCredential(
  id: string,
  secretName: string,
  secretValue: string | null,
  archivedAt: string | null = null,
) {
  return {
    revision: 1,
    credential: {
      id,
      vaultId: "unused",
      archivedAt,
      createdAt: "2026-10-16T00:00:00Z",
      updatedAt: "2026-10-16T00:00:00Z",
      metadata: {},
      auth: {
        type: "environment_variable",
        networking: { type: "unrestricted" },
        secretName,
        secretValue,
        injectionLocation: { body: false, header: true },
      } as { type: string; secretName?: string; secretValue?: string | null },
    },
  };
}

describe("resolveVaultEnvironmentVariables", () => {
  it("collects environment variable credentials in vault order, first vault wins", async () => {
    const byVault: Record<string, ReturnType<typeof envCredential>[]> = {
      vlt_a: [
        envCredential("c1", "ANTHROPIC_API_KEY", "from-a"),
        envCredential("c2", "ARCHIVED", "x", "2026-10-16T00:00:01Z"),
        envCredential("c3", "EMPTY", null),
        envCredential("c4", "1BAD-NAME", "x"),
        {
          revision: 1,
          credential: {
            ...envCredential("c5", "unused", "x").credential,
            auth: { type: "static_bearer", token: "mcp", mcpServerUrl: "https://mcp.example" } as { type: string },
          },
        },
      ],
      vlt_b: [
        envCredential("c6", "ANTHROPIC_API_KEY", "from-b"),
        envCredential("c7", "CLAUDE_CODE_OAUTH_TOKEN", "token-b"),
      ],
    };
    const calls: unknown[] = [];
    const env = await resolveVaultEnvironmentVariables({
      credentials: {
        list: async (input) => {
          calls.push(input);
          return byVault[input.vaultId] ?? [];
        },
      },
      workspaceId: "tn_1",
      vaultIds: ["vlt_a", "vlt_b"],
    });
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "from-a",
      CLAUDE_CODE_OAUTH_TOKEN: "token-b",
    });
    expect(calls).toEqual([
      { workspaceId: "tn_1", vaultId: "vlt_a", includeArchived: false, limit: 100 },
      { workspaceId: "tn_1", vaultId: "vlt_b", includeArchived: false, limit: 100 },
    ]);
  });

  it("returns nothing without vaults", async () => {
    await expect(resolveVaultEnvironmentVariables({
      credentials: { list: async () => { throw new Error("not called"); } },
      workspaceId: "tn_1",
      vaultIds: [],
    })).resolves.toEqual({});
  });

  it("reports policies the plain variable cannot enforce, without the value", async () => {
    const limited = envCredential("c1", "API_TOKEN", "secret-value-1");
    (limited.credential.auth as Record<string, unknown>).networking = { type: "limited", allowedHosts: ["api.example.com"] };
    (limited.credential.auth as Record<string, unknown>).injectionLocation = { body: false, header: false };
    const header = envCredential("c2", "OTHER_TOKEN", "secret-value-2");
    const plain = envCredential("c3", "PLAIN", "secret-value-3");
    (plain.credential.auth as Record<string, unknown>).injectionLocation = { body: false, header: false };
    const notices: Array<{ message: string; details: Record<string, unknown> }> = [];
    const env = await resolveVaultEnvironmentVariables({
      credentials: { list: async () => [limited, header, plain] },
      workspaceId: "tn_1",
      vaultIds: ["vlt_a"],
      warn: (message, details) => notices.push({ message, details }),
    });
    expect(Object.keys(env)).toEqual(["API_TOKEN", "OTHER_TOKEN", "PLAIN"]);
    expect(notices.map((n) => [n.details.secretName, n.details.ignored])).toEqual([
      ["API_TOKEN", ["networking"]],
      ["OTHER_TOKEN", ["injection_location"]],
    ]);
    expect(JSON.stringify(notices)).not.toMatch(/secret-value/);
  });
});

describe("applyVaultEnvironment", () => {
  const credentials = (calls: unknown[]) => ({
    list: async (input: unknown) => {
      calls.push(input);
      return [envCredential("c1", "ANTHROPIC_API_KEY", "sk-vault-test")];
    },
  });

  it("only the acp-sandbox harness gets Vault variables", () => {
    expect(vaultEnvironmentApplies("acp-sandbox")).toBe(true);
    expect(vaultEnvironmentApplies(undefined)).toBe(false);
    expect(vaultEnvironmentApplies("default")).toBe(false);
    expect(vaultEnvironmentApplies("acp-proxy")).toBe(false);
  });

  it("does not read or set the secret for the default harness", async () => {
    const calls: unknown[] = [];
    const set: Record<string, string>[] = [];
    const applied = await applyVaultEnvironment({
      harness: undefined,
      sandbox: { setEnvVars: async (vars) => { set.push(vars); } },
      credentials: credentials(calls),
      workspaceId: "tn_1",
      vaultIds: ["vlt_a"],
    });
    expect(applied).toEqual([]);
    expect(calls).toEqual([]);
    expect(set).toEqual([]);
  });

  it("sets the variables on the sandbox for acp-sandbox", async () => {
    const calls: unknown[] = [];
    const set: Record<string, string>[] = [];
    const applied = await applyVaultEnvironment({
      harness: "acp-sandbox",
      sandbox: { setEnvVars: async (vars) => { set.push(vars); } },
      credentials: credentials(calls),
      workspaceId: "tn_1",
      vaultIds: ["vlt_a"],
    });
    expect(applied).toEqual(["ANTHROPIC_API_KEY"]);
    expect(set).toEqual([{ ANTHROPIC_API_KEY: "sk-vault-test" }]);
  });

  it("keeps the W4 behaviour when skipModelKeys is false", async () => {
    const set: Record<string, string>[] = [];
    const applied = await applyVaultEnvironment({
      harness: "acp-sandbox",
      sandbox: { setEnvVars: async (vars) => { set.push(vars); } },
      credentials: credentials([]),
      workspaceId: "tn_1",
      vaultIds: ["vlt_a"],
      skipModelKeys: false,
    });
    expect(applied).toEqual(["ANTHROPIC_API_KEY"]);
    expect(set).toEqual([{ ANTHROPIC_API_KEY: "sk-vault-test" }]);
  });
});

describe("applyVaultEnvironment with skipModelKeys", () => {
  const records = [
    envCredential("c1", "ANTHROPIC_API_KEY", "sk-vault-anthropic"),
    envCredential("c2", "CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-vault"),
    envCredential("c3", "ANTHROPIC_BASE_URL", "https://vault-base.example"),
    envCredential("c4", "OPENAI_API_KEY", "sk-vault-openai"),
    envCredential("c5", "HOSTED_INFERENCE_TOKEN", "vault-hosted-token"),
    envCredential("c6", "GITHUB_TOKEN", "ghp_vault_github"),
  ];

  it("keeps model keys and server inference variables out of the sandbox", async () => {
    const set: Record<string, string>[] = [];
    const notices: Array<{ message: string; details: Record<string, unknown> }> = [];
    const applied = await applyVaultEnvironment({
      harness: "acp-sandbox",
      sandbox: { setEnvVars: async (vars) => { set.push(vars); } },
      credentials: { list: async () => records },
      workspaceId: "tn_1",
      vaultIds: ["vlt_a"],
      skipModelKeys: true,
      warn: (message, details) => notices.push({ message, details }),
    });

    expect(applied).toEqual(["GITHUB_TOKEN"]);
    expect(set).toEqual([{ GITHUB_TOKEN: "ghp_vault_github" }]);
    expect(notices
      .map((notice) => notice.details)
      .filter((details) => details.op === "main-node.vault_env.model_key_skipped")).toEqual([
      { op: "main-node.vault_env.model_key_skipped", vaultId: "vlt_a", secretName: "ANTHROPIC_API_KEY" },
      { op: "main-node.vault_env.model_key_skipped", vaultId: "vlt_a", secretName: "CLAUDE_CODE_OAUTH_TOKEN" },
      { op: "main-node.vault_env.model_key_skipped", vaultId: "vlt_a", secretName: "ANTHROPIC_BASE_URL" },
      { op: "main-node.vault_env.model_key_skipped", vaultId: "vlt_a", secretName: "OPENAI_API_KEY" },
      { op: "main-node.vault_env.model_key_skipped", vaultId: "vlt_a", secretName: "HOSTED_INFERENCE_TOKEN" },
    ]);
    expect(notices.map((notice) => notice.details.secretName)).toContain("GITHUB_TOKEN");
    expect(notices[0].message).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(notices)).not.toMatch(/sk-vault|sk-ant-oat|vault-base|vault-hosted|ghp_vault/);
  });

  it("skips a model key in every vault and sets nothing when only keys are there", async () => {
    const set: Record<string, string>[] = [];
    const notices: Array<Record<string, unknown>> = [];
    const applied = await applyVaultEnvironment({
      harness: "acp-sandbox",
      sandbox: { setEnvVars: async (vars) => { set.push(vars); } },
      credentials: {
        list: async ({ vaultId }) => [envCredential(`c_${vaultId}`, "ANTHROPIC_API_KEY", `sk-${vaultId}`)],
      },
      workspaceId: "tn_1",
      vaultIds: ["vlt_a", "vlt_b"],
      skipModelKeys: true,
      warn: (_message, details) => notices.push(details),
    });

    expect(applied).toEqual([]);
    expect(set).toEqual([]);
    expect(notices.map((notice) => notice.vaultId)).toEqual(["vlt_a", "vlt_b"]);
  });

  it("reports a skipped key once, not as an unenforced policy", async () => {
    const limited = envCredential("c1", "ANTHROPIC_API_KEY", "sk-vault-limited");
    (limited.credential.auth as Record<string, unknown>).networking = { type: "limited", allowedHosts: ["api.anthropic.com"] };
    const notices: Array<Record<string, unknown>> = [];
    await resolveVaultEnvironmentVariables({
      credentials: { list: async () => [limited] },
      workspaceId: "tn_1",
      vaultIds: ["vlt_a"],
      skipModelKeys: true,
      warn: (_message, details) => notices.push(details),
    });

    expect(notices).toEqual([
      { op: "main-node.vault_env.model_key_skipped", vaultId: "vlt_a", secretName: "ANTHROPIC_API_KEY" },
    ]);
  });

  it("tags an unenforced policy with its own op", async () => {
    const limited = envCredential("c1", "API_TOKEN", "secret-value-1");
    (limited.credential.auth as Record<string, unknown>).networking = { type: "limited", allowedHosts: ["api.example.com"] };
    (limited.credential.auth as Record<string, unknown>).injectionLocation = { body: false, header: false };
    const notices: Array<Record<string, unknown>> = [];
    await resolveVaultEnvironmentVariables({
      credentials: { list: async () => [limited] },
      workspaceId: "tn_1",
      vaultIds: ["vlt_a"],
      skipModelKeys: true,
      warn: (_message, details) => notices.push(details),
    });

    expect(notices).toEqual([{
      op: "main-node.vault_env.policy_not_enforced",
      vaultId: "vlt_a",
      secretName: "API_TOKEN",
      ignored: ["networking"],
    }]);
  });
});

const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...beta },
  body: JSON.stringify(body),
});

async function controlPlane(overrides: NodeComponentOverrides): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-vault-env-"));
  dirs.push(dir);
  const cp = await createNodeControlPlane(await nodeDefaults(loadNodeConfig({
    NODE_ENV: "test",
    AUTH_DISABLED: "1",
    OPENMA_TEST_SANDBOX_PROVIDER: "local-subprocess",
    MEMORY_QUEUE: "disabled",
    DATABASE_PATH: join(dir, "oma.db"),
    AUTH_DATABASE_PATH: join(dir, "auth.db"),
    SANDBOX_WORKDIR: join(dir, "sandboxes"),
    MEMORY_BLOB_DIR: join(dir, "memories"),
    FILES_BLOB_DIR: join(dir, "files"),
    SESSION_OUTPUTS_DIR: join(dir, "outputs"),
    PLATFORM_ROOT_SECRET: Buffer.alloc(32, 7).toString("base64"),
    ANTHROPIC_API_KEY: "unused",
    // Claude Code in the sandbox needs a server address for the inference proxy.
    SANDBOX_GATEWAY_BASE_URL: "http://127.0.0.1:9",
  }), overrides));
  created.push(cp);
  return cp;
}

describe("managed runner exposes Vault environment variables to the sandbox", () => {
  // Since the inference proxy (docs/plans/models-harness.md, 5.7) the model
  // key of a Vault stays out of the sandbox; other variables still arrive.
  it("sets the session's environment_variable credentials on the acp-sandbox sandbox, without the model key", async () => {
    let resolveEnv!: (env: Record<string, string>) => void;
    const seen = new Promise<Record<string, string>>((resolve) => { resolveEnv = resolve; });
    const env: Record<string, string> = {};
    const sandbox: SandboxFactory = async () => {
      const fake: SandboxExecutor & {
        sessionOutputMountCapabilities(): { durability: "durable" };
        mountSessionOutputs(): Promise<void>;
      } = {
        exec: async () => "",
        readFile: async () => { throw new Error("no file"); },
        writeFile: async (path) => path,
        setEnvVars: async (vars) => {
          Object.assign(env, vars);
          if (env.GITHUB_TOKEN) resolveEnv({ ...env });
        },
        sessionOutputMountCapabilities: () => ({ durability: "durable" }),
        mountSessionOutputs: async () => {},
      };
      return fake;
    };
    const cp = await controlPlane({ sandbox });
    const vault = await (await cp.fetch(new Request("http://cp/v1/vaults", post({
      display_name: "claude-code-keys",
    })))).json() as { id: string };
    for (const [name, value] of [["ANTHROPIC_API_KEY", "sk-vault-test"], ["GITHUB_TOKEN", "ghp_vault_test"]]) {
      const credential = await cp.fetch(new Request(`http://cp/v1/vaults/${vault.id}/credentials`, post({
        auth: {
          type: "environment_variable",
          secret_name: name,
          secret_value: value,
          networking: { type: "unrestricted" },
        },
      })));
      expect(credential.status).toBe(201);
    }
    const environment = await (await cp.fetch(new Request("http://cp/v1/environments", post({
      name: "vault-env", config: { type: "cloud", networking: { type: "unrestricted" } },
    })))).json() as { id: string };
    const created = await cp.fetch(new Request("http://cp/v1/agents", post({
      name: "vault-env-agent", model: "claude-sonnet-4-6", system: "hi",
      _oma: { harness: "acp-sandbox", acp: { agent: { id: "claude-acp", command: "claude-agent-acp" } } },
    })));
    expect(created.status, await created.clone().text()).toBeLessThan(300);
    const agent = await created.json() as { id: string };
    const session = await (await cp.fetch(new Request("http://cp/v1/sessions", post({
      agent: agent.id, environment_id: environment.id, vault_ids: [vault.id],
    })))).json() as { id: string };
    const sent = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/events`, post({
      events: [{ type: "user.message", content: [{ type: "text", text: "run" }] }],
    })));
    expect(sent.status).toBe(200);
    const result = await Promise.race([
      seen,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);
    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({
      GITHUB_TOKEN: "ghp_vault_test",
      OMA_OUTPUTS_DIR: "/mnt/session/outputs",
    });
    expect(result).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});
