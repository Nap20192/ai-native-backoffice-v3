import { describe, expect, it } from "vitest";

import type { HarnessContext } from "../src/harness/interface";
import {
  capHistoryText,
  MAX_PI_TOOL_TEXT_CHARS,
  toolsToPi,
  valueToPiContent,
} from "../src/harness/pi-loop-tools";
import { buildTools, parseBase64ExecOutput } from "../src/harness/tools";

// Session 2026-10-16 (qXVa68): the agent read four PNG pages and a PDF with
// `read`. LiteBox exec answers plain stdout, the read tool expected the
// Cloudflare "exit=N\n" prefix and returned the raw base64 as text, and the
// Pi bridge put 900 KB of it into the model context. Qwen then refused every
// turn: "prompt contains at least 262144 input tokens".

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function fakeSandbox(files: Record<string, { exec?: string; text?: string }>) {
  return {
    async exec(command: string) {
      const hit = Object.entries(files).find(([path]) => command.includes(path));
      return hit?.[1].exec ?? "";
    },
    async readFile(path: string) {
      const hit = files[path];
      if (hit?.text === undefined) throw new Error(`no file ${path}`);
      return hit.text;
    },
    async writeFile() {
      return "ok";
    },
  };
}

async function readTool(files: Parameters<typeof fakeSandbox>[0]) {
  const tools = await buildTools(
    { id: "agent_1", name: "a", model: "m", system: "", tools: [{ type: "agent_toolset_20260401" }] } as never,
    fakeSandbox(files) as never,
  );
  const read = tools.read as unknown as { execute: (input: unknown, options?: unknown) => Promise<unknown> };
  return (input: Record<string, unknown>) => read.execute(input, { toolCallId: "t1", messages: [] });
}

describe("read: base64 output of sandbox exec", () => {
  it("accepts the Cloudflare format with the exit prefix", () => {
    expect(parseBase64ExecOutput(`exit=0\n${PNG_BASE64}`)).toEqual({ ok: true, data: PNG_BASE64 });
  });

  it("accepts LiteBox plain stdout", () => {
    expect(parseBase64ExecOutput(`${PNG_BASE64}\n`)).toEqual({ ok: true, data: PNG_BASE64 });
  });

  it("reports a failed command instead of returning its output", () => {
    const result = parseBase64ExecOutput("base64: /x.png: No such file or directory\n[exit 1]");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("exit 1");
  });

  it("reports a sandbox error", () => {
    expect(parseBase64ExecOutput("[error: box stopped]").ok).toBe(false);
  });

  it("never treats non-base64 output as file data and shows what came instead", () => {
    const result = parseBase64ExecOutput("base64: /tmp/page001.png: No such file or directory");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("No such file or directory");
  });

  it("the read tool returns an image block for a PNG in LiteBox, not base64 text", async () => {
    const read = await readTool({ "/tmp/page001.png": { exec: `${PNG_BASE64}\n` } });

    const result = await read({ file_path: "/tmp/page001.png" });

    expect(result).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } });
  });

  it("the read tool refuses a binary file read as text", async () => {
    const zip = "PK\u0003\u0004\u0014\u0000\u0006\u0000" + "�".repeat(400) + "word/document.xml";
    const read = await readTool({ "/mnt/session/outputs/report.docx": { text: zip } });

    const result = await read({ file_path: "/mnt/session/outputs/report.docx" });

    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/binary file/);
    expect((result as string).length).toBeLessThan(600);
  });
});

describe("tool results for the Pi model", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } };
  const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQK" } };

  it("cuts long text and says so", () => {
    const [part] = valueToPiContent("x".repeat(MAX_PI_TOOL_TEXT_CHARS + 10_000));
    expect(part.type).toBe("text");
    const text = (part as { text: string }).text;
    expect(text.length).toBeLessThan(MAX_PI_TOOL_TEXT_CHARS + 200);
    expect(text).toContain("truncated");
  });

  it("passes an image to a model that accepts images", () => {
    expect(valueToPiContent(image, { images: true })).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
  });

  it("turns an image into a short note when the model is not known to see images", () => {
    const [part] = valueToPiContent(image);
    const text = (part as { text: string }).text;
    expect(part.type).toBe("text");
    expect(text).toContain("image/png");
    expect(text).not.toContain(PNG_BASE64);
    expect(text.length).toBeLessThan(500);
  });

  it("turns a PDF into a note that suggests extracting its text", () => {
    const [part] = valueToPiContent(pdf, { images: true });
    const text = (part as { text: string }).text;
    expect(text).toContain("pdftotext");
    expect(text).not.toContain("JVBERi0xLjQK");
  });

  it("toolsToPi sends images only when the model runtime says the model sees them", async () => {
    const ctx = (images: boolean) =>
      ({
        tools: { read: { description: "Read", inputSchema: undefined, execute: async () => image } },
        runtime: {},
        pi: { model: { input: ["text", "image"] }, toolImages: images },
      }) as unknown as HarnessContext;

    const blind = await toolsToPi(ctx(false))[0].execute("t1", {}, undefined as never);
    const seeing = await toolsToPi(ctx(true))[0].execute("t1", {}, undefined as never);

    expect(blind.content[0].type).toBe("text");
    expect(seeing.content[0].type).toBe("image");
  });
});

describe("history rebuilt from stored events", () => {
  it("replaces an old base64 blob with a note", () => {
    const text = capHistoryText(PNG_BASE64.repeat(1_000));
    expect(text).toMatch(/binary data omitted/);
    expect(text.length).toBeLessThan(300);
  });

  it("cuts long plain text", () => {
    const text = capHistoryText("слово ".repeat(20_000));
    expect(text.length).toBeLessThan(MAX_PI_TOOL_TEXT_CHARS + 200);
    expect(text).toContain("truncated");
  });

  it("keeps short text as is", () => {
    expect(capHistoryText("Hello, World!")).toBe("Hello, World!");
  });
});
