import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  instances: [] as object[],
}));

vi.mock("@boxlite-ai/boxlite", () => ({
  SimpleBox: class {
    constructor() {
      const box = sdk.instances.shift();
      if (!box) throw new Error("fake box missing");
      return box;
    }
  },
}));

import { supportsDuplexProcess } from "@open-managed-agents/sandbox";
import { LiteBoxSandbox } from "../src/litebox";

function nativeStream(chunks: Array<string | Error>) {
  const queue = [...chunks];
  return {
    next: vi.fn(async () => {
      const item = queue.shift();
      if (item === undefined) return null;
      if (item instanceof Error) throw item;
      return item;
    }),
  };
}

function fakeExecution(opts: {
  stdout?: Array<string | Error>;
  stderr?: Array<string | Error>;
  exitCode?: number;
} = {}) {
  let finish!: (result: { exitCode: number }) => void;
  const waited = new Promise<{ exitCode: number }>((resolve) => { finish = resolve; });
  const stdin = {
    write: vi.fn(async (_data: Buffer) => {}),
    close: vi.fn(async () => {}),
  };
  const execution = {
    stdin: vi.fn(async () => stdin),
    stdout: vi.fn(async () => nativeStream(opts.stdout ?? [])),
    stderr: vi.fn(async () => nativeStream(opts.stderr ?? [])),
    wait: vi.fn(() => waited),
    kill: vi.fn(async () => { finish({ exitCode: -9 }); }),
    signal: vi.fn(async (_signal: number) => {}),
    finish: (exitCode: number) => finish({ exitCode }),
    stdinHandle: stdin,
  };
  if (opts.exitCode !== undefined) finish({ exitCode: opts.exitCode });
  return execution;
}

type FakeExecution = ReturnType<typeof fakeExecution>;

