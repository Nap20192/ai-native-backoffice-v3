import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  instances: [] as FakeBox[],
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("@boxlite-ai/boxlite", () => ({
  SimpleBox: class {
    constructor(options: Record<string, unknown>) {
      sdk.options.push(options);
      const box = sdk.instances.shift();
      if (!box) throw new Error("fake box missing");
      return box;
    }
  },
}));

import { NoopLogger, setRootLogger, type Logger } from "@open-managed-agents/observability";
import {
  applyShimDnsWorkaround,
  LiteBoxSandbox,
  liteBoxNetwork,
  sandboxFactory,
  stripRuntimeNoise,
  withShimDnsWorkaround,
} from "../src/litebox";

function fakeBox() {
  return {
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" })),
    copyIn: vi.fn(async () => {}),
    copyOut: vi.fn(async (_source: string, destination: string) => { await fs.writeFile(destination, "content"); }),
    stop: vi.fn(async () => {}),
  };
}

type FakeBox = ReturnType<typeof fakeBox>;

function queueBox() {
  const box = fakeBox();
  sdk.instances.push(box);
  return box;
}

const originalEnv = {
  memory: process.env.MEMORY_BLOB_DIR,
  outputs: process.env.FILES_BLOB_DIR,
  proxy: process.env.OMA_VAULT_PROXY_URL,
  ca: process.env.OMA_VAULT_CA_CERT,
  godebug: process.env.GODEBUG,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  sdk.instances.length = 0;
  sdk.options.length = 0;
  delete process.env.MEMORY_BLOB_DIR;
  delete process.env.FILES_BLOB_DIR;
  delete process.env.OMA_VAULT_PROXY_URL;
  delete process.env.OMA_VAULT_CA_CERT;
  delete process.env.GODEBUG;
});

afterEach(() => {
  restore("MEMORY_BLOB_DIR", originalEnv.memory);
  restore("FILES_BLOB_DIR", originalEnv.outputs);
  restore("OMA_VAULT_PROXY_URL", originalEnv.proxy);
  restore("OMA_VAULT_CA_CERT", originalEnv.ca);
  restore("GODEBUG", originalEnv.godebug);
  vi.restoreAllMocks();
});

