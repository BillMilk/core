import { AlertTriangle, Loader2 } from 'lucide-react'
import type { WorkspaceBackgroundServiceDto } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'

interface MergeActiveServicesNoticeProps {
  services: WorkspaceBackgroundServiceDto[]
  isLoading: boolean
  isError: boolean
}

export function MergeActiveServicesNotice({
  services,
  isLoading,
  isError,
}: MergeActiveServicesNoticeProps) {
  const { t } = useI18n()

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <Loader2 size={13} className="animate-spin shrink-0" aria-hidden="true" />
        <span>{t('正在检查后台服务...')}</span>
      </div>
    )
  }

  if (services.length > 0) {
    return (
      <div className="flex gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-900">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 text-xs leading-relaxed">
          <p className="font-medium">
            {t('合并前将停止 {count} 个后台服务', { count: services.length })}
          </p>
          <p className="mt-1 break-all font-mono text-[11px] text-amber-800">
            {services.map(service => service.name).join(', ')}
          </p>
          <p className="mt-1 text-amber-700">{t('停止后不会自动恢复。')}</p>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <p className="text-xs text-amber-700" role="status">
        {t('无法检查后台服务状态，提交时会再次确认。')}
      </p>
    )
  }

  return null
}