function queueBox(execution?: FakeExecution, opts: { streaming?: boolean } = {}) {
  const native = { exec: vi.fn(async () => execution) };
  const box: Record<string, unknown> = {
    exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    copyIn: vi.fn(async () => {}),
    copyOut: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  if (opts.streaming !== false) box._ensureBox = vi.fn(async () => native);
  sdk.instances.push(box);
  return { box, native };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const quiet = { warn: vi.fn(), log: vi.fn() };

beforeEach(() => {
  sdk.instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LiteBoxSandbox.spawnDuplexProcess", () => {
  it("is advertised as a duplex process port", async () => {
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    expect(supportsDuplexProcess(sandbox)).toBe(true);
    await sandbox.destroy();
  });

  it("starts the process with the sandbox env, the spec env and the workspace cwd", async () => {
    const execution = fakeExecution({ exitCode: 0 });
    const { native } = queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    await sandbox.setEnvVars({ HTTP_PROXY: "http://proxy", SHARED: "sandbox" });
    await sandbox.spawnDuplexProcess({
      command: "claude-agent-acp",
      args: ["--flag"],
      env: { SHARED: "spec", CLAUDE_CONFIG_DIR: "/tmp/native", DROPPED: undefined },
    });
    expect(native.exec).toHaveBeenCalledWith(
      "claude-agent-acp",
      ["--flag"],
      [["HTTP_PROXY", "http://proxy"], ["SHARED", "spec"], ["CLAUDE_CONFIG_DIR", "/tmp/native"]],
      false,
      null,
      null,
      "/workspace",
    );
    await sandbox.destroy();
  });

  it("resolves a relative cwd under /workspace and passes no args as an empty list", async () => {
    const execution = fakeExecution({ exitCode: 0 });
    const { native } = queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    await sandbox.spawnDuplexProcess({ command: "agent", cwd: "project" });
    await sandbox.spawnDuplexProcess({ command: "agent", cwd: "/srv/app" });
    expect(native.exec.mock.calls[0]?.slice(1)).toEqual([[], [], false, null, null, "/workspace/project"]);
    expect(native.exec.mock.calls[1]?.[6]).toBe("/srv/app");
    await sandbox.destroy();
  });

  it("streams stdout as bytes, writes stdin and closes it", async () => {
    const execution = fakeExecution({ stdout: ["{\"jsonrpc\":", "\"2.0\"}\n", "ж\n"], exitCode: 0 });
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("{\"id\":1}\n"));
    await writer.close();
    expect(execution.stdinHandle.write).toHaveBeenCalledWith(Buffer.from("{\"id\":1}\n"));
    expect(execution.stdinHandle.close).toHaveBeenCalledTimes(1);
    await expect(readAll(child.stdout)).resolves.toBe("{\"jsonrpc\":\"2.0\"}\nж\n");
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await sandbox.destroy();
  });

  it("closes native stdin when the writer aborts", async () => {
    const execution = fakeExecution({ exitCode: 0 });
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await child.stdin.abort(new Error("gone"));
    expect(execution.stdinHandle.close).toHaveBeenCalledTimes(1);
    await sandbox.destroy();
  });

  it("drops the guest runtime's leading stderr noise but keeps the process's own stderr", async () => {
    const noise = "\u001b[2m2026-10-15T19:45:38.453110Z\u001b[0m \u001b[33m WARN\u001b[0m \u001b[2mlibcontainer::process::init::process\u001b[0m\u001b[2m:\u001b[0m seccomp not available\n";
    const execution = fakeExecution({ stderr: [noise, "agent log\n", noise], exitCode: 0 });
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await expect(readAll(child.stderr)).resolves.toBe(`agent log\n${noise}`);
    await sandbox.destroy();
  });

  it("ends a stream when the native reader fails", async () => {
    const execution = fakeExecution({ stdout: ["partial\n", new Error("stream reset")], exitCode: 0 });
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await expect(readAll(child.stdout)).resolves.toBe("partial\n");
    await sandbox.destroy();
  });

  it("keeps draining native output after the consumer cancels", async () => {
    const execution = fakeExecution({ stdout: ["one\n", "two\n", "three\n"], exitCode: 0 });
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await child.stdout.cancel();
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    const stream = await execution.stdout.mock.results[0]!.value as ReturnType<typeof nativeStream>;
    await vi.waitFor(() => expect(stream.next).toHaveBeenCalledTimes(4));
    await sandbox.destroy();
  });

  it("maps negative exit codes to signals", async () => {
    const killed = fakeExecution({ exitCode: -9 });
    const terminated = fakeExecution({ exitCode: -15 });
    const unknown = fakeExecution({ exitCode: -200 });
    const { native } = queueBox(killed);
    native.exec.mockResolvedValueOnce(killed).mockResolvedValueOnce(terminated).mockResolvedValueOnce(unknown);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    await expect((await sandbox.spawnDuplexProcess({ command: "a" })).exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    await expect((await sandbox.spawnDuplexProcess({ command: "a" })).exited).resolves.toEqual({ code: null, signal: "SIGTERM" });
    await expect((await sandbox.spawnDuplexProcess({ command: "a" })).exited).resolves.toEqual({ code: null, signal: "SIG200" });
    await sandbox.destroy();
  });

  it("sends SIGTERM by default and kills on SIGKILL", async () => {
    const execution = fakeExecution();
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await child.kill();
    await child.kill("SIGTERM");
    expect(execution.signal).toHaveBeenCalledTimes(2);
    expect(execution.signal).toHaveBeenCalledWith(15);
    await child.kill("SIGKILL");
    expect(execution.kill).toHaveBeenCalledTimes(1);
    await expect(child.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
    await sandbox.destroy();
  });

  it("sends the requested signal as is and refuses an unknown one", async () => {
    const execution = fakeExecution();
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    // The ACP spawner passes ChildHandle signals through; the port type is narrower.
    await child.kill("SIGINT" as "SIGTERM");
    await child.kill("SIGHUP" as "SIGTERM");
    expect(execution.signal.mock.calls).toEqual([[2], [1]]);
    await expect(child.kill("SIGNOPE" as "SIGTERM")).rejects.toThrow("unknown signal SIGNOPE");
    expect(execution.kill).not.toHaveBeenCalled();
    execution.finish(0);
    await sandbox.destroy();
  });

  // Measured in a BoxLite 0.9.0 VM (2026-10-16): execution.signal() and execution.kill()
  // of a streaming exec never settle and deliver nothing; the process lives until the box
  // stops. Closing its stdin works, and stdio agents (ACP) exit on EOF.
  it("closes stdin first, so a stdio agent exits even when BoxLite does not deliver the signal", async () => {
    const execution = fakeExecution();
    execution.signal.mockImplementation(() => new Promise<void>(() => {}));
    execution.stdinHandle.close.mockImplementation(async () => { execution.finish(0); });
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet, killTimeoutMs: 20 });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await child.kill("SIGTERM");
    expect(execution.stdinHandle.close).toHaveBeenCalled();
    expect(execution.signal).toHaveBeenCalledWith(15);
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await sandbox.destroy();
  });

  it("warns when the process outlives a kill that BoxLite did not deliver", async () => {
    const execution = fakeExecution();
    execution.kill.mockImplementation(() => new Promise<void>(() => {}));
    queueBox(execution);
    const warn = vi.fn();
    const sandbox = new LiteBoxSandbox({ logger: { warn, log: vi.fn() }, killTimeoutMs: 20 });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await child.kill("SIGKILL");
    expect(execution.stdinHandle.close).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("agent did not exit after SIGKILL"));
    execution.finish(0);
    await sandbox.destroy();
  });

  it("ignores a failed kill after the process exited, but reports it while running", async () => {
    const running = fakeExecution();
    const { native } = queueBox(running);
    const exited = fakeExecution({ exitCode: 1 });
    native.exec.mockResolvedValueOnce(running).mockResolvedValueOnce(exited);
    running.signal.mockRejectedValueOnce(new Error("no such process"));
    exited.signal.mockRejectedValueOnce(new Error("no such process"));
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const live = await sandbox.spawnDuplexProcess({ command: "agent" });
    await expect(live.kill()).rejects.toThrow("no such process");
    const done = await sandbox.spawnDuplexProcess({ command: "agent" });
    await expect(done.exited).resolves.toEqual({ code: 1, signal: null });
    await expect(done.kill()).resolves.toBeUndefined();
    running.finish(0);
    await sandbox.destroy();
  });

  it("still sends the signal when closing stdin fails", async () => {
    const execution = fakeExecution();
    execution.stdinHandle.close.mockRejectedValue(new Error("stdin gone"));
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await expect(child.kill("SIGTERM")).resolves.toBeUndefined();
    expect(execution.signal).toHaveBeenCalledWith(15);
    execution.finish(0);
    await sandbox.destroy();
  });

  it("ignores a failed signal when closing stdin already ended the process", async () => {
    const execution = fakeExecution();
    execution.stdinHandle.close.mockImplementation(async () => { execution.finish(0); });
    execution.signal.mockRejectedValueOnce(new Error("no such process"));
    queueBox(execution);
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    await expect(child.kill("SIGTERM")).resolves.toBeUndefined();
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await sandbox.destroy();
  });

  it("does not warn when the process exits while the kill waits for it", async () => {
    const execution = fakeExecution();
    execution.signal.mockImplementation(() => new Promise<void>(() => {}));
    queueBox(execution);
    const warn = vi.fn();
    const sandbox = new LiteBoxSandbox({ logger: { warn, log: vi.fn() }, killTimeoutMs: 60 });
    const child = await sandbox.spawnDuplexProcess({ command: "agent" });
    // Exits after the signal wait (60 ms) and before the exit wait ends (120 ms).
    setTimeout(() => execution.finish(0), 90);
    await child.kill("SIGTERM");
    expect(warn).not.toHaveBeenCalled();
    await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
    await sandbox.destroy();
  });

  it("refuses when the SDK exposes no streaming exec", async () => {
    queueBox(undefined, { streaming: false });
    const sandbox = new LiteBoxSandbox({ logger: quiet });
    await expect(sandbox.spawnDuplexProcess({ command: "agent" })).rejects.toThrow(
      "streaming exec",
    );
    await sandbox.destroy();
  });
});
