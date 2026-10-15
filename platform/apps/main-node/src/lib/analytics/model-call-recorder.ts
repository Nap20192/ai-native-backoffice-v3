import type { NodeManagedSessionRunnerAcceptInput } from '../node-managed-session-runtime.js';
import { callContext } from './call-context.js';
import type { ModelCall } from './model-call-store.js';
import type { createAnalyticsModelResolver } from './model-resolver.js';
import { costParts, resolveCallPrice } from './price.js';
interface Frame {
  type?: string; id?: string; processed_at?: string; session_thread_id?: string; agent_name?: string;
  model_request_start_id?: string; model?: string; provider_response_id?: string;
  model_usage?: {input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number};
  is_error?: boolean; finish_reason?: string; error_message?: string;
}
export function createModelCallRecorder({store, resolveModel, logger, now = Date.now}: {
  store: {insert(row: ModelCall): Promise<unknown>};
  resolveModel: ReturnType<typeof createAnalyticsModelResolver>;
  logger: {warn(details: {op: string; err: unknown; workspace_id: string; session_id: string}): void};
  now?: () => number;
}) {
  const pending = new Set<Promise<void>>();
  return {
    tap(input: NodeManagedSessionRunnerAcceptInput) {
      const starts = new Map<string, number>();
      const names = new Map<string, string>();
      return (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        const frame = value as Frame;
        if (frame.type === 'session.thread_created' && frame.session_thread_id && frame.agent_name) names.set(frame.session_thread_id, frame.agent_name);
        if (frame.type === 'span.model_request_start' && frame.id && frame.processed_at) {
          const time = Date.parse(frame.processed_at);
          if (Number.isFinite(time)) starts.set(frame.id, time);
          if (starts.size > 1000) starts.delete(starts.keys().next().value!);
        }
        if (frame.type !== 'span.model_request_end' || !frame.id) return;
        const start = starts.get(frame.model_request_start_id ?? '') ?? null;
        starts.delete(frame.model_request_start_id ?? '');
        const context = callContext(input, frame, names.get(frame.session_thread_id ?? ''));
        const ended_at = Date.parse(frame.processed_at ?? '');
        const usage = frame.model_usage;
        const tokens = {input_tokens:usage?.input_tokens ?? 0, output_tokens:usage?.output_tokens ?? 0, cache_read_tokens:usage?.cache_read_input_tokens ?? 0, cache_write_tokens:usage?.cache_creation_input_tokens ?? 0};
        const operation = (async () => {
          if (!Number.isFinite(ended_at)) throw new Error('Invalid model call timestamp');
          const resolved = await resolveModel(input.workspaceId, context.model, frame.model);
          const price = resolveCallPrice(resolved.card, resolved.provider, resolved.wire_model);
          await store.insert({...context, id:frame.id!, card_id:resolved.card_id, provider:resolved.provider, wire_model:resolved.wire_model, model_source:resolved.model_source,
            provider_response_id:frame.provider_response_id ?? null, started_at:start, ended_at, day:new Date(ended_at).toISOString().slice(0,10), latency_ms:start === null ? null : ended_at - start,
            ...tokens, usage_reported:usage ? 1 : 0, is_error:frame.is_error ? 1 : 0, finish_reason:frame.finish_reason ?? null, error_message:frame.error_message?.slice(0,500) ?? null,
            ...costParts(tokens,price), price_source:price.source, recorded_at:now()});
        })().catch(err => {logger.warn({op:'main-node.analytics.record_failed', err, workspace_id:input.workspaceId, session_id:input.sessionId});});
        pending.add(operation);
        void operation.then(() => pending.delete(operation));
      };
    },
    async flush() { while (pending.size) await Promise.all(pending); },
  };
}
export type ModelCallRecorder = ReturnType<typeof createModelCallRecorder>;
