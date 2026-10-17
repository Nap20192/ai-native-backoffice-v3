import { describe, expect, it } from "vitest";

import type { HarnessContext } from "../src/harness/interface";
import { MAX_PI_TOOL_TEXT_CHARS, toolsToPi } from "../src/harness/pi-loop-tools";
import { buildTools, parseExecOutput } from "../src/harness/tools";

// docs/plans/harness-fixes.md, items 8 and 11. Sandbox exec answers in two
// formats: Cloudflare "exit=N\n<stdout>" and LiteBox "<stdout>\n[exit N]"
// (no marker on exit 0) or "[error: ...]". glob and grep read only the
// Cloudflare one, so on LiteBox the model got a bare "[exit 1]". bash kept
// only the head of a long log, and the LiteBox exit code and the build error
// sit at its end.

type Exec = (command: string) => string;

function fakeSandbox(exec: Exec) {
  const commands: string[] = [];
  return {
    commands,
    sandbox: {
      async exec(command: string) {
        commands.push(command);
        return exec(command);
      },
      async readFile(path: string): Promise<string> {
        throw new Error(`no file ${path}`);
      },
      async writeFile() {
        return "ok";
      },
    },
  };
}

/** LiteBox answers the rg probe with plain "rg" and the search with `answer`. */
function liteBox(answer: string): Exec {
  return (command) => (command.startsWith("command -v rg") ? "rg" : answer);
}

/** Cloudflare answers every command with the "exit=N\n" prefix. */
function cloudflare(answer: string): Exec {
  return (command) => (command.startsWith("command -v rg") ? "exit=0\nrg" : answer);
}

async function toolsOn(exec: Exec) {
  const { sandbox } = fakeSandbox(exec);
  return buildTools(
    { id: "agent_1", name: "a", model: "m", system: "", tools: [{ type: "agent_toolset_20260401" }] } as never,
    sandbox as never,
  );
}

async function run(exec: Exec, name: "glob" | "grep" | "bash", input: Record<string, unknown>): Promise<string> {
  const tools = await toolsOn(exec);
  const tool = tools[name] as { execute: (input: unknown, options?: unknown) => Promise<unknown> };
  const result = await tool.execute(input, { toolCallId: "t1", messages: [] });
  expect(typeof result).toBe("string");
  return result as string;
}

/** Text the Pi model gets from one bash call, through the real bridge. */
async function bashForModel(exec: Exec, command: string): Promise<string> {
  const tools = await toolsOn(exec);
  const ctx = { tools: { bash: tools.bash }, runtime: {}, pi: {} } as unknown as HarnessContext;
  const [bash] = toolsToPi(ctx);
  const result = await bash.execute("t1", { command }, undefined as never);
  const [part] = result.content;
  expect(part.type).toBe("text");
  return (part as { text: string }).text;
}

describe("parseExecOutput", () => {
  it.each([
    ["Cloudflare", "exit=3\nout", { code: 3, output: "out" }],
    ["Cloudflare, no output", "exit=0\n", { code: 0, output: "" }],
    ["Cloudflare, no newline", "exit=1", { code: 1, output: "" }],
    ["LiteBox, exit 0 has no marker", "out\n", { code: 0, output: "out\n" }],
    ["LiteBox, nonzero exit", "out\nmore\n[exit 2]", { code: 2, output: "out\nmore" }],
    ["LiteBox, nonzero exit, no output", "\n[exit 1]", { code: 1, output: "" }],
    ["LiteBox, trimmed by a transport", "[exit 1]", { code: 1, output: "" }],
    ["LiteBox, sandbox error", "[error: box stopped]\n", { code: null, output: "[error: box stopped]" }],
    ["LocalSubprocess marker", "out\n[exit exit=2]", { code: 2, output: "out" }],
  ])("%s", (_name, raw, expected) => {
    expect(parseExecOutput(raw)).toEqual(expected);
  });

  it("leaves an exit marker in the middle of the output alone", () => {
    expect(parseExecOutput("[exit 1]\nnext line")).toEqual({ code: 0, output: "[exit 1]\nnext line" });
  });
});

describe("glob reads both exec formats", () => {
  it("lists LiteBox matches with a count", async () => {
    expect(await run(liteBox("/workspace/b.ts\n/workspace/a.ts"), "glob", { pattern: "**/*.ts" })).toBe(
      "Found 2 files\n/workspace/b.ts\n/workspace/a.ts",
    );
  });

  it("says no file matched when LiteBox answers nothing", async () => {
    expect(await run(liteBox(""), "glob", { pattern: "**/*.nothing" })).toBe("No files matched the pattern");
  });

  it("turns a LiteBox exit code into an error, not a bare marker", async () => {
    const result = await run(liteBox("\n[exit 1]"), "glob", { pattern: "*.ts", path: "/missing" });
    expect(result).toMatch(/^Error: glob exited with code 1/);
    expect(result).not.toContain("[exit 1]");
  });

  it("reports a sandbox error", async () => {
    const result = await run(liteBox("[error: box stopped]"), "glob", { pattern: "*.ts" });
    expect(result).toMatch(/^Error: /);
    expect(result).toContain("box stopped");
  });

  it("still reads the Cloudflare format", async () => {
    expect(await run(cloudflare("exit=0\n/workspace/a.ts"), "glob", { pattern: "*.ts" })).toBe("Found 1 file\n/workspace/a.ts");
    expect(await run(cloudflare("exit=0\n"), "glob", { pattern: "*.ts" })).toBe("No files matched the pattern");
  });
});

