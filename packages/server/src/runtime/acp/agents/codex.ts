import { createRequire } from 'node:module';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AgentType } from '@agent-tower/shared';
import { which } from '../../../utils/index.js';
import { AgentRuntimeError } from '../../errors.js';
import { projectCodexAcpProvider } from '../codex-provider-config.js';
import {
  codexAcpMaxStdoutFrameBytes,
  normalizeCodexAcpStdoutFrame,
} from './codex-frame-normalizer.js';
import { isExecutableFile, resolveBundledCodexEntrypoint } from './executable-resolution.js';
import type { AcpAgentDefinition } from './types.js';

const require = createRequire(import.meta.url);

export const codexAcpAgentDefinition: AcpAgentDefinition = {
  agentType: AgentType.CODEX,
  displayName: 'Codex',
  maxStdoutFrameBytes: codexAcpMaxStdoutFrameBytes,
  transformStdoutFrame: normalizeCodexAcpStdoutFrame,

  projectProvider(provider, inheritedEnvironment) {
    return {
      agentType: AgentType.CODEX,
      ...projectCodexAcpProvider(provider, inheritedEnvironment),
    };
  },

  async resolveLaunch(input, profile) {
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
    const codexPath = await resolveCodexOverride(profile.environment);
    if (!codexPath && !resolveBundledCodexEntrypoint()) {
      throw new AgentRuntimeError('missing_codex', 'dependency_check', 'Bundled Codex Runtime was not found', false);
    }
    const environment = { ...profile.environment };
    if (codexPath) environment.CODEX_PATH = codexPath;
    else delete environment.CODEX_PATH;

    return {
      command: process.execPath,
      args: [adapterPath],
      cwd: input.workingDir,
      env: {
        ...environment,
        ELECTRON_RUN_AS_NODE: '1',
        // Keep Agent Tower's session-scoped MCP when a global server uses the same name.
        DISABLE_MCP_CONFIG_FILTERING: 'true',
      },
    };
  },

  async checkAvailability(provider) {
    try {
      require.resolve('@agentclientprotocol/codex-acp');
    } catch {
      return { type: 'NOT_FOUND', error: 'Codex ACP adapter is not installed' };
    }
    const environment = { ...process.env, ...provider.env };
    const available = await resolveCodexOverride(environment) || resolveBundledCodexEntrypoint();
    return available
      ? { type: 'INSTALLATION_FOUND' }
      : { type: 'NOT_FOUND', error: 'Bundled Codex Runtime was not found' };
  },

  async configureSession(context, sessionId, response, profile) {
    if (profile.fastMode === undefined) return;
    const option = response.configOptions?.find(candidate => candidate.id === 'fast-mode');
    if (!option) return;
    const value = option.type === 'boolean'
      ? profile.fastMode
      : profile.fastMode ? 'on' : 'off';
    if (option.currentValue === value) return;
    await context.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: option.id,
      value,
    });
  },
};

async function resolveCodexOverride(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const configured = environment.CODEX_PATH?.trim();
  if (!configured) return undefined;
  if (path.isAbsolute(configured)) {
    return await isExecutableFile(configured) ? configured : undefined;
  }
  return await which(configured, { env: environment }) ?? undefined;
}
