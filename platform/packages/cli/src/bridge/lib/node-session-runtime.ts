import { spawn as childSpawn } from "node:child_process";

import { createAcpRuntime } from "@open-managed-agents/acp-runtime/placement";
import { NodeSpawner } from "@open-managed-agents/acp-runtime/node-spawner";
import { resolveKnownAgent } from "@open-managed-agents/acp-runtime/registry";

import { removeSessionCwd } from "./session-cwd.js";
import { buildAcpSpawnPlan } from "./spawn-plan.js";
import type {
  SessionManagerPreparationInput,
  SessionManagerRuntimeDependencies,
} from "./session-manager.js";

export function createNodeSessionManagerRuntimeDependencies(): SessionManagerRuntimeDependencies {
  return {
    acpRuntime: createAcpRuntime({
      type: "local",
      spawner: new NodeSpawner(),
    }),
    prepareSession: prepareNodeSession,
    releaseSession: removeSessionCwd,
  };
}

async function prepareNodeSession(input: SessionManagerPreparationInput) {
  const agent = resolveKnownAgent(input.command.agentId);
  if (!agent) {
    throw new Error(`unknown ACP agent: ${input.command.agentId}`);
  }
  if (agent.id !== input.command.agentId) {
    process.stderr.write(
      `  ↪ canonicalized acp_agent_id ${input.command.agentId} → ${agent.id} (legacy alias)\n`,
    );
  }

  const onPath = await binaryOnPath(agent.spec.command);
  if (!onPath) {
    throw new Error(
      `binary not on PATH for ${agent.id}: \`${agent.spec.command}\`` +
        (agent.installHint ? `. Install: ${agent.installHint}` : ""),
    );
  }

  const plan = await buildAcpSpawnPlan({
    sessionId: input.command.sessionId,
    agentId: agent.id,
    agentEnv: agent.spec.env,
    requestedCwd: input.command.cwd,
    environment: input.environment,
    agentApiKey: input.scope.agentApiKey,
  });

  return {
    agent: {
      ...agent.spec,
      cwd: plan.cwd,
      env: plan.env,
    },
    mcpServers: plan.mcpServers,
    resumeAcpSessionId: input.command.acpSessionId,
  };
}

function binaryOnPath(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const child = childSpawn(probe, [command], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}
