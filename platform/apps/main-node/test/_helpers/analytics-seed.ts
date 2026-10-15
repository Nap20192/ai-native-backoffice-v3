import { createBetterSqlite3SqlClient, type SqlClient } from '@open-managed-agents/sql-client';
import { Hono } from 'hono';
import { createModelCallStore, type ModelCall } from '../../src/lib/analytics/model-call-store.js';
import { buildAnalyticsRoutes } from '../../src/lib/analytics/analytics-routes.js';
export const NOW = Date.parse('2026-10-16T09:15:00Z');
export const card = { id: 'mc_1', tenant_id: 'ws', model_id: 'alpha', model: 'claude-sonnet-4-6', provider: 'anthropic', pi_config: {cost: {input: 3, output: 15}}, is_default: true, archived_at: null, base_url: null, custom_headers: null, api_key_preview: '', created_at: '', updated_at: null };
export const cards = { list: async () => [card], get: async ({cardId}: {cardId: string}) => cardId === card.id ? card : null, findByModelId: async ({modelId}: {modelId: string}) => modelId === card.model_id ? card : null };
export function fact(overrides: Partial<ModelCall> = {}): ModelCall {
  const ended_at = Date.parse('2026-10-16T08:41:10Z');
  return {workspace_id:'ws',id:'sevt_1',session_id:'ses_1',thread_id:'sthr_primary',agent_id:'ag_1',agent_version:3,agent_name:'Первый',environment_id:'env_1',harness:'pi',model:'alpha',card_id:'mc_1',provider:'anthropic',wire_model:'claude-sonnet-4-6',model_source:'card',effort:null,speed:'standard',provider_response_id:null,started_at:ended_at-3020,ended_at,day:'2026-10-16',latency_ms:3020,input_tokens:20,output_tokens:10,cache_read_tokens:60,cache_write_tokens:20,usage_reported:1,is_error:0,finish_reason:'stop',error_message:null,cost_usd_micros:210,cost_input_usd_micros:60,cost_output_usd_micros:150,cost_cache_read_usd_micros:0,cost_cache_write_usd_micros:0,price_source:'card',recorded_at:NOW,...overrides};
}
export async function seed(sql: SqlClient) {
  const store = createModelCallStore(sql);
  for (const row of [fact(), fact({id:'sevt_2',agent_id:'ag_2',agent_name:'Второй',session_id:'ses_2',thread_id:'sub',is_error:1,input_tokens:40}),fact({id:'sevt_3',ended_at:Date.parse('2026-10-15T00:00:00Z'),day:'2026-10-15',model:'beta',card_id:null,model_source:'unknown',environment_id:null,harness:'acp',cost_usd_micros:null,cost_input_usd_micros:null,cost_output_usd_micros:null,cost_cache_read_usd_micros:null,cost_cache_write_usd_micros:null,price_source:'none',usage_reported:0}),fact({id:'sevt_4',ended_at:Date.parse('2026-10-14T23:59:59.999Z'),day:'2026-10-14'})]) await store.insert(row);
  return store;
}
export async function fixture(populate = true) {
  const sql = await createBetterSqlite3SqlClient(':memory:');
  const store = populate ? await seed(sql) : createModelCallStore(sql);
  const app = new Hono<{Variables:{tenant_id:string;user_id?:string}}>();
  app.use('*',async(c,next)=>{c.set('tenant_id','ws');c.set('user_id','u1');await next();});
  app.route('/v1/oma/analytics',buildAnalyticsRoutes({sql,dialect:'sqlite',modelCards:cards,now:()=>NOW}));
  const get = async (path:string) => {const res = await app.request('/v1/oma/analytics'+path);return {res,body:await res.json() as any};};
  return {sql,store,app,get};
}
export const input = () => ({workspaceId:'ws',sessionId:'ses_1',session:{environmentId:'env_1',agent:{id:'ag_1',version:3,name:'Первый',model:{id:'alpha'},multiagent:null}},environment:{},events:[],initialEvents:[],historyEvents:[],output:async()=>{}} as any);
export const start = {type:'span.model_request_start',id:'start',processed_at:'2026-10-16T09:12:00.100Z'};
export const end = {type:'span.model_request_end',id:'end',model_request_start_id:'start',processed_at:'2026-10-16T09:12:03.120Z',model_usage:{input_tokens:20,output_tokens:10,cache_read_input_tokens:60,cache_creation_input_tokens:20}};
