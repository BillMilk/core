import { TaskOrchestrationStatus } from '@agent-tower/shared'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { orchestrationStatusClass, orchestrationStatusLabel } from './orchestration-model'

export function OrchestrationStatusBadge({
  status,
  compact = false,
  className,
}: {
  status?: TaskOrchestrationStatus | null
  compact?: boolean
  className?: string
}) {
  const { t } = useI18n()
  if (!status) return null
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border font-medium',
        compact ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[11px]',
        orchestrationStatusClass(status),
        className,
      )}
    >
      {t(orchestrationStatusLabel(status))}
    </span>
  )
}
