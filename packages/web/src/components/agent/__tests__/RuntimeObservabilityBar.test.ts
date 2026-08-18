import { describe, expect, it } from 'vitest'
import { LogType, type LogEntry } from '@agent-tower/shared/log-adapter'
import { RuntimeType, type RuntimeStateDto } from '@agent-tower/shared'
import { derivePhase, formatDuration } from '../runtime-observability'

function runtimeState(turnState: RuntimeStateDto['turnState']): RuntimeStateDto {
  return {
    sessionId: 'session-1',
    runtimeType: RuntimeType.CLI,
    turnState,
    capabilities: {
      loadSession: true,
      terminalInput: true,
      terminalResize: true,
      permissions: false,
    },
    pendingPermissions: [],
  }
}

function log(type: LogType, content = 'entry', extra?: Partial<LogEntry>): LogEntry {
  return { id: `${type}-${content}`, type, content, ...extra }
}

describe('RuntimeObservabilityBar phase derivation', () => {
  it('reports permission and terminal phases from runtime state', () => {
    expect(derivePhase([], 'RUNNING', runtimeState('AWAITING_PERMISSION'))).toBe('permission')
    expect(derivePhase([], 'RUNNING', runtimeState('CANCELLING'))).toBe('cancelling')
    expect(derivePhase([], 'COMPLETED', runtimeState('IDLE'))).toBe('completed')
  })

  it('derives thinking, tool, and output phases from the latest CLI log', () => {
    expect(derivePhase([log(LogType.Info, 'thinking', { title: 'Thinking' })], 'RUNNING', runtimeState('RUNNING'))).toBe('thinking')
    expect(derivePhase([
      log(LogType.Tool, 'tool', { tool: { name: 'bash', status: 'in_progress' } }),
    ], 'RUNNING', runtimeState('RUNNING'))).toBe('tool')
    expect(derivePhase([log(LogType.Assistant, 'answer')], 'RUNNING', runtimeState('RUNNING'))).toBe('output')
  })

  it('does not keep showing an old tool after a newer assistant message', () => {
    const logs = [
      log(LogType.Tool, 'tool', { tool: { name: 'bash', status: 'in_progress' } }),
      log(LogType.Assistant, 'answer'),
    ]
    expect(derivePhase(logs, 'RUNNING', runtimeState('RUNNING'))).toBe('output')
  })
})

describe('RuntimeObservabilityBar duration formatting', () => {
  it('formats short, minute, and hour durations', () => {
    expect(formatDuration(8_000)).toBe('8s')
    expect(formatDuration(75_000)).toBe('1m 15s')
    expect(formatDuration(3_725_000)).toBe('1h 2m')
  })
})
