import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AgentType, normalizeRuntimePermissionMode } from '@agent-tower/shared';
import { which } from '../../../utils/index.js';
import { AgentRuntimeError } from '../../errors.js';
import type { AcpAgentDefinition, AcpAgentProfile } from './types.js';

function projectQwenProvider(
  provider: Parameters<AcpAgentDefinition['projectProvider']>[0],
  inheritedEnvironment: Record<string, string>,
): AcpAgentProfile {
  const environment = { ...inheritedEnvironment };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_BASE_URL;
  Object.assign(environment, provider?.env ?? {});
  const model = typeof provider?.config.model === 'string' && provider.config.model.trim()
    ? provider.config.model.trim()
    : undefined;
  const configuredMode = provider?.config.permissionMode ?? provider?.config.acpPermissionMode;
  const appendPrompt = typeof provider?.config.appendPrompt === 'string' && provider.config.appendPrompt
    ? provider.config.appendPrompt
    : undefined;
  const permissionMode = configuredMode === undefined && provider?.config.yolo === true
    ? 'UNRESTRICTED'
    : normalizeRuntimePermissionMode(configuredMode);
  return {
    agentType: AgentType.QWEN_CODE,
    environment,
    permissionMode,
    ...(model ? { model } : {}),
    ...(appendPrompt ? { appendPrompt } : {}),
  };
}

async function resolveQwenPath(environment: NodeJS.ProcessEnv): Promise<string | null> {
  const configured = environment.QWEN_PATH;
  if (configured && path.isAbsolute(configured)) return configured;
  return which(process.platform === 'win32' ? 'qwen.cmd' : 'qwen', { env: environment });
}

export const qwenCodeAcpAgentDefinition: AcpAgentDefinition = {
  agentType: AgentType.QWEN_CODE,
  displayName: 'Qwen Code',

  projectProvider: projectQwenProvider,

  async resolveLaunch(input, profile) {
    const qwenPath = await resolveQwenPath(profile.environment);
    if (!qwenPath) {
      throw new AgentRuntimeError('missing_agent', 'dependency_check', 'Qwen Code CLI was not found', true);
    }
    return {
      command: qwenPath,
      args: [
        '--acp',
        '--experimental-skills',
        ...(profile.permissionMode === 'UNRESTRICTED' ? ['--no-sandbox'] : []),
        ...(profile.model ? ['--model', profile.model] : []),
        ...(profile.environment.OPENAI_API_KEY ? ['--auth-type=openai'] : []),
      ],
      cwd: input.workingDir,
      env: profile.environment,
    };
  },

  async checkAvailability(provider) {
    const profile = projectQwenProvider(provider, { ...process.env } as Record<string, string>);
    return await resolveQwenPath(profile.environment)
      ? { type: 'INSTALLATION_FOUND' }
      : { type: 'NOT_FOUND', error: 'Qwen Code CLI was not found' };
  },

  async configureSession(context, sessionId, response, profile) {
    if (
      profile.permissionMode === 'UNRESTRICTED'
      && response.modes?.currentModeId !== 'yolo'
    ) {
      if (!response.modes?.availableModes.some(mode => mode.id === 'yolo')) {
        throw new AgentRuntimeError(
          'permission_mode_unsupported',
          'session',
          'Qwen Code did not advertise its unrestricted mode',
          false,
        );
      }
      await context.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'yolo' });
    }
  },
};
