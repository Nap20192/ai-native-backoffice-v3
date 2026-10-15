import type { SqlClient } from '@open-managed-agents/sql-client';
import { ensureAnalyticsSchema } from './schema.js';
import type { LimitsValues } from './query-params.js';
export interface CardLimits extends LimitsValues {workspace_id: string; card_id: string; updated_at: number; updated_by: string | null}
export function createModelCardLimitsStore(sql: SqlClient) {
  return {
    async get(workspace: string, card: string): Promise<CardLimits | null> {
      await ensureAnalyticsSchema(sql);
      const row = await sql.prepare('SELECT * FROM model_card_limits WHERE workspace_id = ? AND card_id = ?').bind(workspace,card).first<CardLimits>();
      if (!row) return null;
      return {...row, updated_at:Number(row.updated_at), requests_per_minute:row.requests_per_minute === null ? null : Number(row.requests_per_minute), input_tokens_per_minute:row.input_tokens_per_minute === null ? null : Number(row.input_tokens_per_minute), output_tokens_per_minute:row.output_tokens_per_minute === null ? null : Number(row.output_tokens_per_minute)};
    },
    async upsert(workspace: string, card: string, values: LimitsValues, user: string | null, now: number) {
      await ensureAnalyticsSchema(sql);
      await sql.prepare(`INSERT INTO model_card_limits (workspace_id, card_id, requests_per_minute, input_tokens_per_minute, output_tokens_per_minute, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (workspace_id, card_id) DO UPDATE SET requests_per_minute = excluded.requests_per_minute, input_tokens_per_minute = excluded.input_tokens_per_minute, output_tokens_per_minute = excluded.output_tokens_per_minute, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).bind(workspace,card,values.requests_per_minute,values.input_tokens_per_minute,values.output_tokens_per_minute,now,user).run();
    },
  };
}
