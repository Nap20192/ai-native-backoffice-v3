import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildTools } from "../src/harness/tools";

// docs/plans/harness-fixes.md, items 9, 10 and 12.
// 9: edit put new_string through String.replace, which expands "$&", "$$",
//    "$`" and "$'". An empty old_string was accepted.
// 10: the glob pattern stood in `bash -c` as code, so a pattern could run a
//    command past the always_ask policy of bash.
// 12: Pi runs the tool calls of one step in parallel. Two edits of one file
//    each read the old text, and the second write lost the first change.

type ToolFn = (input: unknown, options?: unknown) => Promise<unknown>;

const AGENT = { id: "agent_1", name: "a", model: "m", system: "", tools: [{ type: "agent_toolset_20260401" }] } as never;

async function toolsOn(sandbox: object): Promise<Record<string, ToolFn>> {
  const tools = await buildTools(AGENT, sandbox as never);
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      (input: unknown) => (tool as { execute: ToolFn }).execute(input, { toolCallId: "t1", messages: [] }),
    ]),
  );
}

/** Files in memory. Every read and write waits a macrotask, as a VM call does. */
function memorySandbox(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [posix.normalize(path), text]));
  const writes: string[] = [];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  return {
    files,
    writes,
    sandbox: {
      async exec(): Promise<string> {
        throw new Error("exec is not expected");
      },
      async readFile(path: string): Promise<string> {
        await tick();
        const text = files.get(posix.normalize(path));
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      async writeFile(path: string, content: string): Promise<string> {
        await tick();
        files.set(posix.normalize(path), content);
        writes.push(path);
        return "ok";
      },
    },
  };
}

describe("edit puts new_string in as it is", () => {
  it.each([
    ["$&", "price = $&;"],
    ["$$", "price = $$;"],
    ["$`", "price = $`;"],
    ["$'", "price = $';"],
    ["$1", "price = $1;"],
  ])("keeps %s in new_string", async (token, expected) => {
    const { files, sandbox } = memorySandbox({ "/workspace/a.ts": "price = 10;" });
    const { edit } = await toolsOn(sandbox);

    await edit({ file_path: "/workspace/a.ts", old_string: "10", new_string: token });

    expect(files.get("/workspace/a.ts")).toBe(expected);
  });

  it("keeps $& with replace_all", async () => {
    const { files, sandbox } = memorySandbox({ "/workspace/a.ts": "x x" });
    const { edit } = await toolsOn(sandbox);

    await edit({ file_path: "/workspace/a.ts", old_string: "x", new_string: "$&$$", replace_all: true });

    expect(files.get("/workspace/a.ts")).toBe("$&$$ $&$$");
  });

  it("refuses an empty old_string with replace_all and leaves the file alone", async () => {
    const { files, writes, sandbox } = memorySandbox({ "/workspace/a.ts": "abc" });
    const { edit } = await toolsOn(sandbox);

    const result = await edit({ file_path: "/workspace/a.ts", old_string: "", new_string: "X", replace_all: true });

    expect(result).toMatch(/^Error: old_string is empty/);
    expect(files.get("/workspace/a.ts")).toBe("abc");
    expect(writes).toEqual([]);
  });

  it("refuses an empty old_string on an empty file", async () => {
    const { files, writes, sandbox } = memorySandbox({ "/workspace/empty.ts": "" });
    const { edit } = await toolsOn(sandbox);

    const result = await edit({ file_path: "/workspace/empty.ts", old_string: "", new_string: "X" });

    expect(result).toMatch(/^Error: old_string is empty/);
    expect(files.get("/workspace/empty.ts")).toBe("");
    expect(writes).toEqual([]);
  });
});

