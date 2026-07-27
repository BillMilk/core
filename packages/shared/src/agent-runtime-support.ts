import { AgentType, RuntimeType } from './types.js'

export type AgentRuntimeSupportMatrix = Record<AgentType, readonly RuntimeType[]>

/**
 * Product capability catalog. Agent identity and execution protocol remain
 * independent even when an Agent currently supports only one Runtime.
 */
export const AGENT_RUNTIME_SUPPORT: AgentRuntimeSupportMatrix = {
  [AgentType.CLAUDE_CODE]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.GEMINI_CLI]: [RuntimeType.CLI],
  [AgentType.CURSOR_AGENT]: [RuntimeType.CLI],
  [AgentType.CODEX]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.QWEN_CODE]: [RuntimeType.ACP],
}

export function supportsAgentRuntime(
  agentType: AgentType | string,
  runtimeType: RuntimeType | string,
): boolean {
  return AGENT_RUNTIME_SUPPORT[agentType as AgentType]?.includes(runtimeType as RuntimeType) ?? false
}
