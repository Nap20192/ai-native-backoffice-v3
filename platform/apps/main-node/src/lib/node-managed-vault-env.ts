/**
 * Vault credentials of type `environment_variable` as sandbox environment.
 *
 * The official contract substitutes the secret on egress, so the sandbox
 * only sees a placeholder. Node has no egress substitution proxy: the value
 * itself is set as the variable in the session sandbox, readable by every
 * process there (an ACP agent such as Claude Code, its tools, bash).
 * `networking` and `injection_location` are therefore not enforced; each
 * credential that sets them is reported through `warn`.
 *
 * Only harnesses that start an agent CLI inside the sandbox and need its key
 * there get the variables (`VAULT_ENV_HARNESSES`). The default (Pi) harness
 * calls the model from the host, so its bash never sees Vault secrets.
 *
 * With `skipModelKeys` the model keys and the variables the server sets for
 * the hosted inference proxy (`MODEL_KEY_ENV_NAMES`, `SERVER_INFERENCE_ENV_NAMES`
 * in acp-env-policy.ts) stay out of the sandbox: the agent reaches its model
 * through the proxy with a session token. The filter lives here because the
 * sandbox environment sits under the launch env of the ACP process, and a
 * Vault key left in it would reach the process even after the inference
 * adapter drops it from the launch env.
 */

import { MODEL_KEY_ENV_NAMES, SERVER_INFERENCE_ENV_NAMES } from "./acp-env-policy.js";

interface VaultCredentialRecord {
  credential: {
    archivedAt: string | null;
    auth: {
      type: string;
      secretName?: string;
      secretValue?: string | null;
      networking?: { type: string };
      injectionLocation?: { body?: boolean; header?: boolean };
    };
  };
}

export interface VaultCredentialLister {
  list(input: {
    workspaceId: string;
    vaultId: string;
    includeArchived: boolean;
    limit: number;
  }): Promise<readonly VaultCredentialRecord[]>;
}

export type VaultEnvironmentNotice =
  | {
      op: "main-node.vault_env.policy_not_enforced";
      vaultId: string;
      secretName: string;
      ignored: string[];
    }
  | {
      op: "main-node.vault_env.model_key_skipped";
      vaultId: string;
      secretName: string;
    };

/** Notices carry the variable name, never its value. */
export type VaultEnvironmentWarn = (
  message: string,
  details: VaultEnvironmentNotice,
) => void;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Harnesses whose agent process runs in the sandbox and reads its key from
 * the environment there. */
export const VAULT_ENV_HARNESSES: ReadonlySet<string> = new Set(["acp-sandbox"]);

export function vaultEnvironmentApplies(harness: string | undefined): boolean {
  return harness !== undefined && VAULT_ENV_HARNESSES.has(harness);
}

/** True for a name the sandbox must not get from a Vault once the model
 * goes through the hosted inference proxy. */
export function isModelKeyEnvName(name: string): boolean {
  return MODEL_KEY_ENV_NAMES.has(name) || SERVER_INFERENCE_ENV_NAMES.has(name);
}

/** Variables from the Session's vaults in vault order; the first vault that
 * defines a name wins. Archived, empty and invalidly named ones are skipped,
 * and so are model keys when `skipModelKeys` is set. */
export async function resolveVaultEnvironmentVariables(input: {
  credentials: VaultCredentialLister;
  workspaceId: string;
  vaultIds: readonly string[];
  warn?: VaultEnvironmentWarn;
  skipModelKeys?: boolean;
}): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const vaultId of input.vaultIds) {
    const records = await input.credentials.list({
      workspaceId: input.workspaceId,
      vaultId,
      includeArchived: false,
      limit: 100,
    });
    for (const { credential } of records) {
      const { auth } = credential;
      if (auth.type !== "environment_variable" || credential.archivedAt !== null) continue;
      const name = auth.secretName ?? "";
      if (!ENV_NAME.test(name) || Object.hasOwn(env, name)) continue;
      if (typeof auth.secretValue !== "string") continue;
      if (input.skipModelKeys === true && isModelKeyEnvName(name)) {
        input.warn?.(
          `Vault variable ${name} is not set in the sandbox: the agent reaches its model through the inference proxy`,
          { op: "main-node.vault_env.model_key_skipped", vaultId, secretName: name },
        );
        continue;
      }
      env[name] = auth.secretValue;
      const ignored = [
        ...(auth.networking?.type === "limited" ? ["networking"] : []),
        ...(auth.injectionLocation?.body || auth.injectionLocation?.header ? ["injection_location"] : []),
      ];
      if (ignored.length > 0) {
        input.warn?.(
          `Vault variable ${name} is set in the sandbox as is: ${ignored.join(" and ")} of the credential are not enforced`,
          { op: "main-node.vault_env.policy_not_enforced", vaultId, secretName: name, ignored },
        );
      }
    }
  }
  return env;
}

/** Sets the Session's Vault variables on its sandbox when the harness needs
 * them; returns the names that were set (never the values). `skipModelKeys`
 * (false by default) keeps model keys out, see the file header. */
export async function applyVaultEnvironment(input: {
  harness: string | undefined;
  sandbox: { setEnvVars?(envVars: Record<string, string>): Promise<void> };
  credentials: VaultCredentialLister;
  workspaceId: string;
  vaultIds: readonly string[];
  warn?: VaultEnvironmentWarn;
  skipModelKeys?: boolean;
}): Promise<string[]> {
  if (!vaultEnvironmentApplies(input.harness) || input.vaultIds.length === 0) return [];
  const env = await resolveVaultEnvironmentVariables(input);
  const names = Object.keys(env);
  if (names.length > 0) await input.sandbox.setEnvVars?.(env);
  return names;
}
