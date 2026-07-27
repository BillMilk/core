import { createRequire } from 'node:module';
import path from 'node:path';
import { AgentType } from '@agent-tower/shared';
import { which } from '../../../utils/index.js';
import { AgentRuntimeError } from '../../errors.js';
import { projectCodexAcpProvider } from '../codex-provider-config.js';
import type { AcpAgentDefinition } from './types.js';

const require = createRequire(import.meta.url);

export const codexAcpAgentDefinition: AcpAgentDefinition = {
  agentType: AgentType.CODEX,
  displayName: 'Codex',

  projectProvider(provider, inheritedEnvironment) {
    return {
      agentType: AgentType.CODEX,
      ...projectCodexAcpProvider(provider, inheritedEnvironment),
    };
  },

  async resolveLaunch(input, profile) {
    const configured = profile.environment.CODEX_PATH;
    const codexPath = configured && path.isAbsolute(configured)
      ? configured
      : await which('codex', { env: profile.environment });
    if (!codexPath) {
      throw new AgentRuntimeError('missing_codex', 'dependency_check', 'Codex CLI was not found', true);
    }

    let adapterPath: string;
    try {
      adapterPath = require.resolve('@agentclientprotocol/codex-acp');
    } catch (error) {
      throw new AgentRuntimeError(
        'missing_adapter',
        'dependency_check',
        'Codex ACP adapter was not found',
        false,
        { cause: error },
      );
    }

    return {
      command: process.execPath,
      args: [adapterPath],
      cwd: input.workingDir,
      env: {
        ...profile.environment,
        CODEX_PATH: codexPath,
        ELECTRON_RUN_AS_NODE: '1',
      },
    };
  },

  async checkAvailability(provider) {
    try {
      require.resolve('@agentclientprotocol/codex-acp');
    } catch {
      return { type: 'NOT_FOUND', error: 'Codex ACP adapter is not installed' };
    }
    const configured = provider.env.CODEX_PATH;
    const codexPath = configured && path.isAbsolute(configured)
      ? configured
      : await which('codex', { env: { ...process.env, ...provider.env } });
    return codexPath
      ? { type: 'INSTALLATION_FOUND' }
      : { type: 'NOT_FOUND', error: 'Codex CLI was not found' };
  },
};
