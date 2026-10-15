import {it,expect} from 'vitest';
import {fixture,fact,NOW} from './_helpers/analytics-seed.js';
import {parseQuery} from '../src/lib/analytics/query-params.js';
it('inserts idempotently per workspace',async()=>{const {store}=await fixture();await store.insert(fact());await store.insert(fact({workspace_id:'other'}));expect((await store.session('ws','ses_1')).totals.requests).toBe(3);expect((await store.session('other','ses_1')).totals.requests).toBe(1);});
it.each(['model','agent','harness','card','environment','speed','none'])('groups by %s with numeric sums and UTC boundaries',async(group_by)=>{const {store}=await fixture();const r=await store.usage('ws',parseQuery({from:'2026-10-15',to:'2026-10-16',group_by},'usage',NOW),NOW);expect(r.totals).toMatchObject({requests:3,errors:1,input_tokens:80,unpriced_requests:1,usage_missing_requests:1,cost_usd_micros:420});expect(r.buckets).toHaveLength(2);expect(r.groups.reduce((n,g)=>n+g.requests,0)).toBe(3);});
it('hour buckets and filters handle null card',async()=>{const {store}=await fixture();const r=await store.usage('ws',parseQuery({from:'2026-10-15',to:'2026-10-16',bucket:'hour',card_id:'none'},'usage',NOW),NOW);expect(r.buckets).toHaveLength(48);expect(r.series[0].bucket_start).toBe('2026-10-15T00:00:00.000Z');expect(r.totals.requests).toBe(1);});
it('latest timestamp is workspace wide without filters',async()=>{const {store}=await fixture();const r=await store.usage('ws',parseQuery({model:'absent'},'usage',NOW),NOW);expect(r.totals.requests).toBe(0);expect(r.latest_ended_at).toBe(new Date(fact().ended_at).toISOString());});
it('paginates equal timestamps without duplicates or omissions',async()=>{const {store}=await fixture();const ids:string[]=[];let cursor:string|undefined;do{const r=await store.journal('ws',parseQuery({limit:'1',...(cursor?{cursor}:{})},'model_calls',NOW));ids.push(...r.data.map(r=>r.id));cursor=r.next_cursor??undefined;}while(cursor);expect(ids).toEqual(['sevt_2','sevt_1','sevt_3','sevt_4']);});
it('session and facets use last agent name and sorted distinct values',async()=>{const {store}=await fixture();const s=await store.session('ws','ses_1');expect(s.models).toEqual(['alpha','beta']);expect(s.totals.requests).toBe(3);const f=await store.facets('ws',parseQuery({},'facets',NOW));expect(f.cards).toEqual([{id:'mc_1',model:'alpha'}]);expect(f.agents).toHaveLength(2);});

it('includes both UTC day boundaries and excludes adjacent milliseconds', async () => {
  const {store} = await fixture(false);
  const start = Date.parse('2026-10-15T00:00:00Z');
  const finish = Date.parse('2026-10-16T00:00:00Z');
  for (const [id, ended_at] of [['before', start - 1], ['start', start], ['last', finish - 1], ['after', finish]] as const) {
    await store.insert(fact({id, ended_at, day: new Date(ended_at).toISOString().slice(0, 10)}));
  }
  const query = parseQuery({from: '2026-10-15', to: '2026-10-15', bucket: 'hour'}, 'usage', NOW);
  const report = await store.usage('ws', query, NOW);
  expect(report.totals.requests).toBe(2);
  expect(report.series.map(row => row.bucket_start)).toEqual([
    '2026-10-15T00:00:00.000Z', '2026-10-15T23:00:00.000Z',
  ]);
  expect((await store.journal('ws', query)).data.map(row => row.id)).toEqual(['last', 'start']);
});

it('chooses the name from the latest actual event when timestamps tie', async () => {
  const {store} = await fixture(false);
  await store.insert(fact({id: 'z_old', ended_at: NOW - 2000, agent_name: 'Старое имя'}));
  await store.insert(fact({id: 'a_current', ended_at: NOW - 1000, agent_name: 'Старое имя'}));
  await store.insert(fact({id: 'b_current', ended_at: NOW - 1000, agent_name: 'Новое имя'}));
  const query = parseQuery({group_by: 'agent'}, 'usage', NOW);
  expect((await store.usage('ws', query, NOW)).groups[0].label).toBe('Новое имя');
  expect((await store.facets('ws', query)).agents).toEqual([{id: 'ag_1', name: 'Новое имя'}]);
  expect((await store.cache('ws', query, NOW)).rows[0].label).toBe('Новое имя');
});