describe("LiteBoxSandbox", () => {
  it("creates lazily once with default options and executes commands", async () => {
    const box = queueBox();
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.exec("one")).resolves.toBe("ok");
    await expect(sandbox.exec("two")).resolves.toBe("ok");
    expect(sdk.options).toEqual([{
      image: "node:22-bookworm",
      memoryMib: undefined,
      cpus: undefined,
      name: undefined,
      volumes: [],
      network: { mode: "enabled" },
    }]);
    expect(box.exec).toHaveBeenNthCalledWith(1, "mkdir", ["-p", "/workspace"]);
    expect(box.exec).toHaveBeenNthCalledWith(2, "sh", ["-c", "one"], {}, {
      cwd: "/workspace",
      timeoutSecs: 120,
    });
    expect(box.exec).toHaveBeenNthCalledWith(3, "sh", ["-c", "two"], {}, {
      cwd: "/workspace",
      timeoutSecs: 120,
    });
    await expect(sandbox.startProcess("ignored")).resolves.toBeNull();
    await sandbox.destroy();
  });

  it("maps output, minimum/default timeouts, env, secrets, and failures", async () => {
    const box = queueBox();
    box.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 4, stdout: "out\n", stderr: "err\n" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "out", stderr: "err" })
      .mockRejectedValueOnce(new Error("offline"));
    const sandbox = new LiteBoxSandbox({ image: "image:1", memoryMib: 512, cpus: 2, name: "named", defaultTimeoutMs: 100 });
    await sandbox.setEnvVars({ A: "1" });
    await sandbox.setEnvVars({ B: "2" });
    sandbox.registerCommandSecrets("git ", { TOKEN: "secret" });
    sandbox.registerCommandSecrets("npm ", { NPM: "secret" });
    await expect(sandbox.exec("git clone", 1)).resolves.toBe("out\nerr\n[exit 4]");
    await expect(sandbox.exec("echo clean")).resolves.toBe("out\nerr");
    await expect(sandbox.exec("npm install")).resolves.toBe("[error: offline]");
    expect(box.exec.mock.calls[1]?.[2]).toEqual({ A: "1", B: "2", TOKEN: "secret" });
    expect(box.exec.mock.calls[2]?.[2]).toEqual({ A: "1", B: "2" });
    expect(box.exec.mock.calls[1]?.[3]).toEqual({ cwd: "/workspace", timeoutSecs: 1 });
    expect(sdk.options[0]).toMatchObject({ image: "image:1", memoryMib: 512, cpus: 2, name: "named" });
    await sandbox.destroy();
  });

  it("explains a missing optional SDK", async () => {
    vi.resetModules();
    vi.doMock("@boxlite-ai/boxlite", () => { throw new Error("not installed"); });
    const fresh = await import("../src/litebox");
    const missing = new fresh.LiteBoxSandbox({ logger: { warn: vi.fn(), log: vi.fn() } });
    await expect(missing.exec("x")).rejects.toThrow("failed to load '@boxlite-ai/boxlite'");
    await missing.destroy();
    vi.doUnmock("@boxlite-ai/boxlite");
    vi.doMock("@boxlite-ai/boxlite", () => ({
      SimpleBox: class {
        constructor(options: Record<string, unknown>) {
          sdk.options.push(options);
          const box = sdk.instances.shift();
          if (!box) throw new Error("fake box missing");
          return box as never;
        }
      },
    }));
  });

  it("mounts memory and outputs from explicit roots before construction", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-roots-"));
    queueBox();
    const warn = vi.fn();
    const sandbox = new LiteBoxSandbox({ memoryRoot: join(root, "memory"), outputsRoot: join(root, "outputs"), logger: { warn, log: vi.fn() } });
    expect(sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await sandbox.mountMemoryStore({ storeName: "memory", storeId: "store", readOnly: true });
    await sandbox.mountSessionOutputs({ tenantId: "tenant", sessionId: "session" });
    await sandbox.exec("x");
    expect(sdk.options[0]?.volumes).toEqual([
      { hostPath: join(root, "memory", "store"), guestPath: "/mnt/memory/memory", readOnly: true },
      { hostPath: join(root, "outputs", "tenant", "session"), guestPath: "/mnt/session/outputs", readOnly: false },
    ]);
    expect(warn).not.toHaveBeenCalled();
    await sandbox.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("supports legacy env roots with warnings and reports missing/late mount configuration", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-env-"));
    process.env.MEMORY_BLOB_DIR = join(root, "memory");
    process.env.FILES_BLOB_DIR = join(root, "outputs");
    const warn = vi.fn();
    queueBox();
    const sandbox = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    expect(sandbox.sessionOutputMountCapabilities()).toEqual({ durability: "durable" });
    await sandbox.mountMemoryStore({ storeName: "m", storeId: "s", readOnly: false });
    await sandbox.mountSessionOutputs({ tenantId: "t", sessionId: "s" });
    expect(warn).toHaveBeenCalledTimes(2);
    await sandbox.exec("x");
    await expect(sandbox.mountMemoryStore({ storeName: "late", storeId: "s", readOnly: false })).rejects.toThrow("box already created");
    await expect(sandbox.mountSessionOutputs({ tenantId: "late", sessionId: "s" })).rejects.toThrow("box already created");
    await sandbox.destroy();

    delete process.env.MEMORY_BLOB_DIR;
    delete process.env.FILES_BLOB_DIR;
    const missing = new LiteBoxSandbox();
    expect(missing.sessionOutputMountCapabilities()).toBeNull();
    await expect(missing.mountMemoryStore({ storeName: "m", storeId: "s", readOnly: false })).rejects.toThrow("memoryRoot not provided");
    await expect(missing.mountSessionOutputs({ tenantId: "t", sessionId: "s" })).rejects.toThrow("outputsRoot not provided");
    await missing.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("copies text and bytes in both directions with relative and absolute paths", async () => {
    const box = queueBox();
    box.copyOut
      .mockImplementationOnce(async (_source, destination) => { await fs.writeFile(destination, "text"); })
      .mockImplementationOnce(async (_source, destination) => { await fs.writeFile(destination, new Uint8Array([1, 2, 3])); });
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.readFile("relative.txt")).resolves.toBe("text");
    await expect(sandbox.readFileBytes("/absolute.bin")).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(sandbox.writeFile("relative.txt", "hello")).resolves.toBe("/workspace/relative.txt");
    await expect(sandbox.writeFileBytes("/absolute.bin", new Uint8Array([4, 5]))).resolves.toBe("/absolute.bin");
    expect(box.copyOut.mock.calls[0]?.[0]).toBe("/workspace/relative.txt");
    expect(box.copyOut.mock.calls[1]?.[0]).toBe("/absolute.bin");
    expect(box.copyIn.mock.calls[0]?.[1]).toBe("/workspace/relative.txt");
    expect(box.copyIn.mock.calls[1]?.[1]).toBe("/absolute.bin");
    expect(box.exec).toHaveBeenCalledWith("mkdir", ["-p", "/workspace"]);
    expect(box.exec).toHaveBeenCalledWith("mkdir", ["-p", "/"]);
    await sandbox.destroy();
  });

  it("writes and reads files under a mounted volume inside the VM, not under the mount", async () => {
    // 2026-10-16: `write` put itogi.md into /mnt/session/outputs with copyIn,
    // the host-mounted outputs hid it, and the file never reached the session
    // outputs although `read` (copyOut) found it again.
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-volume-"));
    const box = queueBox();
    const sandbox = new LiteBoxSandbox({ outputsRoot: join(root, "outputs") });
    await sandbox.mountSessionOutputs({ tenantId: "t", sessionId: "s" });

    await expect(sandbox.writeFile("/mnt/session/outputs/itogi.md", "# Итоги")).resolves.toBe("/mnt/session/outputs/itogi.md");
    const staged = box.copyIn.mock.calls[0]?.[1] as string;
    expect(staged).toMatch(/^\/var\/tmp\/\.oma-write-[0-9a-f]+$/);
    expect(box.exec).toHaveBeenCalledWith("sh", [
      "-c",
      expect.stringContaining('cat "$1" > "$2"'),
      "sh",
      staged,
      "/mnt/session/outputs/itogi.md",
    ], {}, { timeoutSecs: expect.any(Number) });
    expect(box.exec).toHaveBeenCalledWith("rm", ["-f", staged]);

    box.copyOut.mockImplementationOnce(async (_source, destination) => { await fs.writeFile(destination, "# Итоги"); });
    await expect(sandbox.readFile("/mnt/session/outputs/itogi.md")).resolves.toBe("# Итоги");
    const readStaged = box.copyOut.mock.calls[0]?.[0] as string;
    expect(readStaged).toMatch(/^\/var\/tmp\/\.oma-read-[0-9a-f]+$/);
    expect(box.exec).toHaveBeenCalledWith("sh", ["-c", expect.stringContaining('cat "$1" > "$2"'), "sh", "/mnt/session/outputs/itogi.md", readStaged], {}, { timeoutSecs: expect.any(Number) });
    expect(box.exec).toHaveBeenCalledWith("rm", ["-f", readStaged]);

    await sandbox.writeFileBytes("/mnt/session/outputs/svodka.xlsx", new Uint8Array([80, 75]));
    expect(box.copyIn.mock.calls.at(-1)?.[1]).toMatch(/^\/var\/tmp\/\.oma-write-/);

    // /tmp is a tmpfs of the box container: copyIn under it is hidden as well.
    await sandbox.writeFile("/tmp/script.py", "print(1)");
    expect(box.copyIn.mock.calls.at(-1)?.[1]).toMatch(/^\/var\/tmp\/\.oma-write-/);
    expect(box.exec).toHaveBeenCalledWith("sh", ["-c", expect.any(String), "sh", expect.any(String), "/tmp/script.py"], {}, { timeoutSecs: expect.any(Number) });

    // Outside every mount, and out of one through "..", the direct copy stays.
    await sandbox.writeFile("/workspace/a.txt", "a");
    expect(box.copyIn.mock.calls.at(-1)?.[1]).toBe("/workspace/a.txt");
    await sandbox.writeFile("/mnt/session/outputs/../escape.txt", "x");
    expect(box.copyIn.mock.calls.at(-1)?.[1]).toBe("/mnt/session/outputs/../escape.txt");
    await sandbox.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("removes the staging file when the copy inside the VM cannot start, and refuses FIFOs (Codex review)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-volume-gone-"));
    const box = queueBox();
    box.exec.mockImplementation(async (command: string) => {
      if (command === "sh") throw new Error("box gone");
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    });
    const sandbox = new LiteBoxSandbox({ outputsRoot: join(root, "outputs") });
    await sandbox.mountSessionOutputs({ tenantId: "t", sessionId: "s" });

    await expect(sandbox.writeFile("/mnt/session/outputs/a.md", "x")).rejects.toThrow("box gone");
    const staged = box.copyIn.mock.calls[0]?.[1] as string;
    expect(box.exec).toHaveBeenCalledWith("rm", ["-f", staged]);
    const scripts = box.exec.mock.calls.filter((call) => call[0] === "sh").map((call) => (call[1] as string[])[1]);
    expect(scripts.every((script) => script.includes("[ -p "))).toBe(true);
    await sandbox.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reports a copy that failed inside the VM, for example on a read-only memory store", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "openma-litebox-volume-ro-"));
    const box = queueBox();
    box.exec.mockImplementation(async (command: string) =>
      command === "sh"
        ? { exitCode: 1, stdout: "", stderr: "sh: 1: cannot create /mnt/memory/notes/a.md: Read-only file system" }
        : { exitCode: 0, stdout: "ok\n", stderr: "" },
    );
    const sandbox = new LiteBoxSandbox({ memoryRoot: join(root, "memory") });
    await sandbox.mountMemoryStore({ storeName: "notes", storeId: "store", readOnly: true });

    await expect(sandbox.writeFile("/mnt/memory/notes/a.md", "x")).rejects.toThrow(/Read-only file system/);
    await expect(sandbox.readFile("/mnt/memory/notes/missing.md")).rejects.toThrow(/could not read/);
    await sandbox.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("cleans staging paths even when copy operations or cleanup fail", async () => {
    const box = queueBox();
    box.copyOut.mockRejectedValueOnce(new Error("copy out"));
    box.copyIn.mockRejectedValueOnce(new Error("copy in"));
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.readFile("a")).rejects.toThrow("copy out");
    await expect(sandbox.writeFile("b", "x")).rejects.toThrow("copy in");
    await sandbox.destroy();

    const cleanup = queueBox();
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup"));
    const cleanupFailure = new LiteBoxSandbox();
    await expect(cleanupFailure.readFile("a")).resolves.toBe("content");
    expect(rm).toHaveBeenCalled();
    rm.mockRestore();
    await cleanupFailure.destroy();
    expect(cleanup.copyOut).toHaveBeenCalled();
  });

  it("wires the outbound proxy and makes CA upload best-effort", async () => {
    const caPath = join(tmpdir(), `openma-litebox-${process.pid}.pem`);
    await fs.writeFile(caPath, "CA");
    process.env.OMA_VAULT_PROXY_URL = "http://proxy";
    process.env.OMA_VAULT_CA_CERT = caPath;
    const box = queueBox();
    const sandbox = new LiteBoxSandbox();
    await sandbox.setOutboundContext({ tenantId: "t", sessionId: "s" });
    await sandbox.exec("x");
    expect(box.copyIn).toHaveBeenCalledWith(caPath, "/etc/ssl/oma-vault-ca.crt");
    const shellCall = box.exec.mock.calls.find(([command]) => command === "sh");
    expect(shellCall?.[2]).toMatchObject({ HTTPS_PROXY: "http://proxy", SSL_CERT_FILE: "/etc/ssl/oma-vault-ca.crt" });
    await sandbox.destroy();

    const warn = vi.fn();
    const failing = queueBox();
    failing.copyIn.mockRejectedValueOnce(new Error("copy failed"));
    const uploadFailure = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    await uploadFailure.setOutboundContext();
    await uploadFailure.exec("x");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("copy failed"));
    await uploadFailure.destroy();
    await fs.unlink(caPath);
  });

  it("skips incomplete outbound proxy settings", async () => {
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.setOutboundContext()).resolves.toBeUndefined();
    process.env.OMA_VAULT_PROXY_URL = "http://proxy";
    await expect(sandbox.setOutboundContext()).resolves.toBeUndefined();
    await sandbox.destroy();
  });

  it("destroy is repeatable and absorbs stop, create, and scratch cleanup failures", async () => {
    const warn = vi.fn();
    const stopped = queueBox();
    stopped.stop.mockRejectedValueOnce(new Error("stop failed"));
    const sandbox = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    await sandbox.exec("x");
    await sandbox.destroy();
    await sandbox.destroy();
    expect(warn).toHaveBeenCalledWith("destroy stop failed: stop failed");

    const rejected = queueBox();
    rejected.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("exec"));
    const createPromise = new LiteBoxSandbox({ logger: { warn, log: vi.fn() } });
    await createPromise.exec("x");
    await createPromise.destroy();

    const scratchRoot = await fs.mkdtemp(join(tmpdir(), "openma-litebox-cleanup-failure-"));
    const rm = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("rm"));
    const scratch = new LiteBoxSandbox({ scratchRoot });
    await expect(scratch.destroy()).resolves.toBeUndefined();
    rm.mockRestore();
    await fs.rm(scratchRoot, { recursive: true, force: true });
  });

  it("factory maps optional provider construction settings", async () => {
    const configured = await sandboxFactory(
      { sessionId: "session", memoryRoot: "/memory", outputsRoot: "/outputs" } as never,
      { SANDBOX_IMAGE: "image", LITEBOX_MEMORY_MIB: "1024", LITEBOX_CPUS: "4" },
    );
    const defaults = await sandboxFactory({ sessionId: "session" } as never, {});
    expect(configured).toBeInstanceOf(LiteBoxSandbox);
    expect(defaults).toBeInstanceOf(LiteBoxSandbox);
    await configured.destroy();
    await defaults.destroy();
  });

  it("factory sizes the VM root disk from LITEBOX_DISK_SIZE_GB", async () => {
    queueBox();
    queueBox();
    const sized = await sandboxFactory({ sessionId: "session" } as never, { LITEBOX_DISK_SIZE_GB: "8" });
    await sized.exec("x");
    const plain = await sandboxFactory({ sessionId: "session" } as never, {});
    await plain.exec("x");
    expect(sdk.options[0]).toMatchObject({ diskSizeGb: 8 });
    expect(sdk.options[1]?.diskSizeGb).toBeUndefined();
    await sized.destroy();
    await plain.destroy();
  });

  it("factory scopes copy staging to the session workdir lifecycle", async () => {
    const workdir = await fs.mkdtemp(join(tmpdir(), "openma-litebox-session-"));
    const sandbox = await sandboxFactory({ sessionId: "session", workdir }, {});

    const scratchEntries = await fs.readdir(join(workdir, ".openma"));
    expect(scratchEntries).toHaveLength(1);
    expect(scratchEntries[0]).toMatch(/^litebox-scratch-/);

    await sandbox.destroy();
    await expect(fs.readdir(join(workdir, ".openma"))).resolves.toEqual([]);
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("default logger callbacks remain usable", async () => {
    const box = queueBox();
    box.stop.mockRejectedValueOnce(new Error("stop"));
    const sandbox = new LiteBoxSandbox();
    await sandbox.exec("x");
    await sandbox.destroy();
  });

  it("strips the guest runtime's libcontainer log line from command output", async () => {
    const box = queueBox();
    box.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: SECCOMP_WARN })
      .mockResolvedValueOnce({ exitCode: 3, stdout: "out\n", stderr: `${SECCOMP_WARN}real error\n` });
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.exec("false")).resolves.toBe("out\nreal error\n[exit 3]");
    await sandbox.destroy();
  });

  it("forces Go's pure resolver for the shim only while the box boots", async () => {
    const box = queueBox();
    const seen: Array<string | undefined> = [];
    box.exec.mockImplementation(async () => {
      seen.push(process.env.GODEBUG);
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    });
    const log = vi.fn();
    const sandbox = new LiteBoxSandbox({ logger: { warn: vi.fn(), log } });
    await sandbox.exec("x");
    // First exec boots the box (BoxLite spawns boxlite-shim); later ones must
    // not hand the setting to other children of the server.
    expect(seen).toEqual(["netdns=go", undefined]);
    expect(process.env.GODEBUG).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("GODEBUG=netdns=go"));
    await sandbox.destroy();
  });

  it("creates the box with the environment egress policy", async () => {
    queueBox();
    const workdir = await fs.mkdtemp(join(tmpdir(), "openma-litebox-net-"));
    const sandbox = await sandboxFactory({
      sessionId: "s",
      workdir,
      environment: {
        networking: { type: "limited", allowedHosts: ["https://Example.com/x"], allowPackageManagers: false, allowMcpServers: false },
      },
    }, {});
    await sandbox.exec("x");
    expect(sdk.options[0]?.network).toEqual({ mode: "enabled", allowNet: ["example.com"] });
    await sandbox.destroy?.();
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("installs environment packages once, before the first command", async () => {
    const box = queueBox();
    const log = vi.fn();
    const sandbox = new LiteBoxSandbox({
      logger: { warn: vi.fn(), log },
      environment: { packages: { apt: ["jq"], npm: ["left-pad"], pip: [] } },
    });
    await sandbox.setEnvVars({ OMA_OUTPUTS_DIR: "/mnt/session/outputs", ANTHROPIC_API_KEY: "vault-secret" });
    await sandbox.exec("jq --version");
    await sandbox.exec("echo again");
    const calls = box.exec.mock.calls as unknown as Array<[string, string[], Record<string, string>?, Record<string, unknown>?]>;
    expect(calls.map(([command]) => command)).toEqual(["mkdir", "sh", "sh", "sh"]);
    expect(calls[2]?.[1]).toEqual(["-c", "jq --version"]);
    expect(calls[3]?.[1]).toEqual(["-c", "echo again"]);
    const [, setupArgs, setupEnv, setupOptions] = calls[1]!;
    expect(setupArgs[1]).toContain("apt-get install -y -qq --no-install-recommends 'jq'");
    expect(setupArgs[1]).toContain("npm install -g --no-fund --no-audit --loglevel=error 'left-pad'");
    expect(setupArgs[1]).not.toContain("pip install");
    // Third-party install scripts (npm/pip postinstall) never see sandbox
    // variables such as Vault secrets; only the outbound proxy settings.
    expect(setupEnv).toEqual({});
    expect(calls[2]?.[2]).toMatchObject({ ANTHROPIC_API_KEY: "vault-secret" });
    expect(setupOptions).toEqual({ cwd: "/workspace", timeoutSecs: 600 });
    expect(log).toHaveBeenCalledWith("installing environment packages (apt: jq; npm: left-pad)");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^environment packages installed in \d+ ms$/));
    await sandbox.destroy();
  });

  it("passes only the outbound proxy settings to the package install", async () => {
    process.env.OMA_VAULT_PROXY_URL = "http://proxy";
    process.env.OMA_VAULT_CA_CERT = join(tmpdir(), "missing-ca.pem");
    const box = queueBox();
    const sandbox = new LiteBoxSandbox({
      logger: { warn: vi.fn(), log: vi.fn() },
      environment: { packages: { npm: ["left-pad"] } },
    });
    await sandbox.setOutboundContext({ tenantId: "t", sessionId: "s" });
    await sandbox.setEnvVars({ CLAUDE_CODE_OAUTH_TOKEN: "vault-secret" });
    await sandbox.exec("true");
    const calls = box.exec.mock.calls as unknown as Array<[string, string[], Record<string, string>?]>;
    const setupEnv = calls.find(([command, args]) => command === "sh" && args[1]?.includes("npm install"))?.[2];
    expect(setupEnv).toEqual({
      HTTP_PROXY: "http://proxy",
      HTTPS_PROXY: "http://proxy",
      http_proxy: "http://proxy",
      https_proxy: "http://proxy",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/oma-vault-ca.crt",
      SSL_CERT_FILE: "/etc/ssl/oma-vault-ca.crt",
      CURL_CA_BUNDLE: "/etc/ssl/oma-vault-ca.crt",
    });
    await sandbox.destroy();
  });

  it("warns about allowlist gaps of BoxLite 0.9.0: wildcards, the vault proxy, no network", async () => {
    process.env.OMA_VAULT_PROXY_URL = "http://vault.internal:8790";
    queueBox();
    const warn = vi.fn();
    const sandbox = new LiteBoxSandbox({
      logger: { warn, log: vi.fn() },
      resolveHost: async () => ["198.51.100.1"],
      environment: {
        networking: { type: "limited", allowedHosts: ["api.example.com", "*.cdn.example.net"], allowPackageManagers: false, allowMcpServers: false },
      },
    });
    await sandbox.exec("true");
    const warnings = warn.mock.calls.map(([message]) => String(message));
    expect(warnings).toContainEqual(expect.stringContaining("*.cdn.example.net"));
    expect(warnings).toContainEqual(expect.stringContaining("vault.internal"));
    await sandbox.destroy();

    queueBox();
    const quietWarn = vi.fn();
    const none = new LiteBoxSandbox({
      logger: { warn: quietWarn, log: vi.fn() },
      environment: { networking: { type: "limited", allowedHosts: [], allowPackageManagers: false, allowMcpServers: false } },
    });
    await none.exec("true");
    expect(quietWarn.mock.calls.map(([message]) => String(message))).toContainEqual(
      expect.stringContaining("no network, the vault proxy included"),
    );
    await none.destroy();

    // A proxy URL without a host adds no allowed host and no warning.
    process.env.OMA_VAULT_PROXY_URL = "http://";
    queueBox();
    const hostlessWarn = vi.fn();
    const hostless = new LiteBoxSandbox({
      logger: { warn: hostlessWarn, log: vi.fn() },
      resolveHost: async () => ["198.51.100.1"],
      environment: {
        networking: { type: "limited", allowedHosts: ["api.example.com"], allowPackageManagers: false, allowMcpServers: false },
      },
    });
    await hostless.exec("true");
    expect(hostlessWarn).not.toHaveBeenCalled();
    expect(sdk.options.at(-1)?.network).toEqual({ mode: "enabled", allowNet: ["api.example.com"] });
    await hostless.destroy();
  });

  it("pins exact allowed hosts in /etc/hosts before installing packages", async () => {
    // BoxLite 0.9.0 builds its allowlist DNS zones from a Go map: the zone
    // of an apex host (pypi.org → "org.") can shadow deb.debian.org in a
    // random order and answer 0.0.0.0. Pinned names skip that DNS answer;
    // TCP is still filtered by SNI / Host header.
    process.env.OMA_VAULT_PROXY_URL = "http://vault.internal:8790";
    process.env.OMA_VAULT_CA_CERT = "";
    const box = queueBox();
    const log = vi.fn();
    const resolveHost = vi.fn(async (host: string) =>
      host === "api.example.com" ? ["203.0.113.7", "203.0.113.8"] : ["198.51.100.1"]);
    const sandbox = new LiteBoxSandbox({
      logger: { warn: vi.fn(), log },
      resolveHost,
      environment: {
        packages: { apt: ["jq"] },
        networking: {
          type: "limited",
          allowedHosts: ["api.example.com", "*.cdn.example.net", "10.1.2.3", "https://git.example.org/repo"],
          allowPackageManagers: false,
          allowMcpServers: false,
        },
      },
    });
    await sandbox.exec("x");
    const calls = box.exec.mock.calls as unknown as Array<[string, string[], Record<string, string>?, Record<string, unknown>?]>;
    expect(calls.map(([command]) => command)).toEqual(["mkdir", "sh", "sh", "sh"]);
    expect(calls[1]?.[1]).toEqual([
      "-c",
      'printf "%s\\n" "$@" >> /etc/hosts',
      "sh",
      "203.0.113.7 api.example.com",
      "203.0.113.8 api.example.com",
      "198.51.100.1 git.example.org",
    ]);
    expect(calls[2]?.[1][1]).toContain("apt-get install");
    expect(resolveHost.mock.calls.map(([host]) => host)).toEqual(["api.example.com", "git.example.org"]);
    expect(log).toHaveBeenCalledWith("pinned 2 allowed host(s) in /etc/hosts");
    await sandbox.destroy();
  });

  it("skips hosts that do not resolve and keeps going when /etc/hosts cannot be written", async () => {
    const box = queueBox();
    box.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: `${SECCOMP_WARN}sh: /etc/hosts: Read-only file system\n` });
    const warn = vi.fn();
    const sandbox = new LiteBoxSandbox({
      logger: { warn, log: vi.fn() },
      resolveHost: async (host) => {
        if (host === "down.example.com") throw new Error("ENOTFOUND down.example.com");
        return host === "empty.example.com" ? [] : ["192.0.2.10"];
      },
      environment: {
        networking: {
          type: "limited",
          allowedHosts: ["down.example.com", "empty.example.com", "up.example.com"],
          allowPackageManagers: false,
          allowMcpServers: false,
        },
      },
    });
    await expect(sandbox.exec("echo ok")).resolves.toBe("ok");
    expect(box.exec.mock.calls[1]?.[1]).toEqual(["-c", 'printf "%s\\n" "$@" >> /etc/hosts', "sh", "192.0.2.10 up.example.com"]);
    expect(warn).toHaveBeenCalledWith(
      "allowed host down.example.com did not resolve on the host (ENOTFOUND down.example.com); it is not pinned",
    );
    expect(warn).toHaveBeenCalledWith("could not pin allowed hosts in /etc/hosts: sh: /etc/hosts: Read-only file system");
    await sandbox.destroy();

    const none = queueBox();
    const nothing = new LiteBoxSandbox({
      logger: { warn: vi.fn(), log: vi.fn() },
      resolveHost: async () => { throw "offline"; },
      environment: {
        networking: { type: "limited", allowedHosts: ["a.example.com"], allowPackageManagers: false, allowMcpServers: false },
      },
    });
    await nothing.exec("x");
    expect(none.exec.mock.calls.map(([command]) => command)).toEqual(["mkdir", "sh"]);
    expect(none.exec.mock.calls[1]?.[1]).toEqual(["-c", "x"]);
    await nothing.destroy();
  });

  it("pins nothing for unrestricted or disabled networking and resolves with the host DNS by default", async () => {
    const resolveHost = vi.fn(async () => ["192.0.2.1"]);
    for (const networking of [
      { type: "unrestricted" } as const,
      { type: "limited", allowedHosts: [], allowPackageManagers: false, allowMcpServers: false } as const,
    ]) {
      const box = queueBox();
      const sandbox = new LiteBoxSandbox({ resolveHost, environment: { networking } });
      await sandbox.exec("x");
      expect(box.exec.mock.calls.map(([command]) => command)).toEqual(["mkdir", "sh"]);
      await sandbox.destroy();
    }
    expect(resolveHost).not.toHaveBeenCalled();

    const box = queueBox();
    const sandbox = new LiteBoxSandbox({
      logger: { warn: vi.fn(), log: vi.fn() },
      environment: {
        networking: { type: "limited", allowedHosts: ["localhost"], allowPackageManagers: false, allowMcpServers: false },
      },
    });
    await sandbox.exec("x");
    expect(box.exec.mock.calls[1]?.[1]).toEqual(["-c", 'printf "%s\\n" "$@" >> /etc/hosts', "sh", "127.0.0.1 localhost"]);
    await sandbox.destroy();
  });

  it("fails the sandbox and stops the VM when packages do not install", async () => {
    const box = queueBox();
    box.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 100,
        stdout: "[oma-setup] apt: 1 package(s)\n",
        stderr: `${SECCOMP_WARN}E: Unable to locate package nope\n[oma-setup] apt failed (exit 100)\n`,
      });
    const sandbox = new LiteBoxSandbox({
      environment: {
        packages: { apt: ["nope"] },
        networking: { type: "limited", allowedHosts: [], allowPackageManagers: false, allowMcpServers: false },
      },
    });
    const failure = sandbox.exec("x");
    await expect(failure).rejects.toThrow(
      "environment packages failed to install (exit 100) (networking is limited and package managers are not allowed)",
    );
    await expect(failure).rejects.toThrow(/E: Unable to locate package nope\n\[oma-setup\] apt failed \(exit 100\)$/);
    await expect(sandbox.exec("y")).rejects.toThrow("environment packages failed to install");
    expect(box.stop).toHaveBeenCalledTimes(1);
    expect(sdk.options[0]?.network).toEqual({ mode: "disabled" });
    await sandbox.destroy();

    const open = queueBox();
    open.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 127, stdout: "", stderr: "[oma-setup] npm not found in the sandbox image\n" });
    const unrestricted = new LiteBoxSandbox({ environment: { packages: { npm: ["x"] } } });
    await expect(unrestricted.exec("x")).rejects.toThrow(
      "environment packages failed to install (exit 127): [oma-setup] npm not found in the sandbox image",
    );
    await unrestricted.destroy();
  });

  it("stops the VM when /workspace cannot be created, even if stopping fails", async () => {
    for (const [result, message] of [
      [{ exitCode: 1, stdout: "", stderr: `${SECCOMP_WARN}mkdir: read-only\n` }, "/workspace: mkdir: read-only"],
      [{ exitCode: 1, stdout: "only stdout", stderr: SECCOMP_WARN }, "/workspace: only stdout"],
    ] as const) {
      const box = queueBox();
      box.exec.mockResolvedValueOnce({ ...result });
      box.stop.mockRejectedValueOnce(new Error("already gone"));
      const sandbox = new LiteBoxSandbox();
      await expect(sandbox.exec("x")).rejects.toThrow(message);
      expect(box.stop).toHaveBeenCalledTimes(1);
      await sandbox.destroy();
    }
  });

  it("reports a failed parent directory before copying into the box", async () => {
    const box = queueBox();
    box.exec
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "out", stderr: "" });
    const sandbox = new LiteBoxSandbox();
    await expect(sandbox.writeFile("/ro/a.txt", "x")).rejects.toThrow("could not create /ro: denied");
    await expect(sandbox.writeFileBytes("/ro/b.bin", new Uint8Array([1]))).rejects.toThrow("could not create /ro: out");
    expect(box.copyIn).not.toHaveBeenCalled();
    await sandbox.destroy();
  });

  it("logs through the root logger installed after the module was imported", async () => {
    queueBox();
    const lines: string[] = [];
    const capture: Logger = {
      trace: () => {}, debug: () => {}, error: () => {}, fatal: () => {},
      info: (a: unknown, b?: string) => { lines.push(typeof a === "string" ? a : String(b)); },
      warn: (a: unknown, b?: string) => { lines.push(typeof a === "string" ? a : String(b)); },
      child: () => capture,
    } as Logger;
    setRootLogger(capture);
    try {
      const sandbox = new LiteBoxSandbox({ image: "img:1" });
      await sandbox.exec("x");
      await sandbox.destroy();
    } finally {
      setRootLogger(new NoopLogger());
    }
    expect(lines).toContain("creating box (image=img:1, network=unrestricted)");
  });
});

