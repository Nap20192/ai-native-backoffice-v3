// The platform instructions, with the "Environment" block, reach an ACP
// client in the sandbox through the channel that client reads
// (docs/plans/environments.md, 4.4 and unit ES6). The harness delivers
// them in run(), before each process starts; onSessionInit is never called
// here, as in main-node. Each turn uses a new harness and process, as
// runHarnessForTurn does in main-node.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalSubprocessSandbox } from "@open-managed-agents/sandbox/adapters/local-subprocess";
import type { AgentConfig, SessionEvent, UserMessageEvent } from "@open-managed-agents/shared";

import {
  ACP_INSTRUCTIONS_END as END,
  ACP_INSTRUCTIONS_START as START,
  acpInstructionsText,
  prepareAcpInstructions,
  upsertAcpInstructionsSection,
  type AcpInstructionsSandbox,
} from "../src/harness/acp-instructions";
import { AcpSandboxHarness } from "../src/harness/acp-sandbox-loop";
import { buildEnvironmentPrompt } from "../src/harness/environment-prompt";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { composeSystemPrompt } from "../src/harness/platform-guidance";

// A stand-in ACP client. In "claude" mode it treats `_meta.systemPrompt`
// the way claude-agent-acp does (a string replaces the Claude Code preset,
// `{ append }` adds to it) and sends that system prompt to the model, as
// Claude Code does. Every mode logs what it received and reads its
// instructions file once, when the process starts.
const fakeClientSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const log = (record) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(record) + "\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const PRESET = "You are Claude Code, Anthropic's official CLI for Claude.";
const nativeDirs = [
  process.env.CLAUDE_CONFIG_DIR && path.join(process.env.CLAUDE_CONFIG_DIR, "projects"),
  process.env.CODEX_HOME && path.join(process.env.CODEX_HOME, "sessions"),
  process.env.GEMINI_CLI_HOME && path.join(process.env.GEMINI_CLI_HOME, ".gemini", "tmp"),
].filter(Boolean);
const file = process.env.FAKE_INSTRUCTIONS_FILE;
log({ event: "start", file: file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null });
const systemFrom = (meta) => {
  const custom = meta && meta.systemPrompt;
  if (typeof custom === "string") return [{ type: "text", text: custom }];
  const blocks = [{ type: "text", text: PRESET }];
  if (custom && typeof custom === "object" && typeof custom.append === "string") {
    blocks.push({ type: "text", text: custom.append });
  }
  return blocks;
};
let system = systemFrom(null);
let prompts = 0;
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const request = JSON.parse(line);
  const result = (value) => send({ jsonrpc: "2.0", id: request.id, result: value });
  switch (request.method) {
    case "initialize":
      return result({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } });
    case "session/new":
    case "session/resume": {
      log({ method: request.method, meta: request.params._meta ?? null });
      if (request.method === "session/resume" && !nativeDirs.every((dir) => fs.existsSync(dir))) {
        return send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "native state missing" } });
      }
      for (const dir of nativeDirs) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "session.jsonl"), "{}\n");
      }
      system = systemFrom(request.params._meta);
      return result(request.method === "session/new" ? { sessionId: "fake-acp-session" } : {});
    }
    case "session/prompt": {
      prompts += 1;
      const text = request.params.prompt.map((block) => block.text ?? "").join("");
      log({ method: request.method, text });
      let reply = "echo:" + prompts;
      if (process.env.FAKE_MODE === "claude") {
        const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fake", max_tokens: 16, system, messages: [{ role: "user", content: text }] }),
        });
        reply = (await response.json()).content.map((block) => block.text).join("");
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } },
        },
      });
      result({ stopReason: "end_turn" });
      if (process.env.FAKE_EXIT_AFTER_PROMPT) {
        setTimeout(() => { log({ event: "exit" }); process.exit(17); }, 10);
      }
      return;
    }
    default:
      return send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;

interface ModelRequest {
  system: Array<{ type: string; text: string }>;
  messages: Array<{ role: string; content: string }>;
}

type ClientRecord =
  | { event: "start"; file: string | null }
  | { event: "exit" }
  | { method: "session/new" | "session/resume"; meta: { systemPrompt?: { append?: string } } | null }
  | { method: "session/prompt"; text: string };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const manifest = {
  os: "Debian 12 (bookworm)", architecture: "x86_64", user: "root", shell: "bash",
  workingDirectory: "/workspace", python: { version: "3.11", venv: "/opt/venv" },
  node: { version: "22" }, packageManagers: ["apt", "pip", "npm"] as const,
  packages: { pip: [{ name: "python-pptx", version: "1.0.2" }] },
};

/** The system prompt main-node composes: the block comes from the VM facts
 *  and carries the nonce as an allowed host. */
