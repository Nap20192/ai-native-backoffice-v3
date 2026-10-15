import type { NodeManagedSessionRunnerAcceptInput } from '../node-managed-session-runtime.js';
export function callContext(input: Pick<NodeManagedSessionRunnerAcceptInput, 'workspaceId' | 'sessionId' | 'session'>, frame: {session_thread_id?: string}, threadName?: string) {
  const primary = input.session.agent;
  const member = frame.session_thread_id && threadName ? primary.multiagent?.agents.find(agent => agent.type === 'agent' && agent.name === threadName) : undefined;
  const agent = member?.type === 'agent' ? member : primary;
  const harness = agent.openma?.harness;
  return {
    workspace_id:input.workspaceId, session_id:input.sessionId, thread_id:frame.session_thread_id ?? 'sthr_primary',
    agent_id:agent.id, agent_version:agent.version ?? null, agent_name:threadName ?? agent.name,
    environment_id:input.session.environmentId ?? null,
    harness:!harness || harness === 'default' || harness === 'pi' ? 'pi' : harness === 'acp-sandbox' || harness === 'acp-proxy' ? agent.openma?.acp?.agent?.id ?? 'acp' : harness,
    model:agent.model.id, effort:agent.model.effort ?? null, speed:agent.model.speed ?? 'standard',
  };
}