const SECCOMP_WARN =
  "\u001b[2m2026-10-15T18:43:49.677495Z\u001b[0m \u001b[33m WARN\u001b[0m " +
  "\u001b[2mlibcontainer::process::init::process\u001b[0m\u001b[2m:\u001b[0m " +
  "seccomp not available, unable to set seccomp privileges!\n";

describe("stripRuntimeNoise", () => {
  it("drops leading libcontainer log lines with or without ANSI colors", () => {
    expect(stripRuntimeNoise(SECCOMP_WARN)).toBe("");
    expect(stripRuntimeNoise(`${SECCOMP_WARN}${SECCOMP_WARN}boom\n`)).toBe("boom\n");
    expect(stripRuntimeNoise(
      "2026-10-15T14:31:28.571895Z  WARN libcontainer::process::init::process: seccomp not available\nnext",
    )).toBe("next");
  });

  it("keeps the command's own stderr, including look-alike lines after it", () => {
    expect(stripRuntimeNoise("")).toBe("");
    expect(stripRuntimeNoise("plain error\n")).toBe("plain error\n");
    const later = `own line\n${SECCOMP_WARN}`;
    expect(stripRuntimeNoise(later)).toBe(later);
    expect(stripRuntimeNoise("2026-10-15T14:31:28Z WARN myapp::x: hi\n")).toBe("2026-10-15T14:31:28Z WARN myapp::x: hi\n");
  });
});

