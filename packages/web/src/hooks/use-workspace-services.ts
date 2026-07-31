import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  WorkspaceBackgroundServiceLogEntry,
  WorkspaceBackgroundServiceLogsResponse,
  WorkspaceBackgroundServicesResponse,
} from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

const LOG_PAGE_SIZE = 200
const MAX_CLIENT_LOG_ENTRIES = 1_000
const MAX_CLIENT_LOG_CHARS = 512 * 1024

function trimLogEntries(entries: WorkspaceBackgroundServiceLogEntry[]) {
  let chars = entries.reduce((total, entry) => total + entry.data.length, 0)
  let startIndex = 0

  while (
    entries.length - startIndex > MAX_CLIENT_LOG_ENTRIES
    || (chars > MAX_CLIENT_LOG_CHARS && entries.length - startIndex > 1)
  ) {
    chars -= entries[startIndex].data.length
    startIndex += 1
  }

  return {
    entries: startIndex > 0 ? entries.slice(startIndex) : entries,
    trimmed: startIndex > 0,
  }
}

export function mergeWorkspaceServiceLogs(
  current: WorkspaceBackgroundServiceLogsResponse | undefined,
  incoming: WorkspaceBackgroundServiceLogsResponse,
): WorkspaceBackgroundServiceLogsResponse {
  const generationChanged = !!current
    && current.runtimeInstanceId !== incoming.runtimeInstanceId
  const replaceCache = generationChanged || incoming.reset
  const baseEntries = replaceCache ? [] : current?.entries ?? []
  const seen = new Set(baseEntries.map(entry => entry.seq))
  const mergedEntries = [
    ...baseEntries,
    ...incoming.entries.filter(entry => !seen.has(entry.seq)),
  ].sort((left, right) => left.seq - right.seq)
  const bounded = trimLogEntries(mergedEntries)

  return {
    ...incoming,
    entries: bounded.entries,
    reset: incoming.reset
      || generationChanged
      || (!replaceCache && (current?.reset ?? false)),
    truncated: incoming.truncated
      || (!replaceCache && (current?.truncated ?? false))
      || bounded.trimmed,
  }
}

export function useWorkspaceBackgroundServices(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.workspaceServices.list(workspaceId),
    queryFn: async () => {
      const response = await apiClient.get<WorkspaceBackgroundServicesResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/services`,
      )
      return response.services
    },
    enabled: enabled && !!workspaceId,
    refetchInterval: enabled && workspaceId ? 3_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  })
}

export function useWorkspaceBackgroundServiceLogs(
  workspaceId: string,
  serviceName: string,
  initialRuntimeInstanceId: string | null,
  enabled = true,
) {
  const queryClient = useQueryClient()
  const queryKey = queryKeys.workspaceServices.logs(workspaceId, serviceName)

  return useQuery({
    queryKey,
    queryFn: async () => {
      const current = queryClient.getQueryData<WorkspaceBackgroundServiceLogsResponse>(queryKey)
      const afterSeq = current ? Math.max(0, current.nextSeq - 1) : 0
      const expectedRuntimeInstanceId = current === undefined
        ? initialRuntimeInstanceId
        : current.runtimeInstanceId
      const search = new URLSearchParams({ limit: String(LOG_PAGE_SIZE) })
      if (expectedRuntimeInstanceId !== null) {
        search.set('runtimeInstanceId', expectedRuntimeInstanceId)
      }
      search.set('afterSeq', String(afterSeq))
      const incoming = await apiClient.get<WorkspaceBackgroundServiceLogsResponse>(
        `/workspaces/${encodeURIComponent(workspaceId)}/services/${encodeURIComponent(serviceName)}/logs?${search}`,
      )
      return mergeWorkspaceServiceLogs(current, incoming)
    },
    enabled: enabled && !!workspaceId && !!serviceName,
    refetchInterval: (query) => query.state.data?.hasMore ? 250 : 1_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  })
}
