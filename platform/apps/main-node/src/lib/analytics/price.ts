import { findPiCatalogModel } from '@open-managed-agents/managed-agents-application/agents/pi-model-catalog';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ModelCardRow } from '@open-managed-agents/model-cards-store';

export interface CallPrice { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ResolvedPrice { source: 'card' | 'catalog' | 'none'; price: CallPrice | null }
export interface Tokens { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number }
function validPrice(value: unknown): CallPrice | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  const fields = [p.input, p.output, p.cacheRead ?? 0, p.cacheWrite ?? 0];
  if (!fields.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return null;
  return {input: fields[0] as number, output: fields[1] as number, cacheRead: fields[2] as number, cacheWrite: fields[3] as number};
}
export function catalogModel(provider: string | null, wireModel: string | null) {
  if (!wireModel) return undefined;
  const providerId = provider === 'ant' ? 'anthropic' : provider === 'oai' ? 'openai' : provider;
  return findPiCatalogModel(wireModel) ?? builtinProviders().find(p => p.id === providerId)?.getModels().find(m => m.id === wireModel);
}
export function resolveCallPrice(card: Pick<ModelCardRow, 'pi_config'> | null, provider: string | null, wireModel: string | null): ResolvedPrice {
  const cardPrice = validPrice(card?.pi_config?.cost);
  if (cardPrice) return {source:'card', price:cardPrice};
  const price = validPrice(catalogModel(provider, wireModel)?.cost);
  return {source:price ? 'catalog' : 'none', price};
}
export function costParts(tokens: Tokens, resolved: ResolvedPrice) {
  const p = resolved.price;
  const input = p ? Math.round(tokens.input_tokens * p.input) : null;
  const output = p ? Math.round(tokens.output_tokens * p.output) : null;
  const read = p ? Math.round(tokens.cache_read_tokens * p.cacheRead) : null;
  const write = p ? Math.round(tokens.cache_write_tokens * p.cacheWrite) : null;
  return {cost_input_usd_micros:input, cost_output_usd_micros:output, cost_cache_read_usd_micros:read, cost_cache_write_usd_micros:write, cost_usd_micros:p ? input! + output! + read! + write! : null};
}