it('returns empty aggregates and times without leaking another workspace', async () => {
  const {store} = await fixture(false);
  await store.insert(fact({workspace_id: 'other'}));
  const query = parseQuery({group_by: 'none'}, 'usage', NOW);
  const usage = await store.usage('ws', query, NOW);
  expect(usage).toMatchObject({groups: [], series: [], latest_ended_at: null, totals: {
    requests: 0, errors: 0, input_tokens: 0, cost_usd_micros: 0,
    unpriced_requests: 0, usage_missing_requests: 0,
  }});
  expect(usage.buckets).toHaveLength(30);
  expect(await store.session('ws', 'absent')).toMatchObject({
    models: [], harnesses: [], first_started_at: null, last_ended_at: null, totals: {requests: 0},
  });
  expect(await store.get('ws', 'sevt_1')).toBeNull();
  expect(await store.facets('ws', query)).toMatchObject({agents: [], models: [], harnesses: [], cards: []});
});

it('combines card filters including none and keeps filters inside the workspace', async () => {
  const {store} = await fixture();
  await store.insert(fact({workspace_id: 'other', input_tokens: 999999}));
  const query = parseQuery({
    from: '2026-10-15', card_id: 'mc_1,none', agent_id: 'ag_1', model: 'alpha,beta', harness: 'pi,acp',
  }, 'usage', NOW);
  expect((await store.usage('ws', query, NOW)).totals).toMatchObject({requests: 2, input_tokens: 40});
  expect((await store.journal('ws', query)).data.map(row => row.id)).toEqual(['sevt_1', 'sevt_3']);
});

it('counts cache history separately from the current 168 hour totals', async () => {
  const {store} = await fixture(false);
  const hour = Math.floor(NOW / 3600000) * 3600000;
  const currentStart = hour - 167 * 3600000;
  const historyStart = hour - 335 * 3600000;
  const times = [historyStart - 1, historyStart, currentStart - 1, currentStart, hour + 3600000 - 1, hour + 3600000];
  for (const [index, ended_at] of times.entries()) {
    await store.insert(fact({id: `cache_${index}`, ended_at, day: new Date(ended_at).toISOString().slice(0, 10)}));
  }
  const report = await store.cache('ws', parseQuery({}, 'cache', NOW), NOW);
  expect(report.totals).toMatchObject({requests: 2, total_input_tokens: 200, read_ratio: 0.6, write_amortization: 3});
  expect(report.series.reduce((total, row) => total + row.requests, 0)).toBe(4);
  expect(report.series[0].hour_start).toBe(new Date(historyStart).toISOString());
});

it('returns null cache ratios when no input or cache writes were reported', async () => {
  const {store} = await fixture(false);
  const query = parseQuery({}, 'cache', NOW);
  expect((await store.cache('ws', query, NOW)).totals).toMatchObject({read_ratio: null, write_amortization: null});
  await store.insert(fact({input_tokens: 0, cache_read_tokens: 10, cache_write_tokens: 0}));
  expect((await store.cache('ws', query, NOW)).totals).toMatchObject({read_ratio: 1, write_amortization: null});
});

it('counts minute load in the open lower and closed upper time window', async () => {
  const {store} = await fixture(false);
  const from = NOW - 86400000;
  for (const [index, ended_at] of [from, from + 1, NOW, NOW + 1].entries()) {
    await store.insert(fact({id: `window_${index}`, ended_at, cache_read_tokens: 999999}));
  }
  const rows = await store.minutes('ws', from, NOW, 'mc_1');
  expect(rows).toHaveLength(2);
  expect(rows.reduce((total, row) => total + row.requests, 0)).toBe(2);
  expect(rows.map(row => row.input_tokens)).toEqual([40, 40]);
  expect(rows.every(row => Number.isInteger(row.minute))).toBe(true);
});
