import type { AgentType } from '@agent-tower/shared';
import { AgentRuntimeError } from '../../errors.js';
import { codexAcpAgentDefinition } from './codex.js';
import { claudeCodeAcpAgentDefinition } from './claude-code.js';
import { qwenCodeAcpAgentDefinition } from './qwen-code.js';
import type { AcpAgentDefinition } from './types.js';

const definitions = new Map<AgentType, AcpAgentDefinition>([
  [codexAcpAgentDefinition.agentType, codexAcpAgentDefinition],
  [claudeCodeAcpAgentDefinition.agentType, claudeCodeAcpAgentDefinition],
  [qwenCodeAcpAgentDefinition.agentType, qwenCodeAcpAgentDefinition],
]);

export function getAcpAgentDefinition(agentType: AgentType): AcpAgentDefinition {
  const definition = definitions.get(agentType);
  if (!definition) {
    throw new AgentRuntimeError(
      'runtime_not_supported',
      'open',
      `ACP runtime does not support agent '${agentType}'`,
      false,
    );
  }
  return definition;
}

export function supportsAcpAgent(agentType: AgentType | string): boolean {
  return definitions.has(agentType as AgentType);
}
