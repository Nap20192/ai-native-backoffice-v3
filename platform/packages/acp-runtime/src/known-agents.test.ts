import { describe, expect, it } from "vitest";

import {
  OMA_OVERLAY_AGENTS,
  resolveAcpInstructionsDelivery,
  resolveOverlayAgent,
} from "./known-agents.js";

describe("Harbor agent ACP adapters", () => {
  it.each([
    ["aider", "aider-acp", []],
    ["kimi-code", "kimi", ["acp"]],
    ["mimo", "mimo", ["acp"]],
  ])("registers %s as an ACP process", (id, command, args) => {
    const entry = resolveOverlayAgent(id);
    expect(entry?.id).toBe(id);
    expect(entry?.spec.command).toBe(command);
    expect(entry?.spec.args ?? []).toEqual(args);
    expect(entry?.installHint).toEqual(expect.any(String));
  });

  it("does not silently turn the Aider bridge into an upstream Aider binary", () => {
    const aider = resolveOverlayAgent("aider");
    expect(aider?.spec.command).toBe("aider-acp");
    expect(aider?.spec.command).not.toBe("aider");
  });
});

// docs/plans/environments.md, 4.4: each client gets the platform
// instructions through the channel it reads.
describe("ACP instructions delivery", () => {
  it("sends Claude Code the instructions as _meta.systemPrompt", () => {
    expect(resolveOverlayAgent("claude-acp")?.instructions).toEqual({ kind: "meta" });
    // The runbook recipe wraps the binary in sh; the id decides.
    expect(resolveAcpInstructionsDelivery({ id: "claude-acp", command: "sh" })).toEqual({ kind: "meta" });
    expect(resolveAcpInstructionsDelivery({ id: "claude-agent-acp", command: "node" })).toEqual({ kind: "meta" });
    // Agents saved before the registry ids keep only the command.
    expect(resolveAcpInstructionsDelivery({ command: "/usr/local/bin/claude-code-acp" })).toEqual({ kind: "meta" });
  });

  it("writes AGENTS.md for Codex and OpenCode and GEMINI.md for Gemini", () => {
    expect(resolveAcpInstructionsDelivery({ id: "codex-acp", command: "codex-acp" }))
      .toEqual({ kind: "file", path: "AGENTS.md" });
    expect(resolveAcpInstructionsDelivery({ command: "codex-acp" })).toEqual({ kind: "file", path: "AGENTS.md" });
    expect(resolveAcpInstructionsDelivery({ id: "opencode", command: "opencode" }))
      .toEqual({ kind: "file", path: "AGENTS.md" });
    expect(resolveAcpInstructionsDelivery({ id: "gemini-cli", command: "sh" })).toEqual({ kind: "file", path: "GEMINI.md" });
    expect(resolveAcpInstructionsDelivery({ command: "/usr/local/bin/gemini" })).toEqual({ kind: "file", path: "GEMINI.md" });
  });

  it("puts the instructions before the first prompt of any other client", () => {
    expect(resolveAcpInstructionsDelivery({ id: "aider", command: "aider-acp" })).toEqual({ kind: "prefix" });
    expect(resolveAcpInstructionsDelivery({ id: "fake-card", command: "/usr/bin/node" })).toEqual({ kind: "prefix" });
    expect(resolveAcpInstructionsDelivery({ command: "community-acp" })).toEqual({ kind: "prefix" });
  });

  it("keeps instruction files inside the working directory", () => {
    const files = OMA_OVERLAY_AGENTS.flatMap((entry) =>
      entry.instructions?.kind === "file" ? [[entry.id, entry.instructions.path] as const] : []
    );
    expect(files.length).toBeGreaterThan(0);
    for (const [id, path] of files) expect(path, id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  });
});