describe("applyShimDnsWorkaround", () => {
  it("adds netdns=go, keeps other GODEBUG settings and respects an explicit netdns", () => {
    const empty: Record<string, string | undefined> = {};
    expect(applyShimDnsWorkaround(empty)).toBe(true);
    expect(empty.GODEBUG).toBe("netdns=go");
    const other: Record<string, string | undefined> = { GODEBUG: "http2client=0" };
    expect(applyShimDnsWorkaround(other)).toBe(true);
    expect(other.GODEBUG).toBe("http2client=0,netdns=go");
    const explicit: Record<string, string | undefined> = { GODEBUG: "x=1, netdns=cgo+2" };
    expect(applyShimDnsWorkaround(explicit)).toBe(false);
    expect(explicit.GODEBUG).toBe("x=1, netdns=cgo+2");
  });
});

describe("withShimDnsWorkaround", () => {
  it("restores GODEBUG when the last overlapping boot settles", async () => {
    const env: Record<string, string | undefined> = { GODEBUG: "http2client=0" };
    const onApplied = vi.fn();
    let finishFirst!: () => void;
    const first = withShimDnsWorkaround(env, () => new Promise<void>((resolve) => { finishFirst = resolve; }), onApplied);
    const second = withShimDnsWorkaround(env, async () => env.GODEBUG, onApplied);
    await expect(second).resolves.toBe("http2client=0,netdns=go");
    expect(env.GODEBUG).toBe("http2client=0,netdns=go");
    finishFirst();
    await first;
    expect(env.GODEBUG).toBe("http2client=0");
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("removes GODEBUG it added, also when the boot fails", async () => {
    const env: Record<string, string | undefined> = {};
    await expect(withShimDnsWorkaround(env, async () => {
      expect(env.GODEBUG).toBe("netdns=go");
      throw new Error("boot failed");
    })).rejects.toThrow("boot failed");
    expect("GODEBUG" in env).toBe(false);
  });

  it("leaves an operator-chosen netdns and a GODEBUG changed meanwhile alone", async () => {
    const explicit: Record<string, string | undefined> = { GODEBUG: "netdns=cgo" };
    const onApplied = vi.fn();
    await withShimDnsWorkaround(explicit, async () => {}, onApplied);
    expect(explicit.GODEBUG).toBe("netdns=cgo");
    expect(onApplied).not.toHaveBeenCalled();
    const changed: Record<string, string | undefined> = {};
    await withShimDnsWorkaround(changed, async () => { changed.GODEBUG = "x=1"; });
    expect(changed.GODEBUG).toBe("x=1");
  });
});

describe("liteBoxNetwork", () => {
  const limited = (allowedHosts: string[], allowPackageManagers = false) =>
    ({ type: "limited", allowedHosts, allowPackageManagers, allowMcpServers: true }) as const;

  it("keeps unrestricted and absent networking fully enabled", () => {
    expect(liteBoxNetwork(undefined)).toEqual({ mode: "enabled" });
    expect(liteBoxNetwork({ type: "unrestricted" }, ["http://proxy:8080"])).toEqual({ mode: "enabled" });
  });

  it("turns limited networking without any allowed host into no network", () => {
    expect(liteBoxNetwork(limited([" ", ""]), ["http://proxy:8080"])).toEqual({ mode: "disabled" });
  });

  it("allows only the listed hosts, normalised and deduplicated, plus the vault proxy", () => {
    expect(liteBoxNetwork(
      limited(["API.example.com", "https://api.example.com:8443/v1?q=1", "user@git.example.org", "*.cdn.example.net"]),
      ["http://10.0.2.2:3128", "http://"],
    )).toEqual({
      mode: "enabled",
      allowNet: ["api.example.com", "git.example.org", "*.cdn.example.net", "10.0.2.2"],
    });
  });

  it("opens the package registries when package managers are allowed", () => {
    const network = liteBoxNetwork(limited([], true));
    expect(network.mode).toBe("enabled");
    const allowNet = network.mode === "enabled" ? network.allowNet ?? [] : [];
    expect(allowNet).toEqual(expect.arrayContaining(["deb.debian.org", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]));
    expect(allowNet).not.toContain("example.com");
  });
});

