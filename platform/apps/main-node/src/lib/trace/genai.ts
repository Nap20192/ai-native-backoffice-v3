import { traceIdFor } from "./ids.js";
import type { TraceSpan } from "./types.js";

/**
 * Mapping of trace spans to OpenTelemetry GenAI conventions (plan section 1.5).
 * The conventions are in Development status, so every name lives here only.
 * Token totals follow docs/gen-ai/anthropic.md: input_tokens is the sum of
 * plain input, cache reads and cache writes; the cache parts go separately.
 */

export interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status: { code: number; message?: string };
}

export interface OtlpExportTraceServiceRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
}

/** OTLP SpanKind values. */
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
/** OTLP StatusCode values. */
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

export function genaiSpanName(span: TraceSpan): string {
  switch (span.kind) {
    case "turn":
    case "subagent": return `invoke_agent ${span.name}`;
    // Stored spans of old ACP turns still export.
    case "acp_prompt": return `invoke_agent ${span.harness ?? span.name}`;
    case "model_call": return `chat ${span.model ?? span.name}`;
    case "tool_call": return `execute_tool ${span.tool?.name ?? span.name}`;
    default: return `oma.${span.kind}`;
  }
}

const str = (key: string, value: string): OtlpKeyValue => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): OtlpKeyValue => ({ key, value: { intValue: String(Math.round(value)) } });
const strings = (key: string, values: string[]): OtlpKeyValue => ({ key, value: { arrayValue: { values: values.map((stringValue) => ({ stringValue })) } } });

function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function genaiAttributes(sessionId: string, span: TraceSpan): OtlpKeyValue[] {
  const attributes: OtlpKeyValue[] = [];
  switch (span.kind) {
    case "turn":
    case "subagent":
      attributes.push(str("gen_ai.operation.name", "invoke_agent"), str("gen_ai.agent.name", span.name), str("gen_ai.agent.id", span.thread_id), str("gen_ai.conversation.id", sessionId));
      break;
    case "acp_prompt":
      attributes.push(str("gen_ai.operation.name", "invoke_agent"), str("gen_ai.agent.name", span.harness ?? span.name), str("gen_ai.conversation.id", sessionId));
      break;
    case "model_call": {
      attributes.push(str("gen_ai.operation.name", "chat"));
      if (span.model !== null) attributes.push(str("gen_ai.request.model", span.model));
      const provider = span.attrs.provider;
      if (typeof provider === "string") attributes.push(str("gen_ai.provider.name", provider));
      const responseId = span.attrs.provider_response_id;
      if (typeof responseId === "string") attributes.push(str("gen_ai.response.id", responseId));
      if (span.finish_reason !== null) attributes.push(strings("gen_ai.response.finish_reasons", [span.finish_reason]));
      if (span.usage !== null) {
        attributes.push(
          int("gen_ai.usage.input_tokens", span.usage.input + span.usage.cache_read + span.usage.cache_write),
          int("gen_ai.usage.output_tokens", span.usage.output),
          int("gen_ai.usage.cache_read.input_tokens", span.usage.cache_read),
          int("gen_ai.usage.cache_creation.input_tokens", span.usage.cache_write),
        );
      }
      break;
    }
    case "tool_call":
      if (span.tool !== null) {
        attributes.push(
          str("gen_ai.operation.name", "execute_tool"),
          str("gen_ai.tool.name", span.tool.name),
          str("gen_ai.tool.call.id", span.tool.call_id),
          str("gen_ai.tool.type", span.tool.kind === "mcp" ? "extension" : "function"),
        );
      }
      break;
    default:
      break;
  }
  return attributes;
}

export function toOtlpSpan(sessionId: string, span: TraceSpan): OtlpSpan {
  const attributes = genaiAttributes(sessionId, span);
  attributes.push(
    str("oma.session.id", sessionId),
    str("oma.thread.id", span.thread_id),
    str("oma.kind", span.kind),
    str("oma.status", span.status),
    str("oma.precision", span.precision),
    strings("oma.event_ids", span.event_ids),
  );
  if (span.turn_id !== null) attributes.push(str("oma.turn.id", span.turn_id));
  if (span.end_ms === null) attributes.push({ key: "oma.open", value: { boolValue: true } });
  if (span.error !== null && span.error.type !== null) attributes.push(str("error.type", span.error.type));
  const failed = span.status === "error";
  return {
    traceId: traceIdFor(sessionId),
    spanId: span.span_id,
    parentSpanId: span.parent_span_id ?? "",
    name: genaiSpanName(span),
    kind: span.kind === "model_call" || span.kind === "acp_prompt" ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(span.start_ms),
    endTimeUnixNano: nanos(span.end_ms ?? span.start_ms),
    attributes,
    status: failed
      ? { code: STATUS_ERROR, ...(span.error?.message !== null && span.error?.message !== undefined && { message: span.error.message }) }
      : { code: STATUS_UNSET },
  };
}

/** The whole trace of a session as one OTLP/JSON ExportTraceServiceRequest. */
export function toOtlpTraceExport(sessionId: string, spans: readonly TraceSpan[]): OtlpExportTraceServiceRequest {
  return {
    resourceSpans: [{
      resource: { attributes: [str("service.name", "openma-main-node"), str("oma.session.id", sessionId)] },
      scopeSpans: [{
        scope: { name: "openma.trace", version: "1" },
        spans: spans.filter((span) => !span.deleted).map((span) => toOtlpSpan(sessionId, span)),
      }],
    }],
  };
}
