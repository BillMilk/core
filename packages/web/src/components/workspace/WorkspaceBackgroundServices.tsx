import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Clock3, Folder, Loader2, RefreshCw, Server } from 'lucide-react'
import type {
  WorkspaceBackgroundServiceDto,
  WorkspaceBackgroundServiceRuntimeState,
} from '@agent-tower/shared'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { stripAnsiSequences } from '@/lib/ansi'
import {
  useWorkspaceBackgroundServiceLogs,
  useWorkspaceBackgroundServices,
} from '@/hooks/use-workspace-services'

const EMPTY_SERVICES: WorkspaceBackgroundServiceDto[] = []

interface WorkspaceBackgroundServicesProps {
  workspaceId: string
  enabled?: boolean
}

function formatCommand(service: WorkspaceBackgroundServiceDto) {
  return JSON.stringify([service.command, ...service.args])
}

function formatStartedAt(value: string | null, locale: string, fallback: string) {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)
}

function getStatusMeta(state: WorkspaceBackgroundServiceRuntimeState) {
  switch (state) {
    case 'RUNNING':
      return { label: 'Running', dotClassName: 'bg-emerald-400' }
    case 'STARTING':
      return { label: 'Starting', dotClassName: 'bg-amber-400' }
    case 'STOPPING':
      return { label: 'Stopping', dotClassName: 'bg-amber-400' }
    case 'FAILED':
      return { label: 'Failed', dotClassName: 'bg-red-400' }
    case 'EXITED':
      return { label: 'Exited', dotClassName: 'bg-neutral-400' }
    default:
      return { label: 'Stopped', dotClassName: 'bg-neutral-500' }
  }
}

function StatusLabel({ state }: { state: WorkspaceBackgroundServiceRuntimeState }) {
  const { t } = useI18n()
  const status = getStatusMeta(state)
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-300">
      <span className={cn('h-1.5 w-1.5 rounded-full', status.dotClassName)} aria-hidden="true" />
      {t(status.label)}
    </span>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex min-h-24 items-center justify-center gap-2 px-4 text-xs text-red-300" role="alert">
      <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-[#333] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
        title={t('Retry')}
        aria-label={t('Retry')}
      >
        <RefreshCw size={13} />
      </button>
    </div>
  )
}

