// Two acp-sandbox turns of a harness card session. Every turn gets a new
// sandbox token, and main-node disposes the harness after the turn. The
// second turn must resume the ACP session of the first from the checkpoint:
// the token of a turn is not part of the agent configuration.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";
import { registerCoreHarnesses } from "@open-managed-agents/agent/harness/builtins";
import type { HarnessContext, HarnessRuntime } from "@open-managed-agents/agent/harness/interface";
import { resolveHarness } from "@open-managed-agents/agent/harness/registry";
import { describe, expect, it, vi } from "vitest";
import type { HarnessInterface } from "@open-managed-agents/agent/harness/interface";

import { acpTurnAgent, acpTurnEnv, type AcpTurnInference } from "../src/lib/models-harness-wiring";
import { runHarnessForTurn } from "../src/lib/node-managed-harness-turn";
import { cardInferenceEnv } from "../src/lib/sandbox-hosted-inference";

const SESSION_ID = "ses_acp_turn_checkpoint";

describe("acp-sandbox turns of a harness card", () => {
  it("resume the ACP session of the previous turn although the token changed", async () => {
    // main-node disposes the harness after each turn (runHarnessForTurn).
    const messages = await runTwoTurns((harness, ctx) => runHarnessForTurn(harness, ctx));
    expect(messages).toEqual(["new:oma_sbx_turn_one:first", "resume:card-echo-session:oma_sbx_turn_two:second"]);
  });

  it("restart a live ACP process with the new token and keep its session", async () => {
    const messages = await runTwoTurns((harness, ctx) => harness.run(ctx));
    expect(messages).toEqual(["new:oma_sbx_turn_one:first", "resume:card-echo-session:oma_sbx_turn_two:second"]);
  });
});

async function runTwoTurns(
  runTurn: (harness: HarnessInterface, ctx: HarnessContext) => Promise<void>,
): Promise<string[]> {
  const workdir = await mkdtemp(join(tmpdir(), "oma-acp-turn-checkpoint-"));
  const sandbox = new LocalSubprocessSandbox({ workdir });
  const events: SessionEvent[] = [];
  const runtime = createRuntime(sandbox, events);
  registerCoreHarnesses();
  const harness = resolveHarness("acp-sandbox");
  const stored = {
    id: "agent_acp_card",
    name: "Card ACP agent",
    model: "verify-oai",
    system: "",
    tools: [],
    harness: "acp-sandbox",
    acp: {
      agent: {
        id: "card-echo-acp",
        command: process.execPath,
        args: ["-e", resumableAcpAgentSource],
        cwd: "/workspace",
        env: { CARD_FLAG: "1" },
      },
    },
    version: 1,
    created_at: "2026-10-16T00:00:00.000Z",
  } as unknown as AgentConfig;

  try {
    for (const [text, token] of [["first", "oma_sbx_turn_one"], ["second", "oma_sbx_turn_two"]] as const) {
      const inference: AcpTurnInference = {
        kind: "card",
        env: cardInferenceEnv({
          gatewayBaseUrl: "http://host.boxlite.internal:8795",
          sessionId: SESSION_ID,
          token,
          protocol: "openai-chat",
          modelHandle: "verify-oai",
        }),
      };
      // The same two steps as buildHarnessContext in node-managed.ts.
      const agent = acpTurnAgent(stored as never) as unknown as AgentConfig;
      await runTurn(harness, {
        ...createContext(agent, runtime, text),
        env: acpTurnEnv(inference) as HarnessContext["env"],
      });
    }
    expect(events.filter((event) => event.type === "session.error")).toEqual([]);
    return events
      .filter((event) => event.type === "agent.message")
      .map((event) => (event as { content: { text: string }[] }).content.map((block) => block.text).join(""));
  } finally {
    await harness.dispose?.("shutdown");
    await sandbox.destroy();
  }
}

function createContext(agent: AgentConfig, runtime: HarnessRuntime, text: string): HarnessContext {
  return {
    agent,
    userMessage: { type: "user.message", content: [{ type: "text", text }] } as UserMessageEvent,
    session_id: SESSION_ID,
    tools: {},
    model: {} as HarnessContext["model"],
    systemPrompt: "",
    env: {},
    runtime,
  } as HarnessContext;
}

function createRuntime(sandbox: LocalSubprocessSandbox, events: SessionEvent[]): HarnessRuntime {
  return {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    sandbox,
    broadcast: (event: SessionEvent) => events.push(event),
    broadcastStreamStart: vi.fn(async () => {}),
    broadcastChunk: vi.fn(async () => {}),
    broadcastStreamEnd: vi.fn(async () => {}),
    broadcastThinkingStart: vi.fn(async () => {}),
    broadcastThinkingChunk: vi.fn(async () => {}),
    broadcastThinkingEnd: vi.fn(async () => {}),
    broadcastToolInputStart: vi.fn(async () => {}),
    broadcastToolInputChunk: vi.fn(async () => {}),
    broadcastToolInputEnd: vi.fn(async () => {}),
    pendingConfirmations: [],
  } as unknown as HarnessRuntime;
}

// An ACP client that answers with the way its session started and the proxy
// token it got in its environment.
const resumableAcpAgentSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let mode = "uninitialized";
input.on("line", (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      result({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
      break;
    case "session/new":
      mode = "new";
      result({ sessionId: "card-echo-session" });
      break;
    case "session/resume":
      mode = "resume:" + request.params.sessionId;
      result({});
      break;
    case "session/prompt": {
      const text = request.params.prompt.map((block) => block.text ?? "").join("");
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: mode + ":" + process.env.OMA_INFERENCE_TOKEN + ":" + text },
          },
        },
      });
      result({ stopReason: "end_turn" });
      break;
    }
    default:
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;
