// Accepted user input must reach live subscribers of the official Session
// event stream, like the Cloudflare SessionDO broadcast does. The console
// builds the conversation turn from the stream; without the echoed
// user.message the prompt only appears after a page reload (GET /events).

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  Environment,
  Session,
  StreamSessionEvent,
} from "@open-managed-agents/managed-agents-application";
import type { SandboxFactory } from "@open-managed-agents/sandbox";
import { MemorySessionRealtimeHub } from "@open-managed-agents/session-realtime-memory";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults, type NodeComponentOverrides } from "../src/components";
import {
  DefaultNodeManagedSessionRuntimeDriver,
  NodeManagedSessionRuntimeAdapter,
} from "../src/lib/node-managed-session-runtime.js";

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "idle",
  title: "Node session",
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: {
    type: "cloud",
    networking: { type: "unrestricted" },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
  },
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Cloud",
  updatedAt: "2026-08-26T00:00:00.000Z",
};

describe("NodeManagedSessionRuntimeAdapter live input echo", () => {
  it("publishes accepted user input to live subscribers before dispatching the turn", async () => {
    const order: string[] = [];
    const realtime = new MemorySessionRealtimeHub();
    const publish = realtime.publish.bind(realtime);
    realtime.publish = (input) => {
      order.push(`published ${input.frame.event.type}`);
      publish(input);
    };
    const driver = new DefaultNodeManagedSessionRuntimeDriver({
      engine: {
        start: async () => {},
        stop: async () => {},
        accept: async () => {},
        archiveThread: async () => {},
      },
      realtime,
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({ type: "recorded", session }),
      }),
    });
    const adapter = new NodeManagedSessionRuntimeAdapter(driver, {
      sessionEventsAccepted: async () => { order.push("dispatched"); },
      cancelSession: async () => {},
    });
    const live = adapter.subscribe({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const first = live.next();

    await adapter.sessionEventsAccepted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "sevt_user_01",
        type: "user.message",
        content: [{ type: "text", text: "Hello from the console" }],
        processedAt: "2026-08-26T01:00:00.000Z",
      }],
    });

    const result = await Promise.race([
      first,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    // A pending async-generator next() would queue return() behind it.
    if (result !== "timeout") await live.return?.();

    expect(result).not.toBe("timeout");
    expect((result as IteratorResult<StreamSessionEvent>).value).toEqual({
      id: "sevt_user_01",
      type: "user.message",
      content: [{ type: "text", text: "Hello from the console" }],
      processedAt: "2026-08-26T01:00:00.000Z",
    });
    expect(order).toEqual(["published user.message", "dispatched"]);
  });

  it("does not publish to another workspace's subscribers", async () => {
    const driver = new DefaultNodeManagedSessionRuntimeDriver({
      engine: {
        start: async () => {},
        stop: async () => {},
        accept: async () => {},
        archiveThread: async () => {},
      },
      realtime: new MemorySessionRealtimeHub(),
      projectionFor: () => ({
        recordSessionRuntimeEvents: async () => ({ type: "recorded", session }),
      }),
    });
    const adapter = new NodeManagedSessionRuntimeAdapter(driver, {
      sessionEventsAccepted: async () => {},
      cancelSession: async () => {},
    });
    const other = adapter.subscribe({
      workspaceId: "workspace_02",
      sessionId: session.id,
      session,
    })[Symbol.asyncIterator]();
    const next = other.next();

    await adapter.sessionEventsAccepted({
      workspaceId: "workspace_01",
      sessionId: session.id,
      session,
      environment,
      events: [{
        id: "sevt_user_02",
        type: "user.message",
        content: [{ type: "text", text: "Not yours" }],
        processedAt: "2026-08-26T01:00:00.000Z",
      }],
    });

    const result = await Promise.race([
      next,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);
    if (result !== "timeout") await other.return?.();
    expect(result).toBe("timeout");
  });
});

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function controlPlane(overridesFor?: NodeComponentOverrides): Promise<NodeControlPlane> {
  const dir = mkdtempSync(join(tmpdir(), "oma-input-stream-"));
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
    ANTHROPIC_API_KEY: "unused",
  }), overridesFor));
  created.push(cp);
  return cp;
}

const beta = { "anthropic-beta": "managed-agents-2026-04-01" };
const post = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...beta },
  body: JSON.stringify(body),
});

async function readSseUntil(
  body: ReadableStream<Uint8Array>,
  match: (event: string, data: string) => boolean,
  timeoutMs: number,
): Promise<Array<{ event: string; data: string }>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: Array<{ event: string; data: string }> = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), Math.max(1, deadline - Date.now()))),
      ]);
      if (chunk === "timeout" || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event: ?(.*)$/mu.exec(raw)?.[1] ?? "message";
        const data = raw.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.replace(/^data: ?/u, "")).join("\n");
        frames.push({ event, data });
        if (match(event, data)) return frames;
        boundary = buffer.indexOf("\n\n");
      }
    }
    return frames;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

describe("official Session event stream on main-node", () => {
  it("streams the accepted user.message to a connected client", async () => {
    const sandbox: SandboxFactory = async () => {
      throw new Error("the sandbox is not needed to echo user input");
    };
    const cp = await controlPlane({ sandbox });
    const env = await (await cp.fetch(new Request("http://cp/v1/environments", post({
      name: "stream-env", config: { type: "cloud", networking: { type: "unrestricted" } },
    })))).json() as { id: string };
    const agent = await (await cp.fetch(new Request("http://cp/v1/agents", post({
      name: "stream-agent", model: "claude-sonnet-4-6", system: "hi",
    })))).json() as { id: string };
    const created = await (await cp.fetch(new Request("http://cp/v1/sessions", post({
      agent: agent.id, environment_id: env.id,
    })))).json() as { id: string };
    expect(created.id).toMatch(/^session_/);

    const abort = new AbortController();
    const stream = await cp.fetch(new Request(
      `http://cp/v1/sessions/${created.id}/events/stream`,
      { headers: beta, signal: abort.signal },
    ));
    expect(stream.status).toBe(200);
    // The SSE handler attaches its live subscription asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const sent = await cp.fetch(new Request(`http://cp/v1/sessions/${created.id}/events`, post({
      events: [{ type: "user.message", content: [{ type: "text", text: "marker-7d94b0a6" }] }],
    })));
    expect(sent.status).toBe(200);
    const accepted = await sent.json() as { data: Array<{ id: string }> };

    const frames = await readSseUntil(
      stream.body!,
      (event) => event === "user.message",
      5_000,
    );
    abort.abort();

    const userFrame = frames.find((frame) => frame.event === "user.message");
    expect(frames.map((frame) => frame.event)).toContain("user.message");
    expect(JSON.parse(userFrame!.data)).toMatchObject({
      id: accepted.data[0]!.id,
      type: "user.message",
      content: [{ type: "text", text: "marker-7d94b0a6" }],
    });
  });
});
