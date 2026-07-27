import { describe, expect, it } from 'vitest'
import { AGENT_RUNTIME_SUPPORT, supportsAgentRuntime } from '../agent-runtime-support.js'
import { AgentType, RuntimeType } from '../types.js'

describe('Agent Runtime support catalog', () => {
  it('keeps identity and protocol support explicit', () => {
    expect(AGENT_RUNTIME_SUPPORT).toEqual({
      [AgentType.CLAUDE_CODE]: [RuntimeType.CLI, RuntimeType.ACP],
      [AgentType.GEMINI_CLI]: [RuntimeType.CLI],
      [AgentType.CURSOR_AGENT]: [RuntimeType.CLI],
      [AgentType.CODEX]: [RuntimeType.CLI, RuntimeType.ACP],
      [AgentType.QWEN_CODE]: [RuntimeType.ACP],
    })
    expect(supportsAgentRuntime(AgentType.QWEN_CODE, RuntimeType.ACP)).toBe(true)
    expect(supportsAgentRuntime(AgentType.QWEN_CODE, RuntimeType.CLI)).toBe(false)
    expect(supportsAgentRuntime(AgentType.GEMINI_CLI, RuntimeType.ACP)).toBe(false)
  })
})
