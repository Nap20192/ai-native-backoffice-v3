// The managed runner hands the turn's user message to the harness. Harnesses
// that take the prompt from `ctx.userMessage` (acp-sandbox: Claude Code and
// other ACP agents in the sandbox) otherwise fail with "Could not extract text
// from user message — empty turn".

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerHarness } from "@open-managed-agents/agent/harness/registry";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";

import { loadNodeConfig } from "../src/config";
import { createNodeControlPlane, type NodeControlPlane } from "../src/control-plane";
import { nodeDefaults } from "../src/components";
import { harnessUserMessage, latestAcceptedUserMessage } from "../src/lib/node-managed-harness-user-message";

const created: NodeControlPlane[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((cp) => cp.stop("test")));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("latestAcceptedUserMessage", () => {
  it("joins the text blocks of every accepted user message in the batch", () => {
    expect(latestAcceptedUserMessage([
      { type: "user.message", content: [{ type: "text", text: "first message" }] },
      {
        type: "user.message",
        content: [
          { type: "text", text: "first line" },
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
          { type: "text", text: "second line" },
        ],
      },
      { type: "system.message", content: [{ type: "text", text: "not a prompt" }] },
    ])).toEqual({
      type: "user.message",
      content: [
        { type: "text", text: "first message" },
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
    });
  });

  it("uses the outcome description when the turn only defines an outcome", () => {
    expect(latestAcceptedUserMessage([
      { type: "user.define_outcome", description: "Write report.md with the totals", rubric: { type: "text", content: "has totals" } },
    ])).toEqual({
      type: "user.message",
      content: [{ type: "text", text: "Write report.md with the totals" }],
    });
  });

  it("is empty when the turn has no user message", () => {
    expect(latestAcceptedUserMessage([
      { type: "user.tool_confirmation", result: "allow", toolUseId: "toolu_1" },
    ])).toEqual({ type: "user.message", content: [] });
  });
});

describe("harnessUserMessage", () => {
  const confirmation = [{ type: "user.tool_confirmation", result: "allow", toolUseId: "toolu_1" }];

  it("refuses an acp-sandbox turn without prompt text, naming the events", () => {
    expect(() => harnessUserMessage(confirmation, "acp-sandbox")).toThrow(
      /acp-sandbox.*no user message text.*user\.tool_confirmation/,
    );
  });

  it("lets other harnesses take an empty prompt (they read the history)", () => {
    expect(harnessUserMessage(confirmation, undefined)).toEqual({ type: "user.message", content: [] });
  });

  it("passes the prompt text to acp-sandbox", () => {
    expect(harnessUserMessage([{ type: "user.message", content: [{ type: "text", text: "run" }] }], "acp-sandbox"))
      .toEqual({ type: "user.message", content: [{ type: "text", text: "run" }] });
  });
});

describe("managed runner passes the user message to the harness", () => {
  it("fills ctx.userMessage with the sent text", async () => {
    let resolveSeen!: (ctx: HarnessContext) => void;
    const seen = new Promise<HarnessContext>((resolve) => { resolveSeen = resolve; });
    registerHarness("test-capture-user-message", () => ({
      run: async (ctx: HarnessContext) => { resolveSeen(ctx); },
    }));
    const dir = mkdtempSync(join(tmpdir(), "oma-harness-user-message-"));
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
    })));
    created.push(cp);
    const post = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" },
      body: JSON.stringify(body),
    });
    const env = await (await cp.fetch(new Request("http://cp/v1/environments", post({
      name: "user-message-env", config: { type: "cloud", networking: { type: "unrestricted" } },
    })))).json() as { id: string };
    const agent = await (await cp.fetch(new Request("http://cp/v1/agents", post({
      name: "user-message-agent",
      model: "claude-sonnet-4-6",
      _oma: { harness: "test-capture-user-message" },
    })))).json() as { id: string };
    const session = await (await cp.fetch(new Request("http://cp/v1/sessions", post({
      agent: agent.id, environment_id: env.id,
    })))).json() as { id: string };
    const sent = await cp.fetch(new Request(`http://cp/v1/sessions/${session.id}/events`, post({
      events: [{ type: "user.message", content: [{ type: "text", text: "создай verify.txt" }] }],
    })));
    expect(sent.status).toBe(200);
    const ctx = await Promise.race([
      seen,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 15_000)),
    ]);
    expect(ctx).not.toBe("timeout");
    expect((ctx as HarnessContext).userMessage).toEqual({
      type: "user.message",
      content: [{ type: "text", text: "создай verify.txt" }],
    });
  });
});
