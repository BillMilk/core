import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Brain,
  CheckCircle2,
  Clock3,
  Gauge,
  LoaderCircle,
  MessageSquare,
  ShieldAlert,
  Square,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import type { RuntimeStateDto, RuntimeType, SessionStatus } from '@agent-tower/shared'
import { LogType, type LogEntry } from '@agent-tower/shared/log-adapter'
import { AgentLogo } from './AgentLogo'
import { formatNumber } from './TokenUsageBar'
import { derivePhase, formatDuration, getCurrentTool, type RuntimePhase } from './runtime-observability'
import type { TokenUsageInfo } from '@/hooks/useTokenUsage'
import { useI18n } from '@/lib/i18n'
import { getAgentLabel } from '@/lib/agent-meta'
import { cn } from '@/lib/utils'

interface RuntimePhaseInfo {
  key: RuntimePhase
  icon: LucideIcon
  className: string
}

interface RuntimeObservabilityBarProps {
  agentType?: string | null
  runtimeType?: RuntimeType | string | null
  sessionStatus?: SessionStatus | string
  runtimeState?: RuntimeStateDto | null
  logs: LogEntry[]
  usage: TokenUsageInfo | null
  sessionStartedAt?: string | number | null
  sessionEndedAt?: string | number | null
  compact?: boolean
  className?: string
}

function isRuntimeActive(runtimeState?: RuntimeStateDto | null): boolean {
  return runtimeState?.turnState === 'RUNNING'
    || runtimeState?.turnState === 'AWAITING_PERMISSION'
    || runtimeState?.turnState === 'CANCELLING'
}

function parseTimestamp(value?: string | number | null): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function phaseConfig(phase: RuntimePhase): RuntimePhaseInfo {
  switch (phase) {
    case 'starting':
      return { key: phase, icon: LoaderCircle, className: 'text-info bg-info/10' }
    case 'thinking':
      return { key: phase, icon: Brain, className: 'text-violet-500 bg-violet-500/10' }
    case 'tool':
      return { key: phase, icon: Wrench, className: 'text-warning bg-warning/10' }
    case 'output':
      return { key: phase, icon: Activity, className: 'text-success bg-success/10' }
    case 'permission':
      return { key: phase, icon: ShieldAlert, className: 'text-warning bg-warning/10' }
    case 'cancelling':
      return { key: phase, icon: Square, className: 'text-warning bg-warning/10' }
    case 'completed':
      return { key: phase, icon: CheckCircle2, className: 'text-success bg-success/10' }
    case 'failed':
      return { key: phase, icon: XCircle, className: 'text-destructive bg-destructive/10' }
    case 'cancelled':
      return { key: phase, icon: Square, className: 'text-muted-foreground bg-muted' }
    case 'waiting':
      return { key: phase, icon: LoaderCircle, className: 'text-info bg-info/10' }
    default:
      return { key: phase, icon: Activity, className: 'text-muted-foreground bg-muted' }
  }
}

function phaseLabel(phase: RuntimePhase, t: (source: string) => string): string {
  const labels: Record<RuntimePhase, string> = {
    starting: 'Starting agent',
    thinking: 'Thinking',
    tool: 'Calling tool',
    output: 'Generating output',
    waiting: 'Running',
    permission: 'Waiting for permission',
    cancelling: 'Stopping',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Stopped',
    idle: 'Idle',
  }
  return t(labels[phase])
}

function runtimeLabel(runtimeType?: RuntimeType | string | null): string {
  if (runtimeType === 'ACP') return 'ACP'
  if (runtimeType === 'CLI') return 'CLI'
  return runtimeType || 'Runtime'
}

