import type { HarnessContext } from "./interface";
import type { ContentBlock, AgentToolUseEvent } from "@open-managed-agents/shared";
import { ALL_TOOLS } from "./tools";

// Single source of truth lives in ./tools.ts (ALL_TOOLS). Importing here so
// adding a new toolset entry can't drift the event-classification list — a
// hard-coded duplicate once caused `browser`, `schedule`, `cancel_schedule`,
// and `list_schedules` to mis-emit as `agent.custom_tool_use` instead of
// `agent.tool_use`.
const BUILTIN_TOOLS = new Set(ALL_TOOLS);

export const isMcpTool = (name: string) => name.startsWith("mcp_");

// Returning true here makes `runtime.broadcast` emit `agent.tool_use`; false
// routes to `agent.custom_tool_use`. Down-stream consumers (Console UI, SDK
// event filters, billing dashboards) split on those event types.
export const isBuiltinTool = (name: string): boolean =>
  BUILTIN_TOOLS.has(name) || isMcpTool(name) || name.startsWith("call_agent_");

/** Extract the MCP server name from current and legacy projected tool names. */
function extractMcpServerName(toolName: string): string {
  // Current SDK shape: mcp__<server>__<tool>. The registered tool metadata
  // is the authoritative source (see emitHarnessToolUseFromCall); this parser
  // is the fallback for a tool constructed without that metadata.
  if (toolName.startsWith("mcp__")) {
    const withoutPrefix = toolName.slice("mcp__".length);
    const separator = withoutPrefix.indexOf("__");
    return separator >= 0 ? withoutPrefix.slice(0, separator) : withoutPrefix;
  }

  // mcp_{server_name}_{call|list_tools}
  const withoutPrefix = toolName.slice(4); // Remove "mcp_"
  const lastUnderscore = withoutPrefix.lastIndexOf("_");
  // Handle _list_tools (two underscores)
  if (withoutPrefix.endsWith("_list_tools")) {
    return withoutPrefix.slice(0, withoutPrefix.length - "_list_tools".length);
  }
  if (lastUnderscore > 0) {
    return withoutPrefix.slice(0, lastUnderscore);
  }
  return withoutPrefix;
}

/**
 * Map a tool call to the right wire event family (mcp / built-in / custom).
 * The inverse mapping lives in `eventsToMessages`
 * (runtime/history.ts).
 */
export function emitHarnessToolUseFromCall(
  runtime: HarnessContext["runtime"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): void {
  const callInput = input ?? {};

  // call_agent_* writes only its tool use here. The runner writes
  // agent.thread_message_sent and _received in the /v1 shape
  // (node-managed-subagents.ts); a second event of our own broke
  // GET /events with 500 (2026-10-18).

  if (isMcpTool(toolName)) {
    const registeredServerName = tools[toolName]?.metadata?.serverName;
    runtime.broadcast({
      type: "agent.mcp_tool_use",
      id: toolCallId,
      mcp_server_name:
        typeof registeredServerName === "string" && registeredServerName.length > 0
          ? registeredServerName
          : extractMcpServerName(toolName),
      name: toolName,
      input: callInput,
      ...(!tools[toolName]?.execute && { evaluated_permission: "ask" as const }),
    });
  } else if (isBuiltinTool(toolName) || tools[toolName]?.metadata?.openmaBuiltin === true) {
    const event: AgentToolUseEvent = {
      type: "agent.tool_use",
      id: toolCallId,
      name: toolName,
      input: callInput,
    };
    if (!tools[toolName]?.execute) event.evaluated_permission = "ask";
    runtime.broadcast(event);
  } else {
    runtime.broadcast({
      type: "agent.custom_tool_use",
      id: toolCallId,
      name: toolName,
      input: callInput,
    });
  }
}

/**
 * AI SDK ToolResultOutput union → wire `string | ContentBlock[]`.
 * Pure function; same input → same output bytes.
 *
 * Normalization rules — fixed so that read(write(m)) === m at byte level:
 *   text       → string
 *   content[]  → ContentBlock[] (TextBlock for text parts; image/document
 *                ContentBlocks pass through if already shaped that way)
 *   json/error → JSON-stringified string (lossy for the AI SDK type tag,
 *                but Anthropic only ever sees the string, so derive can
 *                rebuild a {type:"text"} ToolResultOutput equivalently)
 *   already-shaped ContentBlock or ContentBlock[] (legacy tool returns)
 *                → wrap or pass through
 */
export function normalizeToolOutputForWire(raw: unknown): string | ContentBlock[] {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";

  // Already wire-shape (single ContentBlock or array)
  if (typeof raw === "object" && "type" in raw) {
    const r = raw as { type: string };
    if (r.type === "text" && "text" in raw) return [raw as ContentBlock];
    if (r.type === "image" && "source" in raw) return [raw as ContentBlock];
    if (r.type === "document" && "source" in raw) return [raw as ContentBlock];

    // AI SDK ToolResultOutput discriminated union
    if (r.type === "text" && "value" in raw) return String((raw as unknown as { value: unknown }).value);
    if (r.type === "json") return JSON.stringify((raw as unknown as { value: unknown }).value);
    if (r.type === "error-text" || r.type === "error-json") {
      const v = (raw as unknown as { value: unknown }).value;
      return typeof v === "string" ? v : JSON.stringify(v);
    }
    if (r.type === "execution-denied") {
      return JSON.stringify({ denied: true, reason: (raw as unknown as { reason?: string }).reason });
    }
    if (r.type === "content" && Array.isArray((raw as unknown as { value: unknown[] }).value)) {
      const parts = (raw as unknown as { value: Array<{ type: string; text?: string; data?: string; mediaType?: string; url?: string }> }).value;
      return parts.map((p): ContentBlock => {
        if (p.type === "text") return { type: "text", text: p.text ?? "" };
        if (p.type === "image-data" || p.type === "media") {
          return {
            type: "image",
            source: { type: "base64", media_type: p.mediaType, data: p.data },
          };
        }
        if (p.type === "image-url") {
          return { type: "image", source: { type: "url", url: p.url, media_type: p.mediaType } };
        }
        if (p.type === "file-data") {
          return {
            type: "document",
            source: { type: "base64", media_type: p.mediaType, data: p.data },
          };
        }
        if (p.type === "file-url") {
          return { type: "document", source: { type: "url", url: p.url, media_type: p.mediaType } };
        }
        return { type: "text", text: JSON.stringify(p) };
      });
    }
  }

  if (Array.isArray(raw) && raw.every((b) => b && typeof b === "object" && "type" in b)) {
    return raw as ContentBlock[];
  }

  return JSON.stringify(raw);
}