describe("edit and write of one file in one step", () => {
  it("keeps both of two parallel edits", async () => {
    const { files, sandbox } = memorySandbox({ "/workspace/a.ts": "a = 1\nb = 2\n" });
    const { edit } = await toolsOn(sandbox);

    const results = await Promise.all([
      edit({ file_path: "/workspace/a.ts", old_string: "a = 1", new_string: "a = 10" }),
      edit({ file_path: "/workspace/a.ts", old_string: "b = 2", new_string: "b = 20" }),
    ]);

    expect(results).toEqual(["ok", "ok"]);
    expect(files.get("/workspace/a.ts")).toBe("a = 10\nb = 20\n");
  });

  it("runs an edit after a write called before it", async () => {
    const { files, sandbox } = memorySandbox({ "/workspace/a.ts": "x = 0\n" });
    const { edit, write } = await toolsOn(sandbox);

    const results = await Promise.all([
      write({ file_path: "/workspace/a.ts", content: "x = 1\n" }),
      edit({ file_path: "/workspace/a.ts", old_string: "x = 1", new_string: "x = 2" }),
    ]);

    expect(results).toEqual(["ok", "ok"]);
    expect(files.get("/workspace/a.ts")).toBe("x = 2\n");
  });

  it("treats two spellings of one path as one file", async () => {
    const { files, sandbox } = memorySandbox({ "/workspace/a.ts": "a = 1\nb = 2\n" });
    const { edit } = await toolsOn(sandbox);

    await Promise.all([
      edit({ file_path: "/workspace/a.ts", old_string: "a = 1", new_string: "a = 10" }),
      edit({ file_path: "/workspace/src/..//./a.ts", old_string: "b = 2", new_string: "b = 20" }),
    ]);

    expect(files.get("/workspace/a.ts")).toBe("a = 10\nb = 20\n");
  });

  it("lets the next edit run after one fails", async () => {
    const { files, sandbox } = memorySandbox({ "/workspace/a.ts": "a = 1\n" });
    const { edit } = await toolsOn(sandbox);

    const results = await Promise.all([
      edit({ file_path: "/workspace/a.ts", old_string: "missing", new_string: "x" }),
      edit({ file_path: "/workspace/missing.ts", old_string: "a", new_string: "b" }),
      edit({ file_path: "/workspace/a.ts", old_string: "a = 1", new_string: "a = 2" }),
    ]);

    expect(results[0]).toBe("Error: old_string not found in file");
    expect(results[1]).toMatch(/^Error: ENOENT/);
    expect(results[2]).toBe("ok");
    expect(files.get("/workspace/a.ts")).toBe("a = 2\n");
  });

  it("does not hold an edit of another file", { timeout: 2_000 }, async () => {
    let releaseA!: () => void;
    const bWritten = new Promise<void>((resolve) => { releaseA = resolve; });
    const files = new Map([["/workspace/a.ts", "a"], ["/workspace/b.ts", "b"]]);
    const sandbox = {
      async exec(): Promise<string> {
        throw new Error("exec is not expected");
      },
      async readFile(path: string): Promise<string> {
        // The edit of a.ts waits until the edit of b.ts has written its file.
        if (path === "/workspace/a.ts") await bWritten;
        return files.get(path)!;
      },
      async writeFile(path: string, content: string): Promise<string> {
        files.set(path, content);
        if (path === "/workspace/b.ts") releaseA();
        return "ok";
      },
    };
    const { edit } = await toolsOn(sandbox);

    const results = await Promise.all([
      edit({ file_path: "/workspace/a.ts", old_string: "a", new_string: "A" }),
      edit({ file_path: "/workspace/b.ts", old_string: "b", new_string: "B" }),
    ]);

    expect(results).toEqual(["ok", "ok"]);
  });
});

