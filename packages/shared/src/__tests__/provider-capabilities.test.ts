import { describe, expect, it } from 'vitest'
import { AgentType } from '../types.js'
import {
  CODEX_NATIVE_MODEL_PROVIDER_IDS,
  PROVIDER_CAPABILITIES,
  getProviderCapability,
  isCodexNativeModelProviderId,
} from '../provider-capabilities.js'

describe('provider capability matrix', () => {
  it('declares the stable simplified paths for Claude and Codex', () => {
    expect(PROVIDER_CAPABILITIES[AgentType.CLAUDE_CODE]).toMatchObject({
      apiBaseUrl: { kind: 'env', path: 'ANTHROPIC_BASE_URL' },
      apiKey: { kind: 'env', path: 'ANTHROPIC_API_KEY' },
      model: { kind: 'config', path: 'model' },
      reasoningEffort: { kind: 'config', path: 'effort' },
      executionPermission: {
        kind: 'config', path: 'dangerouslySkipPermissions', riskKind: 'skip-permissions',
      },
    })
    expect(PROVIDER_CAPABILITIES[AgentType.CODEX]).toMatchObject({
      apiBaseUrl: { kind: 'settings', path: 'openai_base_url' },
      apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
      model: { kind: 'config', path: 'model' },
      reasoningEffort: { kind: 'settings', path: 'model_reasoning_effort' },
      executionPermission: {
        kind: 'config', path: 'dangerouslyBypassApprovalsAndSandbox', riskKind: 'bypass-approvals-and-sandbox',
      },
      disableResponsesWebsocket: { kind: 'config', path: 'disableResponsesWebsocket' },
    })
  })

  it('exposes the Responses WebSocket control only for Codex', () => {
    expect(PROVIDER_CAPABILITIES[AgentType.CODEX].disableResponsesWebsocket)
      .toEqual({ kind: 'config', path: 'disableResponsesWebsocket' })
    expect(PROVIDER_CAPABILITIES[AgentType.CLAUDE_CODE].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.GEMINI_CLI].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.CURSOR_AGENT].disableResponsesWebsocket).toBeUndefined()
  })

  it('declares ordered five-level effort options', () => {
    expect(PROVIDER_CAPABILITIES[AgentType.CLAUDE_CODE].reasoningEffort?.options)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(PROVIDER_CAPABILITIES[AgentType.CODEX].reasoningEffort?.options)
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('identifies only the Codex-reserved native and local model providers', () => {
    expect(CODEX_NATIVE_MODEL_PROVIDER_IDS).toEqual([
      'oss',
      'ollama',
      'lmstudio',
      'amazon-bedrock',
    ])
    for (const providerId of CODEX_NATIVE_MODEL_PROVIDER_IDS) {
      expect(isCodexNativeModelProviderId(providerId)).toBe(true)
    }
    expect(isCodexNativeModelProviderId('openai')).toBe(false)
    expect(isCodexNativeModelProviderId('team-proxy')).toBe(false)
  })

  it('exposes the Gemini API key and model without unrelated fields', () => {
    expect(getProviderCapability(AgentType.GEMINI_CLI)).toMatchObject({
      agentType: AgentType.GEMINI_CLI,
      apiKey: { kind: 'env', path: 'GEMINI_API_KEY' },
      model: { kind: 'config', path: 'model' },
      executionPermission: { kind: 'config', path: 'yolo', riskKind: 'auto-approve' },
    })
    expect(getProviderCapability(AgentType.GEMINI_CLI)?.apiBaseUrl).toBeUndefined()
    expect(getProviderCapability(AgentType.GEMINI_CLI)?.reasoningEffort).toBeUndefined()
  })

  it('only exposes model for Cursor', () => {
    expect(getProviderCapability(AgentType.CURSOR_AGENT)).toMatchObject({
      agentType: AgentType.CURSOR_AGENT,
      model: { kind: 'config', path: 'model' },
      executionPermission: { kind: 'config', path: 'force', riskKind: 'force-execution' },
    })
    expect(getProviderCapability(AgentType.CURSOR_AGENT)?.apiBaseUrl).toBeUndefined()
    expect(getProviderCapability(AgentType.CURSOR_AGENT)?.apiKey).toBeUndefined()
    expect(getProviderCapability(AgentType.CURSOR_AGENT)?.reasoningEffort).toBeUndefined()
  })
})
