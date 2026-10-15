import { Hono } from 'hono';
import type { SqlClient } from '@open-managed-agents/sql-client';
import { createModelCallStore, presentCall, type MinuteRow } from './model-call-store.js';
import { createModelCardLimitsStore, type CardLimits } from './limits-store.js';
import type { AnalyticsCards } from './model-resolver.js';
import { AnalyticsError, DAY, HOUR, iso, parseLimitsBody, parseQuery, ratio, type Metric } from './query-params.js';
import { catalogModel } from './price.js';
import { csv } from './csv.js';

const metrics = ['itpm','otpm','rpm'] as const;
const field = {itpm:'input_tokens',otpm:'output_tokens',rpm:'requests'} as const;
const limitField = {itpm:'input_tokens_per_minute',otpm:'output_tokens_per_minute',rpm:'requests_per_minute'} as const;
const unit = (metric: Metric) => metric === 'rpm' ? 'requests_per_minute' : 'tokens_per_minute';
function peak(rows: MinuteRow[], metric: Metric) {
  let value = 0; let minute: number | null = null;
  for (const row of rows) if (row[field[metric]] > value || row[field[metric]] === value && (minute === null || row.minute > minute)) {value=row[field[metric]];minute=row.minute;}
  return {value,minute,at:minute === null ? null : iso(minute*60000)};
}
function quotas(rows: MinuteRow[], limits: CardLimits | null) {
  return metrics.map(metric=>{const p=peak(rows,metric);const limit=limits?.[limitField[metric]] ?? null;return {metric,unit:unit(metric),limit,peak:p.value,peak_at:p.at,utilization:limit === null ? null : ratio(p.value,limit)};});
}
const usageHeaders = ['bucket_start','group_key','group_label','requests','errors','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','cost_usd_micros','cost_usd','unpriced_requests'];
const logHeaders = ['id','ended_at','started_at','latency_ms','status','session_id','thread_id','agent_id','agent_name','harness','model','card_id','provider','wire_model','speed','effort','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','cost_usd_micros','cost_usd','price_source','finish_reason','error_message'];
const dollars = (micros: number | null) => micros === null ? '' : (micros/1000000).toFixed(6);
export function buildAnalyticsRoutes({sql,dialect,modelCards,now=Date.now}: {sql: SqlClient; dialect: string; modelCards: AnalyticsCards; now?: () => number}) {
  const app = new Hono<{Variables:{tenant_id: string;user_id?: string}}>();
  app.onError((error,c)=>{
    if (!(error instanceof AnalyticsError)) {return c.json({type:'error',error:{type:'api_error',message:'Не удалось получить аналитику.'}},500);}
    return c.json({type:'error',error:{type:error.status === 400 ? 'invalid_request_error' : error.status === 404 ? 'not_found_error' : 'api_error',message:error.message}},error.status);
  });
  app.use('*',async(_c,next)=>{if(dialect === 'mysql')throw new AnalyticsError('На MySQL аналитика не ведётся.',501);await next();});
  // MySQL routes never construct stores or access the database.
  const calls = dialect === 'mysql' ? null : createModelCallStore(sql);
  const limits = dialect === 'mysql' ? null : createModelCardLimitsStore(sql);
  const requireCard = async(workspace: string, id: string)=>{
    const card=await modelCards.get({tenantId:workspace,cardId:id});
    if(!card || card.archived_at)throw new AnalyticsError('Карточка модели не найдена',404);
    return card;
  };
  app.get('/usage',async c=>{
    const time=now();const q=parseQuery(c.req.query(),'usage',time);
    const report=await calls!.usage(c.get('tenant_id'),q,time);
    if(q.format==='json')return c.json(report);
    const labels=new Map(report.groups.map(g=>[g.key,g.label]));
    const rows=report.series.map(r=>[r.bucket_start,r.key,labels.get(r.key),r.requests,r.errors,r.input_tokens,r.output_tokens,r.cache_read_tokens,r.cache_write_tokens,r.cost_usd_micros,dollars(r.cost_usd_micros),r.unpriced_requests]);
    c.header('Content-Disposition',`attachment; filename="analytics-usage-${q.from}_${q.to}.csv"`);
    return c.body(csv(usageHeaders,rows),200,{'Content-Type':'text/csv; charset=utf-8'});
  });
  app.get('/cache',async c=>{const time=now();return c.json(await calls!.cache(c.get('tenant_id'),parseQuery(c.req.query(),'cache',time),time));});
  app.get('/limits',async c=>{
    const time=now();const workspace=c.get('tenant_id');
    const minutes=await calls!.minutes(workspace,time-DAY,time);
    const cards=(await modelCards.list({tenantId:workspace})).filter(card=>!card.archived_at);
    const result=[];
    for(const card of cards){
      const stored=await limits!.get(workspace,card.id);
      result.push({card_id:card.id,model:card.model_id,label:catalogModel(card.provider,card.model)?.name ?? card.model_id,provider:card.provider,wire_model:card.model,is_default:card.is_default,limits_updated_at:stored ? iso(stored.updated_at) : null,quotas:quotas(minutes.filter(row=>row.card_id===card.id),stored)});
    }
    result.sort((a,b)=>Number(b.is_default)-Number(a.is_default)||a.label.localeCompare(b.label)||a.card_id.localeCompare(b.card_id));
    const models=[...new Set(minutes.filter(row=>row.card_id===null).map(row=>row.model))].sort();
    return c.json({window_from:iso(time-DAY),window_to:iso(time),cards:result,uncarded:models.map(model=>{const rows=minutes.filter(row=>row.card_id===null&&row.model===model);return {model,model_source:rows.at(-1)!.model_source,label:catalogModel(null,model)?.name ?? model,quotas:quotas(rows,null)};}),generated_at:iso(time)});
  });
  app.get('/limits/:card_id',async c=>{
    const time=now();const workspace=c.get('tenant_id');const q=parseQuery(c.req.query(),'limit',time);const card=await requireCard(workspace,c.req.param('card_id'));
    const stored=await limits!.get(workspace,card.id);const limit=stored?.[limitField[q.metric]] ?? null;
    const minutes=await calls!.minutes(workspace,time-DAY,time,card.id);const p=peak(minutes,q.metric);
    const rows=p.minute===null?[]:await calls!.breakdown(workspace,card.id,p.minute,q.by,time-DAY,time);
    const breakdown=rows.map(row=>({key:row.key,label:row.label,value:row[field[q.metric]],share:ratio(row[field[q.metric]],p.value),utilization:limit===null?null:ratio(row[field[q.metric]],limit)})).sort((a,b)=>b.value-a.value||a.key.localeCompare(b.key));
    const hour=Math.floor(time/HOUR)*HOUR;const first=hour-167*HOUR;
    const history=await calls!.minutes(workspace,first-1,time,card.id);
    const peaks=new Map<number,number>();for(const row of history){const h=Math.floor(row.minute*60000/HOUR)*HOUR;peaks.set(h,Math.max(peaks.get(h)??0,row[field[q.metric]]));}
    const series=Array.from({length:168},(_,i)=>({hour_start:iso(first+i*HOUR),peak:peaks.get(first+i*HOUR)??0}));
    return c.json({card_id:card.id,model:card.model_id,label:catalogModel(card.provider,card.model)?.name??card.model_id,metric:q.metric,unit:unit(q.metric),limit,peak_24h:{value:p.value,at:p.at,utilization:limit===null?null:ratio(p.value,limit)},breakdown:{by:q.by,rows:breakdown,total:p.value},series,generated_at:iso(time)});
  });
  app.put('/limits/:card_id',async c=>{
    const time=now();const workspace=c.get('tenant_id');const card=await requireCard(workspace,c.req.param('card_id'));
    let body:unknown;try{body=await c.req.json();}catch{throw new AnalyticsError('Тело запроса должно быть JSON.');}
    const values=parseLimitsBody(body);
    await limits!.upsert(workspace,card.id,values,c.get('user_id')??null,time);
    return c.json({card_id:card.id,...values,updated_at:iso(time)});
  });
  app.get('/model_calls',async c=>{
    const q=parseQuery(c.req.query(),'model_calls',now());const report=await calls!.journal(c.get('tenant_id'),q);
    if(q.format==='json'){const {truncated:_truncated,...body}=report;return c.json(body);}
    const rows=report.data.map(r=>[r.id,r.ended_at,r.started_at,r.latency_ms,r.is_error?'error':'ok',r.session_id,r.thread_id,r.agent.id,r.agent.name,r.harness,r.model,r.card_id,r.provider,r.wire_model,r.speed,r.effort,r.input_tokens,r.output_tokens,r.cache_read_tokens,r.cache_write_tokens,r.cost_usd_micros,dollars(r.cost_usd_micros),r.price_source,r.finish_reason,r.error_message]);
    c.header('Content-Disposition',`attachment; filename="analytics-model-calls-${q.from}_${q.to}.csv"`);
    if(report.truncated)c.header('X-Analytics-Truncated','10000');
    return c.body(csv(logHeaders,rows),200,{'Content-Type':'text/csv; charset=utf-8'});
  });
  app.get('/model_calls/:id',async c=>{const row=await calls!.get(c.get('tenant_id'),c.req.param('id'));if(!row)throw new AnalyticsError('Запись журнала не найдена',404);return c.json(presentCall(row));});
  app.get('/sessions/:id',async c=>c.json(await calls!.session(c.get('tenant_id'),c.req.param('id'))));
  app.get('/facets',async c=>c.json(await calls!.facets(c.get('tenant_id'),parseQuery(c.req.query(),'facets',now()))));
  return app;
}