export function WorkspaceBackgroundServices({
  workspaceId,
  enabled = true,
}: WorkspaceBackgroundServicesProps) {
  const { locale, t } = useI18n()
  const servicesQuery = useWorkspaceBackgroundServices(workspaceId, enabled)
  const services = servicesQuery.data ?? EMPTY_SERVICES
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const selectedService = services.find(service => service.name === selectedName) ?? services[0] ?? null
  const logsQuery = useWorkspaceBackgroundServiceLogs(
    workspaceId,
    selectedService?.name ?? '',
    selectedService?.runtimeInstanceId ?? null,
    enabled && !!selectedService,
  )
  const logText = useMemo(() => (
    stripAnsiSequences(logsQuery.data?.entries.map(entry => entry.data).join('') ?? '')
  ), [logsQuery.data?.entries])
  const logViewportRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    stickToBottomRef.current = true
  }, [selectedService?.id, selectedService?.runtimeInstanceId])

  useEffect(() => {
    const viewport = logViewportRef.current
    if (viewport && stickToBottomRef.current) viewport.scrollTop = viewport.scrollHeight
  }, [logText])

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-[#1e1e1e] text-neutral-200 md:flex-row">
      <aside className="flex max-h-[44%] min-h-32 shrink-0 flex-col border-b border-[#343434] bg-[#252526] md:max-h-none md:min-h-0 md:w-72 md:border-b-0 md:border-r">
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#343434] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Server size={13} className="shrink-0 text-neutral-400" aria-hidden="true" />
            <h2 className="truncate text-xs font-medium">{t('Background services')}</h2>
          </div>
          {!servicesQuery.isLoading && !servicesQuery.isError && (
            <span className="text-[11px] tabular-nums text-neutral-500">{services.length}</span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-app-thin">
          {servicesQuery.isLoading ? (
            <div className="flex min-h-24 items-center justify-center gap-2 text-xs text-neutral-500">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {t('Loading background services...')}
            </div>
          ) : servicesQuery.isError ? (
            <ErrorState
              message={t('Failed to load background services.')}
              onRetry={() => void servicesQuery.refetch()}
            />
          ) : services.length === 0 ? (
            <div className="flex min-h-24 flex-col items-center justify-center gap-2 px-4 text-center text-xs text-neutral-500">
              <Server size={22} aria-hidden="true" />
              <span>{t('No background services')}</span>
            </div>
          ) : (
            services.map(service => {
              const selected = service.name === selectedService?.name
              return (
                <button
                  key={service.id}
                  type="button"
                  onClick={() => setSelectedName(service.name)}
                  aria-pressed={selected}
                  className={cn(
                    'block w-full border-b border-[#343434] px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-400',
                    selected ? 'bg-[#1e1e1e]' : 'hover:bg-[#2d2d2d]',
                  )}
                >
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-neutral-100">{service.name}</span>
                    <StatusLabel state={service.runtimeState} />
                  </span>
                  <span className="mt-1 block truncate font-mono text-[10px] text-neutral-500" title={formatCommand(service)}>
                    {formatCommand(service)}
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-neutral-500">
                    <Folder size={10} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">{service.relativeCwd || '.'}</span>
                  </span>
                  <span className="mt-1 flex min-w-0 items-center gap-1 text-[10px] text-neutral-500">
                    <Clock3 size={10} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">
                      {formatStartedAt(service.startedAt, locale, t('Not started'))}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#1e1e1e]" aria-label={t('Background service logs')}>
        {selectedService ? (
          <>
            <header className="shrink-0 border-b border-[#343434] bg-[#252526]">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-2">
                <span className="min-w-0 truncate text-xs font-semibold text-neutral-100">
                  {selectedService.name}
                </span>
                <StatusLabel state={selectedService.runtimeState} />
              </div>
              <div
                className="max-h-32 overflow-y-auto overscroll-y-contain px-3 pb-2 scrollbar-app-thin focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-neutral-400"
                tabIndex={0}
                aria-label={`${selectedService.name} ${t('Details')}`}
              >
                <dl className="mt-1.5 grid min-w-0 gap-x-4 gap-y-1 text-[10px] text-neutral-500 sm:grid-cols-2">
                  <div className="flex min-w-0 gap-1.5">
                    <dt className="shrink-0">{t('Command')}:</dt>
                    <dd className="min-w-0 break-all font-mono text-neutral-400">{formatCommand(selectedService)}</dd>
                  </div>
                  <div className="flex min-w-0 gap-1.5">
                    <dt className="shrink-0">{t('Working directory')}:</dt>
                    <dd className="min-w-0 break-all font-mono text-neutral-400">{selectedService.relativeCwd || '.'}</dd>
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                    <Clock3 size={10} className="shrink-0" aria-hidden="true" />
                    <dt className="shrink-0">{t('Started')}:</dt>
                    <dd className="truncate text-neutral-400">
                      {formatStartedAt(selectedService.startedAt, locale, t('Not started'))}
                    </dd>
                  </div>
                </dl>
                {selectedService.lastError && (
                  <p className="mt-1.5 break-words text-[10px] text-red-300" role="alert">
                    {selectedService.lastError}
                  </p>
                )}
              </div>
            </header>

            {(logsQuery.data?.truncated || logsQuery.data?.reset) && (
              <div className="shrink-0 border-b border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-[10px] text-amber-200">
                {t('Earlier log output is unavailable.')}
              </div>
            )}
            {logsQuery.isError && (
              <div className="flex shrink-0 items-center gap-2 border-b border-red-400/20 bg-red-400/10 px-3 py-1.5 text-[10px] text-red-200" role="alert">
                <span>{t('Failed to refresh service logs.')}</span>
                <button
                  type="button"
                  onClick={() => void logsQuery.refetch()}
                  className="flex h-6 w-6 items-center justify-center rounded text-red-100 transition-colors hover:bg-red-300/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200"
                  title={t('Retry')}
                  aria-label={t('Retry')}
                >
                  <RefreshCw size={11} />
                </button>
              </div>
            )}

            <div
              ref={logViewportRef}
              onScroll={(event) => {
                const target = event.currentTarget
                stickToBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 32
              }}
              className="min-h-0 flex-1 overflow-auto p-3 scrollbar-app-thin"
              role="log"
              aria-live="off"
              tabIndex={0}
            >
              {logsQuery.isLoading && !logsQuery.data ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-neutral-500">
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  {t('Loading service logs...')}
                </div>
              ) : logText ? (
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-neutral-300">
                  {logText}
                </pre>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                  {t('No logs yet')}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-neutral-500">
            {servicesQuery.isLoading ? t('Loading background services...') : t('Select a background service')}
          </div>
        )}
      </section>
    </div>
  )
}
