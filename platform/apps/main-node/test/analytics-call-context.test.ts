import {it,expect} from 'vitest';
import {callContext} from '../src/lib/analytics/call-context.js';
import {input} from './_helpers/analytics-seed.js';
it('resolves primary harness and ACP agent id',()=>{const i=input();expect(callContext(i,{}).harness).toBe('pi');i.session.agent.openma={harness:'acp-sandbox',acp:{agent:{id:'claude-acp'}}};expect(callContext(i,{}).harness).toBe('claude-acp');});
it('uses roster subagent and falls back to primary metadata with thread name',()=>{const i=input();i.session.agent.multiagent={agents:[{...i.session.agent,id:'ag_2',name:'Помощник',type:'agent',model:{id:'beta',speed:'fast',effort:'high'}}]};expect(callContext(i,{session_thread_id:'sub'},'Помощник')).toMatchObject({agent_id:'ag_2',model:'beta',thread_id:'sub',speed:'fast'});expect(callContext(i,{session_thread_id:'sub'},'Другой')).toMatchObject({agent_id:'ag_1',agent_name:'Другой'});});
