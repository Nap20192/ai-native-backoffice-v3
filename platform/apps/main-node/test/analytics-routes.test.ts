import {it,expect} from 'vitest';
import {Hono} from 'hono';
import {buildAnalyticsRoutes} from '../src/lib/analytics/analytics-routes.js';
import {fixture,NOW,fact,cards,card} from './_helpers/analytics-seed.js';
it.each(['/usage','/cache','/limits','/limits/mc_1','/model_calls','/model_calls/sevt_1','/sessions/ses_1','/facets'])('serves JSON contract for GET %s',async path=>{const {get}=await fixture();const {res,body}=await get(path);expect(res.status).toBe(200);expect(body.type).not.toBe('error');});
it.each(['/usage','/cache','/limits','/limits/mc_1','/model_calls','/sessions/absent','/facets'])('handles empty data for %s',async path=>{const {get}=await fixture(false);const {res,body}=await get(path);expect(res.status).toBe(200);if(body.totals)expect(body.totals.requests).toBe(0);if(body.latest_ended_at!==undefined)expect(body.latest_ended_at).toBeNull();});
it('returns cache ratio from summed input, 336 hour history and latest name',async()=>{const {get}=await fixture();const {body}=await get('/cache');expect(body.totals).toMatchObject({requests:2,uncached_input_tokens:60,cache_read_tokens:120,cache_write_tokens:40,total_input_tokens:220,read_ratio:0.5455,write_amortization:3});expect(Date.parse(body.to_hour)-Date.parse(body.series_from_hour)).toBe(335*3600000);expect(body.rows[0].key).toBe('alpha');});
it('low cache diagnostic excludes small agents and includes input at threshold',async()=>{const {get,store}=await fixture(false);await store.insert(fact({input_tokens:10000,cache_read_tokens:0,cache_write_tokens:0}));const {body}=await get('/cache?group_by=agent');expect(body.low_cache_agents).toEqual([{agent_id:'ag_1',agent_name:'Первый',model:'alpha',total_input_tokens:10000,read_ratio:0}]);});
it('updates and reads limits with actor, peak and minute breakdown',async()=>{const {app,get,sql}=await fixture();const response=await app.request('/v1/oma/analytics/limits/mc_1',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({requests_per_minute:4,input_tokens_per_minute:200,output_tokens_per_minute:null})});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({card_id:'mc_1',requests_per_minute:4,updated_at:new Date(NOW).toISOString()});expect(await sql.prepare('SELECT updated_by FROM model_card_limits').first()).toEqual({updated_by:'u1'});const {body}=await get('/limits');expect(body.cards[0].quotas).toEqual([{metric:'itpm',unit:'tokens_per_minute',limit:200,peak:100,peak_at:'2026-10-16T08:41:00.000Z',utilization:0.5},{metric:'otpm',unit:'tokens_per_minute',limit:null,peak:20,peak_at:'2026-10-16T08:41:00.000Z',utilization:null},{metric:'rpm',unit:'requests_per_minute',limit:4,peak:2,peak_at:'2026-10-16T08:41:00.000Z',utilization:0.5}]);const detail=(await get('/limits/mc_1?metric=itpm&by=agent')).body;expect(detail.breakdown.total).toBe(100);expect(detail.breakdown.rows.map((r:any)=>r.value)).toEqual([60,40]);expect(detail.series).toHaveLength(168);expect(detail.series.find((r:any)=>r.hour_start==='2026-10-16T08:00:00.000Z').peak).toBe(100);expect((await get('/limits/mc_1?metric=rpm&by=session')).body.breakdown.rows).toHaveLength(2);});
it('peak ties use latest minute and input excludes cache reads',async()=>{const {get,store}=await fixture(false);await store.insert(fact({id:'first',ended_at:NOW-120000,cache_read_tokens:999}));await store.insert(fact({id:'second',ended_at:NOW-60000}));const {body}=await get('/limits/mc_1');expect(body.peak_24h).toMatchObject({value:40,at:'2026-10-16T09:14:00.000Z'});});
it('log detail has nested agent, ISO timestamps, flags and price parts',async()=>{const {get}=await fixture();const {body}=await get('/model_calls/sevt_1');expect(body).toMatchObject({agent:{id:'ag_1',version:3,name:'Первый'},ended_at:'2026-10-16T08:41:10.000Z',is_error:false,usage_reported:true,cost_parts_usd_micros:{input:60,output:150,cache_read:0,cache_write:0}});expect(body.workspace_id).toBeUndefined();expect(body.day).toBeUndefined();});
it('filters logs by status, session and literal ID prefix',async()=>{const {get}=await fixture();expect((await get('/model_calls?status=error&session_id=ses_2&q=sevt')).body.data.map((r:any)=>r.id)).toEqual(['sevt_2']);expect((await get('/model_calls?q=sevt_')).body.data).toHaveLength(4);expect((await get('/model_calls?q=sevt%25')).body.data).toHaveLength(0);});
it.each(['/model_calls/absent','/limits/absent'])('returns managed 404 for %s',async path=>{const {get}=await fixture();expect((await get(path)).res.status).toBe(404);expect((await get(path)).body.error.type).toBe('not_found_error');});
it.each(['/usage?from=2026-02-30','/usage?group_by=oops','/model_calls?cursor=bad','/limits/mc_1?metric=bad','/cache?group_by=card'])('returns managed 400 for %s',async path=>{const {get}=await fixture();const {res,body}=await get(path);expect(res.status).toBe(400);expect(body.error.type).toBe('invalid_request_error');});
it.each(['{', '{}', '{"requests_per_minute":0,"input_tokens_per_minute":null,"output_tokens_per_minute":null}'])('rejects invalid limit JSON %s',async body=>{const {app}=await fixture();expect((await app.request('/v1/oma/analytics/limits/mc_1',{method:'PUT',body})).status).toBe(400);});
it.each(['/usage','/model_calls'])('exports %s as CSV',async path=>{const {app}=await fixture();const res=await app.request('/v1/oma/analytics'+path+'?format=csv');expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');expect(res.headers.get('content-disposition')).toContain('2026-09-17_2026-10-16.csv');expect(await res.text()).toContain('0.000210');});
it('MySQL returns 501 before touching SQL or cards',async()=>{const app=buildAnalyticsRoutes({dialect:'mysql',sql:null as any,modelCards:null as any});for(const path of ['/usage','/cache','/limits','/limits/c','/model_calls','/model_calls/x','/sessions/x','/facets']){const res=await app.request(path);expect(res.status).toBe(501);expect(await res.json()).toEqual({type:'error',error:{type:'api_error',message:'На MySQL аналитика не ведётся.'}});}});

it('returns exact usage totals, sparse series and all UTC buckets', async () => {
  const {get} = await fixture();
  const {res, body} = await get('/usage?from=2026-10-15&to=2026-10-16&group_by=none');
  expect(res.status).toBe(200);
  expect(body).toMatchObject({
    from: '2026-10-15', to: '2026-10-16', bucket: 'day', group_by: 'none', currency: 'USD',
    filters: {agent_id: [], model: [], harness: [], card_id: []},
    totals: {requests: 3, errors: 1, input_tokens: 80, output_tokens: 30,
      cache_read_tokens: 180, cache_write_tokens: 60, cost_usd_micros: 420,
      cost_parts_usd_micros: {input: 120, output: 300, cache_read: 0, cache_write: 0},
      unpriced_requests: 1, usage_missing_requests: 1},
    latest_ended_at: '2026-10-16T08:41:10.000Z', generated_at: new Date(NOW).toISOString(),
  });
  expect(body.buckets).toEqual(['2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z']);
  expect(body.groups).toHaveLength(1);
  expect(body.groups[0]).toMatchObject({key: 'all', label: 'Всё', requests: 3});
  expect(body.series.map((row: any) => [row.bucket_start, row.key, row.requests])).toEqual([
    ['2026-10-15T00:00:00.000Z', 'all', 1], ['2026-10-16T00:00:00.000Z', 'all', 2],
  ]);
});

it('keeps unknown prices null in log detail', async () => {
  const {get} = await fixture();
  expect((await get('/model_calls/sevt_3')).body).toMatchObject({
    model_source: 'unknown', price_source: 'none', usage_reported: false,
    cost_usd_micros: null,
    cost_parts_usd_micros: {input: null, output: null, cache_read: null, cache_write: null},
  });
});

it('returns session totals across all dates and an empty unknown session', async () => {
  const {get} = await fixture();
  expect((await get('/sessions/ses_1')).body).toMatchObject({
    session_id: 'ses_1', totals: {requests: 3, errors: 0, cost_usd_micros: 420, unpriced_requests: 1},
    models: ['alpha', 'beta'], harnesses: ['acp', 'pi'], last_ended_at: '2026-10-16T08:41:10.000Z',
  });
  expect((await get('/sessions/missing')).body).toMatchObject({
    session_id: 'missing', totals: {requests: 0}, models: [], harnesses: [],
    first_started_at: null, last_ended_at: null,
  });
});

it('paginates the HTTP journal without losing calls at equal timestamps', async () => {
  const {get} = await fixture();
  const first = (await get('/model_calls?limit=1')).body;
  expect(first.data.map((row: any) => row.id)).toEqual(['sevt_2']);
  const second = (await get(`/model_calls?limit=1&cursor=${first.next_cursor}`)).body;
  expect(second.data.map((row: any) => row.id)).toEqual(['sevt_1']);
  const last = (await get(`/model_calls?limit=200&cursor=${second.next_cursor}`)).body;
  expect(last.data.map((row: any) => row.id)).toEqual(['sevt_3', 'sevt_4']);
  expect(last.next_cursor).toBeNull();
});

it('returns zero quotas and a complete hourly series for unused cards', async () => {
  const {get} = await fixture(false);
  const table = (await get('/limits')).body;
  expect(table.cards).toHaveLength(1);
  expect(table.cards[0]).toMatchObject({card_id: 'mc_1', limits_updated_at: null});
  expect(table.cards[0].quotas).toEqual([
    {metric: 'itpm', unit: 'tokens_per_minute', limit: null, peak: 0, peak_at: null, utilization: null},
    {metric: 'otpm', unit: 'tokens_per_minute', limit: null, peak: 0, peak_at: null, utilization: null},
    {metric: 'rpm', unit: 'requests_per_minute', limit: null, peak: 0, peak_at: null, utilization: null},
  ]);
  expect(table.uncarded).toEqual([]);
  const detail = (await get('/limits/mc_1')).body;
  expect(detail).toMatchObject({peak_24h: {value: 0, at: null, utilization: null}, breakdown: {rows: [], total: 0}});
  expect(detail.series).toHaveLength(168);
  expect(detail.series[0]).toEqual({hour_start: '2026-10-09T10:00:00.000Z', peak: 0});
  expect(detail.series[167]).toEqual({hour_start: '2026-10-16T09:00:00.000Z', peak: 0});
});

it('shows uncarded load without assigning card limits', async () => {
  const {get, store} = await fixture(false);
  await store.insert(fact({card_id: null, model_source: 'builtin'}));
  const {body} = await get('/limits');
  expect(body.cards[0].quotas.every((quota: any) => quota.peak === 0)).toBe(true);
  expect(body.uncarded).toHaveLength(1);
  expect(body.uncarded[0]).toMatchObject({model: 'alpha', model_source: 'builtin'});
  expect(body.uncarded[0].quotas.map((quota: any) => quota.peak)).toEqual([40, 10, 1]);
  expect(body.uncarded[0].quotas.every((quota: any) => quota.limit === null)).toBe(true);
});

it('hides archived cards and rejects reading or changing their limits', async () => {
  const {sql} = await fixture(false);
  const archived = {...card, archived_at: '2026-10-16T00:00:00Z'};
  const app = new Hono<{Variables: {tenant_id: string; user_id?: string}}>();
  app.use('*', async (c, next) => {c.set('tenant_id', 'ws'); await next();});
  app.route('/', buildAnalyticsRoutes({sql, dialect: 'sqlite', now: () => NOW,
    modelCards: {...cards, list: async () => [archived], get: async () => archived}}));
  expect(await (await app.request('/limits')).json()).toMatchObject({cards: []});
  for (const method of ['GET', 'PUT']) {
    const response = await app.request('/limits/mc_1', {method, ...(method === 'PUT' ? {body: '{}'} : {})});
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({error: {type: 'not_found_error', message: 'Карточка модели не найдена'}});
  }
});

it.each([null, [], {requests_per_minute: 1.5, input_tokens_per_minute: null, output_tokens_per_minute: null},
  {requests_per_minute: '1', input_tokens_per_minute: null, output_tokens_per_minute: null},
  {requests_per_minute: 1000000001, input_tokens_per_minute: null, output_tokens_per_minute: null}])(
  'rejects invalid replacement limits %j without writing', async body => {
    const {app, sql} = await fixture(false);
    const response = await app.request('/v1/oma/analytics/limits/mc_1', {method: 'PUT', body: JSON.stringify(body)});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({type: 'error', error: {type: 'invalid_request_error'}});
    expect(await sql.prepare('SELECT * FROM model_card_limits').first()).toBeNull();
  },
);

it('replaces every limit and supports removing all limits through HTTP', async () => {
  const {app, get} = await fixture();
  for (const value of [1, null]) {
    const response = await app.request('/v1/oma/analytics/limits/mc_1', {method: 'PUT', body: JSON.stringify({
      requests_per_minute: value, input_tokens_per_minute: value, output_tokens_per_minute: value,
    })});
    expect(response.status).toBe(200);
    const report = (await get('/limits')).body;
    expect(report.cards[0].quotas.map((quota: any) => quota.limit)).toEqual([value, value, value]);
  }
});

it('exports journal CSV without a cursor and leaves unknown cost empty', async () => {
  const {app, get} = await fixture();
  const cursor = (await get('/model_calls?limit=1')).body.next_cursor;
  const response = await app.request(`/v1/oma/analytics/model_calls?format=csv&limit=1&cursor=${cursor}`);
  const lines = (await response.text()).trimEnd().split('\r\n');
  expect(lines).toHaveLength(5);
  expect(lines[0]).toBe('id,ended_at,started_at,latency_ms,status,session_id,thread_id,agent_id,agent_name,harness,model,card_id,provider,wire_model,speed,effort,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd_micros,cost_usd,price_source,finish_reason,error_message');
  expect(lines[1].startsWith('sevt_2,')).toBe(true);
  expect(lines.find(line => line.startsWith('sevt_3,'))).toContain(',,,none,');
  expect(response.headers.has('X-Analytics-Truncated')).toBe(false);
});
