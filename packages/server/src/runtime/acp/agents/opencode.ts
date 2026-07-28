import { AgentType } from '@agent-tower/shared';
import { createNativeAcpAgentDefinition } from './native-agent.js';

export const openCodeAcpAgentDefinition = createNativeAcpAgentDefinition({
  agentType: AgentType.OPENCODE,
  displayName: 'OpenCode',
  executableCandidates: ['opencode'],
  executableEnvKeys: ['OPENCODE_PATH'],
  arguments: ['acp'],
  homeRelativeCandidates: [['.opencode', 'bin', 'opencode']],
  initializeTimeoutMs: 60_000,
  permissionConfigKeys: ['autoApprove'],
  sessionModelValue: profile => profile.model ? `agent-tower/${profile.model}` : undefined,
  buildEnvironment(profile): Record<string, string> {
    const apiKey = profile.environment.OPENAI_API_KEY;
    const model = profile.model;
    if (!apiKey || !model || profile.environment.OPENCODE_CONFIG_CONTENT) return {};
    const baseUrl = profile.environment.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const usesChatCompletions = profile.environment.OPENAI_WIRE_API === 'chat_completions';
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: `agent-tower/${model}`,
        provider: {
          'agent-tower': {
            npm: usesChatCompletions ? '@ai-sdk/openai-compatible' : '@ai-sdk/openai',
            name: 'Agent Tower OpenAI',
            options: { apiKey, baseURL: baseUrl },
            models: { [model]: { name: model } },
          },
        },
      }),
    };
  },
});
