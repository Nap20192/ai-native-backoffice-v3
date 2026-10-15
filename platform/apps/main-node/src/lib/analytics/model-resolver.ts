import type { ModelCardService, ModelCardRow } from '@open-managed-agents/model-cards-store';
export type AnalyticsCards = Pick<ModelCardService, 'list' | 'get' | 'findByModelId'>;
export interface ResolvedModel {
  card_id: string | null;
  provider: string | null;
  wire_model: string | null;
  model_source: 'card' | 'builtin' | 'unknown';
  card: ModelCardRow | null;
}
export function createAnalyticsModelResolver({modelCards, serverKeyAvailable, ttlMs = 60000, now = Date.now}: {modelCards: Pick<AnalyticsCards,'findByModelId'>; serverKeyAvailable: boolean; ttlMs?: number; now?: () => number}) {
  const cache = new Map<string, {expires: number; value: Promise<ResolvedModel>}>();
  return async (workspaceId: string, handle: string, frameModel?: string): Promise<ResolvedModel> => {
    const key = JSON.stringify([workspaceId, handle]);
    const cached = cache.get(key);
    let value = cached && cached.expires > now() ? cached.value : undefined;
    if (!value) {
      value = (async (): Promise<ResolvedModel> => {
        try {
          const card = await modelCards.findByModelId({tenantId:workspaceId, modelId:handle});
          if (card && !card.archived_at) return {card_id:card.id, provider:card.provider, wire_model:card.model, model_source:'card', card};
          if (serverKeyAvailable) return {card_id:null, provider:'anthropic', wire_model:handle, model_source:'builtin', card:null};
        } catch { /* A failed card lookup cannot establish a builtin model. */ }
        return {card_id:null, provider:null, wire_model:null, model_source:'unknown', card:null};
      })();
      // Remove expired entries when new handles arrive to bound stale metadata.
      for (const [k, item] of cache) if (item.expires <= now()) cache.delete(k);
      cache.set(key, {expires:now() + ttlMs, value});
    }
    const result = await value;
    return result.model_source === 'unknown' ? {...result, wire_model:frameModel ?? null} : result;
  };
}
