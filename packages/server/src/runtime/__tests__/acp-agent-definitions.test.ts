import type * as acp from '@agentclientprotocol/sdk';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { describe, expect, it, vi } from 'vitest';
import { getAcpAgentDefinition } from '../acp/agents/registry.js';

function provider(
  agentType: AgentType,
  input: Partial<{
    env: Record<string, string>;
    config: Record<string, unknown>;
    settings: string;
  }> = {},
) {
  return {
    id: `${agentType.toLowerCase()}-acp`,
    name: `${agentType} ACP`,
    agentType,
    runtimeType: RuntimeType.ACP,
    env: input.env ?? {},
    config: input.config ?? {},
    settings: input.settings,
    isDefault: false,
  };
}

describe('ACP Agent definitions', () => {
  it('projects Claude settings, credentials, model, effort and permission mode', () => {
    const definition = getAcpAgentDefinition(AgentType.CLAUDE_CODE);
    const profile = definition.projectProvider(provider(AgentType.CLAUDE_CODE, {
      env: { ANTHROPIC_API_KEY: 'provider-key' },
      config: {
        model: 'claude-sonnet-4-5',
        effort: 'high',
        permissionMode: 'AUTO_APPROVE',
        appendPrompt: '\nUse the repository conventions.',
      },
      settings: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
        permissions: { defaultMode: 'acceptEdits' },
      }),
    }), {
      ANTHROPIC_API_KEY: 'stale-key',
      ANTHROPIC_BASE_URL: 'https://stale.example',
    });

    expect(profile).toMatchObject({
      agentType: AgentType.CLAUDE_CODE,
      model: 'claude-sonnet-4-5',
      effort: 'high',
      permissionMode: 'AUTO_APPROVE',
      appendPrompt: '\nUse the repository conventions.',
    });
    expect(profile.environment).toMatchObject({
      ANTHROPIC_API_KEY: 'provider-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    });
    expect(definition.sessionMetadata?.(profile)).toMatchObject({
      _meta: {
        claudeCode: {
          options: {
            settings: {
              model: 'claude-sonnet-4-5',
              effortLevel: 'high',
              permissions: { defaultMode: 'acceptEdits' },
            },
          },
        },
      },
    });
  });

  it('configures Claude model, effort and bypass permission mode when advertised', async () => {
    const definition = getAcpAgentDefinition(AgentType.CLAUDE_CODE);
    const profile = definition.projectProvider(provider(AgentType.CLAUDE_CODE, {
      config: { model: 'claude-opus-4-1', effort: 'max', permissionMode: 'AUTO_APPROVE' },
    }), {});
    const request = vi.fn()
      .mockResolvedValueOnce({ configOptions: [{ id: 'model' }, { id: 'effort' }] })
      .mockResolvedValue({});

    await definition.configureSession?.({ request } as unknown as acp.ClientContext, 'session-1', {
      configOptions: [{ id: 'model' }, { id: 'effort' }] as never,
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default' }, { id: 'bypassPermissions' }],
      } as never,
    }, profile);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(call => call[1])).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'claude-opus-4-1' },
      { sessionId: 'session-1', configId: 'effort', value: 'max' },
      { sessionId: 'session-1', modeId: 'bypassPermissions' },
    ]);
  });

  it('projects Qwen OpenAI-compatible credentials without inheriting stale values', () => {
    const definition = getAcpAgentDefinition(AgentType.QWEN_CODE);
    const profile = definition.projectProvider(provider(AgentType.QWEN_CODE, {
      env: {
        OPENAI_API_KEY: 'qwen-provider-key',
        OPENAI_BASE_URL: 'https://dashscope.example/v1',
      },
      config: { model: 'qwen3-coder-plus', permissionMode: 'AUTO_APPROVE' },
    }), {
      OPENAI_API_KEY: 'stale-key',
      OPENAI_BASE_URL: 'https://stale.example/v1',
    });

    expect(profile).toMatchObject({
      agentType: AgentType.QWEN_CODE,
      model: 'qwen3-coder-plus',
      permissionMode: 'AUTO_APPROVE',
      environment: {
        OPENAI_API_KEY: 'qwen-provider-key',
        OPENAI_BASE_URL: 'https://dashscope.example/v1',
      },
    });
  });

  it('switches Qwen to yolo mode only when auto approve is requested and available', async () => {
    const definition = getAcpAgentDefinition(AgentType.QWEN_CODE);
    const profile = definition.projectProvider(provider(AgentType.QWEN_CODE, {
      config: { permissionMode: 'AUTO_APPROVE' },
    }), {});
    const request = vi.fn().mockResolvedValue({});

    await definition.configureSession?.({ request } as unknown as acp.ClientContext, 'session-2', {
      configOptions: [],
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default' }, { id: 'yolo' }],
      } as never,
    }, profile);

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toEqual({ sessionId: 'session-2', modeId: 'yolo' });
  });
});
