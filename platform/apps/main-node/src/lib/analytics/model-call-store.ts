import type { SqlClient } from '@open-managed-agents/sql-client';
import { ensureAnalyticsSchema } from './schema.js';
import { encodeCursor, HOUR, iso, ratio, type AnalyticsQuery, type GroupBy } from './query-params.js';

export interface ModelCall {
  workspace_id: string; id: string; session_id: string; thread_id: string;
  agent_id: string; agent_version: number | null; agent_name: string; environment_id: string | null;
  harness: string; model: string; card_id: string | null; provider: string | null; wire_model: string | null;
  model_source: 'card' | 'builtin' | 'unknown'; effort: string | null; speed: string; provider_response_id: string | null;
  started_at: number | null; ended_at: number; day: string; latency_ms: number | null;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  usage_reported: number; is_error: number; finish_reason: string | null; error_message: string | null;
  cost_usd_micros: number | null; cost_input_usd_micros: number | null; cost_output_usd_micros: number | null;
  cost_cache_read_usd_micros: number | null; cost_cache_write_usd_micros: number | null;
  price_source: 'card' | 'catalog' | 'none'; recorded_at: number;
}
const sums = ['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','cost_usd_micros','cost_input_usd_micros','cost_output_usd_micros','cost_cache_read_usd_micros','cost_cache_write_usd_micros'] as const;
type Aggregate = Record<typeof sums[number] | 'requests' | 'errors' | 'unpriced_requests' | 'usage_missing_requests', number> & {key: string; bucket: string | number};
const aggregateSql = `COUNT(*) AS requests, CAST(SUM(is_error) AS BIGINT) AS errors, ${sums.map(key => `CAST(SUM(${key}) AS BIGINT) AS ${key}`).join(', ')}, CAST(SUM(CASE WHEN cost_usd_micros IS NULL THEN 1 ELSE 0 END) AS BIGINT) AS unpriced_requests, CAST(SUM(CASE WHEN usage_reported = 0 THEN 1 ELSE 0 END) AS BIGINT) AS usage_missing_requests`;
const numeric = [...sums, 'agent_version','started_at','ended_at','latency_ms','usage_reported','is_error','recorded_at'] as const;
function normalizeCall(row: ModelCall): ModelCall {
  const copy = {...row};
  for (const key of numeric) if (copy[key] !== null) (copy as Record<string, unknown>)[key] = Number(copy[key]);
  return copy;
}
export function presentCall(row: ModelCall) {
  const {workspace_id: _workspace, agent_id, agent_version, agent_name, day: _day, recorded_at: _recorded, cost_input_usd_micros, cost_output_usd_micros, cost_cache_read_usd_micros, cost_cache_write_usd_micros, ...rest} = normalizeCall(row);
  return {...rest, agent:{id:agent_id,version:agent_version,name:agent_name}, started_at:row.started_at === null ? null : iso(Number(row.started_at)), ended_at:iso(Number(row.ended_at)), usage_reported:!!Number(row.usage_reported), is_error:!!Number(row.is_error), cost_parts_usd_micros:{input:cost_input_usd_micros, output:cost_output_usd_micros, cache_read:cost_cache_read_usd_micros, cache_write:cost_cache_write_usd_micros}};
}
function summary(row?: Partial<Aggregate>) {
  const n = (key: keyof Aggregate) => Number(row?.[key] ?? 0);
  return {requests:n('requests'),errors:n('errors'),input_tokens:n('input_tokens'),output_tokens:n('output_tokens'),cache_read_tokens:n('cache_read_tokens'),cache_write_tokens:n('cache_write_tokens'),cost_usd_micros:n('cost_usd_micros'),cost_parts_usd_micros:{input:n('cost_input_usd_micros'),output:n('cost_output_usd_micros'),cache_read:n('cost_cache_read_usd_micros'),cache_write:n('cost_cache_write_usd_micros')},unpriced_requests:n('unpriced_requests'),usage_missing_requests:n('usage_missing_requests')};
}
function cacheSummary(row?: Partial<Aggregate>) {
  const value = summary(row);
  const total = value.input_tokens + value.cache_read_tokens + value.cache_write_tokens;
  return {requests:value.requests,uncached_input_tokens:value.input_tokens,cache_read_tokens:value.cache_read_tokens,cache_write_tokens:value.cache_write_tokens,total_input_tokens:total,read_ratio:ratio(value.cache_read_tokens,total),write_amortization:ratio(value.cache_read_tokens,value.cache_write_tokens)};
}
interface GroupExpression {select: string; group: string}
const column = (name: string): GroupExpression => ({select:name, group:name});
// Postgres rejects a string constant in GROUP BY, so "none" groups by the single workspace the WHERE clause keeps.
const groupExpressions: Record<GroupBy, GroupExpression> = {model:column('model'),agent:column('agent_id'),harness:column('harness'),card:column("COALESCE(card_id, 'none')"),environment:column("COALESCE(environment_id, 'none')"),speed:column('speed'),none:{select:"'all'",group:'workspace_id'}};
// Groups and series carry no usage_missing_requests: the contract keeps it in totals only.
function groupSummary(row?: Partial<Aggregate>) {
  const {usage_missing_requests: _missing, ...rest} = summary(row);
  return rest;
}
function where(workspace: string, q?: AnalyticsQuery, time?: {from: number; to: number}) {
  const clauses = ['workspace_id = ?'];
  const args: unknown[] = [workspace];
  if (q || time) { clauses.push('ended_at >= ? AND ended_at < ?'); args.push(time?.from ?? q!.fromMs,time?.to ?? q!.toMs); }
  if (q) {
    for (const key of ['agent_id','model','harness','card_id'] as const) {
      const values = q.filters[key];
      if (!values.length) continue;
      const nonNull = values.filter(v => !(key === 'card_id' && v === 'none'));
      const alternatives: string[] = [];
      if (nonNull.length) {alternatives.push(`${key} IN (${nonNull.map(() => '?').join(',')})`); args.push(...nonNull);}
      if (key === 'card_id' && values.includes('none')) alternatives.push('card_id IS NULL');
      clauses.push(`(${alternatives.join(' OR ')})`);
    }
  }
  return {clause:clauses.join(' AND '), args};
}
export interface MinuteRow {card_id: string | null; model: string; model_source: string; minute: number; requests: number; input_tokens: number; output_tokens: number}
export function createModelCallStore(sql: SqlClient) {
  async function all<T>(query: string, args: unknown[] = []): Promise<T[]> {
    await ensureAnalyticsSchema(sql);
    return (await sql.prepare(query).bind(...args).all<T>()).results ?? [];
  }
  async function aggregate(workspace: string, q?: AnalyticsQuery, group?: GroupExpression, bucket?: string, time?: {from: number; to: number}, extra?: {clause: string; args: unknown[]}) {
    const w = where(workspace,q,time);
    if (extra) {w.clause += ' AND '+extra.clause;w.args.push(...extra.args);}
    const expressions = [group?.group,bucket].filter((v): v is string => v !== undefined);
    return all<Aggregate>(`SELECT ${group ? group.select+' AS key, ' : ''}${bucket ? bucket+' AS bucket, ' : ''}${aggregateSql} FROM model_calls WHERE ${w.clause}${expressions.length ? ' GROUP BY '+expressions.join(', ') : ''}`,w.args);
  }
  async function latest(workspace: string) {
    const rows = await all<{ended: number | null}>('SELECT MAX(ended_at) AS ended FROM model_calls WHERE workspace_id = ?',[workspace]);
    return rows[0]?.ended == null ? null : iso(Number(rows[0].ended));
  }
  async function labels(workspace: string, q: AnalyticsQuery, time?: {from:number;to:number}) {
    const w = where(workspace,q,time);
    // The newest row by (ended_at, id), the journal order, names the agent and the card.
    const latestBy = (key: string) => `ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY ended_at DESC, id DESC)`;
    const rows = await all<{agent_id:string;agent_name:string;model:string;card_id:string|null;agent_rank:number;card_rank:number}>(`SELECT agent_id, agent_name, model, card_id, agent_rank, card_rank FROM (SELECT agent_id, agent_name, model, card_id, ${latestBy('agent_id')} AS agent_rank, ${latestBy('card_id')} AS card_rank FROM model_calls WHERE ${w.clause}) ranked WHERE agent_rank = 1 OR card_rank = 1`,w.args);
    const agents = new Map<string,string>(); const cards = new Map<string,string>();
    for (const row of rows) {if (Number(row.agent_rank) === 1) agents.set(row.agent_id,row.agent_name);if (row.card_id && Number(row.card_rank) === 1) cards.set(row.card_id,row.model);}
    return {agents,cards};
  }
  return {
    async insert(row: ModelCall) {
      await ensureAnalyticsSchema(sql);
      const keys = Object.keys(row) as (keyof ModelCall)[];
      await sql.prepare(`INSERT INTO model_calls (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT (workspace_id, id) DO NOTHING`).bind(...keys.map(key => row[key])).run();
    },
    async get(workspace: string, id: string) {return (await all<ModelCall>('SELECT * FROM model_calls WHERE workspace_id = ? AND id = ?',[workspace,id])).map(normalizeCall)[0] ?? null;},
    async usage(workspace: string, q: AnalyticsQuery, now: number) {
      const group = groupExpressions[q.group_by];
      const bucket = q.bucket === 'day' ? 'day' : `ended_at / ${HOUR}`;
      const groups = await aggregate(workspace,q,group);
      const series = await aggregate(workspace,q,group,bucket);
      const totals = summary((await aggregate(workspace,q))[0]);
      const names = await labels(workspace,q);
      const label = (key:string) => q.group_by === 'agent' ? names.agents.get(key) ?? key : q.group_by === 'card' ? key === 'none' ? 'Без карточки' : names.cards.get(key) ?? key : q.group_by === 'environment' && key === 'none' ? 'Без окружения' : q.group_by === 'none' ? 'Всё' : key;
      const buckets: string[] = [];
      for (let time = q.fromMs; time < q.toMs; time += q.bucket === 'day' ? 24 * HOUR : HOUR) buckets.push(iso(time));
      const tokenTotal = (row: Aggregate) => Number(row.input_tokens)+Number(row.output_tokens)+Number(row.cache_read_tokens)+Number(row.cache_write_tokens);
      return {from:q.from,to:q.to,bucket:q.bucket,group_by:q.group_by,currency:'USD',filters:q.filters,buckets,totals,
        groups:groups.sort((a,b) => tokenTotal(b)-tokenTotal(a) || a.key.localeCompare(b.key)).map(row => ({key:row.key,label:label(row.key),...groupSummary(row)})),
        series:series.map(row => ({bucket_start:q.bucket === 'day' ? iso(Date.parse(String(row.bucket))) : iso(Number(row.bucket)*HOUR),key:row.key,...groupSummary(row)})).sort((a,b)=>a.bucket_start.localeCompare(b.bucket_start)||a.key.localeCompare(b.key)),
        latest_ended_at:await latest(workspace),generated_at:iso(now)};
    },
    async cache(workspace: string, q: AnalyticsQuery, now: number) {
      const to = Math.floor(now/HOUR)*HOUR;
      const from = to-167*HOUR;
      const seriesFrom = to-335*HOUR;
      const current = {from,to:to+HOUR};
      const history = {from:seriesFrom,to:to+HOUR};
      const names = await labels(workspace,q,current);
      const label = (key:string) => q.group_by === 'agent' ? names.agents.get(key) ?? key : key;
      const groups = await aggregate(workspace,q,groupExpressions[q.group_by],undefined,current);
      const series = await aggregate(workspace,q,groupExpressions[q.group_by],`ended_at / ${HOUR}`,history);
      const w = where(workspace,q,current);
      const diagnostic = await all<Aggregate & {agent_id:string;model:string}>(`SELECT agent_id, model, ${aggregateSql} FROM model_calls WHERE ${w.clause} GROUP BY agent_id, model`,w.args);
      return {from_hour:iso(from),to_hour:iso(to),series_from_hour:iso(seriesFrom),group_by:q.group_by,filters:{model:q.filters.model,agent_id:q.filters.agent_id},totals:cacheSummary((await aggregate(workspace,q,undefined,undefined,current))[0]),
        rows:groups.map(row=>({key:row.key,label:label(row.key),...cacheSummary(row)})).sort((a,b)=>b.total_input_tokens-a.total_input_tokens||a.key.localeCompare(b.key)),
        series:series.map(row=>{const s=cacheSummary(row);return {hour_start:iso(Number(row.bucket)*HOUR),key:row.key,requests:s.requests,uncached_input_tokens:s.uncached_input_tokens,cache_read_tokens:s.cache_read_tokens,cache_write_tokens:s.cache_write_tokens};}).sort((a,b)=>a.hour_start.localeCompare(b.hour_start)||a.key.localeCompare(b.key)),
        low_cache_agents:diagnostic.map(row=>{const s=cacheSummary(row);return {agent_id:row.agent_id,agent_name:names.agents.get(row.agent_id) ?? row.agent_id,model:row.model,total_input_tokens:s.total_input_tokens,read_ratio:s.read_ratio};}).filter(row=>row.total_input_tokens>=10000 && row.read_ratio!==null && row.read_ratio<0.5).sort((a,b)=>b.total_input_tokens-a.total_input_tokens||a.agent_id.localeCompare(b.agent_id)).slice(0,10),
        latest_ended_at:await latest(workspace),generated_at:iso(now)};
    },
    async journal(workspace: string, q: AnalyticsQuery) {
      const w = where(workspace,q);
      if (q.session_id) {w.clause+=' AND session_id = ?';w.args.push(q.session_id);}
      if (q.status) {w.clause+=' AND is_error = ?';w.args.push(q.status === 'error' ? 1 : 0);}
      if (q.q) {w.clause+=' AND substr(id, 1, ?) = ?';w.args.push(q.q.length,q.q);}
      if (q.cursor && q.format !== 'csv') {w.clause+=' AND (ended_at < ? OR (ended_at = ? AND id < ?))';w.args.push(q.cursor.e,q.cursor.e,q.cursor.i);}
      const limit = q.format === 'csv' ? 10000 : q.limit;
      const rows = await all<ModelCall>(`SELECT * FROM model_calls WHERE ${w.clause} ORDER BY ended_at DESC, id DESC LIMIT ?`,[...w.args,limit+1]);
      const hasMore = rows.length > limit;
      const page = rows.slice(0,limit).map(normalizeCall);
      const last = page.at(-1);
      return {data:page.map(presentCall),next_cursor:hasMore && last ? encodeCursor({e:last.ended_at,i:last.id}) : null,latest_ended_at:await latest(workspace),truncated:q.format === 'csv' && hasMore};
    },
    async session(workspace: string, session: string) {
      const extra = {clause:'session_id = ?',args:[session]};
      const totals = summary((await aggregate(workspace,undefined,undefined,undefined,undefined,extra))[0]);
      const rows = await all<{model:string;harness:string}>('SELECT DISTINCT model, harness FROM model_calls WHERE workspace_id = ? AND session_id = ?',[workspace,session]);
      const times = (await all<{first:number|null;last:number|null}>('SELECT MIN(started_at) AS first, MAX(ended_at) AS last FROM model_calls WHERE workspace_id = ? AND session_id = ?',[workspace,session]))[0];
      return {session_id:session,totals,models:[...new Set(rows.map(r=>r.model))].sort(),harnesses:[...new Set(rows.map(r=>r.harness))].sort(),first_started_at:times?.first == null ? null : iso(Number(times.first)),last_ended_at:times?.last == null ? null : iso(Number(times.last))};
    },
    async facets(workspace: string, q: AnalyticsQuery) {
      const w = where(workspace,q);
      const names = await labels(workspace,q);
      const distinct = await all<{model:string;harness:string}>(`SELECT DISTINCT model, harness FROM model_calls WHERE ${w.clause}`,w.args);
      return {from:q.from,to:q.to,agents:[...names.agents].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)),models:[...new Set(distinct.map(r=>r.model))].sort().map(key=>({key})),harnesses:[...new Set(distinct.map(r=>r.harness))].sort().map(key=>({key})),cards:[...names.cards].map(([id,model])=>({id,model})).sort((a,b)=>a.model.localeCompare(b.model)||a.id.localeCompare(b.id))};
    },
    async minutes(workspace: string, from: number, to: number, card?: string): Promise<MinuteRow[]> {
      const clause = card === undefined ? '' : ' AND card_id = ?';
      const rows = await all<MinuteRow>(`SELECT card_id, MAX(model) AS model, MAX(model_source) AS model_source, ended_at / 60000 AS minute, COUNT(*) AS requests, CAST(SUM(input_tokens + cache_write_tokens) AS BIGINT) AS input_tokens, CAST(SUM(output_tokens) AS BIGINT) AS output_tokens FROM model_calls WHERE workspace_id = ? AND ended_at > ? AND ended_at <= ?${clause} GROUP BY card_id, CASE WHEN card_id IS NULL THEN model ELSE '' END, ended_at / 60000`,[workspace,from,to,...(card === undefined ? [] : [card])]);
      return rows.map(row=>({...row,minute:Number(row.minute),requests:Number(row.requests),input_tokens:Number(row.input_tokens),output_tokens:Number(row.output_tokens)}));
    },
    async breakdown(workspace: string, card: string, minute: number, by: 'agent' | 'session', from: number, to: number) {
      const key = by === 'agent' ? 'agent_id' : 'session_id';
      const rows = await all<Aggregate>(`SELECT ${key} AS key, ${aggregateSql} FROM model_calls WHERE workspace_id = ? AND card_id = ? AND ended_at / 60000 = ? AND ended_at > ? AND ended_at <= ? GROUP BY ${key}`,[workspace,card,minute,from,to]);
      const nameRows = by === 'agent' ? await all<{agent_id:string;agent_name:string}>(`SELECT agent_id, agent_name FROM model_calls WHERE workspace_id = ? AND card_id = ? AND ended_at / 60000 = ? AND ended_at > ? AND ended_at <= ? ORDER BY ended_at DESC, id DESC`,[workspace,card,minute,from,to]) : [];
      const names = new Map<string,string>();for(const row of nameRows)if(!names.has(row.agent_id))names.set(row.agent_id,row.agent_name);
      return rows.map(row=>({key:row.key,label:names.get(row.key) ?? row.key,input_tokens:Number(row.input_tokens)+Number(row.cache_write_tokens),output_tokens:Number(row.output_tokens),requests:Number(row.requests)}));
    },
  };
}
export type ModelCallStore = ReturnType<typeof createModelCallStore>;