describe("grep reads both exec formats", () => {
  it("says no match when rg exits 1 on LiteBox", async () => {
    expect(await run(liteBox("\n[exit 1]"), "grep", { pattern: "nothing" })).toBe("No matches found");
  });

  it("turns a LiteBox exit code 2 into an error with the rg message", async () => {
    const answer = "rg: regex parse error:\n    (foo\n    ^\nerror: unclosed group\n[exit 2]";
    const result = await run(liteBox(answer), "grep", { pattern: "(foo" });
    expect(result).toMatch(/^Error: grep exited with code 2\n/);
    expect(result).toContain("unclosed group");
    expect(result).not.toContain("[exit 2]");
  });

  it("lists LiteBox files with matches", async () => {
    expect(await run(liteBox("/workspace/a.ts\n/workspace/b.ts"), "grep", { pattern: "x" })).toBe(
      "Found 2 files\n/workspace/a.ts\n/workspace/b.ts",
    );
  });

  it("sums LiteBox counts", async () => {
    const result = await run(liteBox("/workspace/a.ts:3\n/workspace/b.ts:2"), "grep", { pattern: "x", output_mode: "count" });
    expect(result).toContain("Found 5 total occurrences across 2 files.");
  });

  it("treats SIGPIPE from head on LiteBox as success", async () => {
    const result = await run(liteBox("a.ts:1:x\nb.ts:2:x\n[exit 141]"), "grep", { pattern: "x", output_mode: "content" });
    expect(result).toBe("a.ts:1:x\nb.ts:2:x");
  });

  it("cuts long LiteBox content", async () => {
    const lines = Array.from({ length: 3_000 }, (_, i) => `/workspace/big.log:${i}:matched line number ${i}`);
    const result = await run(liteBox(lines.join("\n")), "grep", { pattern: "matched", output_mode: "content", head_limit: 0 });
    expect(result.length).toBeLessThanOrEqual(MAX_PI_TOOL_TEXT_CHARS);
    expect(result).toContain("truncated");
  });

  it("reports a sandbox error", async () => {
    const result = await run(liteBox("[error: box stopped]"), "grep", { pattern: "x" });
    expect(result).toMatch(/^Error: /);
    expect(result).toContain("box stopped");
  });

  it("still reads the Cloudflare format", async () => {
    expect(await run(cloudflare("exit=1\n"), "grep", { pattern: "x" })).toBe("No matches found");
    expect(await run(cloudflare("exit=0\n/workspace/a.ts"), "grep", { pattern: "x" })).toBe("Found 1 file\n/workspace/a.ts");
  });
});

describe("bash keeps the end of a long log", () => {
  const start = "> npm run build";
  const noise = Array.from({ length: 4_000 }, (_, i) => `compiling module ${i} of 4000`).join("\n");
  const failure = "src/app.ts(12,5): error TS2304: Cannot find name 'totl'.\nBuild failed with 1 error.";

  it("shows the failure at the end of a LiteBox log and the exit code first", async () => {
    const text = await bashForModel(() => `${start}\n${noise}\n${failure}\n[exit 2]`, "npm run build");
    expect(text).toContain("error TS2304: Cannot find name 'totl'.");
    expect(text).toContain("Build failed with 1 error.");
    expect(text.split("\n")[0]).toMatch(/^\[exit=2\b/);
    expect(text).toContain(start);
    expect(text.length).toBeLessThanOrEqual(MAX_PI_TOOL_TEXT_CHARS);
  });

  it("shows the failure at the end of a Cloudflare log and the exit code first", async () => {
    const text = await bashForModel(() => `exit=1\n${start}\n${noise}\n${failure}`, "npm run build");
    expect(text).toContain("Build failed with 1 error.");
    expect(text.split("\n")[0]).toMatch(/^\[exit=1\b/);
    expect(text).toContain(start);
    expect(text.length).toBeLessThanOrEqual(MAX_PI_TOOL_TEXT_CHARS);
  });

  it("says a long LiteBox log without a marker ended with exit 0", async () => {
    const text = await bashForModel(() => `${start}\n${noise}\nall done`, "npm run build");
    expect(text).toContain("all done");
    expect(text.split("\n")[0]).toMatch(/^\[exit=0\b/);
    expect(text.length).toBeLessThanOrEqual(MAX_PI_TOOL_TEXT_CHARS);
  });

  it("says how much of the middle is left out", async () => {
    const text = await bashForModel(() => `${start}\n${noise}\n${failure}\n[exit 2]`, "npm run build");
    expect(text).toMatch(/\d+ chars omitted/);
  });

  it("keeps short output as the sandbox gave it", async () => {
    expect(await run(() => "hello\n[exit 1]", "bash", { command: "false" })).toBe("hello\n[exit 1]");
    expect(await run(() => "exit=0\nhello", "bash", { command: "echo hello" })).toBe("exit=0\nhello");
  });
});