describe("glob reads the pattern only as a pattern", () => {
  let root: string;
  let outside: string;
  let sandbox: { exec(command: string): Promise<string> };

  /** Real bash on this machine, answering in the LiteBox format. */
  function bashSandbox(cwd: string) {
    return {
      exec(command: string): Promise<string> {
        return new Promise((resolve) => {
          execFile("bash", ["-c", command], { cwd, timeout: 10_000 }, (error, stdout) => {
            const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
            resolve(code === 0 ? stdout : `${stdout}\n[exit ${code}]`);
          });
        });
      },
      async readFile(): Promise<string> {
        throw new Error("readFile is not expected");
      },
      async writeFile(): Promise<string> {
        throw new Error("writeFile is not expected");
      },
    };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "glob-root-"));
    outside = mkdtempSync(join(tmpdir(), "glob-marker-"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, "lib"));
    // Newest first in the result: a.ts, src/b.ts, src/c.tsx, src/deep/d.ts, lib/e.ts, notes.md, my notes.txt.
    const files = ["my notes.txt", "notes.md", "lib/e.ts", "src/deep/d.ts", "src/c.tsx", "src/b.ts", "a.ts"];
    files.forEach((file, i) => {
      writeFileSync(join(root, file), file);
      const time = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      utimesSync(join(root, file), time, time);
    });
    sandbox = bashSandbox(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  async function glob(pattern: string): Promise<unknown> {
    const tools = await toolsOn(sandbox);
    return tools.glob({ pattern, path: root });
  }

  it.each([
    ["semicolon", (m: string) => `*; touch ${m}`],
    ["closing the loop", (m: string) => `*; do touch ${m}; done; for f in *`],
    ["command substitution", (m: string) => `$(touch ${m})`],
    ["backticks", (m: string) => `\`touch ${m}\``],
    ["a newline", (m: string) => `*\ntouch ${m}`],
  ])("does not run a command hidden in the pattern: %s", async (_name, makePattern) => {
    const marker = join(outside, `pwned-${_name.replace(/\W/g, "-")}`);

    const result = await glob(makePattern(marker));

    expect(existsSync(marker)).toBe(false);
    expect(result).toBe("No files matched the pattern");
  });

  it("finds files with ** across folders, newest first", async () => {
    expect(await glob("**/*.ts")).toBe("Found 4 files\na.ts\nsrc/b.ts\nsrc/deep/d.ts\nlib/e.ts");
  });

  it("expands braces", async () => {
    expect(await glob("src/*.{ts,tsx}")).toBe("Found 2 files\nsrc/b.ts\nsrc/c.tsx");
    expect(await glob("{src/{deep,none},lib}/*.ts")).toBe("Found 2 files\nsrc/deep/d.ts\nlib/e.ts");
  });

  it("keeps a space inside the pattern", async () => {
    expect(await glob("my *.txt")).toBe("Found 1 file\nmy notes.txt");
  });

  it("finds an absolute pattern", async () => {
    expect(await glob(`${root}/*.md`)).toBe(`Found 1 file\n${root}/notes.md`);
  });

  it("does not list a plain path that does not exist", async () => {
    expect(await glob("nope.ts")).toBe("No files matched the pattern");
  });

  it("refuses a pattern that expands too far and runs nothing", async () => {
    const commands: string[] = [];
    const tools = await toolsOn({
      async exec(command: string) {
        commands.push(command);
        return "";
      },
    });

    const result = await tools.glob({ pattern: "{a,b}".repeat(8) });

    expect(result).toMatch(/^Error: the pattern expands to more than \d+ patterns/);
    expect(commands).toEqual([]);
  });
});

describe("grep runs under the POSIX sh of the VM image", () => {
  // Live run 20261018-011446: every grep failed with
  // "sh: 1: set: Illegal option -o pipefail". LiteBox runs commands through
  // `sh -c`, and sh in Debian bookworm is dash, which has no pipefail.
  let root: string;
  let sandbox: { exec(command: string): Promise<string> };

  /** Dash refuses `set -o pipefail`; everything else runs in real bash. */
  function dashLikeSandbox(cwd: string) {
    return {
      exec(command: string): Promise<string> {
        if (/^\s*set -o pipefail/.test(command)) {
          return Promise.resolve("sh: 1: set: Illegal option -o pipefail\n\n[exit 2]");
        }
        return new Promise((resolve) => {
          execFile("bash", ["-c", command], { cwd, timeout: 10_000 }, (error, stdout) => {
            const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
            resolve(code === 0 ? stdout : `${stdout}\n[exit ${code}]`);
          });
        });
      },
      async readFile(): Promise<string> {
        throw new Error("readFile is not expected");
      },
      async writeFile(): Promise<string> {
        throw new Error("writeFile is not expected");
      },
    };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "grep-root-"));
    writeFileSync(join(root, "a.txt"), "alpha\nbookworm one\nbeta\n");
    writeFileSync(join(root, "b.txt"), "bookworm two\n");
    sandbox = dashLikeSandbox(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function grep(input: Record<string, unknown>): Promise<unknown> {
    const tools = await toolsOn(sandbox);
    return tools.grep({ path: root, ...input });
  }

  it("says there are no matches", async () => {
    expect(await grep({ pattern: "QWEN_NO_MATCH_7f3a" })).toBe("No matches found");
  });

  it("finds files with a match", async () => {
    const result = String(await grep({ pattern: "bookworm" }));
    expect(result).toMatch(/^Found 2 files\n/);
    expect(result).toContain("a.txt");
    expect(result).toContain("b.txt");
  });

  it("keeps the head limit and still reports content", async () => {
    const result = String(await grep({ pattern: "bookworm", output_mode: "content", head_limit: 1 }));
    expect(result.split("\n")).toHaveLength(1);
    expect(result).toContain("bookworm");
  });

  it("reports a real error through the pipe", async () => {
    const result = String(await grep({ pattern: "x", path: join(root, "missing-dir") }));
    expect(result).toMatch(/^Error: grep exited with code 2/);
  });
});
