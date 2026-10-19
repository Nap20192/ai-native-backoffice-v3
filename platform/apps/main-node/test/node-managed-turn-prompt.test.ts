// The system prompt of a managed turn (docs/plans/environment-programs.md,
// slice П4): the "Environment" block comes first among the platform
// reminders, built from the snapshot of the sandbox the turn runs in.

import { describe, expect, it, vi } from "vitest";
import {
  withSandboxExecutionGuard,
  type SandboxEnvironmentSnapshot,
  type SandboxExecutor,
} from "@open-managed-agents/sandbox";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";

import { buildNodeManagedTurnPrompt } from "../src/lib/node-managed-session-inputs";
import { DefaultNodeManagedSessionRunner } from "../src/lib/node-managed-session-runner";

const DIGEST = `sha256:${"3f".repeat(32)}`;

// Shape written by platform/sandbox-images/manifest.sh, trimmed to the facts the block reads.
const office = {
  schema_version: 1,
  image_digest: DIGEST,
  os: { name: "Debian GNU/Linux", version: "12 (bookworm)", version_id: "12" },
  architecture: "x86_64",
  user: "root",
  shell: "/bin/bash",
  venv: "/opt/venv",
  python_version: "3.11.2",
  node_version: "v22.23.3",
  package_managers: ["apt-get", "npm", "pip", "uv"],
  pip: [
    { name: "openpyxl", version: "3.1.5" }, { name: "pip", version: "24.3.1" },
    { name: "python-docx", version: "1.1.2" }, { name: "python-pptx", version: "1.0.2" },
  ],
  dpkg: [
    { name: "git", version: "1:2.39.5-0+deb12u3" },
    { name: "poppler-utils", version: "22.12.0-2+deb12u3" },
  ],
  fonts: ["DejaVu Sans\t/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
  libreoffice_version: "LibreOffice 7.4.7.2 40(Build:2)",
};

const legacy = {
  ...office,
  venv: null,
  package_managers: ["apt-get", "npm"],
  pip: [],
  dpkg: [{ name: "git", version: "1:2.39.5-0+deb12u3" }],
  libreoffice_version: null,
};

function snapshotOf(manifest: Record<string, unknown> | null, key: string | null = "workplace-office"): SandboxEnvironmentSnapshot {
  return {
    image: {
      key,
      reference: key === null ? "node:22-bookworm" : null,
      digest: key === null ? null : DIGEST,
      manifestSha256: key === null ? null : `sha256:${"ab".repeat(32)}`,
      manifest,
    },
    shell: key === null ? "sh" : "bash",
    workingDirectory: "/workspace",
    networking: { type: "unrestricted" },
    egress: { type: "unrestricted" },
    packages: {},
    resources: { diskGb: 8, memoryMib: 1536, cpus: 2 },
    vm: null,
  };
}

function sandboxOf(snapshot: SandboxEnvironmentSnapshot): SandboxExecutor {
  return {
    exec: vi.fn(async () => "ok"),
    destroy: vi.fn(async () => {}),
    environmentSnapshot: () => snapshot,
  } as unknown as SandboxExecutor;
}

const session = {
  id: "session_01",
  agent: {
    id: "agent_01", description: null, mcpServers: [], model: { id: "qwen3.6-35b" }, multiagent: null,
    name: "Office agent", system: "Make reports.", tools: [], version: 1,
    skills: [{ type: "anthropic", skillId: "pptx", version: "latest" }],
  },
  archivedAt: null, budget: null, createdAt: "2026-10-19T00:00:00.000Z", environmentId: "env_01",
  metadata: {}, outcomeEvaluations: [], resources: [], stats: {}, status: "running", title: null,
  updatedAt: "2026-10-19T00:00:00.000Z", usage: {}, vaultIds: [],
} as unknown as Session;

const environment: Environment = {
  id: "env_01", archivedAt: null, config: { type: "self_hosted" }, createdAt: "2026-10-19T00:00:00.000Z",
  description: null, metadata: {}, name: "Office", updatedAt: "2026-10-19T00:00:00.000Z",
};

describe("system prompt of a managed turn", () => {
  it("puts the environment block of the office image first, with soffice, poppler and the venv", () => {
    const prompt = buildNodeManagedTurnPrompt({
      session, sandbox: sandboxOf(snapshotOf(office)), tools: { bash: {} }, assemblySkills: false,
    });
    expect(prompt.rawSystemPrompt).toBe("Make reports.");
    expect(prompt.platformReminders.map((reminder) => reminder.source)).toEqual(["environment", "skill:pptx"]);
    for (const fact of [
      '<source name="environment">\n<environment>\n',
      "Debian 12 (bookworm), x86_64. You are root.",
      "Python 3.11 (python, pip and uv use the venv /opt/venv)",
      "pdftotext, pdftoppm",
      "LibreOffice 7.4 (soffice --headless)",
      "Python libraries: python-pptx, python-docx, openpyxl.",
      "pip install <name>",
      "Web search: not available.",
    ]) expect(prompt.systemPrompt).toContain(fact);
    expect(prompt.systemPrompt.indexOf('<source name="environment">'))
      .toBeLessThan(prompt.systemPrompt.indexOf('<source name="skill:pptx">'));
  });

  it("tells the agent on the legacy image that pip needs --break-system-packages", () => {
    const { systemPrompt } = buildNodeManagedTurnPrompt({
      session, sandbox: sandboxOf(snapshotOf(legacy, "legacy")), tools: {}, assemblySkills: true,
    });
    expect(systemPrompt).toContain("python3 3.11 without pip");
    expect(systemPrompt).toContain("pip install --break-system-packages <name>");
    expect(systemPrompt).not.toContain("soffice");
    expect(systemPrompt).not.toContain('<source name="skill:pptx">');
  });

  it("does not describe the server image, which has no verified manifest", () => {
    const { systemPrompt } = buildNodeManagedTurnPrompt({
      session, sandbox: sandboxOf(snapshotOf(null, null)), tools: {}, assemblySkills: true,
    });
    expect(systemPrompt).toContain('<source name="environment">');
    expect(systemPrompt).toContain("Check them with commands");
    expect(systemPrompt).not.toContain("Debian");
  });

  it("gives the unknown block to a sandbox without a snapshot and names search when the agent has it", () => {
    const { systemPrompt } = buildNodeManagedTurnPrompt({
      session, sandbox: { exec: async () => "" } as unknown as SandboxExecutor,
      tools: { web_search: {} }, assemblySkills: true,
    });
    expect(systemPrompt).toContain("Check them with commands");
    const withSearch = buildNodeManagedTurnPrompt({
      session, sandbox: sandboxOf(snapshotOf(office)), tools: { web_search: {} }, assemblySkills: true,
    });
    expect(withSearch.systemPrompt).toContain("Web search: available.");
  });

  it("reads the snapshot through the fenced sandbox the runner gives the turn", async () => {
    const prompts: string[] = [];
    let nextId = 0;
    const runner = new DefaultNodeManagedSessionRunner({
      outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool execution"); } },
      buildSandbox: async () => sandboxOf(snapshotOf(office)),
      buildModel: async () => ({}),
      buildTools: async () => ({ bash: {} }),
      buildHarness: () => ({ run: async () => {} }),
      buildHarnessContext: async (input) => {
        prompts.push(buildNodeManagedTurnPrompt({
          session: input.session, sandbox: input.sandbox, tools: input.tools, assemblySkills: false,
        }).systemPrompt);
        return input;
      },
      clock: { now: () => new Date("2026-10-19T09:00:00.000Z") },
      ids: { nextEventId: () => `event_prompt_0${++nextId}` },
    } as never);
    await runner.start({ workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [] });
    const event = {
      id: "event_user_prompt", type: "user.message" as const,
      content: [{ type: "text" as const, text: "Make slides" }], processedAt: "2026-10-19T08:59:00.000Z",
    };
    await runner.accept({
      workspaceId: "workspace_01", sessionId: session.id, session, environment, initialEvents: [],
      events: [event], historyEvents: [event],
      executionFence: {
        workspaceId: "workspace_01", sessionId: session.id, executionId: event.id, attemptId: "attempt_01",
        ownerId: "worker_01", generation: 1, expiresAt: "2026-10-19T09:01:00.000Z",
      },
      output: async () => {},
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("LibreOffice 7.4 (soffice --headless)");
  });

  it("keeps the snapshot readable through the execution guard", () => {
    const guarded = withSandboxExecutionGuard(sandboxOf(snapshotOf(office)), { signal: new AbortController().signal });
    const { systemPrompt } = buildNodeManagedTurnPrompt({ session, sandbox: guarded, tools: {}, assemblySkills: true });
    expect(systemPrompt).toContain("soffice --headless");
  });
});