function systemPromptWithBlock(nonce: string, acpClient: string): string {
  const block = buildEnvironmentPrompt({
    executor: "vm",
    manifest,
    snapshot: { networking: { type: "limited", allowPackageManagers: true, allowedHosts: [`${nonce}.example.org`] } },
    acpClient,
  });
  return composeSystemPrompt("You write short reports.", [{ source: "environment", text: block }]);
}

async function startFakeModel(): Promise<{ url: string; requests: ModelRequest[] }> {
  const requests: ModelRequest[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      requests.push(JSON.parse(body) as ModelRequest);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "msg_fake", type: "message", role: "assistant", model: "fake",
        content: [{ type: "text", text: "model-reply" }], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `oma-acp-instructions-${prefix}-`));
  const sandbox = new LocalSubprocessSandbox({ workdir: join(root, "workspace") });
  cleanups.push(async () => {
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const log = join(root, "client.jsonl");
  const events: SessionEvent[] = [];
  const records = async (): Promise<ClientRecord[]> =>
    existsSync(log)
      ? (await readFile(log, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as ClientRecord)
      : [];
  return { sandbox, log, events, records, runtime: createRuntime(sandbox, events) };
}

function acpAgent(agent: { id?: string; env: Record<string, string> }): AgentConfig {
  return {
    id: "agent_es6",
    name: "ES6 instructions agent",
    model: "fake-model",
    system: "You write short reports.",
    tools: [],
    harness: "acp-sandbox",
    acp: {
      agent: {
        ...(agent.id === undefined ? {} : { id: agent.id }),
        command: process.execPath,
        args: ["-e", fakeClientSource],
        cwd: "/workspace",
        env: agent.env,
      },
    },
    version: 1,
    created_at: "2026-10-16T00:00:00.000Z",
  } as unknown as AgentConfig;
}

function context(
  agent: AgentConfig,
  runtime: HarnessRuntime,
  sessionId: string,
  systemPrompt: string,
  text: string,
): HarnessContext {
  return {
    agent,
    userMessage: { type: "user.message", content: [{ type: "text", text }] } as UserMessageEvent,
    session_id: sessionId,
    tools: {},
    model: {} as HarnessContext["model"],
    systemPrompt,
    env: {},
    runtime,
  } as unknown as HarnessContext;
}

/** One main-node turn: a new harness, run, then dispose with "shutdown". */
async function turn(ctx: HarnessContext): Promise<void> {
  const harness = new AcpSandboxHarness();
  try {
    await harness.run(ctx);
  } finally {
    await harness.dispose("shutdown");
  }
}

function texts(events: SessionEvent[], type: string): string[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => JSON.stringify(event));
}

function nonce(): string {
  return `es6n${Math.random().toString(36).slice(2, 10)}`;
}

describe("ACP sandbox instructions delivery", () => {
  it("puts the block into the system prompt of Claude Code's model request on turns 1 and 2", async () => {
    const model = await startFakeModel();
    const { sandbox, log, events, records, runtime } = await setup("claude");
    await sandbox.writeFile("/workspace/CLAUDE.md", "# Team notes\nKeep answers short.\n");
    const id = nonce();
    const sessionId = `session_es6_claude_${id}`;
    const agent = acpAgent({
      id: "claude-acp",
      env: { FAKE_MODE: "claude", FAKE_LOG: log, ANTHROPIC_BASE_URL: model.url },
    });
    const systemPrompt = systemPromptWithBlock(id, "claude-acp");

    await turn(context(agent, runtime, sessionId, systemPrompt, "turn one"));
    await turn(context(agent, runtime, sessionId, systemPrompt, "turn two"));

    expect(texts(events, "session.error")).toEqual([]);
    expect(model.requests).toHaveLength(2);
    for (const request of model.requests) {
      const system = request.system.map((block) => block.text).join("\n");
      expect(system).toContain("You are Claude Code");
      expect(system).toContain("<environment>");
      expect(system).toContain(`${id}.example.org`);
      expect(system).toContain("If your tool permissions allow shell commands,");
      expect(system).toContain("You write short reports.");
    }
    expect(model.requests.map((request) => request.messages.at(-1)?.content)).toEqual(["turn one", "turn two"]);

    // The second turn starts a new process that resumes the native session.
    const setups = (await records()).filter((record) => "meta" in record);
    expect(setups.map((record) => "method" in record && record.method)).toEqual(["session/new", "session/resume"]);
    for (const record of setups) {
      expect("meta" in record && record.meta?.systemPrompt?.append).toContain(`${id}.example.org`);
    }
    // Claude Code gets no file: the owner's CLAUDE.md stays, AGENTS.md never appears.
    await expect(sandbox.readFile("/workspace/CLAUDE.md")).resolves.toBe("# Team notes\nKeep answers short.\n");
    await expect(sandbox.readFile("/workspace/AGENTS.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sends the block again when Claude Code's process restarts inside one harness", async () => {
    const model = await startFakeModel();
    const { log, events, records, runtime } = await setup("restart");
    const id = nonce();
    const sessionId = `session_es6_restart_${id}`;
    const agent = acpAgent({
      id: "claude-acp",
      env: { FAKE_MODE: "claude", FAKE_LOG: log, ANTHROPIC_BASE_URL: model.url, FAKE_EXIT_AFTER_PROMPT: "1" },
    });
    const systemPrompt = systemPromptWithBlock(id, "claude-acp");

    // A host that keeps the harness, as SessionDO does: the process dies
    // after turn 1 and the next run starts a new one that resumes.
    const harness = new AcpSandboxHarness();
    try {
      await harness.run(context(agent, runtime, sessionId, systemPrompt, "turn one"));
      await expect.poll(async () => (await records()).some((record) => "event" in record && record.event === "exit"))
        .toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await harness.run(context(agent, runtime, sessionId, systemPrompt, "turn two"));
    } finally {
      await harness.dispose("shutdown");
    }

    expect(texts(events, "session.error")).toEqual([]);
    const setups = (await records()).filter((record) => "meta" in record);
    expect(setups.map((record) => "method" in record && record.method)).toEqual(["session/new", "session/resume"]);
    expect(model.requests).toHaveLength(2);
    for (const request of model.requests) {
      expect(request.system.map((block) => block.text).join("\n")).toContain(`${id}.example.org`);
    }
  });

  it("writes AGENTS.md for Codex before its process starts and keeps the owner's text", async () => {
    const { sandbox, log, events, records, runtime } = await setup("codex");
    await sandbox.writeFile("/workspace/AGENTS.md", "# Project rules\nUse tabs.\n");
    const first = nonce();
    const second = nonce();
    const sessionId = `session_es6_codex_${first}`;
    const agent = acpAgent({
      id: "codex-acp",
      env: { FAKE_MODE: "file", FAKE_LOG: log, FAKE_INSTRUCTIONS_FILE: "AGENTS.md" },
    });

    await turn(context(agent, runtime, sessionId, systemPromptWithBlock(first, "codex-acp"), "turn one"));
    await turn(context(agent, runtime, sessionId, systemPromptWithBlock(second, "codex-acp"), "turn two"));

    expect(texts(events, "session.error")).toEqual([]);
    const starts = (await records()).flatMap((record) => ("event" in record && record.event === "start" ? [record.file ?? ""] : []));
    expect(starts).toHaveLength(2);
    expect(starts[0]).toContain(`${first}.example.org`);
    expect(starts[1]).toContain(`${second}.example.org`);
    expect(starts[1]).not.toContain(`${first}.example.org`);

    const file = await sandbox.readFile("/workspace/AGENTS.md");
    expect(file.startsWith("# Project rules\nUse tabs.\n")).toBe(true);
    expect(file.split("# Project rules")).toHaveLength(2);
    expect(file.split("<environment>")).toHaveLength(2);
    // Codex gets neither _meta nor a prefix.
    const setups = (await records()).filter((record) => "meta" in record);
    expect(setups.every((record) => "meta" in record && record.meta === null)).toBe(true);
    const prompts = (await records()).flatMap((record) => ("text" in record ? [record.text] : []));
    expect(prompts).toEqual(["turn one", "turn two"]);
  });

  it("writes GEMINI.md for Gemini CLI", async () => {
    const { log, events, records, runtime } = await setup("gemini");
    const id = nonce();
    const agent = acpAgent({
      id: "gemini",
      env: { FAKE_MODE: "file", FAKE_LOG: log, FAKE_INSTRUCTIONS_FILE: "GEMINI.md" },
    });

    await turn(context(agent, runtime, `session_es6_gemini_${id}`, systemPromptWithBlock(id, "gemini"), "turn one"));

    expect(texts(events, "session.error")).toEqual([]);
    const starts = (await records()).flatMap((record) => ("event" in record && record.event === "start" ? [record.file ?? ""] : []));
    expect(starts).toEqual([expect.stringContaining(`${id}.example.org`)]);
  });

  it("puts the instructions before the first prompt of each new process of an unknown client", async () => {
    const { sandbox, log, events, records, runtime } = await setup("unknown");
    const id = nonce();
    const sessionId = `session_es6_unknown_${id}`;
    const agent = acpAgent({ env: { FAKE_MODE: "echo", FAKE_LOG: log } });
    const systemPrompt = systemPromptWithBlock(id, "acp");

    // One process for two turns, as a host that keeps the harness does.
    const harness = new AcpSandboxHarness();
    try {
      await harness.run(context(agent, runtime, sessionId, systemPrompt, "turn one"));
      await harness.run(context(agent, runtime, sessionId, systemPrompt, "turn two"));
    } finally {
      await harness.dispose("shutdown");
    }
    // A new process, as in main-node, gets the instructions again.
    await turn(context(agent, runtime, sessionId, systemPrompt, "turn three"));

    expect(texts(events, "session.error")).toEqual([]);
    const prompts = (await records()).flatMap((record) => ("text" in record ? [record.text] : []));
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain(`${id}.example.org`);
    expect(prompts[0]).toContain("You write short reports.");
    expect(prompts[0].endsWith("turn one")).toBe(true);
    expect(prompts[1]).toBe("turn two");
    expect(prompts[2]).toContain(`${id}.example.org`);
    expect(prompts[2].endsWith("turn three")).toBe(true);
    await expect(sandbox.readFile("/workspace/AGENTS.md")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("sends nothing extra when the system prompt is empty", async () => {
    const { log, records, runtime } = await setup("empty");
    const id = nonce();
    const agent = acpAgent({ id: "claude-acp", env: { FAKE_MODE: "echo", FAKE_LOG: log } });

    await turn(context(agent, runtime, `session_es6_empty_${id}`, "", "turn one"));

    const all = await records();
    expect(all.filter((record) => "meta" in record)).toEqual([{ method: "session/new", meta: null }]);
    expect(all.flatMap((record) => ("text" in record ? [record.text] : []))).toEqual(["turn one"]);
  });
});

describe("instructions file section", () => {
  const section = (text: string) => `${START}\n${text}\n${END}\n`;

  it("adds the section after the owner's text and replaces it in place later", () => {
    expect(upsertAcpInstructionsSection(null, "A")).toBe(section("A"));
    expect(upsertAcpInstructionsSection("", "A")).toBe(section("A"));
    expect(upsertAcpInstructionsSection("rules", "A")).toBe(`rules\n\n${section("A")}`);
    expect(upsertAcpInstructionsSection(`top\n${section("A")}bottom\n`, "B")).toBe(`top\n${section("B")}bottom\n`);
    expect(upsertAcpInstructionsSection(`top\n${section("A")}`, "A")).toBeNull();
  });

  it("keeps one section and the owner's stray markers", () => {
    expect(upsertAcpInstructionsSection(`${section("A")}middle\n${section("B")}`, "C")).toBe(`${section("C")}middle\n`);
    const owner = `notes\n${START}\nowner text\n`;
    expect(upsertAcpInstructionsSection(`${owner}${section("A")}`, "B")).toBe(`${owner}${section("B")}`);
    const ownerEnd = `${END}\nowner text\n`;
    expect(upsertAcpInstructionsSection(`${ownerEnd}${section("A")}`, "B")).toBe(`${ownerEnd}${section("B")}`);
  });

  it("drops marker strings from the delivered text", () => {
    expect(acpInstructionsText(`  a ${START} b ${END} c\n`)).toBe("a  b  c");
  });

  function memorySandbox(input: { read: () => Promise<string>; exec: () => Promise<string> }) {
    const writes: Array<[string, string]> = [];
    const sandbox: AcpInstructionsSandbox = {
      readFile: input.read,
      writeFile: async (path, content) => { writes.push([path, content]); },
      exec: input.exec,
    };
    return { sandbox, writes };
  }

  it("never writes over a file it could not read and puts the text in front of the prompt", async () => {
    const { sandbox, writes } = memorySandbox({
      read: async () => { throw new Error("copy out failed"); },
      exec: async () => "present",
    });
    const plan = await prepareAcpInstructions({
      sandbox, agent: { id: "codex-acp", command: "codex-acp" }, cwd: "/workspace/", systemPrompt: "Be brief.",
    });
    expect(writes).toEqual([]);
    expect(plan.sessionRequestMeta).toBeUndefined();
    expect(plan.promptPrefix).toContain("Be brief.");
  });

  it("creates the file when the sandbox says it is missing", async () => {
    const { sandbox, writes } = memorySandbox({
      read: async () => { throw new Error("file not found"); },
      exec: async () => "missing",
    });
    const plan = await prepareAcpInstructions({
      sandbox, agent: { id: "gemini", command: "gemini" }, cwd: "/workspace/project", systemPrompt: "Be brief.",
    });
    expect(writes).toEqual([["/workspace/project/GEMINI.md", section("Be brief.")]]);
    expect(plan).toEqual({ promptPrefix: "" });
  });
});

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
