import { Type, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { HarnessContext } from "./interface";

export function toolsToPi(ctx: HarnessContext): AgentTool[] {
  // Images from tools reach the model only when its runtime knows the model
  // sees them (pi catalog or an explicit model-card `input`); otherwise a note.
  const images = ctx.pi?.toolImages === true;
  return Object.entries(ctx.tools).map(([name, raw]) => {
    const tool = raw as {
      description?: string;
      inputSchema?: unknown;
      parameters?: unknown;
      execute?: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const schema = toJsonSchema(tool.inputSchema ?? tool.parameters);
    return {
      name,
      label: name,
      description: tool.description ?? name,
      parameters: Type.Unsafe<Record<string, unknown>>(schema),
      execute: async (toolCallId, params, signal) => {
        if (!tool.execute) {
          ctx.runtime.pendingConfirmations ??= [];
          ctx.runtime.pendingConfirmations.push(toolCallId);
          return {
            content: [{ type: "text", text: "Tool confirmation required" }],
            details: { openmaPendingConfirmation: true },
            terminate: true,
          };
        }
        const value = await tool.execute(params, {
          toolCallId,
          messages: [],
          abortSignal: signal,
        });
        return { content: valueToPiContent(value, { images }), details: value };
      },
    };
  });
}

function toJsonSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    return { type: "object", additionalProperties: true };
  }
  const candidate = input as { jsonSchema?: unknown; _zod?: unknown };
  if (candidate.jsonSchema && typeof candidate.jsonSchema === "object") {
    return candidate.jsonSchema as Record<string, unknown>;
  }
  try {
    return z.toJSONSchema(input as z.ZodType) as Record<string, unknown>;
  } catch {
    return input as Record<string, unknown>;
  }
}

/**
 * Largest tool result text the model gets, same as MAX_TOOL_RESULT_CHARS in
 * tools.ts. A longer result is cut with a note: one tool call must not eat the
 * context window (2026-10-16, four PNG pages as base64 text overflowed the
 * 262144-token window of Qwen and broke the session for good).
 */
export const MAX_PI_TOOL_TEXT_CHARS = 50_000;

/** Base64 longer than this in stored history is file bytes, not something to read. */
const HISTORY_BASE64_MIN_CHARS = 4_000;

export interface PiToolContentOptions {
  /** The model accepts images in tool results. */
  images?: boolean;
}

function cutText(text: string): string {
  if (text.length <= MAX_PI_TOOL_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_PI_TOOL_TEXT_CHARS)}\n...(truncated, total ${text.length} chars)`;
}

function sizeOfBase64(data: string): string {
  const bytes = Math.floor((data.length * 3) / 4);
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

type Base64Block = { type: "image" | "document"; source: { type: "base64"; media_type?: string; data?: string } };

function isBase64Block(value: unknown): value is Base64Block {
  if (!value || typeof value !== "object") return false;
  const block = value as { type?: unknown; source?: { type?: unknown } };
  return (block.type === "image" || block.type === "document") && block.source?.type === "base64";
}

/** Tool result value (string, content block or other object) → Pi content for the model. */
export function valueToPiContent(value: unknown, options: PiToolContentOptions = {}): Array<TextContent | ImageContent> {
  if (typeof value === "string") return [{ type: "text", text: cutText(value) }];
  if (isBase64Block(value)) {
    const mediaType = value.source.media_type ?? "application/octet-stream";
    const data = value.source.data ?? "";
    if (value.type === "image" && options.images) {
      return [{ type: "image", data, mimeType: mediaType }];
    }
    if (value.type === "image") {
      return [{
        type: "text",
        text: `[image ${mediaType}, ${sizeOfBase64(data)}: this model does not receive images, so the picture ` +
          "is not shown. Check the result by its text instead: extract text, read the source data, or list the file.]",
      }];
    }
    return [{
      type: "text",
      text: `[document ${mediaType}, ${sizeOfBase64(data)}: the model does not receive documents. Extract the ` +
        "text instead, for example: pdftotext -layout file.pdf - | head -n 200]",
    }];
  }
  return [{ type: "text", text: cutText(JSON.stringify(value) ?? String(value)) }];
}

/**
 * Tool result text from stored session history, before it goes back to the
 * model: an old base64 blob becomes a note and long text is cut. Sessions that
 * already hold oversized results can run again.
 */
export function capHistoryText(text: string): string {
  if (text.length >= HISTORY_BASE64_MIN_CHARS && looksLikeBase64(text)) {
    const compact = text.replace(/\r?\n/g, "");
    return `[binary data omitted from history: ${sizeOfBase64(compact)} of base64]`;
  }
  return cutText(text);
}

/**
 * Base64 is one long line or lines wrapped at 60-76 characters, with no spaces
 * or tabs. Tables and prose have spaces or tabs; a word list has short lines.
 */
function looksLikeBase64(text: string): boolean {
  if (/[ \t]/.test(text)) return false;
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const compact = lines.join("");
  return /^[A-Za-z0-9+/=]+$/.test(compact) && compact.length / lines.length >= 60;
}
