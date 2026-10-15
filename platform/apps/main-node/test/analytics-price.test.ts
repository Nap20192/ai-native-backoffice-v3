import {it,expect} from 'vitest';
import {resolveCallPrice,costParts} from '../src/lib/analytics/price.js';
import {card} from './_helpers/analytics-seed.js';
it('prices each part in micros without division',()=>{expect(costParts({input_tokens:20,output_tokens:10,cache_read_tokens:0,cache_write_tokens:0},resolveCallPrice(card,'anthropic',card.model))).toEqual({cost_input_usd_micros:60,cost_output_usd_micros:150,cost_cache_read_usd_micros:0,cost_cache_write_usd_micros:0,cost_usd_micros:210});});
it('card overrides catalog and rounds individual parts',()=>{const p=resolveCallPrice({...card,pi_config:{cost:{input:0.3,output:2,cacheRead:0.1,cacheWrite:1.25}}},'ant',card.model);expect(p.source).toBe('card');expect(costParts({input_tokens:3,output_tokens:1,cache_read_tokens:3,cache_write_tokens:2},p).cost_usd_micros).toBe(6);});
it('uses catalog then no price',()=>{expect(resolveCallPrice(null,'ant','claude-sonnet-4-6')).toMatchObject({source:'catalog',price:{input:3,output:15}});expect(resolveCallPrice(null,null,'missing').source).toBe('none');expect(costParts({input_tokens:0,output_tokens:0,cache_read_tokens:0,cache_write_tokens:0},resolveCallPrice(null,null,null)).cost_usd_micros).toBeNull();});
it('rejects invalid card prices',()=>{expect(resolveCallPrice({...card,pi_config:{cost:{input:-1,output:1}}},null,'missing').source).toBe('none');});
