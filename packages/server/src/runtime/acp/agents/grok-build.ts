import { AgentType } from '@agent-tower/shared';
import { createNativeAcpAgentDefinition } from './native-agent.js';

export const grokBuildAcpAgentDefinition = createNativeAcpAgentDefinition({
  agentType: AgentType.GROK_BUILD,
  displayName: 'Grok Build',
  executableCandidates: ['grok'],
  executableEnvKeys: ['GROK_PATH'],
  arguments: (_input, profile) => [
    'agent',
    ...(profile.model ? ['--model', profile.model] : []),
    ...(profile.permissionMode === 'AUTO_APPROVE' ? ['--always-approve'] : []),
    ...(profile.environment.OPENAI_BASE_URL
      ? ['--xai-api-base-url', profile.environment.OPENAI_BASE_URL]
      : []),
    'stdio',
  ],
  homeRelativeCandidates: [['.grok', 'bin', 'grok']],
  permissionConfigKeys: ['alwaysApprove'],
  configureSessionModel: false,
  buildEnvironment(profile): Record<string, string> {
    return profile.environment.OPENAI_API_KEY && !profile.environment.XAI_API_KEY
      ? { XAI_API_KEY: profile.environment.OPENAI_API_KEY }
      : {};
  },
});
