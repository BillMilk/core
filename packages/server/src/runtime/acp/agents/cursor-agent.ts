import { AgentType } from '@agent-tower/shared';
import { createNativeAcpAgentDefinition } from './native-agent.js';

export const cursorAgentAcpAgentDefinition = createNativeAcpAgentDefinition({
  agentType: AgentType.CURSOR_AGENT,
  displayName: 'Cursor Agent',
  executableCandidates: ['agent', 'cursor-agent'],
  executableEnvKeys: ['CURSOR_AGENT_PATH', 'CURSOR_PATH'],
  arguments: ['acp'],
  homeRelativeCandidates: [['.local', 'bin', 'agent'], ['.local', 'bin', 'cursor-agent'], ['.cursor', 'bin', 'agent']],
  permissionConfigKeys: ['force'],
});
