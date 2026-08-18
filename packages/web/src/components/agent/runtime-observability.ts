import type { RuntimeStateDto, SessionStatus } from '@agent-tower/shared'
import { LogType, type LogEntry } from '@agent-tower/shared/log-adapter'

export type RuntimePhase =
  | 'starting'
  | 'thinking'
  | 'tool'
  | 'output'
  | 'waiting'
  | 'permission'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'idle'

const TERMINAL_TOOL_STATUSES = new Set(['success', 'failed', 'denied', 'timed_out'])

function isRuntimeActive(runtimeState?: RuntimeStateDto | null): boolean {
  return runtimeState?.turnState === 'RUNNING'
    || runtimeState?.turnState === 'AWAITING_PERMISSION'
    || runtimeState?.turnState === 'CANCELLING'
}

function getLatestMeaningfulLog(logs: LogEntry[]): LogEntry | undefined {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const log = logs[index]
    if (log.type === LogType.Cursor || log.tokenUsage || !log.content.trim()) continue
    if (log.type === LogType.User) continue
    return log
  }
  return undefined
}

export function getCurrentTool(logs: LogEntry[]): LogEntry | undefined {
  const latest = getLatestMeaningfulLog(logs)
  if (!latest || latest.type !== LogType.Tool) return undefined
  const status = latest.tool?.status
  return !status || !TERMINAL_TOOL_STATUSES.has(status) ? latest : undefined
}

export function derivePhase(
  logs: LogEntry[],
  sessionStatus: SessionStatus | string | undefined,
  runtimeState: RuntimeStateDto | null | undefined,
): RuntimePhase {
  if (runtimeState?.error || sessionStatus === 'FAILED') return 'failed'
  if (runtimeState?.turnState === 'AWAITING_PERMISSION') return 'permission'
  if (runtimeState?.turnState === 'CANCELLING') return 'cancelling'

  const active = isRuntimeActive(runtimeState)
    || sessionStatus === 'RUNNING'
    || sessionStatus === 'PENDING'

  if (!active && sessionStatus === 'COMPLETED') return 'completed'
  if (!active && sessionStatus === 'CANCELLED') return 'cancelled'
  if (!active && sessionStatus === 'PENDING') return 'starting'

  const latest = getLatestMeaningfulLog(logs)
  if (getCurrentTool(logs)) return 'tool'
  if (latest?.type === LogType.Info && latest.title === 'Thinking') return 'thinking'
  if (latest?.type === LogType.Assistant) return 'output'
  if (active) return logs.length === 0 ? 'starting' : 'waiting'
  return 'idle'
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
