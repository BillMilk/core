import { AgentType, RuntimeType } from './types.js'

export type AgentRuntimeSupportMatrix = Record<AgentType, readonly RuntimeType[]>

/**
 * Product capability catalog. Agent identity and execution protocol remain
 * independent even when an Agent currently supports only one Runtime.
 */
export const AGENT_RUNTIME_SUPPORT: AgentRuntimeSupportMatrix = {
  [AgentType.CLAUDE_CODE]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.GEMINI_CLI]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.CURSOR_AGENT]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.CODEX]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.QWEN_CODE]: [RuntimeType.ACP],
  [AgentType.KIRO_CLI]: [RuntimeType.ACP],
  [AgentType.OPENCODE]: [RuntimeType.ACP],
  [AgentType.PI_CODING_AGENT]: [RuntimeType.ACP],
  [AgentType.GROK_BUILD]: [RuntimeType.ACP],
  [AgentType.MINION_CODE]: [RuntimeType.ACP],
}

export function supportsAgentRuntime(
  agentType: AgentType | string,
  runtimeType: RuntimeType | string,
): boolean {
  return AGENT_RUNTIME_SUPPORT[agentType as AgentType]?.includes(runtimeType as RuntimeType) ?? false
}
