import { parse as parseToml } from 'smol-toml';
import {
  AgentType,
  type Provider,
  type RuntimePermissionMode,
} from '@agent-tower/shared';
import { CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID } from '../../executors/codex.executor.js';
import {
  CODEX_OPENAI_COMPATIBLE_PROVIDER_NAME,
  resolveEffectiveProviderConnection,
} from '../../services/provider-effective-connection.service.js';
import { AgentRuntimeError } from '../errors.js';

export interface CodexAcpProviderProjection {
  environment: Record<string, string>;
  permissionMode: RuntimePermissionMode;
  appendPrompt?: string;
  fastMode?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getOrCreateModelProvider(
  config: Record<string, unknown>,
  modelProviderId: string,
): Record<string, unknown> {
  const modelProviders = isRecord(config.model_providers)
    ? { ...config.model_providers }
    : {};
  const modelProvider = isRecord(modelProviders[modelProviderId])
    ? { ...modelProviders[modelProviderId] as Record<string, unknown> }
    : {};
  modelProviders[modelProviderId] = modelProvider;
  config.model_providers = modelProviders;
  return modelProvider;
}

/** Project the persisted Provider into the environment contract consumed by codex-acp. */
export function projectCodexAcpProvider(
  provider: Provider | null,
  inheritedEnvironment: Record<string, string>,
): CodexAcpProviderProjection {
  const environment = { ...inheritedEnvironment };
  delete environment.CODEX_CONFIG;
  delete environment.MODEL_PROVIDER;
  delete environment.OPENAI_BASE_URL;
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;

  if (!provider) {
    return { environment, permissionMode: 'ASK' };
  }
  if (provider.agentType !== AgentType.CODEX) {
    throw new AgentRuntimeError(
      'runtime_not_supported',
      'provider_config',
      `Codex ACP provider projection requires a Codex Provider, received '${provider.agentType}'`,
      false,
    );
  }

  let codexConfig: Record<string, unknown> = {};
  if (provider.settings?.trim()) {
    try {
      codexConfig = parseToml(provider.settings) as Record<string, unknown>;
    } catch (error) {
      throw new AgentRuntimeError(
        'provider_config_invalid',
        'provider_config',
        'Codex Provider settings must be valid TOML',
        false,
        { cause: error },
      );
    }
  }

  const connection = resolveEffectiveProviderConnection(provider);
  if (connection.diagnostics.length > 0) {
    throw new AgentRuntimeError(
      'provider_config_invalid',
      'provider_config',
      connection.diagnostics.map(diagnostic => diagnostic.message).join('; '),
      false,
    );
  }

  const model = provider.config.model;
  if (typeof model === 'string' && model.trim()) codexConfig.model = model.trim();

  let modelProviderId = connection.modelProviderId;
  if (connection.providerKind === 'built-in') {
    if (connection.secret) environment.CODEX_API_KEY = connection.secret;
    if (connection.baseUrl) codexConfig.openai_base_url = connection.baseUrl;

    if (provider.config.disableResponsesWebsocket === true && connection.baseUrl) {
      modelProviderId = CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID;
      Object.assign(getOrCreateModelProvider(codexConfig, modelProviderId), {
        name: 'OpenAI',
        base_url: connection.baseUrl,
        wire_api: 'responses',
        requires_openai_auth: true,
        supports_websockets: false,
      });
    }
  } else if (connection.providerKind === 'custom' && connection.modelProviderId) {
    const modelProvider = getOrCreateModelProvider(codexConfig, connection.modelProviderId);
    if (connection.source === 'codex-openai-compatible') {
      modelProvider.name = CODEX_OPENAI_COMPATIBLE_PROVIDER_NAME;
      modelProvider.wire_api = 'responses';
    }
    modelProvider.http_headers = {
      // Some OpenAI-compatible gateways accept Codex CLI traffic only under its native originator.
      originator: 'codex_exec',
      ...(isRecord(modelProvider.http_headers) ? modelProvider.http_headers : {}),
    };
    if (connection.baseUrl) modelProvider.base_url = connection.baseUrl;
    if (connection.envKey) {
      modelProvider.env_key = connection.envKey;
      delete environment[connection.envKey];
      if (connection.secret !== undefined) environment[connection.envKey] = connection.secret;
    }
    if (provider.config.disableResponsesWebsocket === true) {
      modelProvider.supports_websockets = false;
    }
  }

  if (modelProviderId) {
    codexConfig.model_provider = modelProviderId;
    environment.MODEL_PROVIDER = modelProviderId;
  }
  if (Object.keys(codexConfig).length > 0) {
    environment.CODEX_CONFIG = JSON.stringify(codexConfig);
  }

  const configuredMode = provider.config.permissionMode ?? provider.config.acpPermissionMode;
  const appendPrompt = typeof provider.config.appendPrompt === 'string' && provider.config.appendPrompt
    ? provider.config.appendPrompt
    : undefined;
  const fastMode = typeof provider.config.fastMode === 'boolean'
    ? provider.config.fastMode
    : undefined;
  return {
    environment,
    permissionMode: configuredMode === 'AUTO_APPROVE' ? 'AUTO_APPROVE' : 'ASK',
    ...(appendPrompt ? { appendPrompt } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
}
