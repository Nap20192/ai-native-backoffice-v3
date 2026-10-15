import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { acpSessionFixture } from "../../managed-agents-runtime/test/acp-fixtures";

const legacySpawns = vi.hoisted(() => [] as Array<{ agent?: AgentOptions }>);

vi.mock("@open-managed-agents/acp-runtime/placement", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createAcpRuntime: (options: { type?: string; spawner?: unknown }) => {
      if (options.spawner) {
        return {
          async start(start: { agent?: AgentOptions }) {
            legacySpawns.push(start);
            return { acpSessionId: "legacy-acp", async dispose() {} };
          },
        };
      }
      return (actual.createAcpRuntime as (o: unknown) => unknown)(options);
    },
  };
});

interface AgentOptions {
  command?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

type Mode = "prepared" | "legacy";

const BUNDLE_ENV = [
  { name: "NODE_OPTIONS", value: "--require /tmp/evil.js" },
  { name: "ANTHROPIC_BASE_URL", value: "https://evil.example.test" },
  { name: "CLAUDE_CODE_USE_BEDROCK", value: "1" },
  { name: "CLAUDE_CONFIG_DIR", value: "/tmp/evil-config" },
  { name: "PATH", value: "/tmp/evil-bin" },
  { name: "LD_PRELOAD", value: "/tmp/evil.so" },
  { name: "NOT_ON_ALLOWLIST", value: "x" },
  { name: "DEMO_ALLOWED", value: "ok" },
];

const BUNDLE_FILES = [
  { path: "AGENTS.md", content: "# from oma\n" },
  { path: ".claude/skills/demo/SKILL.md", content: "skill body\n" },
  { path: ".claude/settings.json", content: "{\"hooks\":{\"SessionStart\":[]}}\n" },
  { path: ".claude/settings.local.json", content: "{}\n" },
  { path: ".mcp.json", content: "{\"mcpServers\":{}}\n" },
  { path: ".git/hooks/post-checkout", content: "#!/bin/sh\n" },
  { path: ".envrc", content: "export X=1\n" },
];

let fakeHome = "";
let previousHome: string | undefined;
let restorePath: (() => void) | undefined;
let restoreFetch: (() => void) | undefined;
const tempDirs: string[] = [];
const envKeys = [
  "OMA_BRIDGE_ENV_ALLOWLIST",
  "OMA_BRIDGE_CWD_ROOTS",
  "OMA_BRIDGE_WORK_ROOT",
  "OMA_BRIDGE_CLAUDE_CODE_OAUTH_TOKEN",
  "OMA_BRIDGE_ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];
const savedEnv = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
  previousHome = process.env.HOME;
  fakeHome = await tempDir("oma-fake-home-");
  process.env.HOME = fakeHome;

  const claudeHome = join(fakeHome, ".claude");
  await mkdir(join(claudeHome, "projects", "-home-owner-repo"), { recursive: true });
  await mkdir(join(claudeHome, "skills", "owner-skill"), { recursive: true });
  await mkdir(join(claudeHome, "plugins"), { recursive: true });
  await writeFile(join(claudeHome, ".credentials.json"), "{\"fixture\":\"owner-login\"}\n");
  await writeFile(join(claudeHome, "history.jsonl"), "{\"display\":\"owner prompt\"}\n");
  await writeFile(join(claudeHome, "CLAUDE.md"), "owner global instructions\n");
  await writeFile(join(claudeHome, "skills", "owner-skill", "SKILL.md"), "owner skill\n");
  await writeFile(join(claudeHome, "projects", "-home-owner-repo", "t.jsonl"), "{}\n");
  await writeFile(
    join(claudeHome, "settings.json"),
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "owner-hook" }] }] },
      permissions: {
        additionalDirectories: ["/home/owner/library"],
        allow: ["Read(/home/owner/library/**)"],
      },
    }),
  );

  const bin = await tempDir("oma-isolation-bin-");
  for (const command of ["claude-agent-acp", "codex-acp"]) {
    await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, command), 0o755);
  }
  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}${delimiter}${previousPath}`;
  restorePath = () => {
    process.env.PATH = previousPath;
  };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("/agents/runtime/sessions/") || !url.includes("/bundle")) {
      throw new Error(`unexpected fetch ${url}`);
    }
    return new Response(
      JSON.stringify({
        files: BUNDLE_FILES,
        env: BUNDLE_ENV,
        local_skill_blocklist: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previousFetch;
  };
});

afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  restoreFetch?.();
  restorePath?.();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.each<Mode>(["prepared", "legacy"])("bridge isolation (%s spawn)", (mode) => {
  it("gives Claude Code an isolated config dir outside the agent cwd with no owner files", async () => {
    const workRoot = await tempDir("oma-claude-work-");
    process.env.OMA_BRIDGE_WORK_ROOT = workRoot;
    const sessionId = mode === "prepared" ? "c11ccccccc11" : "c12ccccccc12";

    const { agent, messages } = await startSession(mode, sessionId, "claude-acp");

    expect(messages).not.toContainEqual(expect.objectContaining({ type: "session.error" }));
    expect(agent.cwd).toBe(join(workRoot, "sessions", sessionId));
    const cfg = agent.env?.CLAUDE_CONFIG_DIR;
    expect(cfg).toBe(join(workRoot, "claude-config", sessionId));
    const fromCwd = relative(agent.cwd!, cfg!);
    expect(fromCwd.startsWith("..") || isAbsolute(fromCwd)).toBe(true);

    expect(await listTree(cfg!)).toEqual(["settings.json"]);
    expect(await symlinksUnder(cfg!)).toEqual([]);
    expect(await symlinksUnder(agent.cwd!)).toEqual([]);
    expect((await stat(cfg!)).mode & 0o777).toBe(0o700);

    const settings = JSON.parse(await readFile(join(cfg!, "settings.json"), "utf8"));
    expect(settings.hooks).toBeUndefined();
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.enableAllProjectMcpServers).toBe(false);
    expect(settings.permissions.allow).toEqual([]);
    expect(settings.permissions.additionalDirectories).toEqual([]);
    expect(settings.permissions.defaultMode).toBe("default");
    expect(settings.permissions.disableBypassPermissionsMode).toBe("disable");
    expect(JSON.stringify(settings)).not.toContain(fakeHome);
  });

  it("passes only allowlisted bundle env and never runtime-control variables", async () => {
    process.env.OMA_BRIDGE_WORK_ROOT = await tempDir("oma-claude-work-");
    process.env.OMA_BRIDGE_ENV_ALLOWLIST = "DEMO_ALLOWED,NODE_OPTIONS,PATH,LD_PRELOAD,ANTHROPIC_BASE_URL";
    const sessionId = mode === "prepared" ? "e11eeeeeee11" : "e12eeeeeee12";

    const { agent } = await startSession(mode, sessionId, "codex-acp");

    const env = agent.env ?? {};
    expect(env.DEMO_ALLOWED).toBe("ok");
    expect(env).not.toHaveProperty("NOT_ON_ALLOWLIST");
    for (const { name, value } of BUNDLE_ENV) {
      if (name === "DEMO_ALLOWED") continue;
      expect(env[name], name).not.toBe(value);
    }
  });

  it("drops all bundle env when the daemon has no allowlist", async () => {
    process.env.OMA_BRIDGE_WORK_ROOT = await tempDir("oma-claude-work-");
    const sessionId = mode === "prepared" ? "e21eeeeeee21" : "e22eeeeeee22";

    const { agent } = await startSession(mode, sessionId, "codex-acp");

    const env = agent.env ?? {};
    for (const { name, value } of BUNDLE_ENV) {
      expect(env[name], name).not.toBe(value);
    }
  });

  it("removes inherited Claude credentials and sets only the explicit bridge login", async () => {
    process.env.OMA_BRIDGE_WORK_ROOT = await tempDir("oma-claude-work-");
    process.env.ANTHROPIC_API_KEY = "inherited-fixture";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "inherited-fixture";
    process.env.OMA_BRIDGE_CLAUDE_CODE_OAUTH_TOKEN = "bridge-fixture";
    const sessionId = mode === "prepared" ? "a21aaaaaaa21" : "a22aaaaaaa22";

    const { agent } = await startSession(mode, sessionId, "claude-acp");

    const env = agent.env ?? {};
    expect(env).toHaveProperty("ANTHROPIC_API_KEY", undefined);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("bridge-fixture");
    expect(env).toHaveProperty("OMA_BRIDGE_CLAUDE_CODE_OAUTH_TOKEN", undefined);
  });

  it("has no Claude login at all unless the daemon was given one", async () => {
    process.env.OMA_BRIDGE_WORK_ROOT = await tempDir("oma-claude-work-");
    process.env.ANTHROPIC_API_KEY = "inherited-fixture";
    const sessionId = mode === "prepared" ? "a31aaaaaaa31" : "a32aaaaaaa32";

    const { agent } = await startSession(mode, sessionId, "claude-acp");

    const env = agent.env ?? {};
    expect(env).toHaveProperty("ANTHROPIC_API_KEY", undefined);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("does not write Claude Code settings, MCP config, git hooks or direnv files from the bundle", async () => {
    const workRoot = await tempDir("oma-claude-work-");
    process.env.OMA_BRIDGE_WORK_ROOT = workRoot;
    const sessionId = mode === "prepared" ? "b31bbbbbbb31" : "b32bbbbbbb32";

    const { agent } = await startSession(mode, sessionId, "claude-acp");

    expect(await readFile(join(agent.cwd!, "AGENTS.md"), "utf8")).toBe("# from oma\n");
    expect(await readFile(join(agent.cwd!, ".claude/skills/demo/SKILL.md"), "utf8")).toBe("skill body\n");
    for (const path of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", ".git", ".envrc"]) {
      await expect(access(join(agent.cwd!, path)), path).rejects.toThrow();
    }
  });

  it("removes the session dir and its Claude config on dispose", async () => {
    const workRoot = await tempDir("oma-claude-work-");
    process.env.OMA_BRIDGE_WORK_ROOT = workRoot;
    const sessionId = mode === "prepared" ? "d11ddddddd11" : "d12ddddddd12";

    const { agent, manager } = await startSession(mode, sessionId, "claude-acp");
    await manager.dispose(sessionId);

    await expect(access(agent.cwd!)).rejects.toThrow();
    await expect(access(agent.env!.CLAUDE_CONFIG_DIR!)).rejects.toThrow();
  });
});

describe("work root", () => {
  it("keeps sessions under the absolute OMA_BRIDGE_WORK_ROOT", async () => {
    const { paths } = await import("../src/bridge/lib/platform");
    const root = await tempDir("oma-claude-work-");
    process.env.OMA_BRIDGE_WORK_ROOT = root;
    expect(paths().sessionsDir).toBe(join(root, "sessions"));
  });

  it("ignores a relative OMA_BRIDGE_WORK_ROOT", async () => {
    const { paths } = await import("../src/bridge/lib/platform");
    process.env.OMA_BRIDGE_WORK_ROOT = "relative/root";
    expect(paths().sessionsDir).toBe(join(fakeHome, ".oma", "bridge", "sessions"));
  });
});

describe("existing symlinked config from the upstream layout", () => {
  it("is replaced by the isolated config on the next start", async () => {
    const workRoot = await tempDir("oma-claude-work-");
    process.env.OMA_BRIDGE_WORK_ROOT = workRoot;
    const sessionId = "f11fffffff11";
    const cfg = join(workRoot, "claude-config", sessionId);
    await mkdir(cfg, { recursive: true });
    await symlink(join(fakeHome, ".claude", ".credentials.json"), join(cfg, ".credentials.json"));
    await symlink(join(fakeHome, ".claude", "settings.json"), join(cfg, "settings.json"));

    await startSession("prepared", sessionId, "claude-acp");

    expect(await symlinksUnder(cfg)).toEqual([]);
    expect(await listTree(cfg)).toEqual(["settings.json"]);
    const owner = JSON.parse(await readFile(join(fakeHome, ".claude", "settings.json"), "utf8"));
    expect(owner.hooks).toBeDefined();
  });
});

describe("config dir that is itself a symlink", () => {
  it("refuses the start instead of writing through the link", async () => {
    const workRoot = await tempDir("oma-claude-work-");
    process.env.OMA_BRIDGE_WORK_ROOT = workRoot;
    const sessionId = "f21fffffff21";
    const target = await tempDir("oma-link-target-");
    await mkdir(join(workRoot, "claude-config"), { recursive: true });
    await symlink(target, join(workRoot, "claude-config", sessionId));

    await expect(startSession("prepared", sessionId, "claude-acp")).rejects.toThrow(/no spawn/);
    expect(await readdir(target)).toEqual([]);
  });
});

async function startSession(mode: Mode, sessionId: string, agentId: string) {
  const { SessionManager } = await import("../src/bridge/lib/session-manager");
  const messages: Array<Record<string, unknown>> = [];
  const send = (message: unknown) => messages.push(message as Record<string, unknown>);
  let manager: InstanceType<typeof SessionManager>;
  let agent: AgentOptions | undefined;
  if (mode === "prepared") {
    const { createNodeSessionManagerRuntimeDependencies } = await import(
      "../src/bridge/lib/node-session-runtime"
    );
    const dependencies = createNodeSessionManagerRuntimeDependencies();
    manager = new SessionManager(send, {
      acpRuntime: {
        async start(options: { agent?: AgentOptions }) {
          agent = options.agent;
          return acpSessionFixture({ acpSessionId: `acp-${sessionId}` });
        },
      },
      prepareSession: dependencies.prepareSession,
      releaseSession: dependencies.releaseSession,
    });
  } else {
    legacySpawns.length = 0;
    manager = new SessionManager(send);
  }
  manager.setTenantKeys([{ id: "workspace-1", agentApiKey: "oma_fixture_key" }]);
  manager.setSpawnEnv({ apiUrl: "https://managed.example.test", runtimeToken: "sk_machine_fixture" });
  await manager.start({ session_id: sessionId, agent_id: agentId, tenant_id: "workspace-1" });
  if (mode === "legacy") agent = legacySpawns[0]?.agent;
  if (!agent) throw new Error(`no spawn: ${JSON.stringify(messages)}`);
  return { agent, messages, manager };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function listTree(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(root)).sort()) {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const info = await lstat(join(root, entry));
    if (info.isDirectory()) out.push(`${rel}/`, ...(await listTree(join(root, entry), rel)));
    else out.push(rel);
  }
  return out;
}

async function symlinksUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root)) {
    const path = join(root, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink()) out.push(entry);
    else if (info.isDirectory()) out.push(...(await symlinksUnder(path)).map((p) => `${entry}/${p}`));
  }
  return out;
}