export function RuntimeObservabilityBar({
  agentType,
  runtimeType,
  sessionStatus,
  runtimeState,
  logs,
  usage,
  sessionStartedAt,
  sessionEndedAt,
  compact = false,
  className,
}: RuntimeObservabilityBarProps) {
  const { t } = useI18n()
  const [now, setNow] = useState(() => Date.now())
  const phase = derivePhase(logs, sessionStatus, runtimeState)
  const phaseInfo = phaseConfig(phase)
  const PhaseIcon = phaseInfo.icon
  const currentTool = getCurrentTool(logs)
  const toolCount = useMemo(() => logs.filter((log) => log.type === LogType.Tool).length, [logs])
  const messageCount = useMemo(
    () => logs.filter((log) => log.type === LogType.User || log.type === LogType.Assistant).length,
    [logs],
  )
  const live = isRuntimeActive(runtimeState) || sessionStatus === 'RUNNING' || sessionStatus === 'PENDING'
  const startedAt = parseTimestamp(sessionStartedAt)
  const endedAt = parseTimestamp(sessionEndedAt)
  const duration = startedAt ? Math.max(0, (live ? now : endedAt ?? now) - startedAt) : null
  const contextWindow = usage?.modelContextWindow
  const usageRatio = contextWindow && contextWindow > 0 && usage
    ? usage.totalTokens / contextWindow
    : null
  const usagePercentage = usageRatio == null ? null : Math.min(Math.round(usageRatio * 100), 100)
  const agentLabel = getAgentLabel(agentType, agentType || 'Agent')
  const toolLabel = currentTool?.tool?.name || currentTool?.title || t('Tool')

  useEffect(() => {
    if (!live || !startedAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live, startedAt])

  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 bg-background/95 px-4 py-2 backdrop-blur-sm',
        compact ? 'text-[11px]' : 'text-xs',
        className,
      )}
      data-testid="runtime-observability-bar"
    >
      <div className="flex min-w-0 items-center gap-1.5" title={agentLabel}>
        <AgentLogo agentType={agentType} className={compact ? 'size-3.5' : 'size-4'} />
        <span className="max-w-[150px] truncate font-medium text-foreground">{agentLabel}</span>
        <span className="text-muted-foreground/60">/</span>
        <span className="text-muted-foreground">{runtimeLabel(runtimeType ?? runtimeState?.runtimeType)}</span>
      </div>

      <div className={cn('flex items-center gap-1.5 rounded-full px-2 py-1 font-medium', phaseInfo.className)}>
        <PhaseIcon size={compact ? 12 : 13} className={phase === 'starting' || phase === 'waiting' ? 'animate-spin' : undefined} />
        <span>{phaseLabel(phase, t)}</span>
        {phase === 'tool' ? <span className="max-w-[180px] truncate opacity-80">: {toolLabel}</span> : null}
      </div>

      {duration !== null ? (
        <span className="flex items-center gap-1 text-muted-foreground" title={t('Session duration')}>
          <Clock3 size={compact ? 12 : 13} />
          <span className="tabular-nums">{formatDuration(duration)}</span>
        </span>
      ) : null}

      <span className="flex items-center gap-1 text-muted-foreground" title={t('Tool calls')}>
        <Wrench size={compact ? 12 : 13} />
        <span className="tabular-nums">{toolCount}</span>
      </span>
      <span className="flex items-center gap-1 text-muted-foreground" title={t('Messages')}>
        <MessageSquare size={compact ? 12 : 13} />
        <span className="tabular-nums">{messageCount}</span>
      </span>

      {usage ? (
        <div
          className="ml-auto flex min-w-[190px] flex-1 items-center gap-2 sm:max-w-[320px]"
          title={t('Reported by the CLI. Core does not estimate or compress this context.')}
        >
          <Gauge size={compact ? 13 : 14} className={cn(
            'shrink-0',
            usageRatio != null && usageRatio >= 0.9 ? 'text-red-500' : usageRatio != null && usageRatio >= 0.7 ? 'text-amber-500' : 'text-muted-foreground',
          )} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span>{contextWindow ? t('Context') : t('Token usage')}</span>
              <span className="tabular-nums text-foreground">
                {formatNumber(usage.totalTokens)}
                {contextWindow ? ` / ${formatNumber(contextWindow)}` : ''}
                {usagePercentage !== null ? ` (${usagePercentage}%)` : ''}
              </span>
            </div>
            {contextWindow ? (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-300',
                    usageRatio != null && usageRatio >= 0.9 ? 'bg-red-500' : usageRatio != null && usageRatio >= 0.7 ? 'bg-amber-500' : 'bg-primary',
                  )}
                  style={{ width: `${usagePercentage ?? 0}%` }}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <span className="ml-auto flex items-center gap-1 text-muted-foreground/70" title={t('This CLI has not reported context usage yet.')}>
          <Gauge size={compact ? 13 : 14} />
          <span>{t('Context unavailable')}</span>
        </span>
      )}
    </div>
  )
}
